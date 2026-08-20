(function () {
  "use strict";

  // ────────────────────────────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────────────────────────────
  const state = {
    screen: "loading",        // loading | home | setup | login | app
    view: "gallery",          // gallery | settings | privacy | help
    viewMode: "grid",         // grid | list
    path: [],                 // stack of {vid, rel, name} — [] = vault root
    items: [],
    search: "",
    selectMode: false,
    selected: new Set(),
    stats: { count: 0, size_h: "0 B" },
    busy: false,
    isDecoy: false,            // true when logged into the decoy vault
    covered: false,            // quick-hide cover is showing (master only)
    uiPrefs: { type: "default" },
    prefs: { application: {}, vault: {}, viewer: {}, shortcuts: {} },
    hasVault: false,           // whether a vault already exists on this machine
    entering: false,           // the vault-opening animation is playing
    justEntered: false,        // master vault: content stays hidden until the person scrolls
    sortMode: null,            // resolved per-folder sort {mode,dir} for the current view
    dragging: false,           // a manual-reorder drag is in progress
    privacyScreenOn: false,    // frosted "privacy screen" overlay is showing (window blur)
    favoritesItems: [],        // flat, vault-wide, refreshed on entering the Favorites view
    recentItems: [],           // flat, vault-wide, refreshed on entering the Dashboard view
    albumsItems: [],           // root-level folders flagged as albums, refreshed on entering the Albums view
    faceGroupContainers: [],   // top-level Face Group folders, refreshed on entering the Face Groups dashboard
    currentFaceGroupContainer: null, // {vid, name} of the container currently open (its own mini dashboard)
    containerFaceGroupItems: [], // Person N groups inside the currently open container, refreshed on entering it
    faceScanRunning: false,    // a "Scan for faces" job is currently in flight
    currentAlbum: null,        // {vid, name, origin} of the album/face-group currently open in the albumDetail view — origin is "albums" or "faceGroups", used only to decide where the Back button returns to
    albumDetailItems: [],      // flat, whole-vault-referenced items collected into currentAlbum
    thumbVersion: {},          // itemKey -> bump counter, forces a fresh thumbnail fetch right after a crop/collage edit
    notesList: [],             // "Your Text" — array of {id, title, text, color, createdAt, updatedAt}, loaded from vault prefs
    notesSelected: new Set(),  // ids of text cards currently selected in the notes view
    notesSort: { mode: "created", dir: "desc" }, // mode: "created" | "name"
  };

  let api = null;
  let mediaPort = 0;
  let mediaToken = "";
  // Only one tile's "more actions" popover may be open at a time — this
  // holds the close() function of whichever one currently is, so opening
  // another tile's menu (or any outside click) can tear the old one down.
  let activeTileMenuClose = null;
  // Every hand-built media_server URL in the frontend must go through this,
  // so it carries the current session's auth token — the backend already
  // does this itself (see main.py's _u()) for every URL it constructs, but
  // a few places here build a vid/rel-addressed URL locally (folder
  // backgrounds, custom empty-state images) since those are stored as raw
  // {vid, rel} pairs in item metadata, not pre-built URLs.
  function mediaUrl(path) {
    const sep = path.includes("?") ? "&" : "?";
    return `http://127.0.0.1:${mediaPort}${path}${sep}token=${mediaToken}`;
  }
  function withCacheBust(url) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}t=${Date.now()}`;
  }
  // Thumbnail URLs are stable (e.g. /thumb/{vid}) so the browser happily
  // caches them — great for normal browsing, but it means that right after
  // cropping/recomposing a thumbnail the tile kept showing the OLD cached
  // image until the person left the folder and came back (which just
  // happened to be enough of a gap for the cache to be reconsidered). The
  // backend file is updated immediately; only the displayed URL was stale.
  // Bumping a per-item counter and appending it as a query param forces a
  // fresh fetch the moment an edit succeeds, without cache-busting every
  // thumbnail on every render (which would refetch images unnecessarily).
  function bumpThumbVersion(vid, rel) {
    const key = rel ? `${vid}::${rel}` : vid;
    state.thumbVersion[key] = (state.thumbVersion[key] || 0) + 1;
  }
  function versionedThumbUrl(it) {
    if (!it || !it.thumb_url) return it ? it.thumb_url : undefined;
    const key = it.rel ? `${it.vid}::${it.rel}` : it.vid;
    const v = state.thumbVersion[key];
    if (!v) return it.thumb_url;
    const sep = it.thumb_url.includes("?") ? "&" : "?";
    return `${it.thumb_url}${sep}v=${v}`;
  }

  // Background presets offered in Settings \u2192 Appearance.
  const GRADIENTS = [
    { id: "sunset",  label: "Sunset",  css: "linear-gradient(135deg,#FF6B6B,#FFD93D)" },
    { id: "ocean",   label: "Ocean",   css: "linear-gradient(135deg,#2E3192,#1BFFFF)" },
    { id: "aurora",  label: "Aurora",  css: "linear-gradient(135deg,#00C6FF,#0072FF)" },
    { id: "berry",   label: "Berry",   css: "linear-gradient(135deg,#8E2DE2,#4A00E0)" },
    { id: "forest",  label: "Forest",  css: "linear-gradient(135deg,#134E5E,#71B280)" },
    { id: "dusk",    label: "Dusk",    css: "linear-gradient(135deg,#0F2027,#203A43,#2C5364)" },
    { id: "peach",   label: "Peach",   css: "linear-gradient(135deg,#FFA17F,#00223E)" },
    { id: "candy",   label: "Candy",   css: "linear-gradient(135deg,#F857A6,#FF5858)" },
  ];

  // ────────────────────────────────────────────────────────────────────────
  // Phase 1: preference defaults. Every scope is vault-identity-scoped (see
  // vault_core.py PREF_SCOPES) — these are just the shapes/fallbacks used
  // when a key hasn't been set yet.
  // ────────────────────────────────────────────────────────────────────────
  const DEFAULT_SHORTCUTS = {
    quick_hide:    { keys: "ctrl+shift+h", label: "Quick-hide vault" },
    toggle_select: { keys: "ctrl+shift+s", label: "Toggle select mode" },
    focus_search:  { keys: "ctrl+shift+f", label: "Focus search" },
    new_folder:    { keys: "ctrl+shift+n", label: "New folder" },
    add_file:      { keys: "ctrl+shift+o", label: "Add file" },
    go_back:       { keys: "ctrl+shift+b", label: "Go back" },
    toggle_view:   { keys: "ctrl+shift+g", label: "Toggle grid / list view" },
  };
  const DEFAULT_WORKFLOW = {
    default_click: "open",          // "open" | "select"
    confirm_delete: true,
    confirm_restore: false,
    confirm_open_external: false,
    default_landing: "gallery",     // "gallery" | "settings"
  };
  const DEFAULT_PRIVACY = {
    auto_lock_minutes: 0,           // 0 = off
    history_enabled: true,          // powers "recently opened" sort + last-opened tracking
    privacy_screen_enabled: false,  // frosted cover when the window loses focus
    remember_folder_state: false,   // opt-in: resume last folder + scroll position on next login
  };
  const DEFAULT_VIEWER = {
    background_style: "dark",       // "dark" | "blurred" | "black"
    controls_visible: true,
    remember_zoom: false,
    autoplay_video: true,
    loop_video: false,
  };
  const DEFAULT_QUICK_HIDE = { mode: "clock" }; // "clock" | "update" | "browser"
  const DEFAULT_SORT = { mode: "name", dir: "asc" };
  const AUTO_LOCK_OPTIONS = [
    { v: 0, label: "Off" }, { v: 1, label: "1 minute" }, { v: 5, label: "5 minutes" },
    { v: 15, label: "15 minutes" }, { v: 30, label: "30 minutes" }, { v: 60, label: "1 hour" },
  ];

  function prefGet(scope, key, def) {
    const s = state.prefs[scope];
    return (s && key in s) ? s[key] : def;
  }
  async function prefSet(scope, key, value) {
    state.prefs[scope] = state.prefs[scope] || {};
    state.prefs[scope][key] = value;
    return api.set_pref(scope, key, value);
  }
  function keyForFolder(vid, rel) { return rel ? `${vid}:${rel}` : vid; }
  function folderKey() {
    if (state.path.length === 0) return "root";
    const top = state.path[state.path.length - 1];
    return keyForFolder(top.vid, top.rel);
  }

  function applyBackground(prefs) {
    state.uiPrefs = prefs || { type: "default" };
    let bgEl = document.getElementById("app-bg");
    if (!bgEl) {
      bgEl = document.createElement("div");
      bgEl.id = "app-bg";
      document.body.prepend(bgEl);
    }
    document.body.classList.remove("custom-bg");
    bgEl.style.backgroundImage = "";
    bgEl.style.background = "";
    if (!prefs || prefs.type === "default") return;
    document.body.classList.add("custom-bg");
    if (prefs.type === "gradient") {
      const g = GRADIENTS.find(x => x.id === prefs.gradient_id) || GRADIENTS[0];
      bgEl.style.background = g.css;
    } else if (prefs.type === "image" && (prefs.url || prefs.image_name)) {
      const url = prefs.url || mediaUrl(`/bg/${prefs.image_name}`);
      bgEl.style.backgroundImage = `url('${withCacheBust(url)}')`;
      bgEl.style.backgroundSize = "cover";
      bgEl.style.backgroundPosition = "center";
    } else if (prefs.type === "dynamic" && prefs.url) {
      // Dynamic Content-Based Background — same rendering as a picked
      // image, just always served from /dynbg (encrypted) rather than the
      // plaintext ui_bg_dir path.
      bgEl.style.backgroundImage = `url('${withCacheBust(prefs.url)}')`;
      bgEl.style.backgroundSize = "cover";
      bgEl.style.backgroundPosition = "center";
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Auto-lock (Privacy Customization) — re-armed on any activity while the
  // app screen is showing; locks back to the login screen after N minutes
  // of inactivity. Off by default (auto_lock_minutes === 0).
  // ────────────────────────────────────────────────────────────────────────
  let _autoLockTimer = null;
  function clearAutoLockTimer() { if (_autoLockTimer) { clearTimeout(_autoLockTimer); _autoLockTimer = null; } }
  function armAutoLock() {
    clearAutoLockTimer();
    if (state.screen !== "app" || state.isDecoy) return; // decoy has nothing worth auto-locking
    const mins = prefGet("vault", "privacy", DEFAULT_PRIVACY).auto_lock_minutes;
    if (!mins) return;
    _autoLockTimer = setTimeout(doAutoLock, mins * 60000);
  }
  async function doAutoLock() {
    clearAutoLockTimer();
    await api.lock_out();
    mediaToken = ""; // the old token is now invalid server-side too — stop using it
    // Clear the previous account's custom background BEFORE switching to
    // the login screen. body.custom-bg makes .auth-wrap transparent (so a
    // custom background can show through on it), and that class/image
    // otherwise stays applied from the session that just got locked —
    // which means the login password field would sit directly on top of
    // the master vault's own private background image. Locking must never
    // leave anything from the unlocked session visible.
    applyBackground(null);
    state.screen = "login"; state.entering = false; state.covered = false;
    toast("Locked due to inactivity", "info");
    render();
  }
  ["mousemove", "keydown", "mousedown", "wheel", "touchstart"].forEach(evt => {
    document.addEventListener(evt, () => { if (state.screen === "app") armAutoLock(); }, { passive: true });
  });

  function apiIsReady() {
    return !!(window.pywebview && window.pywebview.api &&
              typeof window.pywebview.api.has_vault === "function");
  }

  function onReady(fn) {
    if (apiIsReady()) { fn(); return; }
    let done = false;
    const fire = () => { if (done) return; done = true; clearInterval(poll); clearTimeout(giveUp); fn(); };
    // Some pywebview builds fire 'pywebviewready' before every api method is
    // actually bound onto window.pywebview.api, and/or fire it before this
    // script attaches its listener — so we both listen AND poll, and only
    // proceed once the api object is genuinely callable.
    window.addEventListener("pywebviewready", () => { if (apiIsReady()) fire(); }, { once: false });
    const poll = setInterval(() => { if (apiIsReady()) fire(); }, 60);
    const giveUp = setTimeout(() => {
      if (done) return;
      clearInterval(poll);
      mount(h("div", { class: "auth-wrap" }, h("div", { class: "auth-card" },
        h("h1", { class: "auth-title" }, "Still starting\u2026"),
        h("p", { class: "auth-sub" }, "VaultLock is taking longer than expected to connect to its backend. Try restarting the app."),
      )));
    }, 12000);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Small DOM helpers
  // ────────────────────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), attrs[k]);
      else if (typeof attrs[k] === "boolean") { if (attrs[k]) node.setAttribute(k, ""); }
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined) continue;
      const isNode = (typeof kid === "object") && typeof kid.nodeType === "number";
      node.appendChild(isNode ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function mount(node) {
    const root = document.getElementById("root");
    root.innerHTML = "";
    root.appendChild(node);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Toast
  // ────────────────────────────────────────────────────────────────────────
  function toast(msg, kind) {
    kind = kind || "info";
    const colors = { info: "#3D5AFE", success: "#1FAE63", error: "#E1293D", warn: "#EDA53A" };
    const host = document.getElementById("toast-host");
    const t = h("div", { class: "toast" },
      h("div", { class: "dot", style: `background:${colors[kind]}` }),
      h("div", {}, msg)
    );
    host.appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .25s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 250); }, 2600);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Generic modal (confirm / choose / prompt)
  // ────────────────────────────────────────────────────────────────────────
  function modal({ title, body, buttons, input }) {
    return new Promise((resolve) => {
      const host = document.getElementById("modal-host");
      const backdrop = h("div", { class: "modal-backdrop" });
      let inputEl = null;
      const box = h("div", { class: "modal" },
        h("h3", {}, title),
        body ? h("p", { html: body }) : null,
      );
      if (input) {
        inputEl = h("input", { type: input.type || "text", placeholder: input.placeholder || "" });
        if (input.value) inputEl.value = input.value;
        box.appendChild(inputEl);
      }
      const row = h("div", { class: "row" });
      (buttons || [{ label: "OK", value: true, variant: "btn-primary" }]).forEach(b => {
        row.appendChild(h("button", {
          class: `btn ${b.variant || "btn-ghost"}`,
          onclick: () => {
            close();
            resolve(input ? (b.value ? (inputEl.value || null) : null) : b.value);
          }
        }, b.label));
      });
      box.appendChild(row);
      backdrop.appendChild(box);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { close(); resolve(input ? null : false); } });
      host.appendChild(backdrop);
      if (inputEl) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 30);
      function close() { backdrop.remove(); }
    });
  }
  function confirmDanger(title, body, confirmLabel) {
    return modal({
      title, body,
      buttons: [
        { label: "Cancel", value: false, variant: "btn-ghost" },
        { label: confirmLabel || "Delete", value: true, variant: "btn-danger" },
      ]
    });
  }
  function chooseDestination(count) {
    return modal({
      title: `Restore ${count} item${count > 1 ? "s" : ""}`,
      body: "Restore each item to where it was originally locked from, or choose one folder to restore everything into.",
      buttons: [
        { label: "Cancel", value: null, variant: "btn-ghost" },
        { label: "Original locations", value: "original", variant: "btn-ghost" },
        { label: "Choose folder\u2026", value: "choose", variant: "btn-primary" },
      ]
    });
  }
  function promptFolderName() {
    return modal({
      title: "New folder",
      body: "Creates an empty folder inside your vault for organizing files \u2014 nothing is added from your computer.",
      input: { placeholder: "Folder name" },
      buttons: [
        { label: "Cancel", value: false, variant: "btn-ghost" },
        { label: "Create", value: true, variant: "btn-primary" },
      ]
    });
  }
  // ════════════════════════════════════════════════════════════════════════
  // CUSTOMIZE MODAL — icon / accent color / tags / description / display
  // name, plus (folders only) a background image and Custom Metadata
  // (category + free-form key/value fields). Works on files and folders,
  // at any depth, since it's just writing the Phase 0 item-meta fields.
  // ════════════════════════════════════════════════════════════════════════
  const ACCENT_SWATCHES = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899"];
  const ICON_CHOICES = ["\u{1F4C1}", "\u{1F4F7}", "\u{1F3AC}", "\u{1F3B5}", "\u{1F4C4}", "\u2764\uFE0F", "\u{1F3E0}", "\u{1F4BC}", "\u{1F393}", "\u{1F3E5}", "\u2708\uFE0F", "\u{1F511}"];

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3.3: FOLDER APPEARANCE PROFILES + LAYOUT PRESETS — a profile and a
  // preset are the same underlying concept (a named, reusable bundle of
  // Phase 2 appearance fields + Phase 1 layout fields), stored once, vault-
  // identity-scoped like everything else in prefs.
  // ════════════════════════════════════════════════════════════════════════
  function getProfiles() { return prefGet("vault", "profiles", []); }
  async function saveProfiles(list) { await prefSet("vault", "profiles", list); }
  async function saveProfile(profile) {
    const list = getProfiles().filter(p => p.name !== profile.name);
    list.push(profile);
    await saveProfiles(list);
  }
  async function deleteProfile(name) {
    await saveProfiles(getProfiles().filter(p => p.name !== name));
  }
  async function applyProfileToFolder(profile, vid, rel) {
    const key = keyForFolder(vid, rel);
    if (profile.sort) await prefSet("vault", `sort:${key}`, profile.sort);
    if (profile.viewMode && key === folderKey()) { state.viewMode = profile.viewMode; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 5.1: FOLDER RULES & AUTOMATION — a small engine that triggers
  // EXISTING, already-built, non-destructive actions. Persisted via the
  // same Phase 0 prefs store every other setting uses (scope "vault", key
  // "rules") — no new storage path, just a new key in the same place
  // sort/order/profiles/workflow/privacy already live.
  //
  // HARD CONSTRAINT: RULE_ACTION_HANDLERS below is the *only* place a rule
  // can ever take effect, and every handler in it calls exclusively into
  // prefSet / set_item_meta / toast / a transient render flag — never
  // delete_item, delete_nested_item, delete_batch, move_item, rename_*, or
  // the duplicate-finder's delete path. A rule can only ever *open* the
  // duplicate finder (via suggest_duplicate_scan) for the person to act on
  // themselves, exactly like clicking the button manually.
  // ════════════════════════════════════════════════════════════════════════
  const RULE_TRIGGERS = [
    { v: "on_open", label: "Every time this folder is opened" },
    { v: "item_count_above", label: "When item count is above\u2026" },
    { v: "size_above_mb", label: "When folder size is above (MB)\u2026" },
  ];
  const RULE_ACTIONS = [
    { v: "set_sort", label: "Set sort mode" },
    { v: "set_color", label: "Set accent color" },
    { v: "set_icon", label: "Set icon" },
    { v: "show_badge", label: "Show a badge in the folder header" },
    { v: "suggest_duplicate_scan", label: "Suggest checking for duplicates" },
  ];

  function getRules() { return prefGet("vault", "rules", []); }
  async function saveRules(list) { await prefSet("vault", "rules", list); }
  function rulesForFolder(vid, rel) {
    const key = keyForFolder(vid, rel);
    return getRules().filter(r => keyForFolder(r.vid, r.rel) === key);
  }
  async function addRule(vid, rel, rule) {
    const list = getRules();
    list.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, vid, rel: rel || null, enabled: true, ...rule });
    await saveRules(list);
  }
  async function updateRule(id, patch) {
    const list = getRules();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], ...patch };
    await saveRules(list);
  }
  async function deleteRule(id) {
    await saveRules(getRules().filter(r => r.id !== id));
  }

  function ruleConditionMet(rule, stats) {
    if (rule.trigger === "on_open") return true;
    if (!stats) return false;
    if (rule.trigger === "item_count_above") return stats.file_count > (Number(rule.threshold) || 0);
    if (rule.trigger === "size_above_mb") return stats.size > (Number(rule.threshold) || 0) * 1024 * 1024;
    return false;
  }

  // Every handler here is deliberately narrow: it can only call the exact
  // same functions the manual UI for that action already calls. Nothing in
  // this map is capable of deleting, moving, renaming, or modifying file
  // content — see the hard-constraint note above.
  const RULE_ACTION_HANDLERS = {
    set_sort: async (rule, vid, rel) => {
      await prefSet("vault", `sort:${keyForFolder(vid, rel)}`, { mode: rule.sortMode || "name", dir: rule.sortDir || "asc" });
    },
    set_color: async (rule, vid, rel, currentMeta) => {
      if (currentMeta.color === rule.color) return; // avoid redundant writes on every open
      await api.set_item_meta(vid, { color: rule.color || null }, rel || null);
    },
    set_icon: async (rule, vid, rel, currentMeta) => {
      if (currentMeta.icon === rule.icon) return;
      await api.set_item_meta(vid, { icon: rule.icon || null }, rel || null);
    },
    show_badge: async (rule, vid, rel, currentMeta, badges) => {
      badges.push({ text: rule.badgeText || "Rule matched", style: rule.badgeStyle || "info" });
    },
    suggest_duplicate_scan: async (rule, vid, rel, currentMeta, badges) => {
      // Never runs the scan itself — just surfaces the same button the
      // Storage settings card already has, in context.
      badges.push({ text: "Consider checking for duplicates", style: "suggest", action: "open_duplicate_finder" });
    },
  };

  // Evaluates every enabled rule for the folder currently being entered.
  // Called once from loadCurrentView() right after top.stats is computed,
  // so conditional (count/size) triggers always see fresh numbers. Returns
  // the transient badges to render in the folder header this time around —
  // never persisted, recomputed on every visit.
  async function applyFolderRules(top) {
    const rules = rulesForFolder(top.vid, top.rel).filter(r => r.enabled);
    if (!rules.length) return [];
    const currentMeta = (await api.get_item_meta(top.vid, top.rel || null)).meta || {};
    const badges = [];
    for (const rule of rules) {
      if (!ruleConditionMet(rule, top.stats)) continue;
      const handler = RULE_ACTION_HANDLERS[rule.action];
      if (!handler) continue; // unknown/legacy action type — ignore, never guess
      try { await handler(rule, top.vid, top.rel, currentMeta, badges); } catch (_) { /* one bad rule shouldn't block the folder from opening */ }
    }
    return badges;
  }

  function ruleSummary(rule) {
    const trig = RULE_TRIGGERS.find(t => t.v === rule.trigger);
    const act = RULE_ACTIONS.find(a => a.v === rule.action);
    let trigLabel = trig ? trig.label : rule.trigger;
    if (rule.trigger !== "on_open") trigLabel = trigLabel.replace("\u2026", ` ${rule.threshold || 0}`);
    let actLabel = act ? act.label : rule.action;
    if (rule.action === "set_sort") actLabel = `Sort by ${rule.sortMode || "name"}`;
    if (rule.action === "set_color") actLabel = `Set color`;
    if (rule.action === "set_icon") actLabel = `Set icon to ${rule.icon || "\u2014"}`;
    if (rule.action === "show_badge") actLabel = `Badge: "${rule.badgeText || ""}"`;
    return `${trigLabel} \u2192 ${actLabel}`;
  }

  function renderRulesEditor(vid, rel) {
    const wrap = h("div", {});
    const list = h("div", { class: "rule-list" });

    function paint() {
      list.innerHTML = "";
      const rules = rulesForFolder(vid, rel);
      if (!rules.length) {
        list.appendChild(h("div", { class: "sub" }, "No rules for this folder yet."));
      }
      rules.forEach(r => {
        const toggle = h("input", { type: "checkbox" });
        toggle.checked = r.enabled;
        toggle.addEventListener("change", async () => { await updateRule(r.id, { enabled: toggle.checked }); });
        const delBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Delete");
        delBtn.addEventListener("click", async () => { await deleteRule(r.id); paint(); });
        list.appendChild(h("div", { class: "rule-row" },
          toggle,
          h("div", { class: "rule-summary" }, ruleSummary(r)),
          delBtn,
        ));
      });
    }
    paint();

    // ── new rule builder ──────────────────────────────────────────────────
    const triggerSelect = h("select", {}, ...RULE_TRIGGERS.map(t => h("option", { value: t.v }, t.label)));
    const thresholdInput = h("input", { type: "number", min: "0", placeholder: "0", class: "hidden", style: "width:70px;" });
    triggerSelect.addEventListener("change", () => {
      thresholdInput.classList.toggle("hidden", triggerSelect.value === "on_open");
    });
    const actionSelect = h("select", {}, ...RULE_ACTIONS.map(a => h("option", { value: a.v }, a.label)));
    const paramsWrap = h("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;" });
    function paintParams() {
      paramsWrap.innerHTML = "";
      const v = actionSelect.value;
      if (v === "set_sort") {
        paramsWrap.appendChild(h("select", { id: "rule_sort_mode" }, ...SORT_OPTIONS.filter(o => o.mode !== "manual").map(o => h("option", { value: o.mode }, o.label))));
      } else if (v === "set_color") {
        const sw = h("div", { class: "customize-swatches" });
        let chosen = ACCENT_SWATCHES[0];
        ACCENT_SWATCHES.forEach(c => sw.appendChild(h("div", {
          class: `customize-swatch ${c === chosen ? "active" : ""}`, style: `background:${c};`,
          onclick: (e) => { chosen = c; sw.querySelectorAll(".customize-swatch").forEach(el => el.classList.remove("active")); e.currentTarget.classList.add("active"); },
        })));
        sw._getValue = () => chosen;
        paramsWrap.appendChild(sw);
      } else if (v === "set_icon") {
        const iconSel = h("select", {}, ...ICON_CHOICES.map(ic => h("option", { value: ic }, ic)));
        paramsWrap.appendChild(iconSel);
      } else if (v === "show_badge" || v === "suggest_duplicate_scan") {
        if (v === "show_badge") paramsWrap.appendChild(h("input", { type: "text", placeholder: "Badge text", id: "rule_badge_text" }));
      }
    }
    actionSelect.addEventListener("change", paintParams);
    paintParams();

    const addBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Add rule");
    addBtn.addEventListener("click", async () => {
      const rule = { trigger: triggerSelect.value, action: actionSelect.value };
      if (triggerSelect.value !== "on_open") rule.threshold = Number(thresholdInput.value) || 0;
      if (actionSelect.value === "set_sort") rule.sortMode = paramsWrap.querySelector("select")?.value || "name";
      if (actionSelect.value === "set_color") rule.color = paramsWrap.firstChild?._getValue ? paramsWrap.firstChild._getValue() : ACCENT_SWATCHES[0];
      if (actionSelect.value === "set_icon") rule.icon = paramsWrap.querySelector("select")?.value || ICON_CHOICES[0];
      if (actionSelect.value === "show_badge") rule.badgeText = paramsWrap.querySelector("#rule_badge_text")?.value || "Rule matched";
      await addRule(vid, rel, rule);
      paint();
    });

    wrap.appendChild(h("p", { class: "sub" }, "Rules only trigger existing display/organizing actions \u2014 sort mode, color, icon, or a badge. They can never delete, move, or rename anything; a suggested duplicate check always opens the duplicate finder for you to review, never runs it automatically."));
    wrap.appendChild(list);
    wrap.appendChild(h("div", { class: "customize-section-label" }, "Add a rule"));
    wrap.appendChild(h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;align-items:center;" },
      h("span", { class: "sub" }, "When"), triggerSelect, thresholdInput,
      h("span", { class: "sub" }, "then"), actionSelect, paramsWrap, addBtn,
    ));
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 5.2: COMPLETE FOLDER IDENTITY SYSTEM — a single tabbed panel that
  // assembles Appearance / Organization / Interaction / Information, all
  // reading and writing the exact same fields/functions every earlier
  // phase already built (get_item_meta, set_item_meta, prefGet/prefSet,
  // folder_stats, favorite/pin toggles, rules engine). Nothing here is a
  // new storage path — see the Phase 5 dependency note in chat.
  // ════════════════════════════════════════════════════════════════════════
  function openCustomizeModal(it) {
    const host = document.getElementById("modal-host");
    const backdrop = h("div", { class: "modal-backdrop" });
    const t = effectiveTarget(it);
    const isFolder = it.is_dir;
    const insideAFolder = state.path.length > 0 || isAlbumItem(it); // pin only applies within a folder view (or the Albums list, for an album)

    let color = it.color || null, icon = it.icon || null;
    const tags = [...(it.tags || [])];
    const meta = { ...(it.metadata || {}) };

    const colorRow = h("div", { class: "customize-swatches" });
    function paintColorRow() {
      colorRow.innerHTML = "";
      colorRow.appendChild(h("div", {
        class: `customize-swatch none ${!color ? "active" : ""}`, title: "No color",
        onclick: () => { color = null; paintColorRow(); },
      }, "\u2715"));
      ACCENT_SWATCHES.forEach(c => colorRow.appendChild(h("div", {
        class: `customize-swatch ${color === c ? "active" : ""}`, style: `background:${c};`,
        onclick: () => { color = c; paintColorRow(); },
      })));
    }
    paintColorRow();

    const iconRow = h("div", { class: "customize-swatches" });
    function paintIconRow() {
      iconRow.innerHTML = "";
      iconRow.appendChild(h("div", {
        class: `customize-icon-choice ${!icon ? "active" : ""}`, title: "Default",
        onclick: () => { icon = null; paintIconRow(); },
      }, "\u2715"));
      ICON_CHOICES.forEach(ic => iconRow.appendChild(h("div", {
        class: `customize-icon-choice ${icon === ic ? "active" : ""}`,
        onclick: () => { icon = ic; paintIconRow(); },
      }, ic)));
    }
    paintIconRow();

    const displayNameInput = h("input", { type: "text", placeholder: it.name, value: it.display_name || "" });
    const descInput = h("textarea", { placeholder: "Notes or a short description\u2026", rows: "2" }, it.description || "");
    const categoryInput = h("input", { type: "text", placeholder: "e.g. Travel, Work, Receipts", value: meta.category || "" });

    const tagsWrap = h("div", { class: "tag-chips" });
    function paintTags() {
      tagsWrap.innerHTML = "";
      tags.forEach((tg, i) => tagsWrap.appendChild(h("span", { class: "tag-chip" }, tg,
        h("span", { class: "tag-chip-x", onclick: () => { tags.splice(i, 1); paintTags(); } }, "\u2715"))));
    }
    paintTags();
    const tagInput = h("input", { type: "text", placeholder: "Add a tag and press Enter" });
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && tagInput.value.trim()) {
        e.preventDefault();
        tags.push(tagInput.value.trim()); tagInput.value = ""; paintTags();
      }
    });

    let bgChoice = it.background || null;
    const bgRow = h("div", { style: "display:flex;gap:8px;align-items:center;" });
    function paintBg() {
      bgRow.innerHTML = "";
      bgRow.appendChild(h("span", { class: "sub" }, bgChoice ? "Custom background set" : "No custom background"));
      const chooseBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Choose from vault\u2026");
      chooseBtn.addEventListener("click", async () => {
        const choice = await vaultImagePickerModal();
        if (choice) { bgChoice = choice; paintBg(); }
      });
      bgRow.appendChild(chooseBtn);
      if (bgChoice) {
        const clearBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Remove");
        clearBtn.addEventListener("click", () => { bgChoice = null; paintBg(); });
        bgRow.appendChild(clearBtn);
      }
    }
    if (isFolder) paintBg();

    // Custom Empty States (folder only): message + optional image shown
    // instead of the generic "This is empty" when this folder has nothing
    // in it (or nothing matching the current search).
    const emptyMsgInput = h("input", { type: "text", placeholder: "e.g. \u201CNothing here yet \u2014 add your first receipt\u201D", value: (it.metadata && it.metadata.empty_state && it.metadata.empty_state.message) || "" });
    let emptyImgChoice = (it.metadata && it.metadata.empty_state && it.metadata.empty_state.image) || null;
    const emptyImgRow = h("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px;" });
    function paintEmptyImg() {
      emptyImgRow.innerHTML = "";
      emptyImgRow.appendChild(h("span", { class: "sub" }, emptyImgChoice ? "Custom image set" : "No custom image"));
      const chooseBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Choose from vault\u2026");
      chooseBtn.addEventListener("click", async () => {
        const choice = await vaultImagePickerModal();
        if (choice) { emptyImgChoice = choice; paintEmptyImg(); }
      });
      emptyImgRow.appendChild(chooseBtn);
      if (emptyImgChoice) {
        const clearBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Remove");
        clearBtn.addEventListener("click", () => { emptyImgChoice = null; paintEmptyImg(); });
        emptyImgRow.appendChild(clearBtn);
      }
    }
    if (isFolder) paintEmptyImg();

    // Folder Appearance Profiles / Layout Presets
    const profiles = getProfiles();
    let pendingProfile = null; // deferred until Save, same as every other field here
    const profileSelect = h("select", {},
      h("option", { value: "" }, "\u2014 Choose a saved profile \u2014"),
      ...profiles.map(p => h("option", { value: p.name }, p.name))
    );
    const applyProfileBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Apply");
    applyProfileBtn.addEventListener("click", () => {
      const p = profiles.find(pr => pr.name === profileSelect.value);
      if (!p) return;
      color = p.color || null; icon = p.icon || null; paintColorRow(); paintIconRow();
      if (isFolder) { bgChoice = p.background || null; paintBg(); }
      pendingProfile = p;
      toast(`Applied "${p.name}" \u2014 click Save to keep it`, "success");
    });
    const profileNameInput = h("input", { type: "text", placeholder: "Profile name" });
    const saveProfileBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Save current as profile");
    saveProfileBtn.addEventListener("click", async () => {
      const name = profileNameInput.value.trim();
      if (!name) return toast("Name the profile first", "error");
      const sort = currentSort();
      await saveProfile({ name, color, icon, background: isFolder ? bgChoice : null, sort, viewMode: state.viewMode });
      toast(`Saved profile "${name}"`, "success");
      profileNameInput.value = "";
    });
    const profilesRow = isFolder ? h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;" },
      profileSelect, applyProfileBtn, profileNameInput, saveProfileBtn
    ) : null;

    // Cover style: this is a GLOBAL setting (Phase 4), not per-folder — the
    // exact same pref/function as the Settings > Folders card, just
    // surfaced here for convenience. Changing it here changes it everywhere.
    const currentCoverStyle = prefGet("vault", "layout", { folder_cover_style: "classic" }).folder_cover_style || "classic";
    const coverStyleSelect = h("select", {},
      ...[{ v: "classic", label: "Classic" }, { v: "poster", label: "Poster" }, { v: "glass", label: "Glass" }]
        .map(o => h("option", { value: o.v, selected: o.v === currentCoverStyle }, o.label))
    );
    coverStyleSelect.addEventListener("change", async () => {
      const layout = prefGet("vault", "layout", { folder_cover_style: "classic" });
      await prefSet("vault", "layout", { ...layout, folder_cover_style: coverStyleSelect.value });
      renderContentInPlace();
    });

    // Thumbnail actions — same functions the tile's action menu already
    // calls, just reachable from here too. No new thumbnail logic.
    // Files don't get a thumbnail action here (or on the tile menu) — a
    // file's tile always just shows its own real, uncropped frame, so
    // there's nothing to set. Folders can still have a thumbnail chosen
    // (from inside the folder, from anywhere in the vault, from the
    // folder's own background, or auto-composited as a collage) — each
    // one keeps that source image's own real aspect ratio, no cropping.
    const thumbBtns = isFolder ? h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;" },
      (() => { const b = h("button", { class: "btn btn-ghost btn-sm" }, "Choose thumb\u2026"); b.addEventListener("click", () => chooseFolderThumbFromVault(it)); return b; })(),
      (() => { const b = h("button", { class: "btn btn-ghost btn-sm" }, "Collage thumb"); b.addEventListener("click", () => generateFolderCollage(it)); return b; })(),
      (() => { const b = h("button", { class: "btn btn-ghost btn-sm" }, "Use background as thumb"); b.addEventListener("click", () => useFolderBackgroundAsThumb(it)); return b; })(),
    ) : null;

    // ── Organization tab extras: favorite/pin toggles + sort mode ─────────
    const favBox = h("input", { type: "checkbox" });
    favBox.checked = !!it.favorite;
    favBox.addEventListener("change", async () => { await toggleFavorite(it); favBox.checked = !!it.favorite; });
    const pinBox = h("input", { type: "checkbox" });
    pinBox.checked = !!it.pinned;
    pinBox.disabled = !insideAFolder;
    pinBox.addEventListener("change", async () => { await togglePinned(it); pinBox.checked = !!it.pinned; });

    // Sort mode acts on THIS folder's own key (keyForFolder(t.vid,t.rel)),
    // not the ambient folderKey() of wherever the modal happened to be
    // opened from — matters when customizing a folder tile from its
    // parent's view, before you've navigated into it.
    const identityFolderKey = isFolder ? keyForFolder(t.vid, t.rel) : null;
    const identitySort = isFolder ? prefGet("vault", `sort:${identityFolderKey}`, DEFAULT_SORT) : null;
    const sortModeSelect = isFolder ? h("select", {},
      ...SORT_OPTIONS.map(o => h("option", { value: o.mode, selected: o.mode === identitySort.mode }, o.label))
    ) : null;
    if (isFolder) sortModeSelect.addEventListener("change", async () => {
      await prefSet("vault", `sort:${identityFolderKey}`, { mode: sortModeSelect.value, dir: identitySort.dir || "asc" });
      if (identityFolderKey === folderKey()) renderContentInPlace(); // only re-render live if we're actually inside it right now
    });

    // ── Information tab: read-only, live-fetched, folders only (files
    // already show their size/type/date in the grid itself) ──────────────
    const infoBody = h("div", {}, h("div", { class: "sub" }, "Loading\u2026"));
    if (isFolder) {
      api.folder_stats(t.vid, t.rel || null).then(res => {
        infoBody.innerHTML = "";
        if (!res.ok) { infoBody.appendChild(h("div", { class: "sub" }, res.error || "Stats unavailable")); return; }
        const s = res.stats;
        infoBody.appendChild(h("div", { class: "identity-info-row" }, h("span", {}, "Files"), h("b", {}, s.file_count)));
        infoBody.appendChild(h("div", { class: "identity-info-row" }, h("span", {}, "Sub-folders"), h("b", {}, s.folder_count)));
        infoBody.appendChild(h("div", { class: "identity-info-row" }, h("span", {}, "Total size"), h("b", {}, s.size_h)));
        if (it.locked_at) infoBody.appendChild(h("div", { class: "identity-info-row" }, h("span", {}, "Added"), h("b", {}, it.time_ago || it.locked_at)));
      });
    }

    // ── tabs ────────────────────────────────────────────────────────────
    const tabNames = isFolder
      ? [["appearance", "Appearance"], ["organization", "Organization"], ["interaction", "Interaction"], ["information", "Information"]]
      : [["appearance", "Appearance"], ["organization", "Organization"]]; // files have no folder-only sections
    let activeTab = "appearance";
    const tabsBar = h("div", { class: "identity-tabs" });
    const sections = {};

    function paintTabs() {
      tabsBar.innerHTML = "";
      tabNames.forEach(([key, label]) => {
        const tab = h("div", { class: `identity-tab ${activeTab === key ? "active" : ""}` }, label);
        tab.addEventListener("click", () => { activeTab = key; paintTabs(); Object.entries(sections).forEach(([k, el]) => el.classList.toggle("active", k === activeTab)); });
        tabsBar.appendChild(tab);
      });
    }
    paintTabs();

    sections.appearance = h("div", { class: "identity-section active" },
      isFolder ? h("div", { class: "customize-section-label" }, "Appearance profile") : null,
      profilesRow,
      h("div", { class: "customize-section-label" }, "Icon"), iconRow,
      h("div", { class: "customize-section-label" }, "Accent color"), colorRow,
      isFolder ? h("div", { class: "customize-section-label" }, "Folder background") : null,
      isFolder ? bgRow : null,
      (isFolder || isMediaFile) ? h("div", { class: "customize-section-label" }, "Thumbnail") : null,
      thumbBtns,
      isFolder ? h("div", { class: "customize-section-label" }, "Cover style (applies to all folders)") : null,
      isFolder ? coverStyleSelect : null,
      isFolder ? h("div", { class: "customize-section-label" }, "Custom empty message") : null,
      isFolder ? emptyMsgInput : null,
      isFolder ? emptyImgRow : null,
    );
    sections.organization = h("div", { class: "identity-section" },
      h("div", { class: "customize-section-label" }, "Display name"), displayNameInput,
      h("div", { class: "customize-section-label" }, "Description / notes"), descInput,
      h("div", { class: "customize-section-label" }, "Tags"), tagsWrap, tagInput,
      h("div", { class: "customize-section-label" }, "Category"), categoryInput,
      h("div", { class: "customize-section-label" }, "Favorites & pinning"),
      h("div", { class: "settings-row" }, h("div", {}, h("div", { class: "label" }, "Favorite"), h("div", { class: "sub" }, "Shows up in the Favorites view")), favBox),
      h("div", { class: "settings-row" }, h("div", {}, h("div", { class: "label" }, "Pin to top"), h("div", { class: "sub" }, insideAFolder ? (isAlbumItem(it) ? "Keeps this above the rest of your albums" : "Keeps this above the rest of this folder") : "Only applies while browsing inside a folder")), pinBox),
      isFolder ? h("div", { class: "customize-section-label" }, "Sort mode for this folder") : null,
      isFolder ? sortModeSelect : null,
    );
    if (isFolder) {
      sections.interaction = h("div", { class: "identity-section" }, renderRulesEditor(t.vid, t.rel));
      sections.information = h("div", { class: "identity-section" }, infoBody);
    }

    const box = h("div", { class: "modal customize-modal identity-modal" },
      h("h3", {}, `${isFolder ? "Folder" : "File"} identity: "${it.name}"`),
      tabsBar,
      sections.appearance, sections.organization, sections.interaction, sections.information,
      h("div", { class: "row" },
        h("button", { class: "btn btn-ghost", onclick: () => close() }, "Cancel"),
        h("button", { class: "btn btn-primary", onclick: save }, "Save"),
      )
    );
    async function save() {
      const updates = {
        color, icon, tags,
        display_name: displayNameInput.value.trim() || null,
        description: descInput.value.trim() || null,
        metadata: { ...meta, category: categoryInput.value.trim() || undefined },
      };
      if (isFolder) {
        updates.background = bgChoice;
        const msg = emptyMsgInput.value.trim();
        updates.metadata.empty_state = (msg || emptyImgChoice) ? { message: msg || null, image: emptyImgChoice } : undefined;
      }
      Object.keys(updates.metadata).forEach(k => updates.metadata[k] === undefined && delete updates.metadata[k]);
      const res = await api.set_item_meta(t.vid, updates, t.rel || null);
      if (res.ok && isFolder && pendingProfile) {
        await applyProfileToFolder(pendingProfile, t.vid, t.rel);
      }
      close();
      if (res.ok) {
        Object.assign(it, updates);
        toast("Updated", "success");
        renderContentInPlace();
      } else {
        toast(res.error || "Couldn't save changes", "error");
      }
    }
    backdrop.appendChild(box);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    host.appendChild(backdrop);
    function close() { backdrop.remove(); }
  }

  function moveTargetModal(itemName, folders) {
    return new Promise((resolve) => {
      const host = document.getElementById("modal-host");
      const backdrop = h("div", { class: "modal-backdrop" });
      const select = h("select", {
        style: "width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:16px;outline:none;background:var(--panel);color:var(--text);"
      });
      folders.forEach(f => select.appendChild(
        h("option", { value: JSON.stringify({ vid: f.vid, rel: f.rel }) }, f.label)
      ));
      const box = h("div", { class: "modal" },
        h("h3", {}, `Move / Copy "${itemName}"`),
        h("p", {}, "Choose a destination inside your vault."),
        select,
        h("div", { class: "row" },
          h("button", { class: "btn btn-ghost", onclick: () => { close(); resolve(null); } }, "Cancel"),
          h("button", {
            class: "btn btn-secondary",
            onclick: () => { const d = JSON.parse(select.value); close(); resolve({ ...d, copy: true }); }
          }, "Copy here"),
          h("button", {
            class: "btn btn-primary",
            onclick: () => { const d = JSON.parse(select.value); close(); resolve({ ...d, copy: false }); }
          }, "Move here"),
        )
      );
      backdrop.appendChild(box);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { close(); resolve(null); } });
      host.appendChild(backdrop);
      function close() { backdrop.remove(); }
    });
  }

  function scanFolderModal(folders) {
    return new Promise((resolve) => {
      const host = document.getElementById("modal-host");
      const backdrop = h("div", { class: "modal-backdrop" });
      const select = h("select", {
        style: "width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;outline:none;background:var(--panel);color:var(--text);"
      });
      folders.forEach(f => select.appendChild(
        h("option", { value: JSON.stringify({ vid: f.vid, rel: f.rel }) }, f.label)
      ));
      const scanBtn = h("button", { class: "btn btn-primary" }, "\u{1F50D} Scan");
      const strictCheck = h("input", { type: "checkbox", id: "scan-strict-check" });
      const strictRow = h("label", {
        for: "scan-strict-check",
        style: "display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:12.5px;color:var(--text-muted,inherit);cursor:pointer;line-height:1.4;"
      }, strictCheck, h("span", {},
        "Stricter matching \u2014 turn this on if scans have been mixing different people into one group. Fewer mismatches, but the same person may occasionally end up split across two groups."));
      const box = h("div", { class: "modal" },
        h("h3", {}, "Scan for faces"),
        h("p", {}, "Pick a vault folder to scan \u2014 keeping it to one folder at a time is faster and keeps matches more accurate than scanning everything at once. Pick \u201CEntire Vault\u201D to scan everywhere. Results land in this Face Group folder only."),
        select,
        strictRow,
        h("div", { class: "row", style: "margin-top:16px;" },
          h("button", { class: "btn btn-ghost", onclick: () => { close(); resolve(null); } }, "Cancel"),
          scanBtn,
        )
      );
      scanBtn.addEventListener("click", () => {
        const threshold = strictCheck.checked ? 0.45 : null;
        const d = JSON.parse(select.value);
        close();
        resolve({ ...d, threshold });
      });
      backdrop.appendChild(box);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { close(); resolve(null); } });
      host.appendChild(backdrop);
      function close() { backdrop.remove(); }
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Icons (inline, no external assets)
  // ────────────────────────────────────────────────────────────────────────
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    check: "\u2713",
  };

  // ────────────────────────────────────────────────────────────────────────
  // Bootstrap
  // ────────────────────────────────────────────────────────────────────────
  // Surface unexpected JS errors instead of a silent blank window — makes
  // real bugs visible instead of looking like the app "isn't working".
  window.addEventListener("error", (e) => {
    console.error(e.error || e.message);
    if (state.screen === "app") toast(`Unexpected error: ${e.message}`, "error");
  });

  // Custom Keyboard Shortcuts — each action's combo is user-configurable in
  // Settings (falls back to DEFAULT_SHORTCUTS). Quick-hide is master-only
  // (the decoy vault has nothing sensitive to hide); the rest apply to both.
  function normalizeCombo(e) {
    const parts = [];
    if (e.ctrlKey) parts.push("ctrl");
    if (e.shiftKey) parts.push("shift");
    if (e.altKey) parts.push("alt");
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    if (!["control", "shift", "alt", "meta"].includes(key)) parts.push(key);
    return parts.join("+");
  }
  function shortcutCombo(action) {
    const custom = prefGet("shortcuts", action, null);
    return (custom || (DEFAULT_SHORTCUTS[action] && DEFAULT_SHORTCUTS[action].keys) || "").toLowerCase();
  }
  document.addEventListener("keydown", (e) => {
    if (state.screen !== "app" || state.covered) return;
    // Never hijack normal typing — a modal input, rename field, search box,
    // etc. always wins over a single-key custom shortcut colliding with it.
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
    const combo = normalizeCombo(e);
    if (!combo) return;
    if (!state.isDecoy && combo === shortcutCombo("quick_hide")) {
      if (state.covered) return;
      state.covered = true; render(); return;
    }
    if (combo === shortcutCombo("toggle_select")) {
      e.preventDefault();
      state.selectMode = !state.selectMode; if (!state.selectMode) state.selected.clear(); render(); return;
    }
    if (combo === shortcutCombo("focus_search")) {
      e.preventDefault();
      const el = document.querySelector(".search-box input"); if (el) el.focus(); return;
    }
    if (combo === shortcutCombo("new_folder")) { e.preventDefault(); onNewFolder(); return; }
    if (combo === shortcutCombo("add_file")) { e.preventDefault(); onAddFile(); return; }
    if (combo === shortcutCombo("toggle_view")) {
      e.preventDefault();
      state.viewMode = state.viewMode === "grid" ? "list" : "grid"; render(); return;
    }
    if (combo === shortcutCombo("go_back") && state.path.length > 0) {
      e.preventDefault();
      state.path = state.path.slice(0, -1); loadCurrentView().then(render); return;
    }
  });

  // Fades out and removes the launch-animation overlay defined in
  // index.html (see #boot-splash there). Purely decorative/DOM-only — it
  // holds no app state and touches nothing else, so a failure here (e.g.
  // the element already gone) can never affect the real screen underneath.
  const BOOT_SPLASH_MIN_MS = 1900; // let the lock animation actually finish, even on a fast/local backend
  const _bootSplashStartedAt = Date.now();
  function dismissBootSplash() {
    const el = document.getElementById("boot-splash");
    if (!el) return;
    const wait = Math.max(0, BOOT_SPLASH_MIN_MS - (Date.now() - _bootSplashStartedAt));
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
    }, wait);
  }

  let booted = false;
  onReady(async () => {
    if (booted) return;
    booted = true;
    try {
      api = window.pywebview.api;
      const info = await api.app_info();
      mediaPort = info.media_port;
      state.hasVault = await api.has_vault();
      // The home/login/setup screens intentionally stay plain — a vault's
      // background is only ever shown once you've actually logged into it.
      state.screen = "home";
      render();
      dismissBootSplash();
    } catch (err) {
      mount(h("div", { class: "auth-wrap" }, h("div", { class: "auth-card" },
        h("h1", { class: "auth-title" }, "Couldn't start VaultLock"),
        h("p", { class: "auth-sub" }, String(err && err.message || err)),
      )));
      dismissBootSplash();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Render dispatcher
  // ────────────────────────────────────────────────────────────────────────
  let _coverTimer = null;
  // Identifies "which content area is this" for the scroll-preservation
  // check below — the view name, plus the current folder when the view is
  // path-based (gallery browsing). Two renders share this key only when
  // they're redrawing the SAME listing, not when the person actually
  // navigated somewhere new.
  function _renderContentContext() {
    if (state.screen !== "app") return null;
    if (state.view === "albumDetail") return `albumDetail::${state.currentAlbum ? state.currentAlbum.vid : ""}`;
    if (state.view === "faceGroupContainer") return `faceGroupContainer::${state.currentFaceGroupContainer ? state.currentFaceGroupContainer.vid : ""}`;
    return state.view === "gallery" || (state.view !== "settings" && state.view !== "privacy" && state.view !== "help")
      ? `${state.view}::${state.view === "gallery" ? folderKey() : ""}`
      : state.view;
  }
  let _lastRenderContext = null;
  function render() {
    // A full render() is called for lots of things that are NOT navigation
    // — toggling multi-select, sorting, pinning, renaming, bulk actions,
    // the "Select" button, etc. Previously every one of those silently
    // reset the content area's scroll back to the top, which is especially
    // painful mid multi-select: pick a file near the bottom of a long
    // folder and the whole list would jump back to the top, forcing a
    // rescroll to reach the next file. This restores the scroll position
    // whenever the redraw is for the same view/folder as before, so only
    // an actual navigation (opening a different folder, switching views)
    // starts at the top. This is independent of the persisted "remember
    // folder state" privacy setting, which only governs restoring position
    // across app restarts — this is just in-session continuity.
    const prevWrap = document.getElementById("content-area");
    const prevScroll = prevWrap ? prevWrap.scrollTop : 0;
    const sameContext = prevWrap && _lastRenderContext !== null && _lastRenderContext === _renderContentContext();

    if (!(state.screen === "app" && state.covered) && _coverTimer) {
      clearInterval(_coverTimer); _coverTimer = null;
    }
    if (state.screen === "app" && state.covered) { mount(renderCoverOverlay()); return; }
    if (state.screen === "home") mount(renderHome());
    else if (state.screen === "setup") mount(renderSetup());
    else if (state.screen === "login") mount(renderLogin());
    else if (state.screen === "app") {
      const appEl = renderApp();
      if (state.privacyScreenOn) appEl.appendChild(renderPrivacyScreenOverlay());
      if (state.entering) {
        mount(h("div", { class: "vault-enter-host" }, appEl, renderVaultEnterAnimation()));
      } else {
        mount(appEl);
      }
    }
    _lastRenderContext = _renderContentContext();
    if (sameContext && prevScroll > 0) {
      const wrap = document.getElementById("content-area");
      if (wrap) {
        wrap.scrollTop = prevScroll;
        // Belt-and-suspenders: some webview engines haven't finished
        // layout yet at this exact point, so the assignment above can be a
        // no-op if scrollHeight isn't settled — one more pass next frame.
        requestAnimationFrame(() => { wrap.scrollTop = prevScroll; });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRIVACY SCREEN — instantly frosts the window when it loses focus (e.g.
  // Alt-Tab, a screen-share starting), reusing the quick-hide cover's fade
  // animation as its base. Unlike quick-hide, this needs no password: it's
  // for a glance away, not a real hide, so it just clears the moment the
  // window is focused again.
  // ════════════════════════════════════════════════════════════════════════
  function renderPrivacyScreenOverlay() {
    return h("div", { class: "privacy-screen-overlay screen-fade" },
      h("div", { class: "privacy-screen-icon" }, "\u{1F512}"),
      h("div", { class: "privacy-screen-text" }, "VaultLock"),
    );
  }
  window.addEventListener("blur", () => {
    if (state.screen !== "app" || state.covered) return;
    const pv = prefGet("vault", "privacy", DEFAULT_PRIVACY);
    if (!pv.privacy_screen_enabled) return;
    state.privacyScreenOn = true;
    render();
  });
  window.addEventListener("focus", () => {
    if (state.privacyScreenOn) { state.privacyScreenOn = false; render(); }
  });

  // ════════════════════════════════════════════════════════════════════════
  // HOME SCREEN — the very first thing you see; just branding + a way in.
  // ════════════════════════════════════════════════════════════════════════
  function renderHome() {
    const wrap = h("div", { class: "auth-wrap screen-fade" });
    const btn = h("button", { class: "btn btn-primary btn-block home-cta" },
      state.hasVault ? "Log In" : "Get Started");
    btn.addEventListener("click", () => {
      state.screen = state.hasVault ? "login" : "setup";
      render();
    });
    const card = h("div", { class: "auth-card home-card" },
      h("div", { class: "auth-logo home-logo" }, "\u{1F512}"),
      h("h1", { class: "auth-title" }, "VaultLock"),
      h("p", { class: "auth-sub" }, "Your private, premium photo & file vault"),
      h("p", { class: "home-tagline" },
        state.hasVault
          ? "Your vault is set up on this device. Log in to continue."
          : "Nothing is stored or synced anywhere else \u2014 just this device, encrypted end to end."),
      btn
    );
    wrap.appendChild(card);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // VAULT-OPENING ANIMATION — plays once right after a successful login,
  // over the top of the already-loaded app, then the doors slide away.
  // The doors themselves show that account's own background (master and
  // decoy can each have a different one), split across the two halves so
  // it reads as one continuous image/gradient behind the closed doors.
  // ════════════════════════════════════════════════════════════════════════
  function doorBackgroundCss() {
    const prefs = state.uiPrefs;
    if (!prefs || prefs.type === "default") return null;
    if (prefs.type === "gradient") {
      const g = GRADIENTS.find(x => x.id === prefs.gradient_id) || GRADIENTS[0];
      return { image: g.css };
    }
    if (prefs.type === "image" && (prefs.url || prefs.image_name)) {
      const url = prefs.url || mediaUrl(`/bg/${prefs.image_name}`);
      return { image: `url('${url}')` };
    }
    if (prefs.type === "dynamic" && prefs.url) {
      return { image: `url('${prefs.url}')` };
    }
    return null;
  }

  function renderVaultEnterAnimation() {
    const overlay = h("div", { class: "vault-enter-overlay" });
    const doorL = h("div", { class: "vault-enter-door left" });
    const doorR = h("div", { class: "vault-enter-door right" });

    const bg = doorBackgroundCss();
    if (bg) {
      [doorL, doorR].forEach(d => {
        d.style.backgroundImage = bg.image;
        d.style.backgroundSize = "200% 100%";
        d.style.backgroundRepeat = "no-repeat";
        d.classList.add("has-bg");
      });
      doorL.style.backgroundPosition = "left center";
      doorR.style.backgroundPosition = "right center";
    }

    const lock = h("div", { class: "vault-enter-lock" }, "\u{1F512}");
    const ring = h("div", { class: "vault-enter-ring" });
    const text = h("div", { class: "vault-enter-text" }, "Unlocking your vault\u2026");
    const center = h("div", { class: "vault-enter-center" }, ring, lock, text);
    overlay.appendChild(doorL);
    overlay.appendChild(doorR);
    overlay.appendChild(center);

    setTimeout(() => {
      lock.textContent = "\u{1F513}";
      lock.classList.add("pop");
      text.textContent = "Welcome back";
    }, 550);
    setTimeout(() => { overlay.classList.add("opening"); }, 900);
    setTimeout(() => { state.entering = false; render(); }, 1650);

    return overlay;
  }

  // ════════════════════════════════════════════════════════════════════════
  // QUICK-HIDE COVER — instantly hides the window behind an innocuous
  // disguise screen. Only reachable from the master account. Re-entering
  // the master password is required to dismiss it, regardless of mode.
  // ════════════════════════════════════════════════════════════════════════
  function renderCoverOverlay() {
    const mode = prefGet("vault", "quick_hide", DEFAULT_QUICK_HIDE).mode;
    if (mode === "update") return renderCoverUpdate();
    if (mode === "browser") return renderCoverBrowser();
    return renderCoverClock();
  }

  // Shared unlock affordance used by every disguise: a click/tap reveals a
  // password field; Enter (or the button) tries it.
  function coverUnlockWidgets(onWrongPassword) {
    const err = h("div", { class: "cover-err" });
    const pwInput = h("input", { type: "password", class: "cover-pw hidden", placeholder: "Password" });
    async function tryUnlock() {
      const res = await api.verify_master_password(pwInput.value);
      if (res.ok) { state.covered = false; render(); }
      else { err.textContent = "Incorrect password"; pwInput.value = ""; if (onWrongPassword) onWrongPassword(); }
    }
    pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
    pwInput.addEventListener("click", (e) => e.stopPropagation());
    return { err, pwInput, tryUnlock };
  }

  function renderCoverClock() {
    const wrap = h("div", { class: "cover-overlay screen-fade" });
    const tick = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const clock = h("div", { class: "cover-clock" }, tick());
    const date = h("div", { class: "cover-date" },
      new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
    const hint = h("div", { class: "cover-hint" }, "Click to unlock");
    const { err, pwInput } = coverUnlockWidgets();

    wrap.addEventListener("click", () => {
      if (!pwInput.classList.contains("hidden")) return;
      pwInput.classList.remove("hidden");
      hint.classList.add("hidden");
      setTimeout(() => pwInput.focus(), 30);
    });

    if (_coverTimer) clearInterval(_coverTimer);
    _coverTimer = setInterval(() => { clock.textContent = tick(); }, 15000);

    wrap.appendChild(clock);
    wrap.appendChild(date);
    wrap.appendChild(hint);
    wrap.appendChild(pwInput);
    wrap.appendChild(err);
    return wrap;
  }

  // Disguise #2: a fake "installing updates" screen — the password field
  // hides behind a small, easy-to-miss "Cancel update" link, consistent
  // with how a real update screen buries its cancel option.
  function renderCoverUpdate() {
    const wrap = h("div", { class: "cover-overlay cover-update screen-fade" });
    const pct = h("div", { class: "cover-update-pct" }, "37%");
    const bar = h("div", { class: "cover-update-bar" }, h("div", { class: "cover-update-fill" }));
    const { err, pwInput } = coverUnlockWidgets();
    const link = h("div", { class: "cover-update-link" }, "Cancel update");
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      pwInput.classList.remove("hidden");
      setTimeout(() => pwInput.focus(), 30);
    });
    let p = 37;
    if (_coverTimer) clearInterval(_coverTimer);
    _coverTimer = setInterval(() => {
      p = p >= 96 ? 41 : p + 1; // creeps forward, resets before completing — never actually finishes
      pct.textContent = `${p}%`;
      bar.querySelector(".cover-update-fill").style.width = `${p}%`;
    }, 700);
    wrap.appendChild(h("div", { class: "cover-update-logo" }, "\u2699\uFE0F"));
    wrap.appendChild(h("div", { class: "cover-update-title" }, "Working on updates"));
    wrap.appendChild(h("div", { class: "cover-update-sub" }, "Your device will restart automatically. Keep it plugged in."));
    wrap.appendChild(pct);
    wrap.appendChild(bar);
    wrap.appendChild(link);
    wrap.appendChild(pwInput);
    wrap.appendChild(err);
    return wrap;
  }

  // Disguise #3: a fake "connection not found" browser error page — the
  // password field is hidden behind a normal-looking "Try again" button.
  function renderCoverBrowser() {
    const wrap = h("div", { class: "cover-overlay cover-browser screen-fade" });
    const { err, pwInput } = coverUnlockWidgets();
    const retryBtn = h("button", { class: "cover-browser-retry" }, "Try again");
    retryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pwInput.classList.remove("hidden");
      setTimeout(() => pwInput.focus(), 30);
    });
    if (_coverTimer) { clearInterval(_coverTimer); _coverTimer = null; }
    wrap.appendChild(h("div", { class: "cover-browser-icon" }, "\u{1F310}"));
    wrap.appendChild(h("div", { class: "cover-browser-title" }, "This site can\u2019t be reached"));
    wrap.appendChild(h("div", { class: "cover-browser-sub" }, "Check your internet connection and try again. ERR_CONNECTION_TIMED_OUT"));
    wrap.appendChild(retryBtn);
    wrap.appendChild(pwInput);
    wrap.appendChild(err);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // SETUP SCREEN
  // ════════════════════════════════════════════════════════════════════════
  function pwField(id, labelText, hint, opts) {
    opts = opts || {};
    const input = h("input", { type: "password", id, placeholder: opts.placeholder || "" });
    const toggle = h("button", { class: "pw-toggle", type: "button", onclick: () => {
      input.type = input.type === "password" ? "text" : "password";
      toggle.textContent = input.type === "password" ? "\u{1F441}" : "\u{1F576}";
    } }, "\u{1F441}");
    const wrap = h("div", { class: "field" },
      h("label", {}, labelText, hint ? h("span", { class: "field-hint" }, hint) : null),
      h("div", { class: "pw-row" }, input, toggle)
    );
    wrap._input = input;
    return wrap;
  }

  function renderSetup() {
    const wrap = h("div", { class: "auth-wrap screen-fade" });
    const errBox = h("div", { class: "auth-err" });

    const fMaster = pwField("su-master", "Master Password");
    const fConfirm = pwField("su-confirm", "Confirm Password");
    const fDecoy = pwField("su-decoy", "Decoy Password", "optional");
    const fNuke = pwField("su-nuke", "Nuke Password", "optional");

    let chosenLocation = null; // null = use the default location
    const locPathEl = h("div", { style: "font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" }, "Loading\u2026");
    const locFreeEl = h("div", { style: "font-size:11px;color:var(--text-3);margin-top:1px;" }, "");
    const locBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Choose\u2026");
    locBtn.addEventListener("click", async () => {
      const picked = await api.choose_location();
      if (!picked) return;
      chosenLocation = picked.path;
      locPathEl.textContent = picked.path;
      locFreeEl.textContent = `${picked.free_h} free on this drive`;
    });
    const locRow = h("div", {
      style: "display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--card-2);border-radius:10px;padding:10px 12px;margin:6px 0 22px;"
    }, h("div", { style: "min-width:0;" }, locPathEl, locFreeEl), locBtn);
    api.default_location_info().then(info => {
      locPathEl.textContent = info.path;
      locFreeEl.textContent = `${info.free_h} free on this drive`;
    });

    const createBtn = h("button", { class: "btn btn-primary btn-block" }, "Create Vault");
    createBtn.addEventListener("click", async () => {
      errBox.classList.remove("show");
      const master = fMaster._input.value, confirm = fConfirm._input.value;
      const decoy = fDecoy._input.value, nuke = fNuke._input.value;
      if (master.length < 4) return showErr("Master password must be at least 4 characters.");
      if (master !== confirm) return showErr("Passwords do not match.");
      createBtn.disabled = true;
      const res = await api.create_vault(master, decoy, nuke, chosenLocation);
      createBtn.disabled = false;
      if (!res.ok) return showErr(res.error);
      toast("Vault created", "success");
      state.hasVault = true;
      state.screen = "login";
      render();
    });
    function showErr(msg) { errBox.textContent = msg; errBox.classList.add("show"); }

    const card = h("div", { class: "auth-card" },
      h("div", { class: "auth-logo" }, "\u{1F512}"),
      h("h1", { class: "auth-title" }, "VaultLock"),
      h("p", { class: "auth-sub" }, "Your private, premium photo & file vault"),
      errBox,
      fMaster, fConfirm, fDecoy, fNuke,
      h("div", { class: "field" },
        h("label", {}, "Storage location", h("span", { class: "field-hint" }, "any drive or folder")),
        locRow
      ),
      h("div", { class: "auth-info" },
        h("div", {}, "\u{1F511} ", h("b", {}, "Master"), " \u2192 opens your real vault"),
        h("div", {}, "\u{1F9AC} ", h("b", {}, "Decoy"), " \u2192 opens a separate, empty-looking vault"),
        h("div", { class: "danger-line" }, "\u{1F4A3} ", h("b", {}, "Nuke"), " \u2192 wipes your main vault silently on login"),
      ),
      createBtn
    );
    wrap.appendChild(card);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ════════════════════════════════════════════════════════════════════════
  function renderLogin() {
    const wrap = h("div", { class: "auth-wrap screen-fade" });
    const errBox = h("div", { class: "auth-err" });
    const fPw = pwField("lg-pw", "Password");
    fPw._input.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

    const btn = h("button", { class: "btn btn-primary btn-block" }, "Unlock Vault");
    btn.addEventListener("click", doLogin);

    async function doLogin() {
      errBox.classList.remove("show");
      const pw = fPw._input.value;
      if (!pw) return;
      btn.disabled = true;
      try {
        const res = await api.login(pw);
        btn.disabled = false;
        if (res.status === "ok") {
          state.screen = "app"; state.path = []; state.view = "gallery";
          state.isDecoy = !!res.decoy; state.covered = false;
          mediaToken = res.token || "";
          state.justEntered = !state.isDecoy; // master starts blank; decoy shows normally
          const prefs = await api.get_ui_prefs(); // this account's own background
          applyBackground(prefs);
          const bundle = await api.get_prefs_bundle();
          state.prefs = bundle.ok ? bundle.prefs : { application: {}, vault: {}, viewer: {}, shortcuts: {} };
          const landing = prefGet("vault", "workflow", DEFAULT_WORKFLOW).default_landing;
          state.view = (landing === "settings" || landing === "dashboard") ? landing : "gallery";
          await restoreLastFolderState(); // opt-in — no-op unless the person turned it on
          await loadCurrentView();
          if (state.view === "dashboard") await loadDashboard();
          state.entering = true;
          armAutoLock();
          render();
        } else if (res.status === "locked") {
          const mins = Math.ceil(res.retry_after_seconds / 60);
          errBox.textContent = `Too many attempts. Try again in ${res.retry_after_seconds < 60 ? res.retry_after_seconds + "s" : mins + " min"}.`;
          errBox.classList.add("show");
          fPw._input.value = "";
        } else {
          errBox.textContent = "Incorrect password"; errBox.classList.add("show");
          fPw._input.value = ""; fPw._input.focus();
        }
      } catch (e) {
        btn.disabled = false;
        errBox.textContent = "Error: " + (e && e.message ? e.message : e);
        errBox.classList.add("show");
      }
    }

    const card = h("div", { class: "auth-card" },
      h("div", { class: "auth-logo" }, "\u{1F510}"),
      h("h1", { class: "auth-title" }, "Welcome back"),
      h("p", { class: "auth-sub" }, "Enter your password to continue"),
      errBox, fPw, btn
    );
    wrap.appendChild(card);
    setTimeout(() => fPw._input.focus(), 50);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // APP SHELL
  // ════════════════════════════════════════════════════════════════════════
  async function toggleFavorite(it, e) {
    if (e) e.stopPropagation();
    const t = effectiveTarget(it);
    const next = !it.favorite;
    const res = await api.set_item_meta(t.vid, { favorite: next }, t.rel || null);
    if (res.ok) {
      it.favorite = next;
      toast(next ? `Added "${it.name}" to Favorites` : `Removed "${it.name}" from Favorites`, "success");
      if (state.view === "favorites") { await loadFavorites(); }
      renderContentInPlace();
    } else {
      toast(res.error || "Couldn't update favorite", "error");
    }
  }
  // True for any root item flagged as an album (see the ALBUMS section
  // below) — used in a handful of places where an album needs to behave
  // a little differently from an ordinary folder (pinning applies to it
  // even though it lives at vault root; thumbnail pickers pull from its
  // collected members instead of a physical subtree, which is always
  // empty for an album).
  function isAlbumItem(it) {
    return !!(it && it.is_dir && it.metadata && it.metadata.is_album);
  }

  async function togglePinned(it, e) {
    if (e) e.stopPropagation();
    // Pinning normally only makes sense "inside a folder view" (floating
    // an item to the top of its siblings) — root items have no such
    // listing of their own to float within, EXCEPT albums, which get
    // their own always-visible listing (the Albums screen) that pin-to-
    // top applies to just the same.
    if (state.path.length === 0 && !isAlbumItem(it)) return;
    const t = effectiveTarget(it);
    const next = !it.pinned;
    const res = await api.set_item_meta(t.vid, { pinned: next }, t.rel || null);
    if (res.ok) { it.pinned = next; render(); }
    else toast(res.error || "Couldn't update pin", "error");
  }

  async function loadFavorites() {
    const res = await api.list_favorites();
    state.favoritesItems = res.ok ? res.items : [];
  }
  async function loadRecent() {
    const res = await api.list_recent(12);
    state.recentItems = res.ok ? res.items : [];
  }
  async function loadDashboard() {
    await Promise.all([loadFavorites(), loadRecent()]);
    state.stats = await api.get_stats();
  }

  // ════════════════════════════════════════════════════════════════════════
  // "YOUR TEXT" — a collection of freeform text cards (title + body), living
  // below Favorites in the sidebar. Not a text FILE in the vault — just bits
  // of plain text (notes, links, names, anything) stored alongside the rest
  // of this vault identity's preferences, so master and decoy each get their
  // own set and it survives closing/reopening the app. Each card gets its
  // own accent color (cycled from NOTE_COLORS) used for its header/buttons
  // (dark) and its body background (a light tint of the same color).
  // ════════════════════════════════════════════════════════════════════════
  const NOTE_COLORS = ["#3D5AFE", "#E1293D", "#1FAE63", "#EDA53A", "#8E2DE2", "#0EA5E9", "#EC4899", "#14B8A6", "#F97316", "#6366F1"];
  function notesUid() { return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function shadeHex(hex, amt) {
    // amt > 0 lightens (mixes toward white), amt < 0 darkens (mixes toward black)
    const c = hex.replace("#", "");
    const num = parseInt(c, 16);
    let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= (1 + amt); g *= (1 + amt); b *= (1 + amt); }
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  }
  // Converts a hue (0-360) picked off the gradient bar into a hex color,
  // fixed saturation/lightness so every pick lands somewhere vivid and
  // legible rather than washed out or near-black.
  function hslToHex(hue, sat, light) {
    const s = sat / 100, l = light / 100;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return "#" + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  }
  async function loadNotes() {
    let list = prefGet("vault", "notes_list", null);
    if (!list) {
      // One-time migration from the old single-scratchpad feature, if it has content.
      const legacy = prefGet("vault", "keep_notes", "");
      const now = Date.now();
      list = legacy ? [{ id: notesUid(), title: "Untitled", text: legacy, color: NOTE_COLORS[0], createdAt: now, updatedAt: now }] : [];
      await prefSet("vault", "notes_list", list);
    }
    // Backfill createdAt/updatedAt for lists saved before sorting existed,
    // preserving their existing (newest-first) order as the fallback timestamps.
    let needsSave = false;
    list.forEach((note, i) => {
      if (!note.createdAt) { note.createdAt = Date.now() - i * 1000; needsSave = true; }
      if (!note.updatedAt) { note.updatedAt = note.createdAt; needsSave = true; }
    });
    if (needsSave) await prefSet("vault", "notes_list", list);
    state.notesList = list;
    state.notesSelected = new Set();
    if (!state.notesSort) state.notesSort = { mode: "created", dir: "desc" };
  }
  async function saveNotesList() { await prefSet("vault", "notes_list", state.notesList); }
  function getSortedNotes() {
    const list = state.notesList.slice();
    const { mode, dir } = state.notesSort;
    list.sort((a, b) => {
      const cmp = mode === "name"
        ? (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" })
        : (a.createdAt || 0) - (b.createdAt || 0);
      return dir === "asc" ? cmp : -cmp;
    });
    return list;
  }
  function setNotesSort(mode) {
    if (state.notesSort.mode === mode) state.notesSort.dir = state.notesSort.dir === "asc" ? "desc" : "asc";
    else { state.notesSort.mode = mode; state.notesSort.dir = mode === "name" ? "asc" : "desc"; }
    render();
  }

  // ─── Color picker: a big preview circle + a full-spectrum gradient bar
  // (click/drag to pick any hue) plus a row of quick preset swatches. ───
  function buildColorPicker(initialColor) {
    let current = initialColor || NOTE_COLORS[0];
    const preview = h("div", { class: "color-preview-circle", style: `background:${current};` });
    const handle = h("div", { class: "color-gradient-handle" });
    const gradientBar = h("div", { class: "color-gradient-bar" }, handle);
    const swatchWrap = h("div", { class: "color-swatches" });
    function markActiveSwatch() {
      swatchWrap.querySelectorAll(".color-swatch").forEach(el => {
        el.classList.toggle("active", el.getAttribute("data-color").toLowerCase() === current.toLowerCase());
      });
    }
    function setColor(hex, huePct) {
      current = hex;
      preview.style.background = hex;
      if (huePct !== undefined) handle.style.left = `${huePct}%`;
      markActiveSwatch();
    }
    function pickFromEvent(clientX) {
      const rect = gradientBar.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      const pct = (x / rect.width) * 100;
      setColor(hslToHex(pct * 3.6, 82, 55), pct);
    }
    let dragging = false;
    const onMove = (e) => { if (dragging) pickFromEvent(e.clientX); };
    const onUp = () => { dragging = false; };
    gradientBar.addEventListener("mousedown", (e) => { dragging = true; pickFromEvent(e.clientX); });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    NOTE_COLORS.forEach(c => {
      const sw = h("div", {
        class: "color-swatch", style: `background:${c};`, "data-color": c, title: c,
        onclick: () => setColor(c)
      });
      swatchWrap.appendChild(sw);
    });
    markActiveSwatch();
    const wrap = h("div", { class: "color-picker-wrap" },
      h("div", { class: "color-picker-top" }, preview, gradientBar),
      swatchWrap
    );
    return {
      el: wrap, getColor: () => current,
      destroy: () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }
    };
  }

  function notesEditModal(existing, suggestedColor) {
    return new Promise((resolve) => {
      const host = document.getElementById("modal-host");
      const backdrop = h("div", { class: "modal-backdrop" });
      const titleInput = h("input", {
        type: "text", placeholder: "Title",
        style: "width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;outline:none;background:var(--panel);color:var(--text);box-sizing:border-box;"
      });
      if (existing) titleInput.value = existing.title || "";
      const textInput = h("textarea", {
        placeholder: "Write anything here\u2026",
        style: "width:100%;min-height:160px;resize:vertical;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.6;outline:none;background:var(--panel);color:var(--text);font-family:var(--font);margin-top:10px;box-sizing:border-box;"
      });
      textInput.value = existing ? (existing.text || "") : "";
      const colorPicker = buildColorPicker(existing ? existing.color : suggestedColor);
      const errBox = h("div", { style: "font-size:12px;color:var(--danger);margin-top:6px;min-height:0;" });
      const box = h("div", { class: "modal" },
        h("h3", {}, existing ? "Edit Text" : "Add Text"),
        h("p", {}, "Give it a short title and write anything below \u2014 stored encrypted with the rest of this vault identity."),
        titleInput, textInput,
        h("div", { class: "customize-section-label" }, "Color"),
        colorPicker.el,
        errBox,
        h("div", { class: "row", style: "margin-top:16px;" },
          h("button", { class: "btn btn-ghost", onclick: () => { close(); resolve(null); } }, "Cancel"),
          h("button", {
            class: "btn btn-primary", onclick: () => {
              const title = titleInput.value.trim();
              const text = textInput.value;
              if (!title && !text.trim()) { errBox.textContent = "Add a title or some text first."; titleInput.focus(); return; }
              close(); resolve({ title: title || "Untitled", text, color: colorPicker.getColor() });
            }
          }, existing ? "Save" : "Add")
        )
      );
      backdrop.appendChild(box);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { close(); resolve(null); } });
      host.appendChild(backdrop);
      setTimeout(() => titleInput.focus(), 30);
      function close() { colorPicker.destroy(); backdrop.remove(); }
    });
  }

  async function onAddNote() {
    const suggested = NOTE_COLORS[state.notesList.length % NOTE_COLORS.length];
    const res = await notesEditModal(null, suggested);
    if (!res) return;
    const now = Date.now();
    state.notesList.unshift({ id: notesUid(), title: res.title, text: res.text, color: res.color, createdAt: now, updatedAt: now });
    await saveNotesList();
    toast("Text added", "success");
    render();
  }
  async function onEditNote(note) {
    const res = await notesEditModal(note, note.color);
    if (!res) return;
    note.title = res.title;
    note.text = res.text;
    note.color = res.color;
    note.updatedAt = Date.now();
    await saveNotesList();
    toast("Saved", "success");
    render();
  }
  async function onDeleteNote(note) {
    const yes = await confirmDanger("Delete this text?", `\u201C${esc(note.title || "Untitled")}\u201D will be permanently removed. This cannot be undone.`, "Delete");
    if (!yes) return;
    state.notesList = state.notesList.filter(n => n.id !== note.id);
    state.notesSelected.delete(note.id);
    await saveNotesList();
    render();
  }
  function onToggleNoteSelect(note) {
    if (state.notesSelected.has(note.id)) state.notesSelected.delete(note.id);
    else state.notesSelected.add(note.id);
    render();
  }
  async function onDeleteSelectedNotes() {
    const n = state.notesSelected.size;
    if (!n) return;
    const yes = await confirmDanger(`Delete ${n} text${n === 1 ? "" : "s"}?`, "This cannot be undone.", "Delete");
    if (!yes) return;
    state.notesList = state.notesList.filter(x => !state.notesSelected.has(x.id));
    state.notesSelected.clear();
    await saveNotesList();
    render();
  }

  function noteDateLabel(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  async function onCopyNoteText(note) {
    try {
      await navigator.clipboard.writeText(note.text || "");
      toast("Text copied", "success");
    } catch (e) {
      toast("Couldn't copy \u2014 try selecting the text manually", "error");
    }
  }

  function renderNoteCard(note) {
    const color = note.color || NOTE_COLORS[0];
    const dark = shadeHex(color, -0.35);   // buttons / header — dark shade of the note's color
    const light = shadeHex(color, 0.88);   // text box — light tint of the *same* color
    const selected = state.notesSelected.has(note.id);
    const copyBtn = h("button", {
      class: "note-btn", style: `--nb:${dark};`, title: "Copy text",
      onclick: () => onCopyNoteText(note)
    }, "\u{1F4CB}");
    const selBtn = h("button", {
      class: "note-btn", style: `--nb:${dark};`, title: selected ? "Deselect" : "Select",
      onclick: () => onToggleNoteSelect(note)
    }, selected ? "\u2611\uFE0F" : "\u2610\uFE0F");
    const editBtn = h("button", {
      class: "note-btn", style: `--nb:${dark};`, title: "Edit",
      onclick: () => onEditNote(note)
    }, "\u270F\uFE0F");
    const delBtn = h("button", {
      class: "note-btn", style: `--nb:${dark};`, title: "Delete",
      onclick: () => onDeleteNote(note)
    }, "\u{1F5D1}\uFE0F");
    const header = h("div", { class: "note-card-hdr", style: `background:${dark};` },
      h("div", { class: "note-card-title-wrap" },
        h("div", { class: "note-card-title" }, note.title || "Untitled"),
        h("div", { class: "note-card-date" }, noteDateLabel(note.createdAt)),
      ),
      h("div", { class: "note-card-actions" }, copyBtn, selBtn, editBtn, delBtn)
    );
    const body = h("div", { class: "note-card-body", style: `background:${light};` },
      note.text
        ? h("div", { class: "note-card-text" }, note.text)
        : h("div", { class: "note-card-text note-card-empty" }, "(empty)")
    );
    return h("div", { class: `note-card${selected ? " selected" : ""}`, style: `border-color:${color};` }, header, body);
  }

  function renderNotesSortControl() {
    const mkBtn = (mode, label) => {
      const active = state.notesSort.mode === mode;
      return h("button", {
        class: `sort-pill ${active ? "active" : ""}`,
        onclick: () => setNotesSort(mode)
      }, label, active ? h("span", { class: "sort-arrow" }, state.notesSort.dir === "asc" ? "\u2191" : "\u2193") : null);
    };
    return h("div", { class: "sort-pills" },
      h("span", { class: "sort-pills-label" }, "Sort:"),
      mkBtn("created", "Date"), mkBtn("name", "Name")
    );
  }

  function renderNotesContent() {
    const wrap = h("div", { class: "content notes-view", id: "content-area" });
    if (!state.notesList.length) {
      wrap.appendChild(h("div", { class: "notes-empty" },
        h("div", { class: "notes-empty-ico" }, "\u{1F4DD}"),
        h("div", { class: "notes-empty-title" }, "No text yet"),
        h("div", { class: "notes-empty-sub" }, "Tap \u201C\uFF0B Add Text\u201D above to create your first one."),
      ));
      return wrap;
    }
    const list = h("div", { class: "notes-list" });
    getSortedNotes().forEach(note => list.appendChild(renderNoteCard(note)));
    wrap.appendChild(list);
    if (state.notesSelected.size) {
      wrap.appendChild(h("div", { class: "notes-bulkbar" },
        h("div", { class: "notes-bulkbar-count" }, `${state.notesSelected.size} selected`),
        h("div", { class: "row" },
          h("button", { class: "btn btn-ghost btn-sm", onclick: () => { state.notesSelected.clear(); render(); } }, "Cancel"),
          h("button", { class: "btn btn-danger btn-sm", onclick: onDeleteSelectedNotes }, "\u{1F5D1} Delete selected"),
        )
      ));
    }
    return wrap;
  }

  // Rebuilds a navigable path chain from a favorite/recent item's
  // (vid, rel, breadcrumb) so clicking it — wherever it lives in the
  // vault — lands you in the right folder, unlike normal browsing which
  // only ever moves one level at a time.
  async function openWalkResultItem(it) {
    if (it.rel === null) {
      if (it.is_dir) {
        state.view = "gallery"; state.path = [{ vid: it.vid, rel: "", name: it.name }];
        await loadCurrentView(); render();
      } else {
        api.record_opened(it.vid, null);
        if (it.cat === "image" || it.cat === "video") openLightbox([it], 0);
        else await api.open_with_system(it.vid, null);
      }
      return;
    }
    const tokens = it.rel.split("/");
    const names = it.path_breadcrumb ? it.path_breadcrumb.split(" / ") : [];
    const rootItems = await api.list_root();
    const rootEntry = rootItems.find(r => r.vid === it.vid);
    const path = [{ vid: it.vid, rel: "", name: rootEntry ? rootEntry.name : (names[0] || it.vid) }];
    let relSoFar = "";
    const folderTokenCount = it.is_dir ? tokens.length : tokens.length - 1;
    for (let idx = 0; idx < folderTokenCount; idx++) {
      relSoFar = relSoFar ? `${relSoFar}/${tokens[idx]}` : tokens[idx];
      // `names` is [rootName, ancestor1, ancestor2, ...] — names[0] is the
      // root we already placed above, so this loop's ancestors start at
      // names[idx + 1], not names[idx]. When the favorited/recent item
      // IS itself a folder, the final segment represents that folder —
      // use its own real name directly rather than the ancestor array,
      // which by construction never includes the item's own name.
      const isSelf = it.is_dir && idx === folderTokenCount - 1;
      const segName = isSelf ? it.name : (names[idx + 1] || tokens[idx]);
      path.push({ vid: it.vid, rel: relSoFar, name: segName });
    }
    state.view = "gallery"; state.path = path;
    await loadCurrentView(); render();
    if (!it.is_dir) {
      const match = state.items.find(i => i.rel === it.rel);
      if (match) openItem(match, state.items.indexOf(match), state.items);
    }
  }

  function buildFavoriteTile(it) {
    // Any tile with a real thumbnail image (file or folder) flows at that
    // image's own aspect ratio; only icon-fallback tiles stay square.
    const freeAspect = !!it.thumb_url;
    const thumbBox = h("div", { class: "tile-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: versionedThumbUrl(it), loading: "lazy" });
      img.addEventListener("error", () => {
        img.remove();
        thumbBox.classList.add("tile-thumb-fallback");
        thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir)));
      });
      thumbBox.appendChild(img);
    } else {
      thumbBox.classList.add("tile-thumb-fallback");
      thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir)));
    }
    const scrim = h("div", { class: "tile-scrim" },
      h("div", { class: "tile-name" }, it.display_name || it.name),
      h("div", { class: "tile-meta" }, it.path_breadcrumb ? `\u{1F4C1} ${it.path_breadcrumb}` : "In your vault")
    );
    const badges = h("div", { class: "tile-badges" });
    if (it.cat === "video") badges.appendChild(h("div", { class: "badge-play" }, h("div", { class: "circle", html: ICON.play })));
    if (it.is_dir) badges.appendChild(h("div", { class: "badge-folder" }, "\u{1F4C1}"));
    const starBtn = h("button", { class: "tile-fav-btn active", title: "Remove from Favorites" }, "\u2605");
    starBtn.addEventListener("click", (e) => toggleFavorite(it, e).then(() => { starBtn.closest(".tile").remove(); }));
    const tile = h("div", { class: `tile ${freeAspect ? "masonry-tile" : ""}`, style: it.color ? `--accent-color:${it.color};` : "" }, thumbBox, scrim, badges, starBtn);
    if (it.color) tile.classList.add("has-accent");
    tile.addEventListener("click", () => openWalkResultItem(it));
    return tile;
  }

  // ════════════════════════════════════════════════════════════════════════
  // ALBUMS — a named, hand-picked way to group things from anywhere in the
  // vault. An album is still, under the hood, an ordinary organizational
  // folder (metadata.is_album = true) purely so it has a name/id/cover —
  // but it never holds real file data itself. Membership is a pure
  // reference: adding an item to an album just appends the album's vid to
  // that item's own `album_ids` list (mirrors how `favorite` is a flag
  // living on the item, not a copy of it). So collecting something into an
  // album never moves, copies, or re-uploads it, and the same file can sit
  // in as many albums as you like without ever leaving its real folder.
  // Nothing can be uploaded directly into an album \u2014 only files already
  // sitting somewhere in the vault can be added, via the vault picker.
  // ════════════════════════════════════════════════════════════════════════
  function promptAlbumName() {
    return modal({
      title: "New album",
      body: "Creates a named collection you build by picking files already in your vault \u2014 nothing is uploaded and nothing is added automatically.",
      input: { placeholder: "Album name, e.g. \u201CSummer Trip\u201D" },
      buttons: [
        { label: "Cancel", value: false, variant: "btn-ghost" },
        { label: "Create Album", value: true, variant: "btn-primary" },
      ]
    });
  }

  async function onNewAlbum() {
    const name = await promptAlbumName();
    if (!name) return;
    const res = await api.create_folder(name);
    if (!res.ok) { toast(res.result || "Couldn't create album", "error"); return; }
    const vid = res.result;
    const metaRes = await api.set_item_meta(vid, { metadata: { is_album: true } });
    if (!metaRes.ok) { toast(metaRes.error || "Couldn't mark this as an album", "error"); return; }
    toast(`Album "${name}" created`, "success");
    // Jump straight into the new (empty) album so files can be picked right away.
    await openAlbumById(vid, name);
  }

  async function loadAlbums() {
    const items = await api.list_root();
    state.albumsItems = items.filter(it => it.is_dir && it.metadata && it.metadata.is_album);
  }

  async function removeFromAlbums(it) {
    const meta = { ...(it.metadata || {}) };
    delete meta.is_album;
    const res = await api.set_item_meta(it.vid, { metadata: meta });
    if (res.ok) {
      // The album folder is un-flagged, but member items would otherwise
      // keep carrying a dangling reference to it forever \u2014 clear those too.
      await api.clear_album_membership(it.vid);
      toast(`Removed "${it.name}" from Albums \u2014 nothing inside it was touched`, "success");
      await loadAlbums();
      render();
    } else {
      toast(res.error || "Couldn't update this album", "error");
    }
  }

  function buildAlbumTile(it) {
    const freeAspect = !!it.thumb_url; // same rule as regular folders — real image aspect ratio when there is one
    const thumbBox = h("div", { class: "tile-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: versionedThumbUrl(it), loading: "lazy" });
      img.addEventListener("error", () => { img.remove(); thumbBox.appendChild(h("div", { class: "icon-fallback" }, it.icon || "\u{1F39E}\uFE0F")); });
      thumbBox.appendChild(img);
    } else {
      thumbBox.appendChild(h("div", { class: "icon-fallback" }, it.icon || "\u{1F39E}\uFE0F"));
    }
    const countLine = h("div", { class: "tile-meta" }, "Loading\u2026");
    api.list_album_items(it.vid).then(res => {
      if (!res.ok) { countLine.textContent = "Album"; return; }
      const n = res.items.length;
      countLine.textContent = `${n} item${n === 1 ? "" : "s"} collected`;
    });
    const scrim = h("div", { class: "tile-scrim" },
      h("div", { class: "tile-name" }, it.display_name || it.name),
      countLine
    );
    const badges = h("div", { class: "tile-badges" }, h("div", { class: "badge-folder" }, "\u{1F39E}\uFE0F"));
    if (it.pinned) badges.appendChild(h("div", { class: "badge-pin" }, "\u{1F4CC}"));

    // Same "⋯ opens a popover of every action" pattern as a regular folder
    // tile (see buildTile) \u2014 an album IS a real folder under the hood
    // (just flagged is_album), so it gets the same management actions:
    // pin, customize, rename, thumbnail options, delete. Move/Copy and
    // Restore-to are deliberately left out: moving an album out of the
    // vault root would make it vanish from this Albums screen (it's only
    // ever listed here from a root-level scan) while still technically
    // existing as a stray flagged folder elsewhere \u2014 a confusing state
    // for what's supposed to be a simple, flat list of collections. The
    // original quick "\u2716 Remove from Albums" (soft \u2014 un-flags but
    // keeps the folder, member files untouched) sits right alongside the
    // \u22EF menu button rather than as its own separate corner button, so
    // it doesn't visually stack on top of it.
    const actionDefs = [
      { icon: it.pinned ? "\u{1F4CC}" : "\u{1F4CD}", label: it.pinned ? "Unpin" : "Pin", fn: () => togglePinned(it) },
      { icon: "\u{1F3A8}", label: "Customize", fn: () => openCustomizeModal(it) },
      { icon: "\u270F\uFE0F", label: "Rename", fn: () => renameOne(it) },
      { icon: "\u{1F5BC}\uFE0F", label: "Use background", title: "Use this album's custom background as its thumbnail", fn: () => useFolderBackgroundAsThumb(it) },
      { icon: "\u{1F5C2}\uFE0F", label: "Choose thumb", title: "Pick any photo or video from your vault as this album's thumbnail", fn: () => chooseFolderThumbFromVault(it) },
      { icon: "\u{1F9E9}", label: "Collage thumb", title: "Auto-generate a thumbnail collage from this album's collected photos", fn: () => generateFolderCollage(it) },
      { icon: "\u{1F5D1}", label: "Delete album", title: "Permanently delete this album (member files themselves are never touched)", fn: () => deleteOne(it), danger: true },
    ];

    const actions = h("div", { class: "tile-hover-actions" });
    const popover = h("div", { class: "tile-actions-popover" });
    let menuBtn = null;
    function closeMenu() {
      popover.classList.remove("open");
      tile.classList.remove("menu-open");
      if (menuBtn) menuBtn.classList.remove("active");
      document.removeEventListener("keydown", onEscKey, true);
      document.removeEventListener("click", onDocClick, true);
      if (activeTileMenuClose === closeMenu) activeTileMenuClose = null;
    }
    function onEscKey(e) { if (e.key === "Escape") closeMenu(); }
    function onDocClick(e) { if (!tile.contains(e.target)) closeMenu(); }
    function toggleMenu() {
      const wasOpen = popover.classList.contains("open");
      if (activeTileMenuClose) activeTileMenuClose();
      if (wasOpen) return;
      popover.classList.add("open");
      tile.classList.add("menu-open");
      if (menuBtn) menuBtn.classList.add("active");
      activeTileMenuClose = closeMenu;
      document.addEventListener("keydown", onEscKey, true);
      document.addEventListener("click", onDocClick, true);
    }
    actionDefs.forEach((a) => {
      const pb = h("button", { class: `tile-popover-btn ${a.danger ? "danger" : ""}`, title: a.title || a.label },
        h("span", { class: "ic" }, a.icon), h("span", { class: "lb" }, a.label)
      );
      pb.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); a.fn(); });
      popover.appendChild(pb);
    });
    popover.addEventListener("click", (e) => { e.stopPropagation(); if (e.target === popover) closeMenu(); });

    const removeBtn = actBtn("\u2716", "Remove from Albums \u2014 soft, keeps the album folder", () => removeFromAlbums(it));
    actions.appendChild(removeBtn);
    menuBtn = actBtn("\u22EF", "More actions", toggleMenu);
    menuBtn.classList.add("tile-menu-btn");
    actions.appendChild(menuBtn);

    const tile = h("div", { class: `tile ${freeAspect ? "masonry-tile" : ""} ${it.color ? "has-accent" : ""}`, style: it.color ? `--accent-color:${it.color};` : "" },
      thumbBox, scrim, badges, actions, popover
    );
    tile.addEventListener("click", async () => { await openAlbumById(it.vid, it.display_name || it.name); });
    return tile;
  }

  function renderAlbumsContent() {
    const wrap = h("div", { class: "content", id: "content-area" });
    if (!state.albumsItems || !state.albumsItems.length) {
      const createBtn = h("button", { class: "btn btn-premium", style: "margin-top:14px;" }, "\uFF0B Create your first album");
      createBtn.addEventListener("click", onNewAlbum);
      wrap.appendChild(h("div", { class: "empty-state" },
        h("div", { class: "empty-badge" }, "\u{1F39E}\uFE0F"),
        h("h3", {}, "No albums yet"),
        h("p", {}, "Albums are a hand-picked way to group things \u2014 pick files already in your vault to collect them here, just like Favorites."),
        createBtn
      ));
      return wrap;
    }
    wrap.appendChild(h("div", { class: "section-hdr" },
      h("h2", {}, "Albums"), h("span", { class: "section-count" }, state.albumsItems.length), h("div", { class: "section-line" })
    ));
    const grid = h("div", { class: "grid" });
    const albumTiles = applyPinnedFirst(state.albumsItems).map(it => buildAlbumTile(it));
    albumTiles.forEach(t => grid.appendChild(t));
    applyMasonryLayout(grid, albumTiles);
    wrap.appendChild(grid);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // FACE GROUPS — two levels deep:
  //   1. Face Group Containers (this dashboard) — plain folders, each one
  //      an isolated "batch." Created empty; a scan run from inside one
  //      only ever creates/updates that container's own Person N groups.
  //   2. Person N groups (inside a container) — mechanically albums
  //      (metadata.is_album = true, so every existing album action —
  //      pin, customize, rename, choose/collage thumbnail, delete —
  //      works unchanged), auto-populated by the scan instead of hand-
  //      picking files, tagged metadata.face_group_container so matching
  //      never crosses into another container's groups.
  // Nothing is ever moved, copied, or re-uploaded to build a group — a
  // match just routes that photo's reference into the group, exactly
  // like adding something to an Album; the real file never leaves the
  // folder it's actually locked in.
  // ════════════════════════════════════════════════════════════════════════
  async function loadFaceGroupContainers() {
    const items = await api.list_face_group_containers();
    state.faceGroupContainers = items || [];
  }

  async function loadContainerFaceGroups() {
    if (!state.currentFaceGroupContainer) return;
    const items = await api.list_face_groups(state.currentFaceGroupContainer.vid);
    state.containerFaceGroupItems = items || [];
  }

  async function openFaceGroupContainer(vid, name) {
    state.view = "faceGroupContainer";
    state.currentFaceGroupContainer = { vid, name };
    await loadContainerFaceGroups();
    render();
  }

  async function backToFaceGroupContainers() {
    state.view = "faceGroups";
    state.currentFaceGroupContainer = null;
    await loadFaceGroupContainers();
    render();
  }

  async function handleScanFaces() {
    if (state.faceScanRunning || !state.currentFaceGroupContainer) return;
    const containerVid = state.currentFaceGroupContainer.vid;
    const folders = await api.list_face_scan_targets();
    if (!folders || !folders.length) { toast("No folders to scan yet", "info"); return; }
    const scope = await scanFolderModal(folders);
    if (!scope) return;
    const start = await api.start_face_scan(scope.vid, scope.rel, scope.threshold || null, containerVid);
    if (!start.ok) { toast(start.error || "Couldn't start the face scan", "error"); return; }
    state.faceScanRunning = true;
    render();
    const prog = buildProgressUI(start.job_id);
    const { close } = gtCloseableModal(h("div", { class: "modal-body" },
      h("h3", {}, "Scanning for faces\u2026"),
      h("p", {}, "Looking through the photos there and grouping the same face together."),
      prog.wrap
    ));
    const job = await pollJob(start.job_id, prog.update);
    close();
    state.faceScanRunning = false;
    if (job.status === "done") {
      const r = job.result || {};
      const n = (r.groups_created || 0) + (r.groups_updated || 0);
      toast(n ? `Found ${n} face group${n === 1 ? "" : "s"} across ${r.photos_scanned || 0} photo(s)`
              : `No repeated faces found across ${r.photos_scanned || 0} photo(s)`,
            n ? "success" : "info");
      if (state.view === "albumDetail" && state.currentAlbum && state.currentAlbum.origin === "faceGroups") {
        await loadAlbumDetail();
      } else if (state.view === "faceGroupContainer" && state.currentFaceGroupContainer &&
                 state.currentFaceGroupContainer.vid === containerVid) {
        await loadContainerFaceGroups();
      }
    } else if (job.status === "cancelled") {
      toast("Face scan cancelled", "info");
    } else {
      toast(job.error || "Face scan failed", "error");
    }
    render();
  }

  // Spins up a fresh, empty Face Group folder on the top-level dashboard.
  // Nothing lives in it until a scan is run from inside it — see
  // openFaceGroupContainer / handleScanFaces.
  async function handleNewFaceGroupContainer() {
    const name = await promptFolderName();
    if (!name) return;
    const res = await api.create_face_group_container(name);
    if (res.ok) {
      await loadFaceGroupContainers();
      render();
    } else {
      toast(res.result || "Couldn't create that folder", "error");
    }
  }

  async function handleDeleteAllFaceGroupContainers() {
    if (!state.faceGroupContainers || !state.faceGroupContainers.length) return;
    const n = state.faceGroupContainers.length;
    const yes = await confirmDanger(
      `Delete all ${n} folder${n === 1 ? "" : "s"}?`,
      "This permanently deletes every Face Group folder, along with every Person group inside each one. Every real photo they referenced is untouched \u2014 nothing is deleted except the auto-generated groups and folders themselves. This cannot be undone.",
      "Delete All"
    );
    if (!yes) return;
    const res = await api.delete_all_face_group_containers();
    if (res.ok) {
      toast(`Deleted ${res.deleted} folder${res.deleted === 1 ? "" : "s"}`, "success");
    } else {
      toast((res.errors && res.errors[0]) || res.error || "Some folders couldn't be deleted", "error");
    }
    await loadFaceGroupContainers();
    render();
  }

  async function handleDeleteAllFaceGroups() {
    if (!state.containerFaceGroupItems || !state.containerFaceGroupItems.length || !state.currentFaceGroupContainer) return;
    const n = state.containerFaceGroupItems.length;
    const yes = await confirmDanger(
      `Delete all ${n} face group${n === 1 ? "" : "s"}?`,
      "This permanently deletes every Person group in this folder. Every real photo they referenced is untouched \u2014 nothing is deleted except the auto-generated groups themselves. You can rebuild them anytime with \u201C\u{1F50D} Scan for faces.\u201D This cannot be undone.",
      "Delete All"
    );
    if (!yes) return;
    const res = await api.delete_all_face_groups(state.currentFaceGroupContainer.vid);
    if (res.ok) {
      toast(`Deleted ${res.deleted} face group${res.deleted === 1 ? "" : "s"}`, "success");
    } else {
      toast((res.errors && res.errors[0]) || res.error || "Some groups couldn't be deleted", "error");
    }
    await loadContainerFaceGroups();
    render();
  }

  // A Face Group Container tile on the top-level dashboard.
  function buildFaceGroupContainerTile(it) {
    const thumbBox = h("div", { class: "tile-thumb" }, h("div", { class: "icon-fallback" }, "\u{1F5C2}\uFE0F"));
    const countLine = h("div", { class: "tile-meta" }, "");
    const scrim = h("div", { class: "tile-scrim" }, h("div", { class: "tile-name" }, it.name), countLine);
    const tile = h("div", { class: "tile" }, thumbBox, scrim);
    tile.addEventListener("click", () => openFaceGroupContainer(it.vid, it.name));
    return tile;
  }

  function buildFaceGroupTile(it) {
    const thumbBox = h("div", { class: "tile-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: versionedThumbUrl(it), loading: "lazy" });
      img.addEventListener("error", () => { img.remove(); thumbBox.appendChild(h("div", { class: "icon-fallback" }, "\u{1F642}")); });
      thumbBox.appendChild(img);
    } else {
      thumbBox.appendChild(h("div", { class: "icon-fallback" }, "\u{1F642}"));
    }
    const countLine = h("div", { class: "tile-meta" }, "Loading\u2026");
    api.list_album_items(it.vid).then(res => {
      if (!res.ok) { countLine.textContent = "Face group"; return; }
      const n = res.items.length;
      countLine.textContent = `${n} photo${n === 1 ? "" : "s"}`;
    });
    const scrim = h("div", { class: "tile-scrim" },
      h("div", { class: "tile-name" }, it.display_name || it.name),
      countLine
    );
    const badges = h("div", { class: "tile-badges" }, h("div", { class: "badge-folder" }, "\u{1F642}"));
    if (it.pinned) badges.appendChild(h("div", { class: "badge-pin" }, "\u{1F4CC}"));

    // Same management actions as an album tile (see buildAlbumTile) —
    // a face group IS a real folder under the hood, just auto-populated.
    const actionDefs = [
      { icon: it.pinned ? "\u{1F4CC}" : "\u{1F4CD}", label: it.pinned ? "Unpin" : "Pin", fn: () => togglePinned(it) },
      { icon: "\u{1F3A8}", label: "Customize", fn: () => openCustomizeModal(it) },
      { icon: "\u270F\uFE0F", label: "Rename", fn: () => renameOne(it) },
      { icon: "\u{1F5BC}\uFE0F", label: "Use background", title: "Use this group's custom background as its thumbnail", fn: () => useFolderBackgroundAsThumb(it) },
      { icon: "\u{1F5C2}\uFE0F", label: "Choose thumb", title: "Pick any photo or video from your vault as this group's thumbnail", fn: () => chooseFolderThumbFromVault(it) },
      { icon: "\u{1F9E9}", label: "Collage thumb", title: "Auto-generate a thumbnail collage from this group's photos", fn: () => generateFolderCollage(it) },
      { icon: "\u{1F5D1}", label: "Delete group", title: "Permanently delete this group (the photos themselves are never touched)", fn: () => deleteOne(it), danger: true },
    ];

    const actions = h("div", { class: "tile-hover-actions" });
    const popover = h("div", { class: "tile-actions-popover" });
    let menuBtn = null;
    function closeMenu() {
      popover.classList.remove("open");
      tile.classList.remove("menu-open");
      if (menuBtn) menuBtn.classList.remove("active");
      document.removeEventListener("keydown", onEscKey, true);
      document.removeEventListener("click", onDocClick, true);
      if (activeTileMenuClose === closeMenu) activeTileMenuClose = null;
    }
    function onEscKey(e) { if (e.key === "Escape") closeMenu(); }
    function onDocClick(e) { if (!tile.contains(e.target)) closeMenu(); }
    function toggleMenu() {
      const wasOpen = popover.classList.contains("open");
      if (activeTileMenuClose) activeTileMenuClose();
      if (wasOpen) return;
      popover.classList.add("open");
      tile.classList.add("menu-open");
      if (menuBtn) menuBtn.classList.add("active");
      activeTileMenuClose = closeMenu;
      document.addEventListener("keydown", onEscKey, true);
      document.addEventListener("click", onDocClick, true);
    }
    actionDefs.forEach((a) => {
      const pb = h("button", { class: `tile-popover-btn ${a.danger ? "danger" : ""}`, title: a.title || a.label },
        h("span", { class: "ic" }, a.icon), h("span", { class: "lb" }, a.label)
      );
      pb.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); a.fn(); });
      popover.appendChild(pb);
    });
    popover.addEventListener("click", (e) => { e.stopPropagation(); if (e.target === popover) closeMenu(); });

    menuBtn = actBtn("\u22EF", "More actions", toggleMenu);
    menuBtn.classList.add("tile-menu-btn");
    actions.appendChild(menuBtn);

    const tile = h("div", { class: `tile ${it.color ? "has-accent" : ""}`, style: it.color ? `--accent-color:${it.color};` : "" },
      thumbBox, scrim, badges, actions, popover
    );
    tile.addEventListener("click", async () => {
      await openAlbumById(it.vid, it.display_name || it.name, "faceGroups", state.currentFaceGroupContainer);
    });
    return tile;
  }

  // Top-level Face Groups dashboard — lists Face Group Containers only.
  function renderFaceGroupsContent() {
    const wrap = h("div", { class: "content", id: "content-area" });
    if (!state.faceGroupContainers || !state.faceGroupContainers.length) {
      const newFolderBtn = h("button", { class: "btn btn-primary", style: "margin-top:14px;" }, "\u{1F5C2}\uFE0F Create Folder");
      newFolderBtn.addEventListener("click", handleNewFaceGroupContainer);
      wrap.appendChild(h("div", { class: "empty-state" },
        h("div", { class: "empty-badge" }, "\u{1F642}"),
        h("h3", {}, "No face groups yet"),
        h("p", {}, "Create a folder, open it, and scan a vault folder from inside \u2014 every photo of the same person gets routed together into its own group there. Each folder you create here is its own isolated batch, so one scan's results never mix with another's. Nothing is moved, copied, or re-uploaded; each photo just stays exactly where it already lives."),
        newFolderBtn
      ));
      return wrap;
    }
    wrap.appendChild(h("div", { class: "section-hdr" },
      h("h2", {}, "Folders"), h("span", { class: "section-count" }, state.faceGroupContainers.length), h("div", { class: "section-line" })
    ));
    const grid = h("div", { class: "grid" });
    state.faceGroupContainers.forEach(it => grid.appendChild(buildFaceGroupContainerTile(it)));
    wrap.appendChild(grid);
    return wrap;
  }

  // Inside one Face Group Container — its own mini dashboard: empty state
  // with a center Scan button, or the grid of Person N groups that scan
  // has produced so far.
  function renderFaceGroupContainerContent() {
    const wrap = h("div", { class: "content", id: "content-area" });
    if (!state.containerFaceGroupItems || !state.containerFaceGroupItems.length) {
      const scanBtn = h("button", { class: "btn btn-primary", style: "margin-top:14px;", disabled: state.faceScanRunning },
        state.faceScanRunning ? "Scanning\u2026" : "\u{1F50D} Scan for faces");
      scanBtn.addEventListener("click", handleScanFaces);
      wrap.appendChild(h("div", { class: "empty-state" },
        h("div", { class: "empty-badge" }, "\u{1F5C2}\uFE0F"),
        h("h3", {}, "This folder is empty"),
        h("p", {}, "Scan a folder from your vault \u2014 every photo of the same person found there gets routed into its own group, right here. This folder's results stay isolated from every other Face Group folder."),
        scanBtn
      ));
      return wrap;
    }
    wrap.appendChild(h("div", { class: "section-hdr" },
      h("h2", {}, "Face Groups"), h("span", { class: "section-count" }, state.containerFaceGroupItems.length), h("div", { class: "section-line" })
    ));
    const grid = h("div", { class: "grid" });
    applyPinnedFirst(state.containerFaceGroupItems).forEach(it => grid.appendChild(buildFaceGroupTile(it)));
    wrap.appendChild(grid);
    return wrap;
  }

  // ── Album detail (albumDetail view) — shows every item this album has
  // collected, wherever it actually lives in the vault. No upload here:
  // the only way in is "Add from Vault", which picks existing files. ─────
  async function openAlbumById(vid, name, origin, faceGroupContainer) {
    state.view = "albumDetail";
    state.currentAlbum = { vid, name, origin: origin || "albums", faceGroupContainer: faceGroupContainer || null };
    await loadAlbumDetail();
    render();
  }

  async function loadAlbumDetail() {
    if (!state.currentAlbum) return;
    const res = await api.list_album_items(state.currentAlbum.vid);
    state.albumDetailItems = res.ok ? res.items : [];
  }

  async function backToAlbums() {
    const isFaceGroup = state.currentAlbum && state.currentAlbum.origin === "faceGroups";
    if (isFaceGroup && state.currentAlbum.faceGroupContainer) {
      const container = state.currentAlbum.faceGroupContainer;
      state.currentAlbum = null;
      await openFaceGroupContainer(container.vid, container.name);
      return;
    }
    state.view = isFaceGroup ? "faceGroups" : "albums";
    state.currentAlbum = null;
    if (isFaceGroup) await loadFaceGroupContainers(); else await loadAlbums();
    render();
  }

  async function removeFromAlbumItem(it) {
    const albumVid = state.currentAlbum.vid;
    const ids = (it.album_ids || []).filter(a => a !== albumVid);
    const res = await api.set_item_meta(it.vid, { album_ids: ids }, it.rel || null);
    if (res.ok) {
      toast(`Removed "${it.display_name || it.name}" from "${state.currentAlbum.name}" \u2014 the file itself is untouched`, "success");
      await loadAlbumDetail();
      render();
    } else {
      toast(res.error || "Couldn't update this album", "error");
    }
  }

  async function openAlbumItem(it) {
    if (it.rel === null && it.is_dir) {
      state.view = "gallery"; state.path = [{ vid: it.vid, rel: "", name: it.name }];
      await loadCurrentView(); render();
      return;
    }
    if (it.is_dir) { await openWalkResultItem(it); return; }
    api.record_opened(it.vid, it.rel || null);
    if (it.cat === "image" || it.cat === "video") {
      const mediaSiblings = state.albumDetailItems.filter(s => !s.is_dir && s.cat === it.cat);
      openLightbox(mediaSiblings, mediaSiblings.findIndex(s => itemKey(s) === itemKey(it)));
      return;
    }
    await api.open_with_system(it.vid, it.rel || null);
  }

  // Every media tile keeps the real aspect ratio of its own image/video
  // frame (no square crop) — laid out by the same applyMasonryLayout()
  // engine used for the main grid and Favorites, so this now shares its
  // markup pattern (.tile + .tile-thumb) with buildTile/buildFavoriteTile
  // instead of a separate bespoke structure.
  function buildAlbumMediaTile(it) {
    // Any tile with a real thumbnail image (file or folder) flows at that
    // image's own aspect ratio; only icon-fallback tiles stay square.
    const freeAspect = !!it.thumb_url;
    const thumbBox = h("div", { class: "tile-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: versionedThumbUrl(it), loading: "lazy", alt: it.display_name || it.name });
      img.addEventListener("error", () => {
        img.remove();
        thumbBox.classList.add("tile-thumb-fallback");
        thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir)));
      });
      thumbBox.appendChild(img);
    } else {
      thumbBox.classList.add("tile-thumb-fallback");
      thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir)));
    }
    const scrim = h("div", { class: "tile-scrim" },
      h("div", { class: "tile-name" }, it.display_name || it.name),
      h("div", { class: "tile-meta" }, it.size_h + (it.path_breadcrumb ? `  \u00B7  ${it.path_breadcrumb}` : ""))
    );
    const badges = h("div", { class: "tile-badges" });
    if (it.cat === "video") badges.appendChild(h("div", { class: "badge-play" }, h("div", { class: "circle", html: ICON.play })));
    if (it.is_dir) badges.appendChild(h("div", { class: "badge-folder" }, "\u{1F4C1}"));
    const removeBtn = h("button", { class: "tile-fav-btn active", title: "Remove from Album" }, "\u2716");
    removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeFromAlbumItem(it); });
    const tile = h("div", { class: `tile ${freeAspect ? "masonry-tile" : ""}` }, thumbBox, scrim, badges, removeBtn);
    tile.addEventListener("click", () => openAlbumItem(it));
    return tile;
  }

  function renderAlbumDetailContent() {
    const wrap = h("div", { class: "content", id: "content-area" });
    if (!state.albumDetailItems || !state.albumDetailItems.length) {
      const addBtn = h("button", { class: "btn btn-primary", style: "margin-top:14px;" }, "\uFF0B Add files from your vault");
      addBtn.addEventListener("click", onAlbumAddFromVault);
      wrap.appendChild(h("div", { class: "empty-state" },
        h("div", { class: "empty-badge" }, "\u{1F39E}\uFE0F"),
        h("h3", {}, "This album is empty"),
        h("p", {}, "Pick any files already in your vault to collect them here \u2014 nothing is uploaded, moved, or copied, just referenced, exactly like Favorites."),
        addBtn
      ));
      return wrap;
    }
    const grid = h("div", { class: "grid" });
    const tiles = state.albumDetailItems.map(it => buildAlbumMediaTile(it));
    tiles.forEach(t => grid.appendChild(t));
    applyMasonryLayout(grid, tiles);
    wrap.appendChild(grid);
    return wrap;
  }

  // ── "Add from Vault" picker \u2014 browse the vault (same tree the app
  // already shows everywhere else) and toggle files in/out of this album.
  // Folders are for navigating into only; only files get collected. ─────
  function albumFilePickerModal(albumVid, memberKeys) {
    return new Promise((resolve) => {
      const host = document.getElementById("modal-host");
      const backdrop = h("div", { class: "modal-backdrop" });

      let path = []; // stack of {vid, rel, name} beneath the vault root
      const picked = new Map();   // key -> {vid, rel, name} newly turned ON this session
      const removedHere = new Set(); // keys that were already members, turned OFF this session

      const crumbBar = h("div", { class: "vault-picker-crumbs" });
      const grid = h("div", { class: "vault-picker-grid" });
      const status = h("div", { class: "vault-picker-status hidden" });
      const countLabel = h("span", { class: "vault-picker-count" }, "Tap files to select them");

      function finish() { close(); resolve({ picked: Array.from(picked.values()), removed: Array.from(removedHere) }); }

      const doneBtn = h("button", { class: "btn btn-primary", onclick: finish }, "Done");

      const box = h("div", { class: "modal vault-picker-modal" },
        h("h3", {}, "Add files to album"),
        h("p", {}, "Browse your vault and pick any files \u2014 they stay exactly where they are; the album just keeps a reference, like Favorites."),
        crumbBar,
        grid,
        status,
        h("div", { class: "row", style: "justify-content:space-between;align-items:center;" },
          countLabel,
          doneBtn
        )
      );
      backdrop.appendChild(box);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(); });
      host.appendChild(backdrop);
      function close() { backdrop.remove(); }

      function keyOf(vid, rel) { return rel ? `${vid}::${rel}` : vid; }
      function isMemberNow(key) {
        const wasMember = memberKeys.has(key) && !removedHere.has(key);
        return wasMember || picked.has(key);
      }
      function updateCount() {
        const n = picked.size + removedHere.size;
        countLabel.textContent = n ? `${n} change${n === 1 ? "" : "s"} pending` : "Tap files to select them";
      }

      function renderCrumbs() {
        crumbBar.innerHTML = "";
        const home = h("span", { class: "vault-picker-crumb" + (path.length === 0 ? " current" : "") }, "\u{1F5C2}\uFE0F My Vault");
        if (path.length > 0) home.addEventListener("click", () => { path = []; load(); });
        crumbBar.appendChild(home);
        path.forEach((p, idx) => {
          crumbBar.appendChild(h("span", { class: "vault-picker-crumb-sep" }, "\u203A"));
          const isCurrent = idx === path.length - 1;
          const seg = h("span", { class: "vault-picker-crumb" + (isCurrent ? " current" : "") }, p.name);
          if (!isCurrent) seg.addEventListener("click", () => { path = path.slice(0, idx + 1); load(); });
          crumbBar.appendChild(seg);
        });
      }

      async function load() {
        renderCrumbs();
        grid.innerHTML = "";
        status.classList.remove("hidden");
        status.textContent = "Loading\u2026";

        let items;
        if (path.length === 0) {
          items = await api.list_root();
        } else {
          const top = path[path.length - 1];
          const res = await api.browse(top.vid, top.rel);
          items = res.ok ? res.items : [];
        }
        // The album folder itself can't usefully be added to itself.
        items = items.filter(it => !(path.length === 0 && it.is_dir && it.vid === albumVid));

        if (!items.length) { status.textContent = "Nothing here"; return; }
        status.classList.add("hidden");

        items.forEach(it => {
          const vid = path.length ? path[path.length - 1].vid : it.vid;
          const rel = path.length ? it.rel : null;
          if (it.is_dir) {
            const tile = h("div", { class: "vault-picker-tile folder", title: it.name },
              h("div", { class: "vault-picker-folder-icon" }, "\u{1F4C1}"),
              h("div", { class: "vault-picker-tile-name" }, it.display_name || it.name)
            );
            tile.addEventListener("click", () => { path.push({ vid, rel, name: it.name }); load(); });
            grid.appendChild(tile);
            return;
          }
          const key = keyOf(vid, rel);
          const tile = h("div", { class: "vault-picker-tile image", title: it.name },
            it.thumb_url ? h("img", { src: versionedThumbUrl(it), loading: "lazy" })
                         : h("div", { class: "vault-picker-folder-icon" }, catIcon(it.cat, false)),
            h("div", { class: "vault-picker-check" })
          );
          function refresh() { tile.classList.toggle("picked", isMemberNow(key)); }
          refresh();
          tile.addEventListener("click", () => {
            const wasMember = memberKeys.has(key);
            if (picked.has(key)) { picked.delete(key); }
            else if (wasMember && !removedHere.has(key)) { removedHere.add(key); }
            else if (wasMember && removedHere.has(key)) { removedHere.delete(key); }
            else { picked.set(key, { vid, rel, name: it.name }); }
            refresh();
            updateCount();
          });
          grid.appendChild(tile);
        });
      }

      load();
    });
  }

  async function onAlbumAddFromVault() {
    const albumVid = state.currentAlbum.vid;
    const memberKeys = new Set(state.albumDetailItems.map(it => it.rel ? `${it.vid}::${it.rel}` : it.vid));
    const result = await albumFilePickerModal(albumVid, memberKeys);
    if (!result || (!result.picked.length && !result.removed.length)) return;

    let added = 0, removed = 0;
    const errors = [];
    for (const p of result.picked) {
      const cur = await api.get_item_meta(p.vid, p.rel || null);
      const ids = cur.ok ? [...(cur.meta.album_ids || [])] : [];
      if (!ids.includes(albumVid)) ids.push(albumVid);
      const res = await api.set_item_meta(p.vid, { album_ids: ids }, p.rel || null);
      if (res.ok) added++; else errors.push(res.error || `Couldn't add "${p.name}"`);
    }
    for (const key of result.removed) {
      const sep = key.indexOf("::");
      const vid = sep === -1 ? key : key.slice(0, sep);
      const rel = sep === -1 ? null : key.slice(sep + 2);
      const cur = await api.get_item_meta(vid, rel);
      const ids = cur.ok ? (cur.meta.album_ids || []).filter(a => a !== albumVid) : [];
      const res = await api.set_item_meta(vid, { album_ids: ids }, rel);
      if (res.ok) removed++;
    }
    if (added) toast(`Added ${added} file${added === 1 ? "" : "s"} to "${state.currentAlbum.name}"`, "success");
    if (removed && !added) toast(`Updated "${state.currentAlbum.name}"`, "success");
    errors.forEach(e => toast(e, "error"));
    await loadAlbumDetail();
    render();
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3.1: CUSTOM HOME DASHBOARD — assembles Favorites + storage stats
  // using the Phase 0 preference store (vault-identity-scoped, so master
  // and decoy each get their own dashboard layout). Widget visibility is
  // opt-out (all on by default) and persisted per vault identity.
  // ════════════════════════════════════════════════════════════════════════
  const DEFAULT_DASHBOARD_LAYOUT = { widgets: { storage: true, favorites: true, recent: true } };
  function dashboardLayout() {
    return { ...DEFAULT_DASHBOARD_LAYOUT, ...prefGet("vault", "dashboard_layout", {}),
             widgets: { ...DEFAULT_DASHBOARD_LAYOUT.widgets, ...(prefGet("vault", "dashboard_layout", {}).widgets || {}) } };
  }
  async function setDashboardWidget(key, on) {
    const layout = dashboardLayout();
    layout.widgets[key] = on;
    await prefSet("vault", "dashboard_layout", layout);
    render();
  }

  function dashboardMiniTile(it) {
    const tile = h("div", { class: "dashboard-mini-tile" },
      h("div", { class: "mini-label" }, it.display_name || it.name)
    );
    if (it.thumb_url) tile.style.backgroundImage = `url('${versionedThumbUrl(it)}')`;
    else tile.textContent = catIcon(it.cat, it.is_dir);
    tile.addEventListener("click", () => openWalkResultItem(it));
    return tile;
  }

  function renderDashboard() {
    const wrap = h("div", { class: "content", id: "content-area" });
    const layout = dashboardLayout();

    const toggles = h("div", { class: "dashboard-widget-toggles" },
      ...["storage", "favorites", "recent"].map(key => {
        const cb = h("input", { type: "checkbox" });
        cb.checked = layout.widgets[key];
        cb.addEventListener("change", () => setDashboardWidget(key, cb.checked));
        return h("label", {}, cb, { storage: "Storage", favorites: "Favorites", recent: "Recently opened" }[key]);
      })
    );
    wrap.appendChild(toggles);

    const grid = h("div", { class: "dashboard-grid" });

    if (layout.widgets.storage) {
      grid.appendChild(h("div", { class: "dashboard-card" },
        h("h3", {}, "Storage"),
        h("div", { class: "dashboard-stat-row" },
          h("b", {}, state.stats.count || 0), h("span", { class: "sub" }, "items locked")),
        h("div", { class: "dashboard-stat-row" },
          h("b", {}, state.stats.size_h || "0 B"), h("span", { class: "sub" }, "total size")),
      ));
    }

    if (layout.widgets.favorites) {
      const card = h("div", { class: "dashboard-card" },
        h("h3", {}, "Favorites", h("span", { class: "see-all", onclick: async () => { state.view = "favorites"; await loadFavorites(); render(); } }, "See all"))
      );
      if (state.favoritesItems.length) {
        const miniGrid = h("div", { class: "dashboard-mini-grid" });
        state.favoritesItems.slice(0, 6).forEach(it => miniGrid.appendChild(dashboardMiniTile(it)));
        card.appendChild(miniGrid);
      } else {
        card.appendChild(h("div", { class: "dashboard-empty" }, "No favorites yet \u2014 star anything to pin it here."));
      }
      grid.appendChild(card);
    }

    if (layout.widgets.recent) {
      const historyOn = prefGet("vault", "privacy", DEFAULT_PRIVACY).history_enabled;
      const card = h("div", { class: "dashboard-card" }, h("h3", {}, "Recently opened"));
      if (!historyOn) {
        card.appendChild(h("div", { class: "dashboard-empty" }, "History is off in Privacy settings \u2014 turn it on to see recently opened items here."));
      } else if (state.recentItems.length) {
        const miniGrid = h("div", { class: "dashboard-mini-grid" });
        state.recentItems.slice(0, 6).forEach(it => miniGrid.appendChild(dashboardMiniTile(it)));
        card.appendChild(miniGrid);
      } else {
        card.appendChild(h("div", { class: "dashboard-empty" }, "Nothing opened yet this vault."));
      }
      grid.appendChild(card);
    }

    wrap.appendChild(grid);
    return wrap;
  }

  function renderFavoritesContent() {
    const wrap = h("div", { class: "content", id: "content-area" });
    if (!state.favoritesItems || !state.favoritesItems.length) {
      wrap.appendChild(h("div", { class: "empty-state" },
        h("div", { class: "empty-badge" }, "\u2B50"),
        h("h3", {}, "No favorites yet"),
        h("p", {}, "Click the star on any file or folder \u2014 at any depth \u2014 to see it here.")
      ));
      return wrap;
    }
    wrap.appendChild(h("div", { class: "section-hdr" },
      h("h2", {}, "Favorites"), h("span", { class: "section-count" }, state.favoritesItems.length), h("div", { class: "section-line" })
    ));
    const grid = h("div", { class: "grid" });
    const tiles = state.favoritesItems.map(it => buildFavoriteTile(it));
    tiles.forEach(t => grid.appendChild(t));
    applyMasonryLayout(grid, tiles);
    wrap.appendChild(grid);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 2.5: REMEMBER FOLDER STATE — opt-in (Privacy setting, default off).
  // Persists the current folder path so the vault resumes where you left
  // off on next login, plus per-folder scroll position. Deliberately does
  // NOT persist anything when the pref is off — no silent default tracking.
  // ════════════════════════════════════════════════════════════════════════
  function rememberStateEnabled() {
    return !!prefGet("vault", "privacy", DEFAULT_PRIVACY).remember_folder_state;
  }
  async function persistFolderStateIfEnabled() {
    if (!rememberStateEnabled()) return;
    // Store only the addressing info needed to re-browse each level, not
    // any derived display data (e.g. folder background) — that's re-read
    // fresh from the item's own metadata when the view reloads anyway.
    const slim = state.path.map(p => ({ vid: p.vid, rel: p.rel, name: p.name }));
    await prefSet("vault", "last_path", slim);
  }
  let _scrollSaveTimer = null;
  function armScrollPersist(wrap) {
    if (!rememberStateEnabled()) return;
    wrap.addEventListener("scroll", () => {
      if (_scrollSaveTimer) clearTimeout(_scrollSaveTimer);
      _scrollSaveTimer = setTimeout(() => {
        prefSet("vault", `scroll:${folderKey()}`, wrap.scrollTop);
      }, 400);
    }, { passive: true });
  }
  async function restoreLastFolderState() {
    if (!rememberStateEnabled()) return;
    const lastPath = prefGet("vault", "last_path", null);
    if (!lastPath || !lastPath.length) return;
    // Validate level by level — if a folder in the saved path was since
    // deleted or restored out of the vault, stop at the last good level
    // instead of failing the whole restore. Also re-fetch each level's
    // own appearance fields (color/icon/background/empty-state) so
    // Appearance Inheritance and Custom Folder Headers work immediately
    // on resume, not just after the person re-clicks through manually.
    const validated = [];
    for (const p of lastPath) {
      const res = await api.browse(p.vid, p.rel);
      if (!res.ok) break;
      const metaRes = await api.get_item_meta(p.vid, p.rel || null);
      const m = metaRes.ok ? metaRes.meta : {};
      validated.push({
        vid: p.vid, rel: p.rel, name: p.name,
        background: m.background || null, color: m.color || null, icon: m.icon || null,
        displayName: m.display_name || null, description: m.description || null, tags: m.tags || [],
        emptyState: (m.metadata && m.metadata.empty_state) || null,
      });
    }
    if (validated.length) state.path = validated;
  }

  async function loadCurrentView() {
    state.stats = await api.get_stats();
    if (state.path.length === 0) {
      const rootItems = await api.list_root();
      // Album folders are purely a reference container now (see the ALBUMS
      // section above) — they're reached only through the Albums view's
      // "Add from Vault" picker, never through normal folder browsing,
      // so the ordinary "+ File" / "+ Folder" upload buttons can never be
      // used to drop new data straight into one.
      state.items = rootItems.filter(it => !(it.is_dir && it.metadata && it.metadata.is_album));
    } else {
      const top = state.path[state.path.length - 1];
      const res = await api.browse(top.vid, top.rel);
      state.items = res.ok ? res.items : [];
      const statsRes = await api.folder_stats(top.vid, top.rel || null);
      top.stats = statsRes.ok ? statsRes.stats : null;
      top.ruleBadges = await applyFolderRules(top);
    }
    persistFolderStateIfEnabled();
  }

  function renderApp() {
    const shell = h("div", { class: "shell screen-fade" });
    shell.appendChild(renderSidebar());
    const main = h("div", { class: "main", id: "app-main" });
    main.appendChild(renderTopbar());
    main.appendChild(
      state.view === "settings" ? renderSettings() :
      state.view === "privacy" ? renderPrivacySecurity() :
      state.view === "help" ? renderHelp() :
      state.view === "favorites" ? renderFavoritesContent() :
      state.view === "albums" ? renderAlbumsContent() :
      state.view === "faceGroups" ? renderFaceGroupsContent() :
      state.view === "faceGroupContainer" ? renderFaceGroupContainerContent() :
      state.view === "albumDetail" ? renderAlbumDetailContent() :
      state.view === "dashboard" ? renderDashboard() :
      state.view === "notes" ? renderNotesContent() :
      renderContent()
    );
    if (state.selectMode) main.appendChild(renderBulkBar());
    shell.appendChild(main);
    return shell;
  }

  function renderSidebar() {
    const nav = (icon, label, key) => h("div", {
      class: `nav-item ${state.view === key ? "active" : ""}`,
      onclick: async () => {
        state.view = key;
        if (key === "gallery") { state.path = []; await loadCurrentView(); }
        else if (key === "favorites") { await loadFavorites(); }
        else if (key === "albums") { state.currentAlbum = null; await loadAlbums(); }
        else if (key === "faceGroups") { state.currentAlbum = null; state.currentFaceGroupContainer = null; await loadFaceGroupContainers(); }
        else if (key === "dashboard") { await loadDashboard(); }
        else if (key === "notes") { await loadNotes(); }
        render();
      }
    }, h("span", { class: "nav-ico" }, icon), label);

    return h("div", { class: "sidebar" },
      h("div", { class: "brand" },
        h("div", { class: "brand-badge" }, "\u{1F512}"),
        h("div", { class: "brand-name" }, "VaultLock")
      ),
      nav("\u{1F4CA}", "Dashboard", "dashboard"),
      nav("\u{1F5C2}\uFE0F", "My Vault", "gallery"),
      nav("\u2B50", "Favorites", "favorites"),
      nav("\u{1F4DD}", "Your Text", "notes"),
      nav("\u{1F39E}\uFE0F", "Albums", "albums"),
      nav("\u{1F642}", "Face Groups", "faceGroups"),
      nav("\u2699\uFE0F", "Settings", "settings"),
      nav("\u{1F6E1}\uFE0F", "Privacy & Security", "privacy"),
      nav("\u2753", "Help", "help"),
      !state.isDecoy ? h("div", {
        class: "nav-item", title: shortcutCombo("quick_hide").replace(/\+/g, " + "),
        onclick: () => { state.covered = true; render(); }
      }, h("span", { class: "nav-ico" }, "\u{1F576}\uFE0F"), "Hide Vault") : null,
      h("div", { class: "sidebar-spacer" }),
      h("div", { class: "sidebar-stats" },
        h("b", {}, `${state.stats.count} item${state.stats.count === 1 ? "" : "s"} locked`),
        state.stats.size_h
      )
    );
  }

  function renderTopbar() {
    if (state.view === "dashboard") {
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" }, h("h1", { class: "topbar-title" }, "Dashboard")),
        ),
      );
    }
    if (state.view === "favorites") {
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" }, h("h1", { class: "topbar-title" }, "Favorites")),
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" }, `${state.favoritesItems.length} item(s) across your vault`),
        )
      );
    }
    if (state.view === "notes") {
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" }, h("h1", { class: "topbar-title" }, "Your Text")),
          h("div", { class: "topbar-actions" },
            h("button", { class: "btn btn-premium btn-sm", onclick: onAddNote }, "\uFF0B Add Text")
          )
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" }, `${state.notesList.length} text${state.notesList.length === 1 ? "" : "s"}`),
          state.notesList.length > 1 ? renderNotesSortControl() : null,
        )
      );
    }
    if (state.view === "albums") {
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" }, h("h1", { class: "topbar-title" }, "Albums")),
          h("div", { class: "topbar-actions" },
            h("button", { class: "btn btn-premium btn-sm", onclick: onNewAlbum }, "\uFF0B New Album")
          )
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" }, `${state.albumsItems.length} album${state.albumsItems.length === 1 ? "" : "s"}`),
        )
      );
    }
    if (state.view === "faceGroups") {
      const newFolderBtn = h("button", { class: "btn btn-secondary btn-sm" }, "\u{1F5C2}\uFE0F New Folder");
      newFolderBtn.addEventListener("click", handleNewFaceGroupContainer);
      const actions = [newFolderBtn];
      if (state.faceGroupContainers.length) {
        const deleteAllBtn = h("button", { class: "btn btn-danger-soft btn-sm" }, "\u{1F5D1}\uFE0F Delete All");
        deleteAllBtn.addEventListener("click", handleDeleteAllFaceGroupContainers);
        actions.push(deleteAllBtn);
      }
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" }, h("h1", { class: "topbar-title" }, "Face Groups")),
          h("div", { class: "topbar-actions" }, ...actions)
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" },
            `${state.faceGroupContainers.length} folder${state.faceGroupContainers.length === 1 ? "" : "s"}`),
        )
      );
    }
    if (state.view === "faceGroupContainer") {
      const scanBtn = h("button", { class: "btn btn-primary btn-sm", disabled: state.faceScanRunning },
        state.faceScanRunning ? "Scanning\u2026" : "\u{1F50D} Scan for faces");
      scanBtn.addEventListener("click", handleScanFaces);
      const actions = [h("button", { class: "btn btn-ghost btn-sm", onclick: backToFaceGroupContainers }, "\u2B05 Face Groups")];
      if (state.containerFaceGroupItems.length) {
        const deleteAllBtn = h("button", { class: "btn btn-danger-soft btn-sm" }, "\u{1F5D1}\uFE0F Delete All");
        deleteAllBtn.addEventListener("click", handleDeleteAllFaceGroups);
        actions.push(deleteAllBtn);
      }
      actions.push(scanBtn);
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" },
            h("h1", { class: "topbar-title" }, state.currentFaceGroupContainer ? state.currentFaceGroupContainer.name : "Face Group")
          ),
          h("div", { class: "topbar-actions" }, ...actions)
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" },
            `${state.containerFaceGroupItems.length} group${state.containerFaceGroupItems.length === 1 ? "" : "s"}`),
        )
      );
    }
    if (state.view === "albumDetail") {
      const count = state.albumDetailItems.length;
      const isFaceGroup = state.currentAlbum && state.currentAlbum.origin === "faceGroups";
      const backLabel = isFaceGroup ? "\u2B05 Face Groups" : "\u2B05 Albums";
      const rightBtn = isFaceGroup
        ? h("button", { class: "btn btn-primary btn-sm", disabled: state.faceScanRunning },
            state.faceScanRunning ? "Scanning\u2026" : "\u21BB Rescan")
        : h("button", { class: "btn btn-primary btn-sm", onclick: onAlbumAddFromVault }, "\uFF0B Add from Vault");
      if (isFaceGroup) rightBtn.addEventListener("click", handleScanFaces);
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" },
            h("h1", { class: "topbar-title" }, state.currentAlbum ? state.currentAlbum.name : "Album")
          ),
          h("div", { class: "topbar-actions" },
            h("button", { class: "btn btn-ghost btn-sm", onclick: backToAlbums }, backLabel),
            rightBtn
          )
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" }, `${count} item${count === 1 ? "" : "s"} collected`),
        )
      );
    }
    if (state.view === "privacy") {
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" }, h("h1", { class: "topbar-title" }, "Privacy & Security")),
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" }, "How VaultLock actually protects your files, and the controls that manage it"),
        )
      );
    }
    if (state.view === "help") {
      return h("div", { class: "topbar" },
        h("div", { class: "topbar-row1" },
          h("div", { class: "topbar-title-wrap" }, h("h1", { class: "topbar-title" }, "Help")),
        ),
        h("div", { class: "topbar-row2" },
          h("div", { class: "meta-line" }, "A walkthrough of every feature, colour-coded by how carefully to use it"),
        )
      );
    }
    const atRoot = state.path.length === 0;
    const title = atRoot ? "My Vault" : state.path[state.path.length - 1].name;

    const crumbs = h("div", { class: "crumbs" });
    if (!atRoot) {
      crumbs.appendChild(h("span", { class: "crumb", onclick: async () => { state.path = []; await loadCurrentView(); render(); } }, "My Vault"));
      state.path.forEach((p, i) => {
        crumbs.appendChild(h("span", { class: "crumb-sep" }, "\u203A"));
        const isCur = i === state.path.length - 1;
        crumbs.appendChild(h("span", {
          class: `crumb ${isCur ? "current" : ""}`,
          onclick: async () => { state.path = state.path.slice(0, i + 1); await loadCurrentView(); render(); }
        }, p.name));
      });
    }

    const row1 = h("div", { class: "topbar-row1" },
      h("div", { class: "topbar-title-wrap" },
        h("h1", { class: "topbar-title" }, title),
      ),
      h("div", { class: "topbar-actions" }, ...topbarActions(atRoot))
    );

    const search = h("div", { class: "search-box" },
      h("span", {}, "\u{1F50D}"),
      h("input", {
        placeholder: "Search this view\u2026", value: state.search,
        oninput: (e) => { state.search = e.target.value; renderContentInPlace(); }
      })
    );
    const viewToggle = h("div", { class: "view-toggle" },
      h("button", { class: state.viewMode === "grid" ? "active" : "", onclick: () => { state.viewMode = "grid"; render(); } }, "\u25A6 Gallery"),
      h("button", { class: state.viewMode === "list" ? "active" : "", onclick: () => { state.viewMode = "list"; render(); } }, "\u2261 List"),
    );
    const sortSelect = renderSortControl();
    const row2 = h("div", { class: "topbar-row2" },
      !atRoot ? crumbs : h("div", { class: "meta-line" }, `${state.stats.count} items \u00B7 ${state.stats.size_h}`),
      h("div", { style: "display:flex;align-items:center;gap:14px;" }, sortSelect, search, viewToggle)
    );

    return h("div", { class: "topbar" }, row1, row2);
  }

  function topbarActions(atRoot) {
    const actions = [];
    if (atRoot) {
      actions.push(h("button", {
        class: "btn btn-ghost btn-sm",
        onclick: () => { state.selectMode = !state.selectMode; if (!state.selectMode) state.selected.clear(); render(); }
      }, state.selectMode ? "Cancel Select" : "\u2611 Select"));
      actions.push(h("button", { class: "btn btn-success-soft btn-sm", onclick: onRestoreAll }, "\u{1F4E4} Restore All"));
      actions.push(h("button", { class: "btn btn-danger-soft btn-sm", onclick: onWipeVault }, "\u{1F4A3} Wipe Vault"));
      actions.push(h("div", { class: "divider-v" }));
    } else {
      actions.push(h("button", { class: "btn btn-ghost btn-sm", onclick: async () => { state.path = state.path.slice(0, -1); await loadCurrentView(); render(); } }, "\u2B05 Back"));
    }
    actions.push(h("button", { class: "btn btn-ghost btn-sm", onclick: onNewFolder }, "\u{1F5C2}\uFE0F New Folder"));
    actions.push(h("button", { class: "btn btn-primary btn-sm", onclick: onAddFile }, "\uFF0B File"));
    actions.push(h("button", { class: "btn btn-secondary btn-sm", onclick: onAddFolder }, "\uFF0B Folder"));
    return actions;
  }

  async function onNewFolder() {
    const name = await promptFolderName();
    if (!name) return;
    const atRoot = state.path.length === 0;
    const res = atRoot
      ? await api.create_folder(name)
      : await api.create_subfolder(state.path[state.path.length - 1].vid, state.path[state.path.length - 1].rel, name);
    if (res.ok) { toast("Folder created", "success"); await loadCurrentView(); render(); }
    else toast(res.result || "Couldn't create folder", "error");
  }

  async function onAddFile() {
    const atRoot = state.path.length === 0;
    const res = atRoot
      ? await api.add_files()
      : await api.add_files_into(state.path[state.path.length - 1].vid, state.path[state.path.length - 1].rel);
    if (res.added) toast(`Locked ${res.added} file${res.added > 1 ? "s" : ""}`, "success");
    res.errors.forEach(e => toast(e, "error"));
    if (res.added) { await loadCurrentView(); render(); }
  }
  async function onAddFolder() {
    const atRoot = state.path.length === 0;
    const res = atRoot
      ? await api.add_folder()
      : await api.add_folder_into(state.path[state.path.length - 1].vid, state.path[state.path.length - 1].rel);
    if (res.added) { toast("Folder locked", "success"); await loadCurrentView(); render(); }
    res.errors.forEach(e => toast(e, "error"));
  }
  async function onRestoreAll() {
    if (state.stats.count === 0) return;
    const choice = await chooseDestination(state.stats.count);
    if (!choice) return;
    let dest = null;
    if (choice === "choose") { dest = await api.choose_folder(); if (!dest) return; }
    const res = await api.restore_all(dest);
    const ok = res.results.filter(r => r.ok).length;
    toast(`Restored ${ok} of ${res.results.length} item${res.results.length > 1 ? "s" : ""}`, ok === res.results.length ? "success" : "warn");
    await loadCurrentView(); render();
  }
  async function onWipeVault() {
    const yes = await confirmDanger("Wipe entire vault?", "This permanently deletes every locked file and folder. This cannot be undone.", "Wipe Vault");
    if (!yes) return;
    await api.wipe_vault();
    toast("Vault wiped", "success");
    await loadCurrentView(); render();
  }

  // ── Bulk selection bar ──────────────────────────────────────────────────
  // Selecting/deselecting items must NOT do a full re-render — that would
  // remount the whole app and reset scroll to the top. Instead we patch the
  // content area and the bulk bar in place, preserving scroll position.
  function updateSelectionUI() {
    renderContentInPlace();
    const main = document.getElementById("app-main");
    if (!main) { render(); return; } // fallback if the shell isn't mounted yet
    const existingBar = document.getElementById("bulk-bar");
    if (existingBar) existingBar.remove();
    if (state.selectMode) main.appendChild(renderBulkBar());
  }

  function selectAllVisible() {
    filteredItems().forEach(it => state.selected.add(itemKey(it)));
    updateSelectionUI();
  }
  function deselectAll() {
    state.selected.clear();
    updateSelectionUI();
  }

  function renderBulkBar() {
    const n = state.selected.size;
    const total = filteredItems().length;
    // Selection keys are canonicalKey(it) — "vid" for root items, or
    // "vid::rel" for items inside a locked folder (see canonicalKey's
    // comment above). delete_batch/restore_batch need the real {vid, rel}
    // pair per item (same shape effectiveTarget() gives the single-item
    // delete/restore calls), not the composite string key — passing the
    // raw key as "vid" made every nested item's bulk delete/restore
    // silently fail since "actualvid::relpath" never matches a real vid.
    const selectedItems = Array.from(state.selected).map(k => filteredItems().find(it => itemKey(it) === k)).filter(Boolean);
    const targets = selectedItems.map(it => effectiveTarget(it));
    const allSelected = total > 0 && n === total;

    return h("div", { class: "bulk-bar", id: "bulk-bar" },
      h("span", { class: "bulk-count" }, n > 0 ? `${n} selected` : "Select items\u2026"),
      h("div", { class: "divider-v" }),
      h("button", {
        class: "btn btn-ghost", disabled: allSelected || total === 0, onclick: selectAllVisible
      }, "\u2611 Select All"),
      h("button", {
        class: "btn btn-ghost", disabled: n === 0, onclick: deselectAll
      }, "\u2610 Deselect All"),
      h("div", { class: "divider-v" }),
      h("button", { class: "btn btn-ghost", disabled: n === 0, onclick: () => openBatchRename(selectedItems) }, "\u{1F522} Batch Rename\u2026"),
      h("button", { class: "btn btn-ghost", disabled: n === 0, onclick: () => openPrivacyScrubber(selectedItems) }, "\u{1F6E1}\uFE0F Privacy Scrub\u2026"),
      h("div", { class: "divider-v" }),
      h("button", { class: "btn btn-ghost", disabled: n === 0, onclick: async () => {
        const res = await api.restore_batch(targets, null);
        finishBulk(res, "restored");
      } }, "\u21A9 Restore to original"),
      h("button", { class: "btn btn-ghost", disabled: n === 0, onclick: async () => {
        const dest = await api.choose_folder();
        if (!dest) return;
        const res = await api.restore_batch(targets, dest);
        finishBulk(res, "restored");
      } }, "\u{1F4C2} Restore to folder\u2026"),
      h("button", { class: "btn btn-danger", disabled: n === 0, onclick: async () => {
        const yes = await confirmDanger(`Delete ${n} item${n > 1 ? "s" : ""}?`, "This permanently deletes the selected files/folders. This cannot be undone.", "Delete");
        if (!yes) return;
        const res = await api.delete_batch(targets);
        finishBulk(res, "deleted");
      } }, "\u{1F5D1} Delete"),
      h("button", { class: "btn btn-ghost", onclick: () => { state.selected.clear(); state.selectMode = false; render(); } }, "Cancel")
    );

    async function finishBulk(res, verb) {
      const ok = res.results.filter(r => r.ok).length;
      toast(`${verb.charAt(0).toUpperCase() + verb.slice(1)} ${ok} of ${res.results.length} item${res.results.length > 1 ? "s" : ""}`, ok === res.results.length ? "success" : "warn");
      state.selected.clear(); state.selectMode = false;
      await loadCurrentView(); render();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // CUSTOM SORTING — per-folder, remembered via Phase 0 prefs. "Manual" mode
  // just means "don't reorder — use the persisted drag order as-is."
  // ════════════════════════════════════════════════════════════════════════
  const SORT_OPTIONS = [
    { mode: "name", label: "Name" },
    { mode: "date", label: "Date added" },
    { mode: "size", label: "Size" },
    { mode: "type", label: "Type" },
    { mode: "recent", label: "Recently opened" },
    { mode: "manual", label: "Custom order" },
  ];

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3.2: PARENT → CHILD APPEARANCE INHERITANCE — evaluated fresh on
  // every render by walking the live path segments (never baked into a
  // child's own stored fields), so editing a parent folder's color/icon/
  // background immediately shows up on every descendant that hasn't set
  // its own override, with zero migration needed.
  // ════════════════════════════════════════════════════════════════════════
  function inheritedField(field) {
    for (let i = state.path.length - 1; i >= 0; i--) {
      const v = state.path[i][field];
      if (v) return v;
    }
    return null;
  }
  function effectiveAppearance(it) {
    // An item only inherits from its ancestors, never from itself — a
    // folder's own explicit fields always win over anything above it, and
    // a folder with no explicit fields passes its ancestor's values down
    // to ITS children unchanged (the chain stops at the first override).
    return {
      color: it.color || inheritedField("color"),
      icon: it.icon || inheritedField("icon"),
    };
  }

  function currentSort() {
    return prefGet("vault", `sort:${folderKey()}`, DEFAULT_SORT);
  }
  async function setSortMode(mode) {
    const cur = currentSort();
    await prefSet("vault", `sort:${folderKey()}`, { mode, dir: cur.dir || "asc" });
    render();
  }
  async function toggleSortDir() {
    const cur = currentSort();
    await prefSet("vault", `sort:${folderKey()}`, { mode: cur.mode, dir: cur.dir === "desc" ? "asc" : "desc" });
    render();
  }

  function renderSortControl() {
    const cur = currentSort();
    const select = h("select", { class: "sort-select" },
      ...SORT_OPTIONS.map(o => h("option", { value: o.mode, selected: o.mode === cur.mode }, o.label))
    );
    select.addEventListener("change", () => setSortMode(select.value));
    const dirBtn = h("button", {
      class: "btn btn-ghost btn-sm sort-dir-btn", title: cur.dir === "desc" ? "Descending" : "Ascending",
      onclick: toggleSortDir,
    }, cur.dir === "desc" ? "\u2193" : "\u2191");
    return h("div", { class: "sort-control" }, select, dirBtn);
  }

  // Manual order is stored per parent-folder — and, at the root level,
  // per visible category group too (Folders / Photos & Videos / Audio /
  // Files render as separate grids, so a drag only ever reorders within
  // one of them; storing them under separate keys means reordering one
  // group can never clobber another's saved arrangement).
  function manualOrderKey(groupLabel) {
    return `order:${folderKey()}${groupLabel ? ":" + groupLabel : ""}`;
  }
  function applyManualOrder(items, groupLabel) {
    const order = prefGet("vault", manualOrderKey(groupLabel), null);
    if (!order || !order.length) return items;
    const pos = new Map(order.map((k, i) => [k, i]));
    return [...items].sort((a, b) => {
      const ka = pos.has(itemKey(a)) ? pos.get(itemKey(a)) : Infinity;
      const kb = pos.has(itemKey(b)) ? pos.get(itemKey(b)) : Infinity;
      return ka - kb;
    });
  }
  async function persistManualOrder(items, groupLabel) {
    await prefSet("vault", manualOrderKey(groupLabel), items.map(itemKey));
  }

  // "Pinned" items always float to the top of whatever the active sort
  // produces — a stable partition, so pinned items keep their relative
  // order among themselves and everyone else keeps theirs too. Applies
  // uniformly across every sort mode, including manual drag order.
  function applyPinnedFirst(items) {
    const pinned = items.filter(i => i.pinned);
    if (!pinned.length) return items;
    const rest = items.filter(i => !i.pinned);
    return [...pinned, ...rest];
  }

  function sortItems(items, groupLabel) {
    const { mode, dir } = currentSort();
    if (mode === "manual") return applyPinnedFirst(applyManualOrder(items, groupLabel));
    const mul = dir === "desc" ? -1 : 1;
    const sorted = [...items].sort((a, b) => {
      switch (mode) {
        case "size": return (a.size - b.size) * mul;
        case "type": {
          const ta = a.is_dir ? "" : (a.ext || a.cat || "");
          const tb = b.is_dir ? "" : (b.ext || b.cat || "");
          return ta.localeCompare(tb) * mul || a.name.localeCompare(b.name) * mul;
        }
        case "date": {
          const da = a.locked_at ? new Date(a.locked_at).getTime() : 0;
          const db = b.locked_at ? new Date(b.locked_at).getTime() : 0;
          return (da - db) * mul;
        }
        case "recent": {
          const ra = (a.metadata && a.metadata.last_opened) ? new Date(a.metadata.last_opened).getTime() : 0;
          const rb = (b.metadata && b.metadata.last_opened) ? new Date(b.metadata.last_opened).getTime() : 0;
          return (rb - ra) * -mul; // most-recent first by default
        }
        default: return a.name.localeCompare(b.name) * mul;
      }
    });
    return applyPinnedFirst(sorted);
  }

  // ════════════════════════════════════════════════════════════════════════
  // CONTENT (gallery grid / list) — shared for root + nested folder browsing
  // ════════════════════════════════════════════════════════════════════════
  function filteredItems() {
    if (!state.search) return state.items;
    const q = state.search.toLowerCase();
    return state.items.filter(i => i.name.toLowerCase().includes(q));
  }

  function renderContent() {
    const wrap = h("div", { class: `content ${state.selectMode ? "select-mode" : ""}`, id: "content-area" });
    fillContent(wrap);
    if (state.justEntered && !state.isDecoy) {
      const onScroll = () => {
        if (wrap.scrollTop > 40) {
          state.justEntered = false;
          wrap.removeEventListener("scroll", onScroll);
        }
      };
      wrap.addEventListener("scroll", onScroll);
    }
    armScrollPersist(wrap);
    if (rememberStateEnabled()) {
      const saved = prefGet("vault", `scroll:${folderKey()}`, 0);
      if (saved) requestAnimationFrame(() => { wrap.scrollTop = saved; });
    }
    return wrap;
  }
  function renderContentInPlace() {
    const wrap = document.getElementById("content-area");
    if (!wrap) return;
    // Same problem render() solves for full redraws: fillContent() clears
    // and rebuilds every tile, which — even though `wrap` itself stays
    // mounted — collapses its scrollHeight for a moment and gets the
    // browser to clamp scrollTop back to 0. Selecting a file/folder near
    // the bottom of a long listing used to snap the whole page back to
    // the top on every single tap, forcing a rescroll before the next
    // pick. Capture and reapply the scroll position around the rebuild so
    // multi-select stays exactly where you left it.
    const prevScroll = wrap.scrollTop;
    wrap.className = `content ${state.selectMode ? "select-mode" : ""}`;
    fillContent(wrap);
    if (prevScroll > 0) {
      wrap.scrollTop = prevScroll;
      // Belt-and-suspenders: masonry/image layout can settle a frame
      // later, same as the render() restore below.
      requestAnimationFrame(() => { wrap.scrollTop = prevScroll; });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3.4/3.5/3.6: Custom Folder Header, Cover Styles, Custom Empty States
  // ════════════════════════════════════════════════════════════════════════
  function coverStylePref() {
    return prefGet("vault", "layout", { folder_cover_style: "classic" }).folder_cover_style || "classic";
  }
  // {vid, rel} -> media URL, for the various stored-image-reference fields
  // (folder background, custom empty-state image) that hold raw addressing
  // info rather than a pre-built URL.
  function vidRelUrl(ref) {
    if (!ref || !ref.vid) return null;
    return ref.rel ? mediaUrl(`/media/${ref.vid}/${ref.rel}`) : mediaUrl(`/media/${ref.vid}`);
  }

  function renderFolderHeader(top) {
    const coverUrl = vidRelUrl(top.background);
    const cover = h("div", { class: `folder-cover folder-cover-${coverStylePref()}` });
    if (coverUrl) cover.style.backgroundImage = `url('${coverUrl}')`;
    else cover.appendChild(h("div", { class: "folder-cover-fallback" }, top.icon || inheritedField("icon") || "\u{1F4C1}"));

    const statsLine = top.stats
      ? `${top.stats.file_count} file${top.stats.file_count === 1 ? "" : "s"}` +
        (top.stats.folder_count ? `, ${top.stats.folder_count} folder${top.stats.folder_count === 1 ? "" : "s"}` : "") +
        ` \u00B7 ${top.stats.size_h}`
      : "";

    const tagsRow = (top.tags && top.tags.length)
      ? h("div", { class: "folder-header-tags" }, ...top.tags.map(t => h("span", { class: "tag-chip small" }, t)))
      : null;

    // Phase 5.1: transient badges from Folder Rules — recomputed on every
    // visit, never persisted. A "suggest_duplicate_scan" badge is the one
    // clickable kind, and it only ever opens the existing duplicate finder
    // modal for the person to review — it never deletes anything itself.
    const badgesRow = (top.ruleBadges && top.ruleBadges.length)
      ? h("div", { class: "folder-header-badges" }, ...top.ruleBadges.map(b => {
          const chip = h("span", { class: `rule-badge rule-badge-${b.style}` }, b.text);
          if (b.action === "open_duplicate_finder") {
            chip.classList.add("clickable");
            chip.addEventListener("click", openDuplicateFinder);
          }
          return chip;
        }))
      : null;

    return h("div", { class: "folder-header" },
      cover,
      h("div", { class: "folder-header-info" },
        h("h1", { class: "folder-header-title" }, top.displayName || top.name),
        top.description ? h("p", { class: "folder-header-desc" }, top.description) : null,
        tagsRow,
        badgesRow,
        statsLine ? h("div", { class: "folder-header-stats" }, statsLine) : null,
      )
    );
  }

  function renderEmptyState(atRoot, top) {
    // Custom Empty States: a folder can set its own message/image via the
    // Customize modal (stored under metadata.empty_state); falls back to
    // the generic empty-state otherwise.
    const custom = !atRoot && top && top.emptyState;
    if (custom && custom.image && custom.image.vid) {
      const url = vidRelUrl(custom.image);
      return h("div", { class: "empty-state empty-state-custom" },
        h("img", { class: "empty-state-custom-img", src: url }),
        h("h3", {}, custom.message || "This is empty"),
      );
    }
    return h("div", { class: "empty-state" },
      h("div", { class: "empty-badge" }, "\u{1F5BC}\uFE0F"),
      h("h3", {}, state.search ? "No matches" : (custom && custom.message) || "This is empty"),
      h("p", {}, state.search ? "Try a different search term." : "Add files or folders using the buttons above.")
    );
  }

  function fillContent(wrap) {
    wrap.innerHTML = "";
    const atRoot = state.path.length === 0;

    // Folder Customization: a folder with a chosen background image shows
    // it behind its own contents while you're browsing inside it. If THIS
    // folder didn't set its own, Appearance Inheritance falls back to the
    // nearest ancestor that did (evaluated live from state.path, never
    // baked in) so a whole branch can share one look from a single edit.
    wrap.classList.remove("has-folder-bg");
    wrap.style.backgroundImage = "";
    if (!atRoot) {
      const bg = inheritedField("background");
      if (bg && bg.vid) {
        const url = vidRelUrl(bg);
        wrap.classList.add("has-folder-bg");
        wrap.style.backgroundImage = `url('${url}')`;
      }
    }

    // Fresh into the master vault: show nothing but the background at
    // first — the actual gallery only appears once you scroll down to it.
    if (state.justEntered && !state.isDecoy && atRoot) {
      wrap.appendChild(h("div", { class: "vault-blank-spacer" },
        h("div", { class: "vault-blank-hint" },
          h("div", { class: "vault-blank-arrow" }, "\u2193"),
          h("span", {}, "Scroll to view your vault")
        )
      ));
    }

    const top = !atRoot ? state.path[state.path.length - 1] : null;
    if (top) wrap.appendChild(renderFolderHeader(top));

    const items = filteredItems();
    if (items.length === 0) {
      wrap.appendChild(renderEmptyState(atRoot, top));
      return;
    }

    if (atRoot) {
      const groups = [
        { key: "folder", title: "Folders" },
        { key: ["image", "video"], title: "Photos & Videos" },
        { key: "audio", title: "Audio" },
        { key: ["text", "pdf", "other"], title: "Files" },
      ];
      groups.forEach(g => {
        const match = Array.isArray(g.key) ? (c) => g.key.includes(c) : (c) => c === g.key;
        const group = sortItems(items.filter(i => match(i.cat)), g.title);
        if (group.length === 0) return;
        wrap.appendChild(h("div", { class: "section-hdr" },
          h("h2", {}, g.title), h("span", { class: "section-count" }, group.length), h("div", { class: "section-line" })
        ));
        wrap.appendChild(state.viewMode === "grid" ? buildGrid(group, true, g.title, wrap) : buildList(group, true, g.title, wrap));
      });
    } else {
      // Nested (inside a locked folder) items are now individually
      // manageable too — restore/move/delete a single file or sub-folder
      // without touching the rest of the folder.
      const sorted = sortItems(items, null);
      wrap.appendChild(state.viewMode === "grid" ? buildGrid(sorted, true, null, wrap) : buildList(sorted, true, null, wrap));
    }
  }

  // Resolves an item shown in the current listing to the {vid, rel} pair
  // its backend calls need: root items carry their own vid; items browsed
  // inside a folder use that folder's vid plus their own token path.
  function effectiveTarget(it) {
    if (state.path.length === 0) return { vid: it.vid, rel: null };
    const top = state.path[state.path.length - 1];
    return { vid: top.vid, rel: it.rel };
  }

  function catIcon(cat, isDir) {
    if (isDir) return "\u{1F4C1}";
    return { image: "\u{1F5BC}\uFE0F", video: "\u{1F3AC}", audio: "\u{1F3B5}", pdf: "\u{1F4C4}", text: "\u{1F4CB}", other: "\u{1F4CE}" }[cat] || "\u{1F4CE}";
  }

  // ════════════════════════════════════════════════════════════════════════
  // MASONRY LAYOUT — real, JS-computed Pinterest-style packing shared by
  // every media grid in the app (main browsing grid, Favorites, Album
  // detail). This deliberately does NOT use CSS multi-column
  // (column-count): that approach balances columns by total content
  // rather than true "shortest column wins" placement, and behaves
  // inconsistently across rendering engines. Instead:
  //   - the number of columns is computed from the container's actual
  //     width (not a fixed count), so it adapts smoothly as the window or
  //     sidebar resizes;
  //   - each tile is measured from its own real image (via naturalWidth/
  //     naturalHeight once it loads) and absolutely positioned at the
  //     exact left/top/width/height that preserves that aspect ratio —
  //     nothing is ever cropped or stretched to fit a box;
  //   - non-photo tiles (folders, other file types) fall back to a 1:1
  //     box, since they have no "real shape" of their own, but still
  //     participate in the same shortest-column packing as everything
  //     else.
  // ════════════════════════════════════════════════════════════════════════
  const MASONRY_MIN_COL_WIDTH = 200;
  const MASONRY_MAX_COLS = 6;
  const MASONRY_GAP = 14;

  function masonryColumnCount(containerWidth) {
    const cols = Math.floor((containerWidth + MASONRY_GAP) / (MASONRY_MIN_COL_WIDTH + MASONRY_GAP));
    return Math.max(1, Math.min(MASONRY_MAX_COLS, cols));
  }

  // Attaches a live masonry layout to `container` for the given `tiles`
  // (already built + appended DOM elements). Each tile may carry a
  // `data-aspect` (width/height) already, or an <img> whose real size is
  // measured once it loads; tiles with neither default to a 1:1 box.
  // Safe to call more than once per container lifetime — a resize
  // observer keeps it correct as the window/sidebar/column count changes.
  function applyMasonryLayout(container, tiles) {
    container.classList.add("masonry-js");
    let raf = null;
    function relayout() {
      const width = container.clientWidth;
      if (!width || !tiles.length) { container.style.height = "0px"; return; }
      const cols = masonryColumnCount(width);
      const colWidth = (width - MASONRY_GAP * (cols - 1)) / cols;
      const colHeights = new Array(cols).fill(0);
      tiles.forEach((tile) => {
        let col = 0;
        for (let i = 1; i < cols; i++) if (colHeights[i] < colHeights[col]) col = i;
        const aspect = parseFloat(tile.dataset.aspect) || 1; // width / height
        const tileHeight = colWidth / aspect;
        tile.style.width = `${colWidth}px`;
        tile.style.height = `${tileHeight}px`;
        tile.style.left = `${col * (colWidth + MASONRY_GAP)}px`;
        tile.style.top = `${colHeights[col]}px`;
        colHeights[col] += tileHeight + MASONRY_GAP;
      });
      container.style.height = `${Math.max(0, ...colHeights) - MASONRY_GAP}px`;
    }
    function scheduleRelayout() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(relayout);
    }
    tiles.forEach((tile) => {
      const img = tile.querySelector(".tile-thumb img");
      if (!img) return; // no image (folder icon, fallback, etc.) — stays at the default 1:1 aspect
      const setAspect = () => {
        if (img.naturalWidth && img.naturalHeight) {
          tile.dataset.aspect = img.naturalWidth / img.naturalHeight;
          scheduleRelayout();
        }
      };
      if (img.complete) setAspect();
      else img.addEventListener("load", setAspect, { once: true });
    });
    scheduleRelayout();
    const ro = new ResizeObserver(() => scheduleRelayout());
    ro.observe(container);
    container._masonryRO = ro; // not explicitly disconnected — GC'd along with the discarded container on next render
  }


  function buildGrid(items, canManage, groupLabel, scrollHost) {
    const grid = h("div", { class: "grid" });
    const tiles = items.map((it, idx) => buildTile(it, idx, items, canManage, groupLabel, scrollHost, grid));
    tiles.forEach(t => grid.appendChild(t));
    applyMasonryLayout(grid, tiles);
    return grid;
  }

  function itemKey(it) { return canonicalKey(it); }
  // BUGFIX: this used to be `it.vid || it.rel`. Every item browsed inside a
  // locked folder carries the SAME parent `vid` (only `rel` tells them
  // apart), so `it.vid` alone was always truthy and `it.rel` was never
  // reached — every file inside a given folder collapsed onto one identical
  // key. That made multi-select inside a folder behave erratically (picking
  // a second file could silently "toggle" the first one back off instead of
  // adding a new selection, since they looked like the same key), and could
  // also scramble manual drag order and lightbox sibling matching for
  // nested items. Combining both fields keeps root items keyed by their own
  // vid (unchanged) while giving nested items a key unique to their path.
  function canonicalKey(it) { return it.rel ? `${it.vid}::${it.rel}` : it.vid; }

  function workflowPrefs() { return prefGet("vault", "workflow", DEFAULT_WORKFLOW); }

  // Single click either opens (default) or selects, per the person's
  // Personal Workflow preference — the other action always stays available
  // as a double-click, so nothing is ever lost, just re-prioritized.
  function handlePrimaryClick(e, it, idx, siblings, canManage) {
    if (state.selectMode && canManage) { toggleSelect(itemKey(it)); return; }
    const clickMode = workflowPrefs().default_click;
    if (clickMode === "select" && canManage) { toggleSelect(itemKey(it)); return; }
    openItem(it, idx, siblings);
  }
  function handleSecondaryOpen(it, idx, siblings, canManage) {
    if (workflowPrefs().default_click === "select" && canManage) openItem(it, idx, siblings);
  }

  function buildTile(it, idx, siblings, canManage, groupLabel, scrollHost, gridEl) {
    const key = itemKey(it);
    const selected = state.selected.has(key);
    const eff = effectiveAppearance(it);
    // Photo/video files always flow at their real aspect ratio (masonry).
    // Folders do too, AS LONG AS they have a real thumbnail image to show —
    // an auto-detected preview (first photo found inside) or a custom one
    // the person set keeps its own true shape, exactly like a file. Only
    // tiles with no real image at all (icon-fallback folders, generic
    // files) keep the classic square cover, since an icon has no "true
    // shape" of its own. `freeAspect` (not `isMedia`) is what actually
    // drives the CSS below — see `coverStylePref` note further down.
    const isMedia = !it.is_dir && (it.cat === "image" || it.cat === "video");
    const thumbBox = h("div", { class: "tile-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: versionedThumbUrl(it), loading: "lazy" });
      img.addEventListener("error", () => {
        img.remove();
        thumbBox.classList.add("tile-thumb-fallback");
        thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir)));
      });
      thumbBox.appendChild(img);
    } else {
      thumbBox.classList.add("tile-thumb-fallback");
      thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir)));
    }

    const scrim = h("div", { class: "tile-scrim" },
      h("div", { class: "tile-name" }, it.display_name || it.name),
      h("div", { class: "tile-meta" }, it.size_h + (it.time_ago ? `  \u00B7  ${it.time_ago}` : ""))
    );

    // Badges are separate siblings (not nested in thumbBox) so they always
    // paint above the name/meta scrim, regardless of stacking order.
    const badges = h("div", { class: "tile-badges" });
    if (it.cat === "video") badges.appendChild(h("div", { class: "badge-play" }, h("div", { class: "circle", html: ICON.play })));
    if (it.is_dir) badges.appendChild(h("div", { class: "badge-folder" }, "\u{1F4C1}"));
    if (eff.icon) badges.appendChild(h("div", { class: "badge-custom-icon" }, eff.icon));
    if (it.pinned) badges.appendChild(h("div", { class: "badge-pin" }, "\u{1F4CC}"));

    const favBtn = h("button", {
      class: `tile-fav-btn ${it.favorite ? "active" : ""}`,
      title: it.favorite ? "Remove from Favorites" : "Add to Favorites",
    }, it.favorite ? "\u2605" : "\u2606");
    favBtn.addEventListener("click", (e) => toggleFavorite(it, e));

    const selBox = h("div", {
      class: "tile-select", onclick: (e) => { e.stopPropagation(); toggleSelect(key); }
    }, selected ? ICON.check : "");

    // Tile actions used to be a row of icon buttons pinned to the top-right
    // corner; with up to 8 of them that row ran wider than the tile itself
    // and got clipped. Instead, a single "more actions" (\u22EF) button opens a
    // popover grid of all the actions, layered over the tile with the
    // thumbnail blurred behind it.
    const actionDefs = [];
    if (canManage && !state.selectMode) {
      actionDefs.push({ icon: it.pinned ? "\u{1F4CC}" : "\u{1F4CD}", label: it.pinned ? "Unpin" : "Pin", fn: () => togglePinned(it) });
      actionDefs.push({ icon: "\u{1F3A8}", label: "Customize", fn: () => openCustomizeModal(it) });
      actionDefs.push({ icon: "\u270F\uFE0F", label: "Rename", fn: () => renameOne(it) });
      if (!it.is_dir && (it.cat === "image" || it.cat === "video")) {
        // No "Adjust thumb" (reposition/zoom) here anymore — media tiles
        // now show the file's real, uncropped frame, so there's no square
        // crop left to reposition.
        if (state.path.length > 0) {
          actionDefs.push({
            icon: "\u{1F4C1}", label: "Set as folder thumb",
            title: "Use this file as the thumbnail for the folder you're browsing",
            fn: () => setAsFolderThumb(it),
          });
        }
        if (it.cat === "video") {
          actionDefs.push({
            icon: "\u{1F3AC}", label: "Advanced frame extractor\u2026",
            title: "Every frame, every Nth frame, timestamps, ranges \u2014 and manual frame-by-frame browsing",
            fn: () => openAdvancedFrameExtractor(it),
          });
        }
        if (it.cat === "image") {
          actionDefs.push({
            icon: "\u2728", label: "Increase quality\u2026",
            title: "Upscale to 4K/8K with sharpening, then compare before/after",
            fn: () => openImageUpscaler(it),
          });
        }
      } else if (it.is_dir) {
        actionDefs.push({
          icon: "\u{1F5BC}\uFE0F", label: "Use background",
          title: "Use this folder's custom background as its thumbnail",
          fn: () => useFolderBackgroundAsThumb(it),
        });
        actionDefs.push({
          icon: "\u{1F5C2}\uFE0F", label: "Choose thumb",
          title: "Pick any photo or video from your vault as this folder's thumbnail",
          fn: () => chooseFolderThumbFromVault(it),
        });
        actionDefs.push({
          icon: "\u{1F9E9}", label: "Collage thumb",
          title: "Auto-generate a thumbnail collage from photos inside this folder",
          fn: () => generateFolderCollage(it),
        });
      }
      actionDefs.push({ icon: "\u{1F4C2}", label: "Restore to\u2026", fn: () => restoreOneChoose(it) });
      actionDefs.push({ icon: "\u{1F4E6}", label: "Move/Copy", fn: () => onMoveItem(it) });
      actionDefs.push({ icon: "\u{1F5D1}", label: "Delete", fn: () => deleteOne(it), danger: true });
    }

    const actions = h("div", { class: "tile-hover-actions" });
    const popover = h("div", { class: "tile-actions-popover" });
    let menuBtn = null;

    function closeMenu() {
      popover.classList.remove("open");
      tile.classList.remove("menu-open");
      if (menuBtn) menuBtn.classList.remove("active");
      document.removeEventListener("keydown", onEscKey, true);
      document.removeEventListener("click", onDocClick, true);
      if (activeTileMenuClose === closeMenu) activeTileMenuClose = null;
    }
    function onEscKey(e) { if (e.key === "Escape") closeMenu(); }
    function onDocClick(e) { if (!tile.contains(e.target)) closeMenu(); }
    function toggleMenu() {
      const wasOpen = popover.classList.contains("open");
      if (activeTileMenuClose) activeTileMenuClose();
      if (wasOpen) return;
      popover.classList.add("open");
      tile.classList.add("menu-open");
      if (menuBtn) menuBtn.classList.add("active");
      activeTileMenuClose = closeMenu;
      document.addEventListener("keydown", onEscKey, true);
      document.addEventListener("click", onDocClick, true);
    }

    if (actionDefs.length) {
      actionDefs.forEach((a) => {
        const pb = h("button", { class: `tile-popover-btn ${a.danger ? "danger" : ""}`, title: a.title || a.label },
          h("span", { class: "ic" }, a.icon), h("span", { class: "lb" }, a.label)
        );
        pb.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); a.fn(); });
        popover.appendChild(pb);
      });
      // Clicking the blurred backdrop area (not one of the buttons) just
      // closes the menu instead of falling through to open the item.
      popover.addEventListener("click", (e) => { e.stopPropagation(); if (e.target === popover) closeMenu(); });
      menuBtn = actBtn("\u22EF", "More actions", toggleMenu);
      menuBtn.classList.add("tile-menu-btn");
      actions.appendChild(menuBtn);
    }

    const coverCls = it.is_dir && coverStylePref() !== "classic" ? `cover-${coverStylePref()}` : "";
    // A folder only free-flows at its thumbnail's real aspect ratio under
    // the default "classic" cover style — "poster"/"glass" are a deliberate
    // fixed-shape choice the person picked in Settings, so those keep the
    // uniform card regardless of what the underlying thumbnail looks like.
    // Files always free-flow (there's no fixed-shape option for files).
    const freeAspect = !!it.thumb_url && (isMedia || coverStylePref() === "classic");
    const tile = h("div", { class: `tile ${freeAspect ? "masonry-tile" : ""} ${selected ? "selected" : ""} ${eff.color ? "has-accent" : ""} ${coverCls}`,
                             style: eff.color ? `--accent-color:${eff.color};` : "" },
      thumbBox, scrim, badges, favBtn, selBox, actions, popover
    );
    tile.addEventListener("click", (e) => handlePrimaryClick(e, it, idx, siblings, canManage));
    tile.addEventListener("dblclick", () => handleSecondaryOpen(it, idx, siblings, canManage));
    if (canManage && !state.selectMode && gridEl && scrollHost) {
      attachDragReorder(tile, it, idx, siblings, groupLabel, scrollHost, gridEl, true);
    }
    return tile;
  }

  function actBtn(icon, title, fn, danger) {
    const b = h("button", { class: `tile-action-btn ${danger ? "danger" : ""}`, title }, icon);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function buildList(items, canManage, groupLabel, scrollHost) {
    const list = h("div", { class: "list" });
    list.appendChild(h("div", { class: "list-hdr" },
      h("div", { style: "width:32px" }), h("div", { style: "width:38px" }),
      h("div", { class: "list-name" }, "Name"),
      h("div", { class: "list-col type" }, "Type"), h("div", { class: "list-col" }, "Size"),
      h("div", { class: "list-col" }, "Added"), h("div", { style: "width:190px" })
    ));
    items.forEach((it, idx) => list.appendChild(buildRow(it, idx, items, canManage, groupLabel, scrollHost, list)));
    return list;
  }

  function buildRow(it, idx, siblings, canManage, groupLabel, scrollHost, listEl) {
    const key = itemKey(it);
    const selected = state.selected.has(key);
    const eff = effectiveAppearance(it);
    const check = h("div", {
      class: "list-check", onclick: (e) => { e.stopPropagation(); toggleSelect(key); }
    }, selected ? ICON.check : "");
    const thumb = h("div", { class: "list-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: versionedThumbUrl(it) });
      img.addEventListener("error", () => { img.remove(); thumb.textContent = catIcon(it.cat, it.is_dir); });
      thumb.appendChild(img);
    } else thumb.textContent = catIcon(it.cat, it.is_dir);

    const row = h("div", { class: `list-row ${selected ? "selected" : ""} ${eff.color ? "has-accent" : ""}`,
                            style: eff.color ? `--accent-color:${eff.color};` : "" },
      check, thumb,
      h("div", { class: "list-name" },
        it.pinned ? h("span", { class: "pin-dot", title: "Pinned" }, "\u{1F4CC}") : null,
        eff.icon ? h("span", { class: "list-custom-icon" }, eff.icon) : null,
        it.display_name || it.name),
      h("div", { class: "list-col type" }, it.is_dir ? "Folder" : (it.ext || it.cat).replace(".", "").toUpperCase()),
      h("div", { class: "list-col" }, it.size_h),
      h("div", { class: "list-col" }, it.time_ago || ""),
    );
    const favBtn = h("button", {
      class: `list-fav-btn ${it.favorite ? "active" : ""}`,
      title: it.favorite ? "Remove from Favorites" : "Add to Favorites",
    }, it.favorite ? "\u2605" : "\u2606");
    favBtn.addEventListener("click", (e) => toggleFavorite(it, e));
    row.insertBefore(favBtn, row.children[2]);
    const actions = h("div", { class: "list-actions" });
    if (canManage) {
      actions.appendChild(actBtn(it.pinned ? "\u{1F4CC}" : "\u{1F4CD}", it.pinned ? "Unpin" : "Pin to top", () => togglePinned(it)));
      actions.appendChild(actBtn("\u{1F3A8}", "Customize\u2026", () => openCustomizeModal(it)));
      actions.appendChild(actBtn("\u270F\uFE0F", "Rename", () => renameOne(it)));
      if (!it.is_dir && (it.cat === "image" || it.cat === "video")) {
        if (state.path.length > 0) {
          actions.appendChild(actBtn("\u{1F4C1}", "Set as folder thumbnail", () => setAsFolderThumb(it)));
        }
      }
      actions.appendChild(actBtn("\u{1F4C2}", "Restore to folder\u2026", () => restoreOneChoose(it)));
      actions.appendChild(actBtn("\u{1F4E6}", "Move / Copy\u2026", () => onMoveItem(it)));
      actions.appendChild(actBtn("\u{1F5D1}", "Delete", () => deleteOne(it), true));
    }
    row.appendChild(actions);
    row.addEventListener("click", (e) => handlePrimaryClick(e, it, idx, siblings, canManage));
    row.addEventListener("dblclick", () => handleSecondaryOpen(it, idx, siblings, canManage));
    if (canManage && !state.selectMode && listEl && scrollHost) {
      attachDragReorder(row, it, idx, siblings, groupLabel, scrollHost, listEl, false);
    }
    return row;
  }

  // ════════════════════════════════════════════════════════════════════════
  // DRAG-TO-REORDER (Manual Sort) — press-and-hold, then drag, with a drop
  // indicator and edge auto-scroll. Purely a display-order change: it only
  // ever writes to Phase 0 prefs, never touches the underlying encrypted
  // files. Disabled while in select mode (drag would be ambiguous there).
  // ════════════════════════════════════════════════════════════════════════
  const DRAG_HOLD_MS = 220;
  const DRAG_MOVE_CANCEL_PX = 6;
  const AUTO_SCROLL_EDGE_PX = 56;
  const AUTO_SCROLL_MAX_SPEED = 18;

  function attachDragReorder(el, item, idx, siblingsRef, groupLabel, scrollHost, containerEl, isGrid) {
    let holdTimer = null, dragging = false, startX = 0, startY = 0, pointerId = null;
    let order = siblingsRef.slice(); // local working copy, reindexed as tiles get inserted
    let dropIndex = idx;
    let indicator = null;

    function cleanupHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest(".tile-action-btn, .tile-select, .list-check, select, input, button")) return;
      startX = e.clientX; startY = e.clientY; pointerId = e.pointerId;
      cleanupHold();
      holdTimer = setTimeout(() => engageDrag(e), DRAG_HOLD_MS);
      const onEarlyMove = (me) => {
        if (Math.hypot(me.clientX - startX, me.clientY - startY) > DRAG_MOVE_CANCEL_PX && !dragging) {
          cleanupHold();
          el.removeEventListener("pointermove", onEarlyMove);
        }
      };
      el.addEventListener("pointermove", onEarlyMove);
      const onEarlyUp = () => { cleanupHold(); el.removeEventListener("pointermove", onEarlyMove); el.removeEventListener("pointerup", onEarlyUp); };
      el.addEventListener("pointerup", onEarlyUp, { once: true });
    });

    function engageDrag(e) {
      dragging = true;
      order = siblingsRef.slice();
      dropIndex = idx;
      el.classList.add("drag-source");
      try { el.setPointerCapture(pointerId); } catch (_) {}
      indicator = h("div", { class: isGrid ? "drop-indicator-grid" : "drop-indicator-list" });
      containerEl.appendChild(indicator);
      positionIndicator(idx);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp, { once: true });
      el.addEventListener("pointercancel", onUp, { once: true });
    }

    function childEls() {
      return Array.from(containerEl.children).filter(c => c !== indicator);
    }

    function positionIndicator(atIndex) {
      const kids = childEls();
      const ref = kids[atIndex] || null;
      if (ref) containerEl.insertBefore(indicator, ref);
      else containerEl.appendChild(indicator);
    }

    function nearestIndexForPoint(x, y) {
      const kids = childEls().filter(k => k !== el);
      if (!kids.length) return 0;
      let closest = kids[0], bestDist = Infinity;
      kids.forEach((k) => {
        const r = k.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const dist = isGrid ? Math.hypot(x - cx, y - cy) : Math.abs(y - cy);
        if (dist < bestDist) { bestDist = dist; closest = k; }
      });
      const r = closest.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const isBefore = y < cy;
      let domIndex = childEls().indexOf(closest);
      if (domIndex === -1) domIndex = order.length;
      return isBefore ? domIndex : domIndex + 1;
    }
    let lastClientY = 0, lastClientX = 0, scrollRaf = null;
    function runAutoScroll() {
      const r = scrollHost.getBoundingClientRect();
      let dy = 0;
      if (lastClientY < r.top + AUTO_SCROLL_EDGE_PX) {
        const t = (r.top + AUTO_SCROLL_EDGE_PX - lastClientY) / AUTO_SCROLL_EDGE_PX;
        dy = -Math.ceil(t * AUTO_SCROLL_MAX_SPEED);
      } else if (lastClientY > r.bottom - AUTO_SCROLL_EDGE_PX) {
        const t = (lastClientY - (r.bottom - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX;
        dy = Math.ceil(t * AUTO_SCROLL_MAX_SPEED);
      }
      if (dy !== 0) scrollHost.scrollTop += dy;
      scrollRaf = requestAnimationFrame(runAutoScroll);
    }

    function onMove(e) {
      if (!dragging) return;
      lastClientX = e.clientX; lastClientY = e.clientY;
      if (!scrollRaf) scrollRaf = requestAnimationFrame(runAutoScroll);
      dropIndex = nearestIndexForPoint(e.clientX, e.clientY);
      positionIndicator(Math.min(dropIndex, childEls().length));
      el.style.transform = "scale(0.97)";
    }

    function onUp() {
      if (!dragging) { cleanupHold(); return; }
      dragging = false;
      if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
      el.removeEventListener("pointermove", onMove);
      el.classList.remove("drag-source");
      el.style.transform = "";
      if (indicator && indicator.parentNode) indicator.remove();

      const from = order.findIndex(o => itemKey(o) === itemKey(item));
      let to = dropIndex;
      if (from === -1) return;
      const reordered = order.slice();
      const [moved] = reordered.splice(from, 1);
      if (to > from) to -= 1;
      reordered.splice(Math.max(0, Math.min(to, reordered.length)), 0, moved);

      // Switch to manual sort mode (if not already) and persist, then
      // re-render this content area in place with the new arrangement.
      (async () => {
        const cur = currentSort();
        if (cur.mode !== "manual") await prefSet("vault", `sort:${folderKey()}`, { mode: "manual", dir: cur.dir || "asc" });
        await persistManualOrder(reordered, groupLabel);
        renderContentInPlace();
      })();
    }
  }

  function toggleSelect(key) {
    if (state.selected.has(key)) state.selected.delete(key); else state.selected.add(key);
    state.selectMode = true;
    updateSelectionUI();
  }

  // ── Single-item restore / delete / move-copy ────────────────────────────
  async function restoreOne(it, dest) {
    if (workflowPrefs().confirm_restore) {
      const yes = await confirmDanger(`Restore "${it.name}"?`,
        dest ? "This will restore it to the folder you chose." : "This restores it to its original location on disk.",
        "Restore");
      if (!yes) return;
    }
    const t = effectiveTarget(it);
    const res = t.rel
      ? await api.restore_nested_item(t.vid, t.rel, dest)
      : await api.restore_item(t.vid, dest);
    toast(res.ok ? `Restored "${it.name}"` : `Failed: ${res.result}`, res.ok ? "success" : "error");
    if (res.ok) { await loadCurrentView(); render(); }
  }
  // Reloads whichever screen is actually on-screen after an item-level
  // action (rename/delete/thumbnail change/…). loadCurrentView() alone
  // only refreshes state.items (state.path-based gallery browsing) — the
  // Albums and Favorites screens keep their own separate item lists
  // (state.albumsItems / state.favoritesItems), so an action taken from
  // one of those screens needs its own reload or the change wouldn't show
  // up until navigating away and back.
  async function refreshAfterItemAction() {
    if (state.view === "albums") { await loadAlbums(); return; }
    if (state.view === "faceGroups") { await loadFaceGroupContainers(); return; }
    if (state.view === "faceGroupContainer") { await loadContainerFaceGroups(); return; }
    if (state.view === "albumDetail") { await loadAlbumDetail(); return; }
    if (state.view === "favorites") { await loadFavorites(); return; }
    await loadCurrentView();
  }

  async function restoreOneChoose(it) {
    const dest = await api.choose_folder();
    if (!dest) return;
    restoreOne(it, dest);
  }
  async function deleteOne(it) {
    if (workflowPrefs().confirm_delete !== false) {
      const yes = await confirmDanger(`Delete "${it.name}"?`,
        isAlbumItem(it)
          ? "This permanently deletes the album itself. Nothing collected into it is touched \u2014 every file stays exactly where it already lives in your vault. This cannot be undone."
          : "This permanently deletes it from the vault. This cannot be undone.",
        "Delete");
      if (!yes) return;
    }
    const t = effectiveTarget(it);
    const res = t.rel
      ? await api.delete_nested_item(t.vid, t.rel)
      : await api.delete_item(t.vid);
    if (res.ok && isAlbumItem(it)) {
      // The album folder itself is gone — strip the now-dangling
      // album_ids pointer from every item that was collected into it, same
      // cleanup the soft "Remove from Albums" (✕) does, so nothing keeps
      // referencing an album that no longer exists.
      await api.clear_album_membership(t.vid);
    }
    toast(res.ok ? `Deleted "${it.name}"` : `Failed: ${res.result}`, res.ok ? "success" : "error");
    if (res.ok) { await refreshAfterItemAction(); render(); }
  }
  async function onMoveItem(it) {
    const folders = await api.list_vault_folders();
    const choice = await moveTargetModal(it.name, folders);
    if (!choice) return;
    const t = effectiveTarget(it);
    const res = await api.move_item(t.vid, t.rel, choice.vid, choice.rel, choice.copy);
    if (res.ok) {
      toast(`${choice.copy ? "Copied" : "Moved"} "${it.name}"`, "success");
      await loadCurrentView(); render();
    } else {
      toast(res.result || "Couldn't move/copy that item", "error");
    }
  }

  async function renameOne(it) {
    const newName = await modal({
      title: "Rename",
      body: `Choose a new name for "${it.name}".`,
      input: { placeholder: "New name", value: it.name },
      buttons: [
        { label: "Cancel", value: false, variant: "btn-ghost" },
        { label: "Rename", value: true, variant: "btn-primary" },
      ]
    });
    if (!newName || newName === it.name) return;
    const t = effectiveTarget(it);
    const res = t.rel
      ? await api.rename_nested_item(t.vid, t.rel, newName)
      : await api.rename_item(t.vid, newName);
    if (res.ok) { toast("Renamed", "success"); await refreshAfterItemAction(); render(); }
    else toast(res.result || "Couldn't rename", "error");
  }
  // Uses this file (must be inside a folder, i.e. not a root item) as the
  // thumbnail for the folder currently being browsed. The file's own
  // picture/frame is used as-is, at its own real aspect ratio — there's no
  // position/zoom step anymore (that used to force every folder thumbnail
  // into a square crop, which is exactly why folder tiles wouldn't match
  // their real photo's shape).
  async function setAsFolderThumb(it) {
    const t = effectiveTarget(it);
    if (!t.rel) return; // only makes sense for items found while browsing inside a folder
    // Applies to whichever folder is currently being browsed — the top of
    // the path stack — so this naturally works for child/nested folders
    // too, not just the top-level vault item.
    const top = state.path[state.path.length - 1];
    // Fetched as a data: URL straight through the JS bridge, rather than
    // loading it.thumb_url (an http:// URL to the media server) into an
    // <img crossorigin> — that requires a CORS header matching the exact
    // origin the OS webview reports, which doesn't hold in every
    // environment. A data: URL never leaves this process, so there's no
    // cross-origin request to satisfy in the first place.
    const prev = await api.get_item_preview_data_url(t.vid, t.rel);
    if (!prev.ok) { toast(prev.error || "Couldn't load that file", "error"); return; }
    const res = await api.set_folder_thumbnail_from_crop(t.vid, top.rel || null, prev.data_url);
    if (res.ok) { bumpThumbVersion(t.vid, top.rel || null); toast("Folder thumbnail updated", "success"); await loadCurrentView(); render(); }
    else toast(res.result || "Couldn't set thumbnail", "error");
  }
  // A folder can already have a custom background picked (Customize\u2026 \u2192
  // Folder background). This reuses that same picture as the folder's own
  // thumbnail, at its own real aspect ratio, instead of requiring a
  // separate image to be chosen just for that. It targets the folder `it`
  // itself (root-level vault item, or a nested folder), not whichever
  // folder happens to currently be open.
  async function useFolderBackgroundAsThumb(it) {
    const bg = it.background;
    const atRoot = state.path.length === 0;
    const vid = atRoot ? it.vid : state.path[state.path.length - 1].vid;
    const folderRel = atRoot ? "" : it.rel;
    if (!bg || !bg.vid) {
      toast("This folder doesn't have a custom background set yet \u2014 set one from Customize\u2026 first", "error");
      return;
    }
    const prev = await api.get_item_preview_data_url(bg.vid, bg.rel || null);
    if (!prev.ok) { toast(prev.error || "Couldn't load that background image", "error"); return; }
    const res = await api.set_folder_thumbnail_from_crop(vid, folderRel || null, prev.data_url);
    if (res.ok) { bumpThumbVersion(vid, folderRel || null); toast("Thumbnail set from folder background", "success"); await refreshAfterItemAction(); render(); }
    else toast(res.result || "Couldn't set thumbnail from background", "error");
  }
  // Lets a folder's thumbnail be picked from ANY photo/video anywhere in
  // the vault, not just something already inside this particular folder —
  // useful especially when the folder (and its subfolders) don't have
  // anything the automatic preview could use on its own. Same vault-wide
  // browser as "Choose from vault\u2026" for backgrounds, reused here with
  // videos allowed too, since a plain "Set thumb" already allows them. The
  // chosen file is used as-is, at its own real aspect ratio.
  async function chooseFolderThumbFromVault(it) {
    const atRoot = state.path.length === 0;
    const vid = atRoot ? it.vid : state.path[state.path.length - 1].vid;
    const folderRel = atRoot ? "" : it.rel;
    const isAlbum = isAlbumItem(it);
    // Scoped to this folder's own subtree — otherwise picking a thumbnail
    // routed through the whole vault from the root, forcing a trip back
    // down through every parent just to reach files already inside the
    // very folder being customized. An album has no subtree of its own
    // (its members physically live elsewhere — see list_album_items), so
    // scoping the picker to it would always show an empty folder; browse
    // the whole vault instead.
    const choice = await vaultImagePickerModal({
      title: "Choose a thumbnail from your vault",
      hint: isAlbum
        ? "Pick any photo or video anywhere in your vault \u2014 it'll be used as this album's thumbnail."
        : "Browse into this folder and pick any photo or video \u2014 it'll be used as this folder's thumbnail.",
      allowVideo: true,
      scopeRoot: isAlbum ? null : { vid, rel: folderRel || null, name: it.name },
    });
    if (!choice) return;
    const prev = await api.get_item_preview_data_url(choice.vid, choice.rel);
    if (!prev.ok) { toast(prev.error || "Couldn't load that file", "error"); return; }
    const res = await api.set_folder_thumbnail_from_crop(vid, folderRel || null, prev.data_url);
    if (res.ok) { bumpThumbVersion(vid, folderRel || null); toast("Thumbnail updated", "success"); await refreshAfterItemAction(); render(); }
    else toast(res.result || "Couldn't set thumbnail", "error");
  }

  // Smart Thumbnail Collage: auto-picks up to 4 photos/frames found inside
  // the folder (same depth-first order the single-image auto-preview
  // uses) and combines them into one composite thumbnail, generated
  // server-side and cached the same way a manually-cropped thumbnail is —
  // either can overwrite the other at any time.
  async function generateFolderCollage(it) {
    const atRoot = state.path.length === 0;
    const vid = atRoot ? it.vid : state.path[state.path.length - 1].vid;
    const folderRel = atRoot ? "" : it.rel;
    // For an album, the backend automatically sources candidate photos
    // from its collected members (list_album_items) instead of scanning
    // a physical subtree, which is always empty for an album — see
    // find_album_preview_multi() in vault_core.py.
    const res = await api.generate_folder_collage(vid, folderRel || null);
    if (res.ok) {
      bumpThumbVersion(vid, folderRel || null);
      toast("Collage thumbnail generated", "success");
      await refreshAfterItemAction(); render();
    } else {
      toast(res.error || (isAlbumItem(it)
        ? "Couldn't generate a collage \u2014 collect a photo into this album first"
        : "Couldn't generate a collage \u2014 try adding a photo first"), "error");
    }
  }

  // ── Opening items (folders navigate in-place, media opens the lightbox) ─
  async function openItem(it, idx, siblings) {
    if (it.is_dir) {
      const atRoot = state.path.length === 0;
      const vid = atRoot ? it.vid : state.path[state.path.length - 1].vid;
      const rel = atRoot ? "" : it.rel;
      state.path.push({
        vid, rel, name: it.name,
        background: it.background || null, color: it.color || null, icon: it.icon || null,
        displayName: it.display_name || null, description: it.description || null, tags: it.tags || [],
        emptyState: (it.metadata && it.metadata.empty_state) || null,
      });
      await loadCurrentView();
      render();
      return;
    }
    const t = effectiveTarget(it);
    api.record_opened(t.vid, t.rel || null); // fire-and-forget; skipped server-side if history is off
    if (it.cat === "image" || it.cat === "video") {
      const mediaSiblings = siblings.filter(s => !s.is_dir && s.cat === it.cat);
      openLightbox(mediaSiblings, mediaSiblings.findIndex(s => itemKey(s) === itemKey(it)));
      return;
    }
    // audio / pdf / text / other → hand off to the system app
    if (workflowPrefs().confirm_open_external) {
      const yes = await confirmDanger(`Open "${it.name}" in its default app?`,
        "It will be decrypted to a temporary file for the external app to read, then deleted automatically once that app closes it.",
        "Open");
      if (!yes) return;
    }
    await api.open_with_system(t.vid, t.rel || null);
  }

  // ════════════════════════════════════════════════════════════════════════
  // LIGHTBOX (image viewer + video player) — in-window, never a new window
  // ════════════════════════════════════════════════════════════════════════
  let _closeActiveLightbox = null;

  function openLightbox(items, index) {
    if (_closeActiveLightbox) _closeActiveLightbox();
    const host = document.getElementById("lightbox-host");
    host.innerHTML = "";
    let i = index;
    const viewerPrefs = prefGet("viewer", "appearance", DEFAULT_VIEWER);
    host.className = `lb-bg-${viewerPrefs.background_style || "dark"}`;

    // Zoom/pan state for the image viewer — reset whenever the shown item
    // changes, unless "remember zoom" is on, in which case the zoom level
    // (not the pan offset — that stays image-relative) carries over to the
    // next item you view in this same session.
    let zoom = 1, panX = 0, panY = 0, dragging = false, dragStart = null;
    let rememberedZoom = 1;
    let imgEl = null;
    let videoEl = null;

    // Full screen targets the persistent #lightbox-host container (not the
    // inner .lightbox box, which gets torn down and rebuilt every time you
    // move to the next/previous item) — otherwise navigating while in full
    // screen would remove the fullscreen element from the DOM and silently
    // kick the browser back out of full screen on every arrow-key press.
    function isFullscreen() { return !!document.fullscreenElement; }
    function toggleFullscreen() {
      if (!isFullscreen()) {
        const req = host.requestFullscreen || host.webkitRequestFullscreen;
        if (req) req.call(host);
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
    }
    function onFsChange() {
      host.classList.toggle("lb-fullscreen", isFullscreen());
      const btn = host.querySelector(".lb-fs-btn");
      if (btn) {
        btn.textContent = isFullscreen() ? "\u2921" : "\u26F6";
        btn.title = isFullscreen() ? "Exit full screen (F)" : "Full screen (F)";
      }
    }
    document.addEventListener("fullscreenchange", onFsChange);

    function onKey(e) {
      if (e.key === "Escape") {
        // First Escape just exits full screen (the browser already does
        // this on its own); only close the viewer on a second press.
        if (isFullscreen()) return;
        close();
      }
      else if (e.key === "ArrowLeft" && items.length > 1 && zoom <= 1) { i = (i - 1 + items.length) % items.length; draw(); }
      else if (e.key === "ArrowRight" && items.length > 1 && zoom <= 1) { i = (i + 1) % items.length; draw(); }
      else if (e.key.toLowerCase() === "f") { toggleFullscreen(); }
      else if ((e.key === "+" || e.key === "=") && imgEl) { setZoom(zoom + 0.25); }
      else if (e.key === "-" && imgEl) { setZoom(zoom - 0.25); }
      else if (e.key === "0" && imgEl) { setZoom(1); }
    }
    document.addEventListener("keydown", onKey);
    _closeActiveLightbox = close;

    function applyTransform() {
      if (!imgEl) return;
      imgEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    }
    function setZoom(z) {
      zoom = Math.min(5, Math.max(1, z));
      if (zoom === 1) { panX = 0; panY = 0; }
      if (viewerPrefs.remember_zoom) rememberedZoom = zoom;
      applyTransform();
      if (imgEl) imgEl.style.cursor = zoom > 1 ? "grab" : "default";
      const label = host.querySelector(".lb-zoom-pct");
      if (label) label.textContent = `${Math.round(zoom * 100)}%`;
    }

    // Custom Viewer Appearance: "controls visible" off means the bar/nav
    // fade out after a couple seconds of no mouse movement and reappear on
    // the next movement — a cleaner immersive view without losing access.
    let autoHideTimer = null;
    function armControlsAutoHide(box, bar) {
      box.classList.add("lb-autohide-armed");
      const show = () => {
        box.classList.remove("lb-controls-hidden");
        if (autoHideTimer) clearTimeout(autoHideTimer);
        autoHideTimer = setTimeout(() => box.classList.add("lb-controls-hidden"), 2200);
      };
      box.addEventListener("mousemove", show);
      show();
    }

    function draw() {
      host.innerHTML = "";
      zoom = (viewerPrefs.remember_zoom && items[i].cat === "image") ? rememberedZoom : 1;
      panX = 0; panY = 0; dragging = false; imgEl = null; videoEl = null;
      const it = items[i];
      const zoomControls = it.cat === "image" ? h("div", { class: "lb-zoom" },
        h("button", { class: "lb-btn", title: "Zoom out (-)", onclick: () => setZoom(zoom - 0.25) }, "\u2212"),
        h("span", { class: "lb-zoom-pct" }, "100%"),
        h("button", { class: "lb-btn", title: "Zoom in (+)", onclick: () => setZoom(zoom + 0.25) }, "\uFF0B"),
        h("button", { class: "lb-btn", title: "Reset zoom (0)", onclick: () => setZoom(1) }, "Reset"),
      ) : null;
      // Snapshot: grab whatever frame the video is currently sitting on
      // (playing or paused, wherever the person scrubbed/paused it) and
      // save it as its own photo. Disabled while metadata hasn't loaded
      // yet (currentTime isn't meaningful before that).
      const snapshotBtn = it.cat === "video"
        ? h("button", { class: "lb-btn", title: "Save the current frame as a photo", disabled: true },
            "\u{1F4F8} Snapshot")
        : null;
      if (snapshotBtn) {
        snapshotBtn.addEventListener("click", () => { if (videoEl) openVideoSnapshotModal(it, videoEl); });
      }
      const upscaleBtn = it.cat === "image"
        ? h("button", { class: "lb-btn", title: "Increase quality (upscale + sharpen)" }, "\u2728 Increase Quality")
        : null;
      if (upscaleBtn) {
        upscaleBtn.addEventListener("click", () => openImageUpscaler(it, {
          onSaved: (action) => {
            if (action === "overwrite") {
              const t2 = effectiveTarget(it);
              bumpThumbVersion(t2.vid, t2.rel || null);
              it.media_url = it.media_url + (it.media_url.includes("?") ? "&" : "?") + "v=" + Date.now();
              draw();
            }
          },
        }));
      }
      const bar = h("div", { class: "lb-bar" },
        h("span", { class: "lb-title" }, it.name),
        h("span", { class: "lb-counter" }, `${i + 1} / ${items.length}`),
        zoomControls,
        snapshotBtn,
        upscaleBtn,
        h("div", { class: "lb-spacer" }),
        h("button", { class: "lb-btn lb-fs-btn", title: "Full screen (F)", onclick: toggleFullscreen }, "\u26F6"),
        h("button", { class: "lb-btn", title: "Close (Esc)", onclick: close }, "\u2715")
      );
      const stage = h("div", { class: "lb-stage" });
      if (items.length > 1) {
        stage.appendChild(h("button", { class: "lb-nav prev", onclick: () => { if (zoom > 1) return; i = (i - 1 + items.length) % items.length; draw(); } }, "\u2039"));
        stage.appendChild(h("button", { class: "lb-nav next", onclick: () => { if (zoom > 1) return; i = (i + 1) % items.length; draw(); } }, "\u203A"));
      }

      const box = h("div", { class: `lightbox ${viewerPrefs.background_style === "blurred" ? "lb-blurred-bg" : ""}` });
      if (viewerPrefs.background_style === "blurred") {
        box.appendChild(h("img", { class: "lb-blur-backdrop", src: it.media_url, "aria-hidden": "true" }));
      }
      box.appendChild(bar);
      if (!viewerPrefs.controls_visible) armControlsAutoHide(box, bar);
      if (it.cat === "image") {
        imgEl = h("img", { src: it.media_url, draggable: "false" });

        stage.addEventListener("wheel", (e) => {
          e.preventDefault();
          setZoom(zoom + (e.deltaY < 0 ? 0.2 : -0.2));
        }, { passive: false });
        stage.addEventListener("dblclick", () => setZoom(zoom > 1 ? 1 : 2));

        // Pointer Events (not mouse events) so this also works with touch,
        // and setPointerCapture keeps the drag going even if the pointer
        // moves faster than the image or leaves the stage bounds.
        stage.addEventListener("pointerdown", (e) => {
          if (zoom <= 1) return;
          e.preventDefault();
          dragging = true;
          dragStart = { x: e.clientX - panX, y: e.clientY - panY };
          imgEl.style.cursor = "grabbing";
          try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        });
        stage.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          panX = e.clientX - dragStart.x;
          panY = e.clientY - dragStart.y;
          applyTransform();
        });
        const endDrag = (e) => {
          if (!dragging) return;
          dragging = false;
          imgEl.style.cursor = zoom > 1 ? "grab" : "default";
          try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        stage.addEventListener("pointerup", endDrag);
        stage.addEventListener("pointercancel", endDrag);

        stage.appendChild(imgEl);
        box.appendChild(stage);
      } else {
        videoEl = h("video", {
          src: it.media_url, controls: "controls",
          autoplay: viewerPrefs.autoplay_video === false ? undefined : "autoplay",
          loop: viewerPrefs.loop_video ? "loop" : undefined,
        });
        // The snapshot button needs a real currentTime to grab, which
        // isn't meaningful until the browser has loaded enough of the
        // video to know its duration/frames — keep it disabled until then.
        videoEl.addEventListener("loadedmetadata", () => { if (snapshotBtn) snapshotBtn.disabled = false; }, { once: true });
        stage.appendChild(videoEl);
        box.appendChild(stage);
      }
      host.appendChild(box);
    }
    function close() {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
      if (autoHideTimer) clearTimeout(autoHideTimer);
      if (isFullscreen()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
      host.innerHTML = "";
      if (_closeActiveLightbox === close) _closeActiveLightbox = null;
    }
    draw();
  }

  // Opens a small "where should this go" picker for a video snapshot —
  // same destination-folder control (existing folder dropdown + "Create
  // new folder…") the Advanced Frame Extractor uses, just without any of
  // that dialog's extraction-mode options, since this is always exactly
  // one frame: whichever one the player is sitting on right now.
  function openVideoSnapshotModal(it, videoEl) {
    const timestamp = videoEl.currentTime || 0;
    const wasPlaying = !videoEl.paused;
    // Freeze on the exact frame about to be captured — clearer feedback
    // than letting playback keep moving while the person picks a folder.
    videoEl.pause();
    function resumeIfNeeded() { if (wasPlaying) videoEl.play().catch(() => {}); }

    const totalSecs = Math.max(0, Math.floor(timestamp));
    const hh = Math.floor(totalSecs / 3600), mm = Math.floor((totalSecs % 3600) / 60), ss = totalSecs % 60;
    const pad = (n) => String(n).padStart(2, "0");
    const label = hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;

    (async () => {
      const t = effectiveTarget(it);
      // list_vault_folders() includes a leading "My Vault (root)" pseudo-
      // entry (vid:null) for the Move/Copy picker — that one isn't an
      // actual folder with somewhere to attach new files, so it's
      // excluded here, same as the other video tools.
      const folders = (await api.list_vault_folders()).filter(f => f.vid);
      const dest = buildDestFolderControl(folders);
      const saveBtn = h("button", { class: "btn btn-primary" }, "Save Snapshot");
      const cancelBtn = h("button", { class: "btn btn-ghost" }, "Cancel");

      const { close } = gtCloseableModal(h("div", {},
        h("h3", {}, `Save snapshot \u2014 "${it.name}"`),
        h("p", {}, `Saves the frame at ${label} as its own photo.`),
        h("label", { class: "gt-field-label" }, "Save into"),
        dest.destSelect, dest.newNameInput,
        h("div", { class: "row", style: "margin-top:16px;" }, cancelBtn, saveBtn),
      ));
      cancelBtn.addEventListener("click", () => { close(); resumeIfNeeded(); });

      saveBtn.addEventListener("click", async () => {
        const destResolved = await dest.resolveDest();
        if (!destResolved) return;
        saveBtn.disabled = true; saveBtn.textContent = "Saving\u2026";
        const res = await api.capture_video_snapshot(t.vid, t.rel || null, timestamp, destResolved.vid, destResolved.rel || null);
        if (res.ok) {
          toast(`Saved snapshot "${res.result}"`, "success");
          close();
          await refreshAfterItemAction(); render();
          resumeIfNeeded();
        } else {
          toast(res.result || "Couldn't save that snapshot", "error");
          saveBtn.disabled = false; saveBtn.textContent = "Save Snapshot";
        }
      });
    })();
  }

  // ════════════════════════════════════════════════════════════════════════
  // SETTINGS
  // ════════════════════════════════════════════════════════════════════════
  function busyModal(text) {
    const host = document.getElementById("modal-host");
    const backdrop = h("div", { class: "modal-backdrop" });
    const box = h("div", { class: "modal", style: "text-align:center;width:320px;" },
      h("div", { class: "spinner" }),
      h("p", { style: "margin-top:14px;" }, text)
    );
    backdrop.appendChild(box);
    host.appendChild(backdrop);
    return () => backdrop.remove();
  }

  // ── small settings-row builders shared by the new Phase 1 cards ─────────
  function settingsCheckboxRow(label, sub, checked, onChange) {
    const box = h("input", { type: "checkbox" });
    box.checked = !!checked;
    box.addEventListener("change", () => onChange(box.checked));
    return h("div", { class: "settings-row" },
      h("div", {}, h("div", { class: "label" }, label), sub ? h("div", { class: "sub" }, sub) : null),
      box
    );
  }
  function settingsSelectRow(label, sub, options, current, onChange) {
    const sel = h("select", {},
      ...options.map(o => h("option", { value: String(o.v), selected: String(o.v) === String(current) }, o.label))
    );
    sel.addEventListener("change", () => onChange(sel.value));
    return h("div", { class: "settings-row" },
      h("div", {}, h("div", { class: "label" }, label), sub ? h("div", { class: "sub" }, sub) : null),
      sel
    );
  }

  function renderWorkflowCard() {
    const wf = { ...DEFAULT_WORKFLOW, ...prefGet("vault", "workflow", {}) };
    async function update(patch) { await prefSet("vault", "workflow", { ...wf, ...patch }); render(); }
    return h("div", { class: "settings-card" },
      h("h3", {}, "Workflow"),
      h("p", { class: "desc" }, "Tune how a single click behaves, which actions ask you to confirm first, and where you land after logging in."),
      settingsSelectRow("Single click on an item", "The other action is always still one double-click away.",
        [{ v: "open", label: "Opens it" }, { v: "select", label: "Selects it" }],
        wf.default_click, (v) => update({ default_click: v })),
      settingsSelectRow("After logging in, show", null,
        [{ v: "gallery", label: "My vault" }, { v: "dashboard", label: "Dashboard" }, { v: "settings", label: "Settings" }],
        wf.default_landing, (v) => update({ default_landing: v })),
      settingsCheckboxRow("Confirm before deleting", "Off = deletes immediately when you click Delete.",
        wf.confirm_delete, (v) => update({ confirm_delete: v })),
      settingsCheckboxRow("Confirm before restoring", null, wf.confirm_restore, (v) => update({ confirm_restore: v })),
      settingsCheckboxRow("Confirm before opening in an external app", null,
        wf.confirm_open_external, (v) => update({ confirm_open_external: v })),
    );
  }

  function renderViewerCard() {
    const vp = { ...DEFAULT_VIEWER, ...prefGet("viewer", "appearance", {}) };
    async function update(patch) { await prefSet("viewer", "appearance", { ...vp, ...patch }); render(); }
    return h("div", { class: "settings-card" },
      h("h3", {}, "Viewer"),
      h("p", { class: "desc" }, "How the full-screen photo and video viewer looks and behaves."),
      settingsSelectRow("Background", null,
        [{ v: "dark", label: "Dark" }, { v: "blurred", label: "Blurred photo" }, { v: "black", label: "Black" }],
        vp.background_style, (v) => update({ background_style: v })),
      settingsCheckboxRow("Always show controls", "Off = the toolbar fades out and reappears on mouse movement.",
        vp.controls_visible, (v) => update({ controls_visible: v })),
      settingsCheckboxRow("Remember zoom level between photos", null, vp.remember_zoom, (v) => update({ remember_zoom: v })),
      settingsCheckboxRow("Autoplay videos", null, vp.autoplay_video, (v) => update({ autoplay_video: v })),
      settingsCheckboxRow("Loop videos", null, vp.loop_video, (v) => update({ loop_video: v })),
    );
  }

  function renderPrivacyCard() {
    const pv = { ...DEFAULT_PRIVACY, ...prefGet("vault", "privacy", {}) };
    async function update(patch) { await prefSet("vault", "privacy", { ...pv, ...patch }); armAutoLock(); render(); }
    const clearBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Clear temporary decrypted files now");
    clearBtn.addEventListener("click", async () => {
      const res = await api.clear_temp_files();
      toast(res.ok ? `Cleared ${res.removed} temporary file(s)` : "Couldn't clear temp files", res.ok ? "success" : "error");
    });
    return h("div", { class: "settings-card" },
      h("h3", {}, "Privacy"),
      settingsSelectRow("Auto-lock after inactivity", null, AUTO_LOCK_OPTIONS, pv.auto_lock_minutes,
        (v) => update({ auto_lock_minutes: parseInt(v, 10) })),
      settingsCheckboxRow("Remember recently-opened items", "Powers the \u201CRecently opened\u201D sort option. Off = nothing is recorded.",
        pv.history_enabled, (v) => update({ history_enabled: v })),
      settingsCheckboxRow("Privacy screen when the window loses focus", "Frosts the window instantly when you Alt-Tab away or a screen-share starts.",
        pv.privacy_screen_enabled, (v) => update({ privacy_screen_enabled: v })),
      settingsCheckboxRow("Remember folder state", "Resume in the same folder (and scroll position) next time you log in, instead of always starting at the top. Off by default.",
        pv.remember_folder_state, async (v) => {
          if (!v) {
            // Turning it off also forgets what was already recorded — an
            // opt-out should actually stop the tracking, not just stop
            // adding to it.
            await prefSet("vault", "last_path", null);
            const scrollKeys = Object.keys(state.prefs.vault || {}).filter(k => k.startsWith("scroll:"));
            for (const k of scrollKeys) await prefSet("vault", k, null);
          }
          update({ remember_folder_state: v });
        }),
      h("div", { class: "settings-row" },
        h("div", {}, h("div", { class: "label" }, "Temporary decrypted files"),
          h("div", { class: "sub" }, "Files opened in an external app are decrypted to a temp folder and deleted automatically once that app closes them.")),
        clearBtn
      ),
    );
  }

  function renderQuickHideCard() {
    if (state.isDecoy) return null;
    const qh = { ...DEFAULT_QUICK_HIDE, ...prefGet("vault", "quick_hide", {}) };
    async function update(patch) { await prefSet("vault", "quick_hide", { ...qh, ...patch }); render(); }
    return h("div", { class: "settings-card" },
      h("h3", {}, "Quick-hide disguise"),
      h("p", { class: "desc" }, `Press ${shortcutCombo("quick_hide").replace(/\+/g, " + ")} any time to instantly cover the window with one of these. Your master password dismisses it, no matter which one is active.`),
      settingsSelectRow("Disguise screen", null, [
        { v: "clock", label: "Clock" }, { v: "update", label: "Installing updates" }, { v: "browser", label: "Browser error page" },
      ], qh.mode, (v) => update({ mode: v })),
    );
  }

  function renderShortcutsCard() {
    const rows = Object.keys(DEFAULT_SHORTCUTS)
      .filter(action => !(state.isDecoy && action === "quick_hide"))
      .map(action => {
      const def = DEFAULT_SHORTCUTS[action];
      const combo = shortcutCombo(action);
      const display = combo.split("+").map(p => p[0].toUpperCase() + p.slice(1)).join(" + ");
      const conflict = Object.keys(DEFAULT_SHORTCUTS).some(other => other !== action &&
        !(state.isDecoy && other === "quick_hide") && shortcutCombo(other) === combo);
      const keyBtn = h("button", { class: `btn btn-ghost btn-sm shortcut-key ${conflict ? "conflict" : ""}` }, display);
      keyBtn.addEventListener("click", () => {
        keyBtn.textContent = "Press keys\u2026";
        keyBtn.classList.add("recording");
        const onCapture = async (e) => {
          e.preventDefault();
          if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
          if (!e.ctrlKey && !e.altKey) {
            toast("Shortcuts need Ctrl or Alt held down, so they never collide with normal typing", "error");
            document.removeEventListener("keydown", onCapture, true);
            keyBtn.classList.remove("recording");
            render();
            return;
          }
          const newCombo = normalizeCombo(e);
          document.removeEventListener("keydown", onCapture, true);
          await prefSet("shortcuts", action, newCombo);
          render();
        };
        document.addEventListener("keydown", onCapture, true);
      });
      const resetBtn = h("button", {
        class: "btn btn-ghost btn-sm", title: "Reset to default",
        onclick: async () => { await prefSet("shortcuts", action, def.keys); render(); },
      }, "\u21BA");
      return h("div", { class: "settings-row" },
        h("div", {}, h("div", { class: "label" }, def.label)),
        h("div", { style: "display:flex;gap:8px;align-items:center;" }, keyBtn, resetBtn)
      );
    });
    return h("div", { class: "settings-card" },
      h("h3", {}, "Keyboard shortcuts"),
      h("p", { class: "desc" }, "Click a combo to change it. Conflicting shortcuts are highlighted \u2014 only one of them will fire."),
      ...rows
    );
  }

  function renderFactoryResetCard() {
    return h("div", { class: "settings-card" },
      h("h3", {}, "Factory reset"),
      h("p", { class: "desc" }, "Erases absolutely everything: both vaults, every password, every preference, cached thumbnails, and temporary files. There is no undo."),
      h("button", { class: "btn btn-danger", onclick: onFactoryReset }, "\u26A0\uFE0F Erase everything and start over")
    );
  }
  async function onFactoryReset() {
    const pw = await modal({
      title: "Factory reset",
      body: "Enter your current master password to continue.",
      input: { type: "password", placeholder: "Master password" },
      buttons: [{ label: "Cancel", value: false, variant: "btn-ghost" }, { label: "Continue", value: true, variant: "btn-danger" }],
    });
    if (!pw) return;
    const phrase = await modal({
      title: "Type to confirm",
      body: 'This cannot be undone. Type <b>DELETE EVERYTHING</b> exactly to proceed.',
      input: { placeholder: "DELETE EVERYTHING" },
      buttons: [{ label: "Cancel", value: false, variant: "btn-ghost" }, { label: "Erase everything", value: true, variant: "btn-danger" }],
    });
    if (!phrase) return;
    const closeBusy = busyModal("Erasing everything\u2026");
    const res = await api.factory_reset(pw, phrase);
    closeBusy();
    if (!res.ok) { toast(res.error || "Factory reset failed", "error"); return; }
    state.screen = "setup"; state.hasVault = false; state.entering = false; state.covered = false;
    toast("Everything has been erased", "success");
    render();
  }

  function renderStorageLocationRow() {
    const pathEl = h("div", { class: "label", style: "max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" }, "Loading\u2026");
    const subEl = h("div", { class: "sub" }, "");
    const changeBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Change location\u2026");
    changeBtn.addEventListener("click", async () => {
      const picked = await api.choose_location();
      if (!picked) return;
      const yes = await modal({
        title: "Move vault to new location?",
        body: `This moves every locked file and folder to:<br><b>${esc(picked.path)}</b><br><br>${esc(picked.free_h)} free there. This may take a while for a large vault — don't close the app while it's moving.`,
        buttons: [
          { label: "Cancel", value: false, variant: "btn-ghost" },
          { label: "Move vault", value: true, variant: "btn-primary" },
        ]
      });
      if (!yes) return;
      const closeBusy = busyModal("Moving your vault\u2026 this can take a while for large vaults.");
      const res = await api.move_vault(picked.path);
      closeBusy();
      if (res.ok) {
        toast("Vault moved successfully", "success");
        refreshStorageRow();
      } else {
        toast(res.result || "Couldn't move the vault", "error");
      }
    });
    async function refreshStorageRow() {
      const info = await api.get_storage_info();
      pathEl.textContent = info.path;
      subEl.textContent = `${info.used_h} used \u00B7 ${info.free_h} free on ${info.drive}`;
    }
    refreshStorageRow();
    return h("div", { class: "settings-row" },
      h("div", {}, pathEl, subEl),
      changeBtn
    );
  }

  function renderAppearanceCard() {
    const swatches = h("div", { style: "display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;" });
    GRADIENTS.forEach(g => {
      const active = state.uiPrefs && state.uiPrefs.type === "gradient" && state.uiPrefs.gradient_id === g.id;
      const sw = h("div", {
        title: g.label,
        style: `width:44px;height:44px;border-radius:10px;cursor:pointer;background:${g.css};` +
               `border:2px solid ${active ? "var(--accent3)" : "transparent"};box-shadow:${active ? "0 0 0 2px var(--accent3-bg)" : "none"};`,
        onclick: async () => {
          const res = await api.set_background("gradient", g.id);
          applyBackground(res.prefs);
          render();
        }
      });
      swatches.appendChild(sw);
    });

    const imageBtn = h("button", { class: "btn btn-ghost btn-sm" }, "\u{1F5BC}\uFE0F Choose image\u2026");
    imageBtn.addEventListener("click", onChooseSystemImage);
    const vaultBtn = h("button", { class: "btn btn-ghost btn-sm" }, "\u{1F5C2}\uFE0F Choose from vault\u2026");
    vaultBtn.addEventListener("click", onChooseBackgroundFromVault);
    const dynamicBtn = h("button", { class: "btn btn-ghost btn-sm" },
      state.uiPrefs && state.uiPrefs.type === "dynamic" ? "\u2728 Regenerate from my photos" : "\u2728 Generate from my photos");
    dynamicBtn.addEventListener("click", onGenerateDynamicBackground);
    const resetBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Use default");
    resetBtn.addEventListener("click", async () => {
      const res = await api.set_background("default");
      applyBackground(res.prefs);
      render();
    });
    const buttons = [imageBtn, vaultBtn, dynamicBtn, resetBtn];
    if (state.uiPrefs && state.uiPrefs.type === "image") {
      const adjustBtn = h("button", { class: "btn btn-ghost btn-sm" }, "\u{1F3AF} Adjust position/zoom\u2026");
      adjustBtn.addEventListener("click", async () => {
        await runBackgroundEditor();
      });
      buttons.splice(2, 0, adjustBtn);
    }

    return h("div", { class: "settings-card" },
      h("h3", {}, "Appearance"),
      h("p", { class: "desc" }, "Pick a gradient, use a photo as the background, or auto-generate one from your own vault photos \u2014 nothing chosen from the vault ever leaves it unencrypted except the single image you explicitly pick as wallpaper."),
      swatches,
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;" }, buttons)
    );
  }

  function renderFolderStyleCard() {
    const layout = prefGet("vault", "layout", { folder_cover_style: "classic" });
    const styleSelect = settingsSelectRow("Folder cover style", "How folder tiles look in the gallery.",
      [{ v: "classic", label: "Classic" }, { v: "poster", label: "Poster" }, { v: "glass", label: "Glass" }],
      layout.folder_cover_style || "classic",
      async (v) => { await prefSet("vault", "layout", { ...layout, folder_cover_style: v }); renderContentInPlace(); });

    const profiles = getProfiles();
    const list = h("div", { class: "profile-list" },
      ...(profiles.length ? profiles.map(p => h("div", { class: "settings-row" },
        h("div", {},
          h("div", { class: "label" }, p.name),
          h("div", { class: "sub" }, [
            p.color ? "color" : null, p.icon ? "icon" : null, p.background ? "background" : null,
            p.sort ? `sort: ${p.sort.mode}` : null, p.viewMode ? `view: ${p.viewMode}` : null,
          ].filter(Boolean).join(" \u00B7 ") || "empty profile"),
        ),
        (() => {
          const del = h("button", { class: "btn btn-ghost btn-sm" }, "Delete");
          del.addEventListener("click", async () => {
            const yes = await confirmDanger(`Delete profile "${p.name}"?`, "Folders that already used it keep their current look \u2014 this only removes it from the list.", "Delete");
            if (yes) { await deleteProfile(p.name); render(); }
          });
          return del;
        })()
      )) : [h("div", { class: "sub" }, "No saved profiles yet \u2014 create one from a folder's Customize dialog.")])
    );

    // Phase 5.1: read-only overview of every rule across every folder, for
    // inspectability from Settings — full create/edit/delete lives in each
    // folder's own Identity panel (Interaction tab), since rules are
    // folder-specific; this is just "can I see them all in one place."
    const allRules = getRules();
    const rulesList = h("div", { class: "profile-list" },
      ...(allRules.length ? allRules.map(r => h("div", { class: "settings-row" },
        h("div", {},
          h("div", { class: "label" }, keyForFolder(r.vid, r.rel)),
          h("div", { class: "sub" }, `${ruleSummary(r)}${r.enabled ? "" : " (disabled)"}`),
        ),
        (() => {
          const del = h("button", { class: "btn btn-ghost btn-sm" }, "Delete");
          del.addEventListener("click", async () => { await deleteRule(r.id); render(); });
          return del;
        })()
      )) : [h("div", { class: "sub" }, "No rules set up yet \u2014 add one from a folder's Customize dialog (Interaction tab).")])
    );

    return h("div", { class: "settings-card" },
      h("h3", {}, "Folders"),
      styleSelect,
      h("div", { class: "customize-section-label", style: "margin-top:14px;" }, "Saved appearance profiles"),
      list,
      h("div", { class: "customize-section-label", style: "margin-top:14px;" }, "Folder rules (all folders)"),
      rulesList,
    );
  }

  async function onGenerateDynamicBackground() {
    toast("Generating a background from your photos\u2026", "info");
    const res = await api.generate_dynamic_background();
    if (!res.ok) { toast(res.error || "Couldn't generate a background \u2014 add some photos first", "error"); return; }
    applyBackground(res.prefs);
    render();
    toast("Background generated from your vault photos", "success");
  }

  async function onChooseSystemImage() {
    const res = await api.choose_background_image();
    if (!res.ok) { if (res.error) toast(res.error, "error"); return; }
    applyBackground(res.prefs);
    render();
    await runBackgroundEditor();
  }

  async function onChooseBackgroundFromVault() {
    const choice = await vaultImagePickerModal();
    if (!choice) return;
    const res = await api.set_background_from_vault(choice.vid, choice.rel);
    if (!res.ok) { toast(res.error || "Couldn't use that image", "error"); return; }
    applyBackground(res.prefs);
    render();
    await runBackgroundEditor();
  }

  // Opens the position/zoom editor on the CURRENT background image and,
  // if the person applies their crop, saves the result as the new
  // background. Always re-fetches the image itself as a data: URL rather
  // than trusting a passed-in http:// one — the editor's <img crossorigin>
  // needs a CORS header matching the exact origin the OS webview reports,
  // which isn't guaranteed across environments, so an http:// URL here can
  // render as a broken image even though the same URL works fine as a
  // plain (non-crossorigin) CSS background elsewhere. See
  // get_background_preview_data_url() for the full rationale.
  async function runBackgroundEditor() {
    const prev = await api.get_background_preview_data_url();
    if (!prev.ok) { toast(prev.error || "Couldn't load that image", "error"); return; }
    const screenW = window.screen.width || 1920;
    const screenH = window.screen.height || 1080;
    const dataUrl = await openImageFitEditor(prev.data_url, {
      aspect: screenW / screenH, frameW: 560, outMaxW: Math.min(screenW, 2560),
      title: "Position & zoom your background",
      hint: "Drag to reposition, scroll (or use the buttons) to zoom \u2014 the frame below is exactly what will show behind the app.",
    });
    if (!dataUrl) return; // cancelled — the uncropped version stays as a fallback
    const res = await api.save_background_data_url(dataUrl);
    if (res.ok) { applyBackground(res.prefs); toast("Background updated", "success"); render(); }
    else toast(res.error || "Couldn't save background", "error");
  }

  // ── Position/zoom editor: fit a chosen photo into a frame of the given
  // aspect ratio. Only the app background still uses this — folder/file
  // thumbnails no longer go through a crop step at all (see
  // setAsFolderThumb / useFolderBackgroundAsThumb / chooseFolderThumbFromVault
  // above), so every thumbnail keeps its own real, uncropped aspect ratio.
  function openImageFitEditor(url, { aspect, frameW, outMaxW, title, hint }) {
    return new Promise((resolve) => {
      const host = document.getElementById("modal-host");
      const backdrop = h("div", { class: "modal-backdrop" });

      const frameH = Math.round(frameW / aspect);

      const img = h("img", { src: url, draggable: "false", class: "bg-edit-img", crossorigin: "anonymous" });
      const frame = h("div", { class: "bg-edit-frame", style: `width:${frameW}px;height:${frameH}px;` }, img);

      // Despite draggable="false", Chromium/WebView2 can still kick off a
      // native HTML5 image drag (a "ghost" drag-and-drop) on mousedown+move
      // over an <img>. Once that starts, the browser stops sending
      // pointermove/mousemove for the rest of the gesture — it sends drag
      // events instead, which nothing here listens for — so panning looks
      // completely dead even though pointerdown/pointerup still fire fine.
      // Explicitly cancelling dragstart (on the image AND the frame, since
      // either can be the drag source depending on where the pointer lands)
      // is what actually stops it; preventDefault() on pointerdown alone is
      // too late, because dragstart only fires after that.
      img.addEventListener("dragstart", (e) => e.preventDefault());
      frame.addEventListener("dragstart", (e) => e.preventDefault());
      img.ondragstart = () => false;

      let natW = 0, natH = 0, minScale = 1, scale = 1, panX = 0, panY = 0;
      let dragging = false, dragStart = null, ready = false;

      // If the image never actually loads (bad data, unreadable file,
      // etc.) the frame would otherwise just sit there forever with no
      // feedback, and clicking Apply would silently do nothing (drawImage
      // throws on a zero-size source and nothing was catching it — the
      // "the adjust button doesn't work" symptom). Surface it instead.
      img.addEventListener("error", () => {
        toast("Couldn't load that image", "error");
        close();
        resolve(null);
      });

      function clampPan() {
        const dispW = natW * scale, dispH = natH * scale;
        const maxX = Math.max(0, (dispW - frameW) / 2);
        const maxY = Math.max(0, (dispH - frameH) / 2);
        panX = Math.min(maxX, Math.max(-maxX, panX));
        panY = Math.min(maxY, Math.max(-maxY, panY));
      }
      function apply() {
        if (!ready) return;
        clampPan();
        img.style.transform = `translate(-50%,-50%) translate(${panX}px, ${panY}px) scale(${scale})`;
        const label = host.querySelector(".bg-edit-zoom-pct");
        if (label) label.textContent = `${Math.round((scale / minScale) * 100)}%`;
      }
      function setScale(s) {
        scale = Math.min(minScale * 4, Math.max(minScale, s));
        apply();
      }

      // The starting zoom shown when the editor first opens. Using the
      // exact "cover" scale (minScale) here means whichever dimension —
      // width or height — happens to match the frame exactly has ZERO
      // slack to drag in: for a background frame (wide, ~16:9) and a
      // photo whose aspect ratio is wider than that, the image's height
      // lands flush with the frame's height at minScale, so dragging up
      // or down visibly does nothing until the person zooms in first —
      // which reads as "the image doesn't move." Starting a little past
      // minScale guarantees a bit of room in BOTH directions right away,
      // regardless of the source image's own aspect ratio. minScale
      // itself is kept as-is (still the floor for zooming back out via
      // Reset/double-click/the − button), so nothing else changes.
      const START_OVERSCAN = 1.15;
      // BUGFIX: a flat 15% overscan only gives comfortable room when the
      // source image's aspect ratio already differs noticeably from the
      // frame's — which is true the FIRST time you pick a photo, but not
      // when re-opening "Adjust position/zoom…" on a background that's
      // already been saved once. A saved background was itself exported
      // to exactly the frame's aspect ratio, so on re-opening BOTH
      // dimensions are equally tight at once, and 15% of that shrinks to
      // just a few px of pan room inside a ~560px-wide preview — easy to
      // miss entirely, which is exactly what read as "dragging doesn't
      // work, only for an already-fixed background." Guaranteeing a
      // minimum amount of pan room in real pixels (not just a percentage)
      // fixes that case without changing anything for a fresh photo,
      // where the percentage-based overscan already provides plenty.
      const MIN_PAN_PX = 60;

      img.addEventListener("load", () => {
        natW = img.naturalWidth || 1; natH = img.naturalHeight || 1;
        minScale = Math.max(frameW / natW, frameH / natH);
        let s = minScale * START_OVERSCAN;
        const tightestPanPx = Math.min((natW * s - frameW) / 2, (natH * s - frameH) / 2);
        if (tightestPanPx < MIN_PAN_PX) {
          const neededForW = (frameW + 2 * MIN_PAN_PX) / natW;
          const neededForH = (frameH + 2 * MIN_PAN_PX) / natH;
          s = Math.max(s, neededForW, neededForH);
        }
        scale = s; panX = 0; panY = 0; ready = true;
        apply();
      });

      frame.addEventListener("wheel", (e) => {
        e.preventDefault();
        setScale(scale * (e.deltaY < 0 ? 1.08 : 0.92));
      }, { passive: false });
      frame.addEventListener("dblclick", () => { scale = minScale; panX = 0; panY = 0; apply(); });
      frame.addEventListener("pointerdown", (e) => {
        if (!ready) return;
        e.preventDefault();
        dragging = true;
        dragStart = { x: e.clientX - panX, y: e.clientY - panY };
        frame.style.cursor = "grabbing";
        try { frame.setPointerCapture(e.pointerId); } catch (_) {}
      });
      frame.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        panX = e.clientX - dragStart.x;
        panY = e.clientY - dragStart.y;
        apply();
      });
      const endDrag = (e) => {
        dragging = false;
        frame.style.cursor = "grab";
        try { frame.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      frame.addEventListener("pointerup", endDrag);
      frame.addEventListener("pointercancel", endDrag);

      const zoomRow = h("div", { class: "bg-edit-zoom-row" },
        h("button", { class: "btn btn-ghost btn-icon", title: "Zoom out", onclick: () => setScale(scale * 0.9) }, "\u2212"),
        h("span", { class: "bg-edit-zoom-pct" }, "100%"),
        h("button", { class: "btn btn-ghost btn-icon", title: "Zoom in", onclick: () => setScale(scale * 1.1) }, "\uFF0B"),
        h("button", { class: "btn btn-ghost btn-sm", title: "Reset", onclick: () => { scale = minScale; panX = 0; panY = 0; apply(); } }, "Reset"),
      );

      function exportCrop() {
        // Guards against a zero-size drawImage() call (which throws) if
        // the image somehow never finished loading by the time Apply was
        // clicked — that used to fail silently and leave the dialog stuck.
        if (!ready || !natW || !natH) return null;
        // Renders at (up to) outMaxW so the result looks sharp instead of
        // stretched/pixelated, using exactly what's inside the frame above.
        const outW = outMaxW;
        const outH = Math.round(outW / aspect);
        const canvas = document.createElement("canvas");
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext("2d");
        const k = outW / frameW; // preview px -> output px
        const dispW = natW * scale * k, dispH = natH * scale * k;
        const dx = outW / 2 - dispW / 2 + panX * k;
        const dy = outH / 2 - dispH / 2 + panY * k;
        ctx.drawImage(img, dx, dy, dispW, dispH);
        try {
          return canvas.toDataURL("image/jpeg", 0.92);
        } catch (e) {
          return null;
        }
      }

      const box = h("div", { class: "modal bg-edit-modal" },
        h("h3", {}, title),
        h("p", {}, hint),
        frame,
        zoomRow,
        h("div", { class: "row" },
          h("button", { class: "btn btn-ghost", onclick: () => { close(); resolve(null); } }, "Cancel"),
          h("button", {
            class: "btn btn-primary",
            onclick: () => {
              let d = null;
              try { d = exportCrop(); } catch (e) { d = null; }
              close();
              if (!d) toast("Couldn't process that image", "error");
              resolve(d);
            }
          }, "Apply"),
        )
      );
      backdrop.appendChild(box);
      host.appendChild(backdrop);
      function close() { backdrop.remove(); }
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 4.1: HIERARCHICAL STORAGE VISUALIZATION — a bar-per-item view of
  // what's taking up space, with folders clickable to drill down. Uses
  // folder_stats() (recursive size/count rollup over the tree manifest,
  // built in Phase 3) rather than the possibly-stale cached size on a
  // folder's own index entry, so this always reflects what's on disk now.
  // Entirely separate navigation state from the main browsing state, so
  // exploring it never disturbs where you actually are in the vault.
  // ════════════════════════════════════════════════════════════════════════
  function openStorageVisualizer() {
    const host = document.getElementById("modal-host");
    const backdrop = h("div", { class: "modal-backdrop" });
    let vizPath = []; // stack of {vid, rel, name} — [] = vault root

    const crumbBar = h("div", { class: "vault-picker-crumbs" });
    const list = h("div", { class: "storage-viz-list" });
    const status = h("div", { class: "vault-picker-status" }, "Loading\u2026");

    const box = h("div", { class: "modal storage-viz-modal" },
      h("h3", {}, "Storage breakdown"),
      h("p", {}, "Biggest items first. Click a folder to see what's inside it."),
      crumbBar, status, list,
      h("div", { class: "row" }, h("button", { class: "btn btn-ghost", onclick: () => close() }, "Close"))
    );
    backdrop.appendChild(box);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    host.appendChild(backdrop);
    function close() { backdrop.remove(); }

    function renderCrumbs() {
      crumbBar.innerHTML = "";
      crumbBar.appendChild(h("span", { class: "crumb", onclick: () => loadLevel([]) }, "My Vault"));
      vizPath.forEach((p, i) => {
        crumbBar.appendChild(h("span", {}, " / "));
        crumbBar.appendChild(h("span", { class: "crumb", onclick: () => loadLevel(vizPath.slice(0, i + 1)) }, p.name));
      });
    }

    async function loadLevel(newPath) {
      vizPath = newPath;
      renderCrumbs();
      list.innerHTML = "";
      status.classList.remove("hidden");
      status.textContent = "Loading\u2026";

      let rawItems;
      if (vizPath.length === 0) {
        rawItems = await api.list_root();
      } else {
        const top = vizPath[vizPath.length - 1];
        const res = await api.browse(top.vid, top.rel);
        rawItems = res.ok ? res.items : [];
      }

      // Live recursive size for every folder shown at this level — the
      // cached `size` on the index entry can lag behind actual contents.
      const withLiveSize = await Promise.all(rawItems.map(async (it) => {
        if (!it.is_dir) return { ...it, liveSize: it.size };
        const sres = await api.folder_stats(it.vid, it.rel || null);
        return { ...it, liveSize: sres.ok ? sres.stats.size : it.size, liveStats: sres.ok ? sres.stats : null };
      }));

      status.classList.add("hidden");
      list.innerHTML = "";
      if (!withLiveSize.length) {
        list.appendChild(h("div", { class: "dashboard-empty" }, "Nothing here."));
        return;
      }
      const sorted = withLiveSize.sort((a, b) => b.liveSize - a.liveSize);
      const maxSize = Math.max(1, ...sorted.map(i => i.liveSize));
      sorted.forEach(it => {
        const pct = Math.max(2, Math.round((it.liveSize / maxSize) * 100));
        const row = h("div", { class: `storage-viz-row ${it.is_dir ? "clickable" : ""}` },
          h("div", { class: "storage-viz-icon" }, catIcon(it.cat, it.is_dir)),
          h("div", { class: "storage-viz-info" },
            h("div", { class: "storage-viz-name" }, it.display_name || it.name),
            h("div", { class: "storage-viz-bar-track" }, h("div", { class: "storage-viz-bar-fill", style: `width:${pct}%` })),
          ),
          h("div", { class: "storage-viz-size" },
            it.is_dir && it.liveStats
              ? `${human_size_client(it.liveSize)} \u00B7 ${it.liveStats.file_count} file${it.liveStats.file_count === 1 ? "" : "s"}`
              : human_size_client(it.liveSize)
          ),
        );
        if (it.is_dir) row.addEventListener("click", () => loadLevel([...vizPath, { vid: it.vid, rel: it.rel, name: it.display_name || it.name }]));
        list.appendChild(row);
      });
    }

    loadLevel([]);
  }
  // Sizes already come formatted from the backend (size_h) for the current
  // item, but drilled-down folder sizes are computed live client-side from
  // raw bytes, so a small formatter is needed here too.
  function human_size_client(n) {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n, i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 4.4: DUPLICATE FINDER — content-hash scan, never auto-deletes.
  // Every deletion here is ALWAYS confirmed regardless of the Workflow
  // "confirm before delete" setting (that toggle is for routine single-item
  // deletes; bulk duplicate removal is exactly the kind of action the hard
  // constraint calls out as needing its own unconditional confirmation).
  // ════════════════════════════════════════════════════════════════════════
  function openDuplicateFinder() {
    const host = document.getElementById("modal-host");
    const backdrop = h("div", { class: "modal-backdrop" });
    let groups = [];
    // keySet of items marked for deletion, keyed by `${vid}:${rel||""}`
    const marked = new Set();
    const dupKey = (it) => `${it.vid}:${it.rel || ""}`;

    const status = h("div", { class: "vault-picker-status" }, "Scanning your vault for duplicate files\u2026");
    const list = h("div", { class: "storage-viz-list" });
    const summary = h("div", { class: "sub" }, "");
    const deleteBtn = h("button", { class: "btn btn-danger", disabled: true }, "Delete selected");

    const box = h("div", { class: "modal dup-finder-modal" },
      h("h3", {}, "Find duplicate files"),
      h("p", {}, "Files with byte-identical content, anywhere in your vault \u2014 including inside folders. Nothing is deleted until you choose and confirm."),
      status, list, summary,
      h("div", { class: "row" },
        h("button", { class: "btn btn-ghost", onclick: () => close() }, "Close"),
        deleteBtn,
      )
    );
    backdrop.appendChild(box);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    host.appendChild(backdrop);
    function close() { backdrop.remove(); }

    function updateSummary() {
      const n = marked.size;
      summary.textContent = n ? `${n} file${n === 1 ? "" : "s"} selected for deletion.` : "";
      deleteBtn.disabled = n === 0;
    }

    function renderGroups() {
      list.innerHTML = "";
      if (!groups.length) {
        list.appendChild(h("div", { class: "dashboard-empty" }, "No duplicate files found \u2014 your vault is already tidy."));
        return;
      }
      groups.forEach((g, gi) => {
        const groupEl = h("div", { class: "dup-group" },
          h("div", { class: "dup-group-hdr" }, `${g.count} copies \u00B7 ${human_size_client(g.size)} each \u00B7 ${human_size_client(g.size * (g.count - 1))} recoverable`)
        );
        g.items.forEach((it, ii) => {
          const cb = h("input", { type: "checkbox" });
          // Pre-check every copy except the first in each group, so the
          // default selection is "keep one, remove the rest" — the person
          // can still uncheck/recheck any individual copy before deleting.
          cb.checked = ii > 0;
          if (cb.checked) marked.add(dupKey(it));
          cb.addEventListener("change", () => {
            if (cb.checked) marked.add(dupKey(it)); else marked.delete(dupKey(it));
            updateSummary();
          });
          const row = h("div", { class: "dup-item-row" },
            cb,
            h("img", { class: "dup-item-thumb", src: versionedThumbUrl(it) }),
            h("div", { class: "dup-item-info" },
              h("div", { class: "dup-item-name" }, it.name),
              h("div", { class: "dup-item-path" }, it.path_breadcrumb || "Vault root"),
            ),
          );
          groupEl.appendChild(row);
        });
        list.appendChild(groupEl);
      });
      updateSummary();
    }

    deleteBtn.addEventListener("click", async () => {
      const allItems = groups.flatMap(g => g.items).filter(it => marked.has(dupKey(it)));
      if (!allItems.length) return;
      const yes = await confirmDanger(
        `Delete ${allItems.length} duplicate file${allItems.length === 1 ? "" : "s"}?`,
        "This permanently removes the selected copies from the vault. This cannot be undone \u2014 double-check you're not deleting the only copy of anything you want to keep.",
        "Delete permanently"
      );
      if (!yes) return;
      deleteBtn.disabled = true;
      let okCount = 0, failCount = 0;
      for (const it of allItems) {
        const res = it.rel ? await api.delete_nested_item(it.vid, it.rel) : await api.delete_item(it.vid);
        if (res.ok) okCount++; else failCount++;
      }
      toast(`Deleted ${okCount} file${okCount === 1 ? "" : "s"}` + (failCount ? ` \u2014 ${failCount} failed` : ""),
            failCount ? "error" : "success");
      marked.clear();
      await loadCurrentView(); // refresh whatever's behind the modal too
      await scan();
    });

    async function scan() {
      status.classList.remove("hidden");
      status.textContent = "Scanning your vault for duplicate files\u2026";
      list.innerHTML = ""; summary.textContent = "";
      const res = await api.find_duplicates();
      groups = res.ok ? res.groups : [];
      status.classList.add("hidden");
      renderGroups();
    }
    scan();
  }

  function vaultImagePickerModal(opts) {
    const {
      title = "Choose a background from your vault",
      hint = "Browse into folders and pick any photo \u2014 it stays encrypted; only a plain copy is used for the background.",
      allowVideo = false,
      // When set ({vid, rel, name}), the picker is scoped to that
      // folder's own subtree — it opens straight into that folder's
      // children instead of the vault root, and there's no way to
      // navigate above it. Used when choosing a folder's own thumbnail,
      // so picking it never routes through the whole vault: only files
      // and sub-folders actually inside the folder being customized are
      // ever shown.
      scopeRoot = null,
    } = opts || {};
    return new Promise((resolve) => {
      const host = document.getElementById("modal-host");
      const backdrop = h("div", { class: "modal-backdrop" });

      let path = []; // stack of {vid, rel, name} beneath scopeRoot (or the vault root, if no scopeRoot)

      const crumbBar = h("div", { class: "vault-picker-crumbs" });
      const grid = h("div", { class: "vault-picker-grid" });
      const status = h("div", { class: "vault-picker-status hidden" });

      const box = h("div", { class: "modal vault-picker-modal" },
        h("h3", {}, title),
        h("p", {}, hint),
        crumbBar,
        grid,
        status,
        h("div", { class: "row" },
          h("button", { class: "btn btn-ghost", onclick: () => { close(); resolve(null); } }, "Cancel"),
        )
      );
      backdrop.appendChild(box);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { close(); resolve(null); } });
      host.appendChild(backdrop);
      function close() { backdrop.remove(); }

      // The folder currently being browsed — either the deepest entry on
      // `path`, or scopeRoot itself when path is empty, or (with no
      // scopeRoot at all) null, meaning the real vault root.
      function currentTop() {
        if (path.length > 0) return path[path.length - 1];
        return scopeRoot || null;
      }

      // Resolves the {vid, rel} a clicked item (folder or image) refers to,
      // whether it's a root-level item (its own vid) or something found
      // while browsing inside a folder (rel path under the current top).
      function targetFor(it) {
        if (!scopeRoot && it.vid) return { vid: it.vid, rel: null };
        const top = currentTop();
        return { vid: top.vid, rel: it.rel };
      }

      function renderCrumbs() {
        crumbBar.innerHTML = "";
        const rootLabel = scopeRoot ? `\u{1F4C1} ${scopeRoot.name}` : "\u{1F5C2}\uFE0F My Vault";
        const home = h("span", { class: "vault-picker-crumb" + (path.length === 0 ? " current" : "") }, rootLabel);
        if (path.length > 0) home.addEventListener("click", () => { path = []; load(); });
        crumbBar.appendChild(home);
        path.forEach((p, idx) => {
          crumbBar.appendChild(h("span", { class: "vault-picker-crumb-sep" }, "\u203A"));
          const isCurrent = idx === path.length - 1;
          const seg = h("span", { class: "vault-picker-crumb" + (isCurrent ? " current" : "") }, p.name);
          if (!isCurrent) seg.addEventListener("click", () => { path = path.slice(0, idx + 1); load(); });
          crumbBar.appendChild(seg);
        });
      }

      async function load() {
        renderCrumbs();
        grid.innerHTML = "";
        status.classList.remove("hidden");
        status.textContent = "Loading\u2026";

        let items;
        const top = currentTop();
        if (!top) {
          items = await api.list_root();
        } else {
          const res = await api.browse(top.vid, top.rel);
          items = res.ok ? res.items : [];
        }
        // Only folders (to browse into) and images — plus videos, when
        // allowVideo is set — are relevant here; everything else is hidden.
        const usable = items.filter(it => it.is_dir || it.cat === "image" || (allowVideo && it.cat === "video"));

        if (!usable.length) {
          status.textContent = (path.length === 0 && !scopeRoot)
            ? (allowVideo ? "No photos or videos in your vault yet" : "No images in your vault yet")
            : "Nothing here";
          return;
        }
        status.classList.add("hidden");

        usable.forEach(it => {
          if (it.is_dir) {
            const tile = h("div", { class: "vault-picker-tile folder", title: it.name },
              h("div", { class: "vault-picker-folder-icon" }, "\u{1F4C1}"),
              h("div", { class: "vault-picker-tile-name" }, it.name)
            );
            tile.addEventListener("click", () => {
              const t = targetFor(it);
              path.push({ vid: t.vid, rel: t.rel, name: it.name });
              load();
            });
            grid.appendChild(tile);
          } else {
            const tile = h("div", { class: "vault-picker-tile image", title: it.name },
              h("img", { src: versionedThumbUrl(it), loading: "lazy" })
            );
            tile.addEventListener("click", () => { const t = targetFor(it); close(); resolve(t); });
            grid.appendChild(tile);
          }
        });
      }

      load();
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRIVACY & SECURITY — technical detail + the controls that back it up
  // ════════════════════════════════════════════════════════════════════════
  function renderAiEnhanceCard() {
    const card = h("div", { class: "tech-card" },
      h("h3", {}, "\u2728 AI photo enhancement (optional)"),
      h("p", { class: "desc" },
        "Powers \u201CIncrease Quality\u201D on photos. When enabled, the one photo you run it on is decrypted and sent to a free Hugging Face super-resolution model to reconstruct real detail, instead of just resizing locally \u2014 then the enhanced result comes back and is re-encrypted into your vault. Off by default; nothing about your vault leaves this device unless you turn this on."),
    );
    const body = h("div", { style: "margin-top:12px;" }, "Loading\u2026");
    card.appendChild(body);

    let info = { has_token: false, token_preview: "", enabled: false };
    let editing = false;
    let pending = "";

    async function load() {
      const res = await api.get_ai_settings();
      if (res.ok) info = res;
      renderBody();
    }

    function renderBody() {
      body.innerHTML = "";

      const enableCheckbox = h("input", { type: "checkbox" });
      enableCheckbox.checked = info.enabled;
      enableCheckbox.disabled = !info.has_token;
      body.appendChild(h("label", { class: "iq-ai-label", style: "margin-bottom:10px;" },
        enableCheckbox,
        h("span", {},
          h("strong", {}, "Enable AI enhancement"),
          h("span", { style: "color:var(--text-2);" }, info.has_token ? "" : " \u2014 add an API key below first"),
        ),
      ));
      enableCheckbox.addEventListener("change", async () => {
        enableCheckbox.disabled = true;
        const res = await api.set_ai_enabled(enableCheckbox.checked);
        if (res.ok) { info.enabled = enableCheckbox.checked; toast(info.enabled ? "AI enhancement enabled" : "AI enhancement disabled", "success"); }
        else toast("Couldn't save that", "error");
        enableCheckbox.disabled = !info.has_token;
      });

      if (info.has_token && !editing) {
        body.appendChild(h("div", { style: "font-size:12.5px;color:var(--text-2);display:flex;align-items:center;gap:10px;flex-wrap:wrap;" },
          h("span", {}, `API key: ${info.token_preview}`),
          h("button", { class: "btn btn-ghost btn-sm", onclick: () => { editing = true; pending = ""; renderBody(); } }, "Change"),
          h("button", { class: "btn btn-ghost btn-sm", onclick: async () => {
            const res = await api.clear_ai_key();
            if (res.ok) { info = { has_token: false, token_preview: "", enabled: false }; toast("API key removed", "success"); }
            renderBody();
          } }, "Remove"),
        ));
      } else {
        const tokenInput = h("input", { class: "gt-field", type: "password", placeholder: "hf_xxxxxxxxxxxxxxxxxxxxxxxx", value: pending });
        tokenInput.addEventListener("input", () => { pending = tokenInput.value; });
        const saveBtn = h("button", { class: "btn btn-primary btn-sm", style: "margin-top:8px;" }, "Save key");
        const rowBtns = [saveBtn];
        if (editing) rowBtns.push(h("button", { class: "btn btn-ghost btn-sm", style: "margin-top:8px;", onclick: () => { editing = false; renderBody(); } }, "Cancel"));
        body.appendChild(h("div", { style: "font-size:12.5px;color:var(--text-2);margin-bottom:6px;" },
          "Create a free token at huggingface.co/settings/tokens (\u201Cread\u201D access is enough). Stored locally on this device, only sent to Hugging Face when you use Increase Quality with AI enhancement turned on."));
        body.appendChild(tokenInput);
        body.appendChild(h("div", { class: "row", style: "justify-content:flex-start;margin-top:8px;" }, ...rowBtns));
        saveBtn.addEventListener("click", async () => {
          if (!pending.trim()) { toast("Paste an API key first", "warn"); return; }
          saveBtn.disabled = true; saveBtn.textContent = "Saving\u2026";
          const res = await api.save_ai_key(pending.trim(), true);
          if (res.ok) {
            info = { has_token: true, enabled: true, token_preview: pending.trim().length > 12 ? (pending.trim().slice(0, 6) + "\u2026" + pending.trim().slice(-4)) : "\u2022".repeat(pending.trim().length) };
            editing = false;
            toast("AI enhancement key saved", "success");
          } else {
            toast("Couldn't save the key", "error");
          }
          renderBody();
        });
      }
    }

    load();
    return card;
  }

  function techCard(title, icon, descHtml, points, note) {
    const card = h("div", { class: "tech-card" },
      h("h3", {}, icon ? `${icon} ` : "", title),
      descHtml ? h("p", { class: "desc" }, descHtml) : null,
    );
    if (points && points.length) {
      card.appendChild(h("ul", { class: "tech-list" },
        ...points.map(p => h("li", { html: p }))
      ));
    }
    if (note) {
      card.appendChild(h("div", { class: `tech-note ${note.kind || "info"}`, style: "margin-top:14px;" },
        h("span", {}, note.kind === "danger" ? "\u26A0\uFE0F" : "\u2139\uFE0F"),
        h("div", { html: note.text })
      ));
    }
    return card;
  }

  function jumpToSettingsBtn(label) {
    const btn = h("button", { class: "btn btn-ghost btn-sm" }, label || "Open in Settings \u2192");
    btn.addEventListener("click", () => { state.view = "settings"; render(); window.scrollTo(0, 0); });
    return btn;
  }

  function renderPrivacySecurity() {
    const wrap = h("div", { class: "content" });
    const inner = h("div", { class: "settings-wrap" });

    inner.appendChild(h("div", { class: "security-hero" },
      h("h2", {}, "\u{1F6E1}\uFE0F Everything here is actually encrypted \u2014 not just hidden"),
      h("p", {}, "VaultLock never stores your files, their names, or your key in a form that's readable without your password. This page explains exactly how, and gives you direct access to every control that manages it.")
    ));

    inner.appendChild(techCard(
      "File encryption", "\u{1F510}",
      "Every file you lock \u2014 photos, videos, anything \u2014 is fully encrypted before it ever touches the vault folder on disk.",
      [
        "<b>AES-256-CTR</b> encrypts the file content itself, with a fresh random value used per file.",
        "<b>HMAC-SHA256</b> is attached to every file so tampering or corruption is detected, not silently accepted.",
        "The moment the encrypted copy is written successfully, the original plaintext file is deleted \u2014 there is no lingering unencrypted copy left behind.",
        "Cached thumbnails and previews are encrypted the same way \u2014 there is no unencrypted \u201Cshortcut\u201D version sitting on disk anywhere."
      ]
    ));

    inner.appendChild(techCard(
      "Names & folder structure are hidden too", "\u{1F3F7}\uFE0F",
      "Locking a folder doesn't just encrypt the files inside it \u2014 it hides what everything is called.",
      [
        "Every file and folder name becomes a meaningless random token on disk.",
        "The real names and folder tree exist only inside an encrypted manifest (<b>_index.enc</b>), which is decrypted into memory only while you're logged in.",
        "If you open the vault folder directly in File Explorer, you'll see nothing but random tokens and ciphertext \u2014 no filenames, thumbnails, or folder names that hint at what's inside."
      ]
    ));

    inner.appendChild(techCard(
      "How your password protects the key", "\u{1F511}",
      "Your password never encrypts your files directly \u2014 it protects the key that does.",
      [
        "A random 256-bit encryption key is generated once, when your vault is created.",
        "That key is wrapped using a key derived from your password via <b>PBKDF2 with 480,000 iterations</b> \u2014 deliberately slow, to make password-guessing impractical.",
        "The key is only unwrapped into memory after you log in successfully, and forgotten again when you lock or close the app.",
        "The decoy vault uses a completely separate key from the real vault, so one can never be used to derive or reach the other."
      ],
      { kind: "danger", text: "<b>There is no back door.</b> If you forget your master password and don't have the decoy password, nothing in the vault can be recovered \u2014 by you, or by anyone else." }
    ));

    inner.appendChild(techCard(
      "Three passwords, three outcomes", "\u{1F9E9}",
      "VaultLock's login screen quietly does one of three completely different things depending on which password you type \u2014 same box, no visible difference.",
      [
        "<b>Master</b> \u2192 opens your real vault, exactly as you left it.",
        "<b>Decoy</b> \u2192 opens a separate, empty-looking vault with its own independent encryption key.",
        "<b>Nuke</b> \u2192 silently and permanently wipes your real vault, then drops you into an empty one. No warning is shown \u2014 that's intentional, for use under duress."
      ]
    ));
    inner.lastChild.appendChild(h("div", { class: "row", style: "margin-top:14px;" }, jumpToSettingsBtn("\u{1F511} Manage passwords \u2192")));

    const clearBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Clear temporary decrypted files now");
    clearBtn.addEventListener("click", async () => {
      const res = await api.clear_temp_files();
      toast(res.ok ? `Cleared ${res.removed} temporary file(s)` : "Couldn't clear temp files", res.ok ? "success" : "error");
    });
    inner.appendChild(techCard(
      "Temporary files", "\u{1F9F9}",
      "Opening a file in an external app (e.g. your OS photo viewer) requires briefly decrypting it to disk.",
      [
        "That decrypted copy is written to a temporary folder and deleted automatically the moment the external app closes it.",
        "If the app ever closes unexpectedly, you can force a cleanup right here."
      ]
    ));
    inner.lastChild.appendChild(clearBtn);

    inner.appendChild(techCard(
      "Where your vault actually lives", "\u{1F4BE}",
      "By default your vault stores everything under your Windows profile (the C: drive), but it doesn't have to.",
      [
        "A tiny pointer file (a few bytes, just remembering <b>where</b> your vault is) always stays on the C: drive under <code>%APPDATA%\\VaultLock\\</code>.",
        "The actual encrypted photos, videos, and files can live on any drive you choose \u2014 an internal drive, an external/USB drive, or a NAS mount.",
        "Moving your vault later copies everything to the new location first, then removes it from the old one \u2014 safe to use even with an existing vault full of data."
      ]
    ));
    inner.lastChild.appendChild(h("div", { class: "row", style: "margin-top:14px;" },
      jumpToSettingsBtn("\u{1F4C1} Change storage location \u2192"),
      (() => { const b = h("button", { class: "btn btn-ghost btn-sm", onclick: openStorageVisualizer }, "\u{1F4CA} Storage breakdown"); return b; })(),
      (() => { const b = h("button", { class: "btn btn-ghost btn-sm", onclick: openDuplicateFinder }, "\u{1F9EC} Find duplicates"); return b; })(),
    ));

    inner.appendChild(renderPrivacyCard());
    const qhCard = renderQuickHideCard();
    if (qhCard) inner.appendChild(qhCard);
    inner.appendChild(renderAiEnhanceCard());

    inner.appendChild(h("div", { class: "tech-card" },
      h("h3", {}, "\u26A0\uFE0F Danger zone"),
      h("p", { class: "desc" }, "These permanently destroy data. They live here too because they're security-relevant \u2014 see the Help page's red zone before using them."),
      h("div", { class: "row" },
        h("button", { class: "btn btn-danger", onclick: onWipeVault }, "\u{1F4A3} Wipe entire vault"),
        h("button", { class: "btn btn-danger", onclick: onFactoryReset }, "\u26A0\uFE0F Factory reset"),
      )
    ));

    wrap.appendChild(inner);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // HELP — every feature, colour-coded by how carefully to use it
  // ════════════════════════════════════════════════════════════════════════
  function zoneBanner(color, emoji, title, sub) {
    return h("div", { class: `zone-banner ${color}` },
      h("span", { class: "zone-emoji" }, emoji),
      h("div", { class: "zone-copy" }, h("div", {}, title), h("span", {}, sub))
    );
  }
  function helpCard(color, badge, label, sub, actionBtn) {
    return h("div", { class: `help-card ${color}` },
      h("div", { class: "help-body" },
        h("div", { class: `zone-badge ${color}` }, badge),
        h("div", { class: "label" }, label),
        h("div", { class: "sub", html: sub })
      ),
      actionBtn ? h("div", { class: "help-action" }, actionBtn) : null
    );
  }
  function gotoView(view, label) {
    const btn = h("button", { class: "btn btn-ghost btn-sm" }, label || "Open \u2192");
    btn.addEventListener("click", async () => {
      state.view = view;
      if (view === "gallery") { state.path = []; await loadCurrentView(); }
      else if (view === "favorites") { await loadFavorites(); }
      else if (view === "albums") { await loadAlbums(); }
      else if (view === "faceGroups") { state.currentFaceGroupContainer = null; await loadFaceGroupContainers(); }
      else if (view === "dashboard") { await loadDashboard(); }
      render();
    });
    return btn;
  }

  function renderHelp() {
    const wrap = h("div", { class: "content" });
    const inner = h("div", { class: "settings-wrap" });

    inner.appendChild(h("p", { class: "help-intro" },
      "Here's a plain-language walkthrough of everything VaultLock can do, grouped by how much thought you should put in before using it. ",
      h("b", {}, "Green"), " = click around freely, nothing can go wrong. ",
      h("b", {}, "Yellow"), " = totally normal to use, just know what it does. ",
      h("b", {}, "Red"), " = powerful and permanent \u2014 only use these on purpose."
    ));

    // ── GREEN ────────────────────────────────────────────────────────────
    inner.appendChild(zoneBanner("green", "\u2705", "Safe to explore",
      "Look, click, browse, customize \u2014 nothing here changes or deletes your files."));
    inner.appendChild(helpCard("green", "Safe", "Browsing your vault",
      "Open Gallery or List view, move in and out of folders with the breadcrumb trail and Back button, and open any photo or video in the full-screen viewer. Purely for looking \u2014 nothing is changed.",
      gotoView("gallery", "\u{1F5C2}\uFE0F Open My Vault")));
    inner.appendChild(helpCard("green", "Safe", "Favorites & Dashboard",
      "Star items to collect them in Favorites, and check the Dashboard for quick stats and recently-opened items. Just bookmarks and read-only views.",
      gotoView("dashboard", "\u{1F4CA} Open Dashboard")));
    inner.appendChild(helpCard("green", "Safe", "Albums",
      "Create a named album with the \u201C+ New Album\u201D button, then use \u201C+ Add from Vault\u201D to hand-pick files already in your vault \u2014 nothing is ever uploaded into an album. Adding a file just references it, like Favorites, so it stays put; removing it from the album (\u2716) never touches the real file.",
      gotoView("albums", "\u{1F39E}\uFE0F Open Albums")));
    inner.appendChild(helpCard("green", "Safe", "Face Groups",
      "Click \u201C\u{1F50D} Scan for faces\u201D and pick a folder (or Entire Vault) to look through \u2014 VaultLock routes photos of the same person into one group, automatically. Scanning one folder at a time is faster and keeps matches more accurate than scanning everything at once. Just like Albums, this only ever references files in place; nothing is moved, copied, or re-uploaded. Rescan any time to catch new photos; pin, rename, or set a custom thumbnail on any group just like a regular album.",
      gotoView("faceGroups", "\u{1F642} Open Face Groups")));
    inner.appendChild(helpCard("green", "Safe", "Search & sort",
      "Filter what you're looking at and change the sort order. This only changes what you see, never what's stored."));
    inner.appendChild(helpCard("green", "Safe", "Appearance & folder covers",
      "Pick a background, a folder cover style, colors, and icons. Pure decoration \u2014 fully reversible any time from Settings.",
      jumpToSettingsBtn()));
    inner.appendChild(helpCard("green", "Safe", "Viewer settings",
      "Control autoplay, looping, zoom memory, and the viewer's background style. Preferences only \u2014 your files aren't touched."));
    inner.appendChild(helpCard("green", "Safe", "Workflow & privacy preferences",
      "Auto-lock timing, whether single-click opens or selects, confirmation prompts, history tracking, and the privacy screen. All toggles \u2014 flip any of them back at any time.",
      gotoView("privacy", "\u{1F6E1}\uFE0F Open Privacy & Security")));
    inner.appendChild(helpCard("green", "Safe", "Keyboard shortcuts",
      "Rebind any shortcut combo to whatever feels natural. Reset-to-default is always one click away."));
    inner.appendChild(helpCard("green", "Safe", "Quick-hide disguise",
      "Press the quick-hide combo to instantly cover the window with a fake clock/update/browser screen. It's just a cover \u2014 nothing underneath is touched, and typing your master password dismisses it instantly no matter what's showing."));

    // ── YELLOW ───────────────────────────────────────────────────────────
    inner.appendChild(zoneBanner("yellow", "\u26A0\uFE0F", "Fine to use \u2014 just know what happens",
      "These move or remove files. Nothing catastrophic, but understand the outcome before you click."));
    inner.appendChild(helpCard("yellow", "Care", "Adding files & folders (\u201Clocking\u201D)",
      "Once a file finishes encrypting into the vault, its original unlocked copy is deleted from where it was. Make sure you don't still need a plain copy sitting outside the vault.",
      gotoView("gallery", "\u{1F5C2}\uFE0F Go add something")));
    inner.appendChild(helpCard("yellow", "Care", "Restoring files",
      "Restore to original location, restore to a folder you choose, or use Restore All / multi-select restore. This decrypts the file back to a normal, unencrypted file on disk exactly where you send it \u2014 as intended, just good to know it leaves the vault's protection."));
    inner.appendChild(helpCard("yellow", "Care", "Deleting files & folders",
      "Removes them from the vault permanently \u2014 there's no recycle bin inside VaultLock. Turn on \u201CConfirm before deleting\u201D in Settings if you'd like a safety check first.",
      jumpToSettingsBtn()));
    inner.appendChild(helpCard("yellow", "Care", "Moving your vault's storage location",
      "Copies everything to the new drive or folder first, then removes it from the old one. Safe even with an existing vault \u2014 just don't close the app while a large move is in progress.",
      jumpToSettingsBtn()));
    inner.appendChild(helpCard("yellow", "Care", "Duplicate finder & storage breakdown",
      "Browsing what's taking up space is completely safe \u2014 but deleting duplicates you find there is a real, permanent delete like any other.",
      (() => { const b = h("button", { class: "btn btn-ghost btn-sm", onclick: openDuplicateFinder }, "\u{1F9EC} Find duplicates"); return b; })()));

    // ── RED ──────────────────────────────────────────────────────────────
    inner.appendChild(zoneBanner("red", "\u26D4", "Only use these on purpose",
      "Powerful, permanent actions. Read twice, then act \u2014 there's no undo."));
    inner.appendChild(helpCard("red", "Critical", "Changing your master, decoy, or nuke password",
      "Re-wraps your encryption key under the new password. If you forget the new master password afterward (and don't have the decoy password), the vault cannot be recovered by anyone, ever.",
      jumpToSettingsBtn("\u{1F511} Manage passwords \u2192")));
    inner.appendChild(helpCard("red", "Critical", "Logging in with the decoy password",
      "Opens a completely separate, empty-looking vault with its own key. Not destructive, but easy to confuse with your real vault \u2014 know which password is which."));
    inner.appendChild(helpCard("red", "Critical", "Logging in with the nuke password",
      "Silently and permanently wipes your entire real vault the instant you log in with it. No confirmation is shown \u2014 that's by design, so only use it if you actually mean to."));
    inner.appendChild(helpCard("red", "Critical", "Wipe entire vault",
      "Permanently deletes every locked file and folder in the vault, in one action. Cannot be undone.",
      h("button", { class: "btn btn-danger btn-sm", onclick: onWipeVault }, "\u{1F4A3} Wipe vault")));
    inner.appendChild(helpCard("red", "Critical", "Factory reset",
      "Erases absolutely everything: both vaults, every password, every preference, cached thumbnails, and temporary files. Total start-over \u2014 no undo.",
      h("button", { class: "btn btn-danger btn-sm", onclick: onFactoryReset }, "\u26A0\uFE0F Factory reset")));

    wrap.appendChild(inner);
    return wrap;
  }

  function renderSettings() {
    const wrap = h("div", { class: "content" });
    const inner = h("div", { class: "settings-wrap" });

    const curPw = h("input", { type: "password", placeholder: "Current master password" });
    const newMaster = h("input", { type: "password", placeholder: "New master password (leave blank to keep)" });
    const newDecoy = h("input", { type: "password", placeholder: "New decoy password (leave blank to keep)" });
    const newNuke = h("input", { type: "password", placeholder: "New nuke password (leave blank to keep)" });
    [curPw, newMaster, newDecoy, newNuke].forEach(inp => {
      inp.style.cssText = "width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:10px;outline:none;";
    });
    const saveBtn = h("button", { class: "btn btn-primary" }, "Update Passwords");
    saveBtn.addEventListener("click", async () => {
      if (!curPw.value) return toast("Enter your current master password", "error");
      const res = await api.change_passwords(curPw.value, newMaster.value, newDecoy.value, newNuke.value);
      toast(res.ok ? "Passwords updated" : res.error, res.ok ? "success" : "error");
      if (res.ok) { curPw.value = newMaster.value = newDecoy.value = newNuke.value = ""; }
    });

    inner.appendChild(renderAppearanceCard());
    inner.appendChild(renderFolderStyleCard());
    inner.appendChild(renderWorkflowCard());
    inner.appendChild(renderViewerCard());
    inner.appendChild(renderPrivacyCard());
    const qhCard = renderQuickHideCard();
    if (qhCard) inner.appendChild(qhCard);
    inner.appendChild(renderShortcutsCard());

    inner.appendChild(h("div", { class: "settings-card" },
      h("h3", {}, "Security"),
      h("p", { class: "desc" }, "Change your master, decoy, or nuke password. You'll need your current master password to confirm."),
      curPw, newMaster, newDecoy, newNuke, saveBtn
    ));

    inner.appendChild(h("div", { class: "settings-card" },
      h("h3", {}, "Storage"),
      h("div", { class: "settings-row" },
        h("div", {}, h("div", { class: "label" }, "Items in this vault"), h("div", { class: "sub" }, "Files and folders currently locked")),
        h("div", {}, `${state.stats.count}`)
      ),
      h("div", { class: "settings-row" },
        h("div", {}, h("div", { class: "label" }, "Total size")),
        h("div", {}, state.stats.size_h)
      ),
      renderStorageLocationRow(),
      h("div", { class: "row", style: "margin-top:10px;" },
        h("button", { class: "btn btn-ghost btn-sm", onclick: openStorageVisualizer }, "\u{1F4CA} View storage breakdown"),
        h("button", { class: "btn btn-ghost btn-sm", onclick: openDuplicateFinder }, "\u{1F9EC} Find duplicate files"),
      )
    ));

    inner.appendChild(h("div", { class: "settings-card" },
      h("h3", {}, "Danger zone"),
      h("p", { class: "desc" }, "Permanently deletes every file and folder currently in this vault."),
      h("button", { class: "btn btn-danger", onclick: onWipeVault }, "\u{1F4A3} Wipe entire vault")
    ));
    inner.appendChild(renderFactoryResetCard());

    wrap.appendChild(inner);
    return wrap;
  }

  // ════════════════════════════════════════════════════════════════════════
  // GALLERY TOOLS — Advanced Batch Rename, Privacy Scrubber, Advanced Video
  // Frame Extractor, Video Contact Sheet Generator, Increase Quality.
  // ════════════════════════════════════════════════════════════════════════

  // ── shared: destination-folder picker (select existing, or name a new one) ──
  function buildDestFolderControl(folders) {
    const destSelect = h("select", { class: "gt-field" });
    destSelect.appendChild(h("option", { value: "__new__" }, "\u2795 Create new folder\u2026"));
    folders.forEach(f => destSelect.appendChild(
      h("option", { value: JSON.stringify({ vid: f.vid, rel: f.rel }) }, f.label)
    ));
    const newNameInput = h("input", {
      class: "gt-field", type: "text", placeholder: "New folder name",
      style: "margin-top:8px;" + (folders.length ? "display:none;" : ""),
    });
    destSelect.addEventListener("change", () => {
      newNameInput.style.display = destSelect.value === "__new__" ? "" : "none";
    });
    async function resolveDest() {
      if (destSelect.value === "__new__") {
        const name = newNameInput.value.trim();
        if (!name) { toast("Enter a name for the new folder", "error"); return null; }
        const res = await api.create_folder(name);
        if (!res.ok) { toast(res.result || "Couldn't create that folder", "error"); return null; }
        return { vid: res.result, rel: null };
      }
      const d = JSON.parse(destSelect.value);
      return { vid: d.vid, rel: d.rel };
    }
    return { destSelect, newNameInput, resolveDest };
  }

  // ── shared: background-job progress bar + cancel ────────────────────────
  function buildProgressUI(jobId) {
    const msgLbl = h("span", {}, "Starting\u2026");
    const countLbl = h("span", {}, "");
    const fill = h("div", { class: "gt-progress-fill", style: "width:0%;" });
    const cancelBtn = h("button", { class: "btn btn-ghost", style: "margin-top:10px;" }, "Cancel");
    const wrap = h("div", { class: "gt-progress-wrap" },
      h("div", { class: "gt-progress-bar" }, fill),
      h("div", { class: "gt-progress-label" }, msgLbl, countLbl),
      cancelBtn,
    );
    cancelBtn.addEventListener("click", () => {
      cancelBtn.disabled = true; cancelBtn.textContent = "Cancelling\u2026";
      api.cancel_job(jobId);
    });
    function update(job) {
      const total = job.total || 0;
      const pct = total > 0 ? Math.min(100, Math.round((job.done / total) * 100)) : (job.status === "done" ? 100 : 5);
      fill.style.width = pct + "%";
      msgLbl.textContent = job.message || "";
      countLbl.textContent = total > 0 ? `${job.done} / ${total}` : (job.done ? String(job.done) : "");
    }
    return { wrap, update, cancelBtn };
  }

  function pollJob(jobId, onUpdate) {
    return new Promise((resolve) => {
      const iv = setInterval(async () => {
        const res = await api.get_job(jobId);
        if (!res.ok) { clearInterval(iv); resolve({ status: "error", error: res.error }); return; }
        onUpdate(res.job);
        if (["done", "error", "cancelled"].includes(res.job.status)) { clearInterval(iv); resolve(res.job); }
      }, 350);
    });
  }

  function gtCloseableModal(bodyNode, wide) {
    const host = document.getElementById("modal-host");
    const backdrop = h("div", { class: "modal-backdrop" });
    const box = h("div", { class: wide ? "modal modal-wide" : "modal" }, bodyNode);
    backdrop.appendChild(box);
    host.appendChild(backdrop);
    return { close: () => backdrop.remove(), box, backdrop };
  }

  // ────────────────────────────────────────────────────────────────────────
  // 1. ADVANCED BATCH RENAME
  // ────────────────────────────────────────────────────────────────────────
  function openBatchRename(selItems) {
    selItems = (selItems || []).filter(it => !it.is_dir);
    if (!selItems.length) { toast("Select files to rename", "warn"); return; }

    let order = selItems.map(it => {
      const t = effectiveTarget(it);
      return { vid: t.vid, rel: t.rel || null, name: it.name || it.display_name, thumb_url: it.thumb_url };
    });

    const listEl = h("div", { class: "gt-reorder-list" });
    const baseNameInput = h("input", { class: "gt-field", type: "text", placeholder: "e.g. Tree" });
    const startNumInput = h("input", { class: "gt-field", type: "number", value: "1", min: "0" });
    const sepInput = h("input", { class: "gt-field", type: "text", value: ".." });
    const padSelect = h("select", { class: "gt-field" },
      h("option", { value: "0" }, "None"),
      h("option", { value: "2" }, "2 (01)"),
      h("option", { value: "3" }, "3 (001)"),
      h("option", { value: "4" }, "4 (0001)"),
    );
    const previewBody = h("tbody", {});
    const applyBtn = h("button", { class: "btn btn-primary", disabled: true }, "Rename");

    function renderList() {
      listEl.innerHTML = "";
      order.forEach((entry, idx) => {
        const row = h("div", { class: "gt-reorder-row", draggable: true },
          h("div", { class: "gt-reorder-num" }, String(idx + 1)),
          h("div", { class: "gt-reorder-handle" }, "\u2630"),
          entry.thumb_url
            ? h("img", { class: "gt-reorder-thumb", src: entry.thumb_url })
            : h("div", { class: "gt-reorder-thumb" }),
          h("div", { class: "gt-reorder-name" }, entry.name),
        );
        row.addEventListener("dragstart", (e) => {
          row.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(idx));
        });
        row.addEventListener("dragend", () => row.classList.remove("dragging"));
        row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drop-over"); });
        row.addEventListener("dragleave", () => row.classList.remove("drop-over"));
        row.addEventListener("drop", (e) => {
          e.preventDefault(); row.classList.remove("drop-over");
          const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
          if (Number.isNaN(fromIdx) || fromIdx === idx) return;
          const [moved] = order.splice(fromIdx, 1);
          order.splice(idx, 0, moved);
          renderList(); updatePreview();
        });
        listEl.appendChild(row);
      });
    }

    async function updatePreview() {
      const items = order.map(e => ({ vid: e.vid, rel: e.rel, name: e.name }));
      const res = await api.batch_rename_preview(
        items, baseNameInput.value, parseInt(startNumInput.value || "1", 10), sepInput.value, parseInt(padSelect.value || "0", 10)
      );
      previewBody.innerHTML = "";
      if (!res.ok) { applyBtn.disabled = true; return; }
      let anyConflict = false;
      res.entries.forEach(en => {
        if (en.conflict || en.error) anyConflict = true;
        previewBody.appendChild(h("tr", { class: (en.conflict || en.error) ? "conflict" : "" },
          h("td", {}, en.old_name),
          h("td", { class: "gt-arrow" }, "\u2192"),
          h("td", {}, en.new_name || en.error || "?"),
        ));
      });
      applyBtn.disabled = anyConflict || !baseNameInput.value.trim();
    }

    [baseNameInput, startNumInput, sepInput].forEach(el => el.addEventListener("input", updatePreview));
    padSelect.addEventListener("change", updatePreview);

    renderList();

    const { close } = gtCloseableModal(h("div", {},
      h("h3", {}, `Advanced Batch Rename \u2014 ${order.length} file${order.length === 1 ? "" : "s"}`),
      h("p", {}, "Drag to set the order, then choose a base name. Nothing else (dates, EXIF, camera info) is used automatically \u2014 you're fully in control."),
      listEl,
      h("div", { class: "gt-row" },
        h("div", {}, h("label", { class: "gt-field-label" }, "Base name"), baseNameInput),
        h("div", {}, h("label", { class: "gt-field-label" }, "Starting number"), startNumInput),
      ),
      h("div", { class: "gt-row" },
        h("div", {}, h("label", { class: "gt-field-label" }, "Separator"), sepInput),
        h("div", {}, h("label", { class: "gt-field-label" }, "Padding"), padSelect),
      ),
      h("label", { class: "gt-field-label" }, "Preview"),
      h("table", { class: "gt-preview-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Current name"), h("th", {}), h("th", {}, "New name"))),
        previewBody,
      ),
      h("div", { class: "row", style: "margin-top:14px;" },
        h("button", { class: "btn btn-ghost", onclick: () => close() }, "Cancel"),
        applyBtn,
      ),
    ), true);

    applyBtn.addEventListener("click", async () => {
      const items = order.map(e => ({ vid: e.vid, rel: e.rel, name: e.name }));
      applyBtn.disabled = true; applyBtn.textContent = "Renaming\u2026";
      const res = await api.batch_rename_apply(
        items, baseNameInput.value, parseInt(startNumInput.value || "1", 10), sepInput.value, parseInt(padSelect.value || "0", 10)
      );
      if (!res.ok) {
        toast(res.error || "Couldn't rename those files", "error");
        applyBtn.disabled = false; applyBtn.textContent = "Rename";
        return;
      }
      close();
      state.selected.clear(); state.selectMode = false;
      await loadCurrentView(); render();
      offerUndo(`Renamed ${res.renamed} file${res.renamed === 1 ? "" : "s"}`, async () => {
        const u = await api.batch_rename_undo();
        toast(u.ok ? `Restored ${u.restored} original name${u.restored === 1 ? "" : "s"}` : (u.error || "Couldn't undo"), u.ok ? "success" : "error");
        await loadCurrentView(); render();
      });
    });

    updatePreview();
  }

  // Small "X happened. [Undo]" toast with a real action button (the plain
  // toast() has no interactive affordance and disappears too quickly for
  // this), used after batch rename.
  function offerUndo(message, onUndo) {
    const host = document.getElementById("toast-host");
    const t = h("div", { class: "toast" },
      h("div", { class: "dot", style: "background:#1FAE63" }),
      h("div", {}, message),
      h("button", { class: "btn btn-ghost btn-sm", style: "margin-left:8px;" }, "Undo"),
    );
    t.lastChild.addEventListener("click", () => { onUndo(); t.remove(); });
    host.appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .25s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 250); }, 8000);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 2. PRIVACY SCRUBBER
  // ────────────────────────────────────────────────────────────────────────
  const PRIVACY_CATEGORY_LABELS = {
    gps: "GPS / location", device: "Device information", software: "Software information",
    personal: "Personal information (author, copyright, comments)", embedded_thumb: "Embedded thumbnail",
    exif: "EXIF", iptc: "IPTC", xmp: "XMP", datetime: "Date/time",
  };
  const PRIVACY_SCRUB_OPTION_KEYS = ["gps", "device", "personal", "software", "embedded_thumb", "exif", "iptc", "xmp"];

  async function openPrivacyScrubber(selItems) {
    selItems = (selItems || []).filter(it => !it.is_dir && (it.cat === "image" || it.cat === "video"));
    if (!selItems.length) { toast("Select photos or videos to scan", "warn"); return; }
    const items = selItems.map(it => {
      const t = effectiveTarget(it);
      return { vid: t.vid, rel: t.rel || null, name: it.name || it.display_name };
    });

    const bodyHost = h("div", {});
    const { close } = gtCloseableModal(h("div", {},
      h("h3", {}, `Privacy Scan \u2014 ${items.length} file${items.length === 1 ? "" : "s"}`),
      bodyHost,
    ), true);
    bodyHost.appendChild(h("div", { style: "text-align:center;padding:20px 0;" },
      h("div", { class: "spinner" }), h("p", { style: "margin-top:12px;" }, "Scanning for privacy-sensitive metadata\u2026")
    ));

    const scan = await api.privacy_scan(items);
    bodyHost.innerHTML = "";
    if (!scan.ok) {
      bodyHost.appendChild(h("p", {}, scan.error || "Couldn't scan those files."));
      bodyHost.appendChild(h("div", { class: "row" }, h("button", { class: "btn btn-ghost", onclick: () => close() }, "Close")));
      return;
    }

    const totalFound = scan.results.reduce((s, r) => s + (r.found_count || 0), 0);
    bodyHost.appendChild(h("p", {}, totalFound > 0
      ? `Found ${totalFound} potentially sensitive metadata field${totalFound === 1 ? "" : "s"} across these files. Nothing is removed until you choose to scrub.`
      : "No readable privacy metadata was found in these files (or metadata reading isn't available for their format)."));

    scan.results.forEach(r => {
      const tagsWrap = h("div", { class: "gt-scan-fields" });
      if (r.error) {
        tagsWrap.appendChild(h("span", { class: "gt-tag" }, r.error));
      } else {
        Object.entries(PRIVACY_CATEGORY_LABELS).forEach(([key, label]) => {
          if (!(key in r.fields)) return;
          tagsWrap.appendChild(h("span", { class: `gt-tag ${r.fields[key] ? "found" : ""}` }, `${label}: ${r.fields[key] ? "Found" : "\u2014"}`));
        });
        if (r.fields.unavailable) tagsWrap.appendChild(h("span", { class: "gt-tag" }, "Video metadata tools not installed \u2014 install ffmpeg to scan/scrub video"));
      }
      bodyHost.appendChild(h("div", { class: "gt-scan-item" },
        h("div", { class: "name" }, r.name),
        tagsWrap,
      ));
    });

    const checklist = h("div", { class: "gt-checklist" });
    const checkboxes = {};
    PRIVACY_SCRUB_OPTION_KEYS.forEach(key => {
      const cb = h("input", { type: "checkbox" });
      cb.checked = true;
      checkboxes[key] = cb;
      checklist.appendChild(h("div", { class: "gt-check-row" }, cb, h("span", {}, PRIVACY_CATEGORY_LABELS[key])));
    });
    bodyHost.appendChild(h("label", { class: "gt-field-label" }, "Remove selected categories"));
    bodyHost.appendChild(checklist);

    const scrubSelectedBtn = h("button", { class: "btn btn-ghost" }, "Remove Selected");
    const scrubAllBtn = h("button", { class: "btn btn-primary" }, "Remove All Privacy Metadata");
    bodyHost.appendChild(h("div", { class: "row", style: "margin-top:14px;justify-content:space-between;" },
      h("button", { class: "btn btn-ghost", onclick: () => close() }, "Cancel"),
      h("div", { style: "display:flex;gap:8px;" }, scrubSelectedBtn, scrubAllBtn),
    ));

    async function runScrub(options) {
      scrubSelectedBtn.disabled = true; scrubAllBtn.disabled = true;
      scrubAllBtn.textContent = "Scrubbing\u2026";
      const res = await api.privacy_scrub(items, options);
      if (!res.ok) {
        toast(res.error || "Couldn't scrub those files", "error");
        scrubSelectedBtn.disabled = false; scrubAllBtn.disabled = false; scrubAllBtn.textContent = "Remove All Privacy Metadata";
        return;
      }
      close();
      const ok = res.processed;
      const failed = res.errors.length;
      toast(failed === 0
        ? `Scrubbed privacy metadata from ${ok} file${ok === 1 ? "" : "s"}`
        : `Scrubbed ${ok} file${ok === 1 ? "" : "s"}, ${failed} failed`, failed === 0 ? "success" : "warn");
      await loadCurrentView(); render();
    }

    scrubAllBtn.addEventListener("click", () => runScrub({ all: true }));
    scrubSelectedBtn.addEventListener("click", () => {
      const options = {};
      PRIVACY_SCRUB_OPTION_KEYS.forEach(key => { options[key] = checkboxes[key].checked; });
      runScrub(options);
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3. ADVANCED VIDEO FRAME EXTRACTOR
  // ────────────────────────────────────────────────────────────────────────
  const FRAME_MODES = [
    { id: "every_frame", label: "Every Frame" },
    { id: "every_nth", label: "Every Nth Frame" },
    { id: "fps", label: "FPS" },
    { id: "interval", label: "Time Interval" },
    { id: "frame_range", label: "Frame Range" },
    { id: "time_range", label: "Time Range" },
    { id: "timestamps", label: "Specific Timestamps" },
  ];

  async function openAdvancedFrameExtractor(it) {
    const t = effectiveTarget(it);
    const folders = (await api.list_vault_folders()).filter(f => f.vid);
    const dest = buildDestFolderControl(folders);

    let mode = "fps";
    const modeBody = h("div", {});
    const tabs = h("div", { class: "gt-tabs" });
    FRAME_MODES.forEach(m => {
      const tab = h("button", { class: `gt-tab ${m.id === mode ? "active" : ""}`, type: "button" }, m.label);
      tab.addEventListener("click", () => {
        mode = m.id;
        Array.from(tabs.children).forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        renderModeBody();
      });
      tabs.appendChild(tab);
    });

    const nthInput = h("input", { class: "gt-field", type: "number", value: "10", min: "1" });
    const fpsInput = h("input", { class: "gt-field", type: "number", value: "2", min: "0.1", max: "60", step: "0.1" });
    const intervalInput = h("input", { class: "gt-field", type: "number", value: "5", min: "0.1" });
    const rangeStart = h("input", { class: "gt-field", type: "number", value: "0", min: "0" });
    const rangeEnd = h("input", { class: "gt-field", type: "number", value: "500", min: "0" });
    const rangeEvery = h("input", { class: "gt-field", type: "number", value: "5", min: "1" });
    const trStart = h("input", { class: "gt-field", type: "text", placeholder: "00:01:20", value: "00:00:00" });
    const trEnd = h("input", { class: "gt-field", type: "text", placeholder: "00:03:40", value: "00:01:00" });
    const trFps = h("input", { class: "gt-field", type: "number", value: "2", min: "0.1", max: "60", step: "0.1" });
    const timestampsArea = h("textarea", {
      class: "gt-field", rows: "4",
      placeholder: "00:00:12.500\n00:01:25.200\n00:03:41.800",
    });

    function renderModeBody() {
      modeBody.innerHTML = "";
      if (mode === "every_frame") {
        modeBody.appendChild(h("p", { style: "color:var(--text-2);font-size:12.5px;" }, "Extracts every single frame. This can produce a very large number of files for longer videos."));
      } else if (mode === "every_nth") {
        modeBody.appendChild(h("label", { class: "gt-field-label" }, "Every N frames"));
        modeBody.appendChild(nthInput);
      } else if (mode === "fps") {
        modeBody.appendChild(h("label", { class: "gt-field-label" }, "Frames per second"));
        modeBody.appendChild(fpsInput);
      } else if (mode === "interval") {
        modeBody.appendChild(h("label", { class: "gt-field-label" }, "Extract one frame every (seconds)"));
        modeBody.appendChild(intervalInput);
      } else if (mode === "frame_range") {
        modeBody.appendChild(h("div", { class: "gt-row" },
          h("div", {}, h("label", { class: "gt-field-label" }, "Start frame"), rangeStart),
          h("div", {}, h("label", { class: "gt-field-label" }, "End frame"), rangeEnd),
          h("div", {}, h("label", { class: "gt-field-label" }, "Every"), rangeEvery),
        ));
      } else if (mode === "time_range") {
        modeBody.appendChild(h("div", { class: "gt-row" },
          h("div", {}, h("label", { class: "gt-field-label" }, "Start (hh:mm:ss)"), trStart),
          h("div", {}, h("label", { class: "gt-field-label" }, "End (hh:mm:ss)"), trEnd),
          h("div", {}, h("label", { class: "gt-field-label" }, "FPS"), trFps),
        ));
      } else if (mode === "timestamps") {
        modeBody.appendChild(h("label", { class: "gt-field-label" }, "One timestamp per line (hh:mm:ss.mmm)"));
        modeBody.appendChild(timestampsArea);
      }
    }
    renderModeBody();

    const baseNameInput = h("input", { class: "gt-field", type: "text", placeholder: `${(it.name || "video").replace(/\.[^.]+$/, "")}_frame` });
    const formatSelect = h("select", { class: "gt-field" },
      h("option", { value: "jpeg" }, "JPEG"), h("option", { value: "png" }, "PNG"), h("option", { value: "webp" }, "WEBP"),
    );
    const qualityInput = h("input", { class: "gt-field", type: "number", value: "95", min: "1", max: "100" });
    const resizeSelect = h("select", { class: "gt-field" },
      h("option", { value: "original" }, "Original"), h("option", { value: "percent:50" }, "50%"),
      h("option", { value: "percent:25" }, "25%"), h("option", { value: "width" }, "Custom width"),
      h("option", { value: "height" }, "Custom height"),
    );
    const resizeCustomInput = h("input", { class: "gt-field", type: "number", placeholder: "pixels", style: "display:none;margin-top:8px;" });
    resizeSelect.addEventListener("change", () => {
      resizeCustomInput.style.display = (resizeSelect.value === "width" || resizeSelect.value === "height") ? "" : "none";
    });

    const progressHost = h("div", {});
    const startBtn = h("button", { class: "btn btn-primary" }, "Extract");

    const { close } = gtCloseableModal(h("div", {},
      h("h3", {}, `Advanced Frame Extractor \u2014 "${it.name || it.display_name}"`),
      tabs, modeBody,
      h("label", { class: "gt-field-label" }, "Save into"),
      dest.destSelect, dest.newNameInput,
      h("div", { class: "gt-row" },
        h("div", {}, h("label", { class: "gt-field-label" }, "Base name"), baseNameInput),
        h("div", {}, h("label", { class: "gt-field-label" }, "Format"), formatSelect),
      ),
      h("div", { class: "gt-row" },
        h("div", {}, h("label", { class: "gt-field-label" }, "Quality (JPEG/WEBP)"), qualityInput),
        h("div", {}, h("label", { class: "gt-field-label" }, "Resolution"), resizeSelect, resizeCustomInput),
      ),
      progressHost,
      h("div", { class: "row", style: "margin-top:14px;" },
        h("button", { class: "btn btn-ghost", onclick: () => close() }, "Cancel"),
        startBtn,
      ),
    ), true);

    startBtn.addEventListener("click", async () => {
      const destResolved = await dest.resolveDest();
      if (!destResolved) return;

      let params = {};
      if (mode === "every_nth") params = { n: parseInt(nthInput.value || "10", 10) };
      else if (mode === "fps") params = { fps: parseFloat(fpsInput.value || "2") };
      else if (mode === "interval") params = { seconds: parseFloat(intervalInput.value || "5") };
      else if (mode === "frame_range") params = {
        start: parseInt(rangeStart.value || "0", 10), end: parseInt(rangeEnd.value || "0", 10),
        every: parseInt(rangeEvery.value || "1", 10),
      };
      else if (mode === "time_range") params = {
        start_sec: parseTimeToSeconds(trStart.value), end_sec: parseTimeToSeconds(trEnd.value),
        fps: parseFloat(trFps.value || "1"),
      };
      else if (mode === "timestamps") params = {
        timestamps: timestampsArea.value.split("\n").map(s => s.trim()).filter(Boolean),
      };

      let resize = { kind: "original" };
      if (resizeSelect.value === "percent:50") resize = { kind: "percent", value: 50 };
      else if (resizeSelect.value === "percent:25") resize = { kind: "percent", value: 25 };
      else if (resizeSelect.value === "width") resize = { kind: "width", value: parseInt(resizeCustomInput.value || "0", 10) };
      else if (resizeSelect.value === "height") resize = { kind: "height", value: parseInt(resizeCustomInput.value || "0", 10) };

      const outputOpts = {
        base_name: baseNameInput.value.trim() || `${(it.name || "video").replace(/\.[^.]+$/, "")}_frame`,
        start_num: 1, separator: "..", padding: 0,
        format: formatSelect.value, quality: parseInt(qualityInput.value || "95", 10), resize,
      };

      startBtn.disabled = true; startBtn.textContent = "Starting\u2026";
      const start = await api.start_advanced_frame_extraction(t.vid, t.rel || null, destResolved.vid, destResolved.rel || null, mode, params, outputOpts);
      if (!start.ok) { toast(start.error || "Couldn't start extraction", "error"); startBtn.disabled = false; startBtn.textContent = "Extract"; return; }

      startBtn.style.display = "none";
      const prog = buildProgressUI(start.job_id);
      progressHost.appendChild(prog.wrap);
      const job = await pollJob(start.job_id, prog.update);
      if (job.status === "done") {
        toast(`Saved ${job.result?.saved ?? job.done} frame${(job.result?.saved ?? job.done) === 1 ? "" : "s"}`, "success");
        close(); await refreshAfterItemAction(); render();
      } else if (job.status === "cancelled") {
        toast("Extraction cancelled", "warn");
        close(); await refreshAfterItemAction(); render();
      } else {
        toast(job.error || "Frame extraction failed", "error");
      }
    });
  }

  function parseTimeToSeconds(str) {
    str = (str || "").trim();
    if (!str) return 0;
    if (!str.includes(":")) return parseFloat(str) || 0;
    const parts = str.split(":").map(p => parseFloat(p) || 0);
    while (parts.length < 3) parts.unshift(0);
    const [hh, mm, ss] = parts.slice(-3);
    return hh * 3600 + mm * 60 + ss;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4. INCREASE QUALITY — image upscaler (Lanczos resample + sharpen, run
  // as a background job) with a before/after comparison and an explicit
  // choice of where the result goes. `opts.onSaved(action)` is an optional
  // callback the lightbox uses to refresh the image it's showing after an
  // in-place overwrite; the tile menu doesn't need it (a normal view
  // refresh already covers that case).
  // ────────────────────────────────────────────────────────────────────────
  const UPSCALE_TARGETS = [
    { id: "2x", label: "2\u00d7", sub: "Double the current size" },
    { id: "4x", label: "4\u00d7", sub: "Quadruple the current size" },
    { id: "4k", label: "4K", sub: "Fit within 3840px on the long edge" },
    { id: "8k", label: "8K", sub: "Fit within 7680px on the long edge" },
  ];

  async function openImageUpscaler(it, opts) {
    opts = opts || {};
    if (it.is_dir || it.cat !== "image") { toast("Increase Quality only works on photos", "warn"); return; }
    const t = effectiveTarget(it);

    let target = "4k";
    let useAi = false;
    let aiInfo = { has_token: false, token_preview: "", enabled: false };
    const fallback_before_url = versionedThumbUrl(it) || it.media_url;

    const bodyHost = h("div", {});
    const { close, box } = gtCloseableModal(h("div", {},
      h("h3", {}, `Increase Quality \u2014 "${it.name || it.display_name}"`),
      h("p", {}, "Upscales this photo using high-quality resampling and sharpening. This sharpens and enlarges what's already in the photo \u2014 it can't invent detail that isn't there, so results vary by source quality."),
      bodyHost,
    ), true);
    box.classList.remove("modal-wide");
    box.classList.add("modal-xxl");

    async function renderSetup() {
      bodyHost.innerHTML = "";
      bodyHost.appendChild(h("div", { class: "gt-field-label", style: "margin-top:0;" }, "Loading\u2026"));
      const settingsRes = await api.get_ai_settings();
      if (settingsRes.ok) {
        aiInfo = settingsRes;
        useAi = aiInfo.has_token && aiInfo.enabled;
      }
      renderSetupBody();
    }

    function renderSetupBody() {
      bodyHost.innerHTML = "";
      const grid = h("div", { class: "gt-radio-grid iq-target-grid" });
      UPSCALE_TARGETS.forEach(opt => {
        const card = h("div", { class: `gt-radio-opt ${opt.id === target ? "active" : ""}` },
          h("div", { style: "font-weight:600;font-size:14px;" }, opt.label),
          h("div", { style: "font-size:11.5px;color:var(--text-2);margin-top:2px;" }, opt.sub),
        );
        card.addEventListener("click", () => {
          target = opt.id;
          Array.from(grid.children).forEach(c => c.classList.remove("active"));
          card.classList.add("active");
        });
        grid.appendChild(card);
      });
      bodyHost.appendChild(grid);
      bodyHost.appendChild(h("p", { style: "font-size:11.5px;color:var(--text-2);margin-top:8px;" },
        "2\u00d7/4\u00d7 always multiply this photo's own resolution. 4K/8K set a target size and won't shrink a photo that's already bigger than that \u2014 in that case only the sharpening pass runs."));

      // ── Free AI enhancement (Hugging Face) — managed in Privacy & Security ──
      const aiBox = h("div", { class: "iq-ai-box" });
      if (aiInfo.has_token && aiInfo.enabled) {
        const useAiCheckbox = h("input", { type: "checkbox" });
        useAiCheckbox.checked = useAi;
        useAiCheckbox.addEventListener("change", () => { useAi = useAiCheckbox.checked; });
        aiBox.appendChild(h("label", { class: "iq-ai-label" },
          useAiCheckbox,
          h("span", {},
            h("strong", {}, "\u2728 Use AI enhancement for this photo"),
            h("span", { style: "color:var(--text-2);" }, ` \u2014 reconstructs real detail instead of just resizing. (Key: ${aiInfo.token_preview})`),
          ),
        ));
      } else {
        aiBox.appendChild(h("div", { style: "font-size:12.5px;color:var(--text-2);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;" },
          h("span", {}, "\u2728 AI enhancement isn't set up yet \u2014 it reconstructs real detail instead of just resizing, using a free Hugging Face model."),
          (() => {
            const b = h("button", { class: "btn btn-ghost btn-sm" }, "Set up in Privacy & Security \u2192");
            b.addEventListener("click", () => { close(); state.view = "privacy"; render(); window.scrollTo(0, 0); });
            return b;
          })(),
        ));
      }
      bodyHost.appendChild(aiBox);

      const startBtn = h("button", { class: "btn btn-primary" }, "Increase Quality");
      const cancelBtn = h("button", { class: "btn btn-ghost", onclick: () => close() }, "Cancel");
      bodyHost.appendChild(h("div", { class: "row", style: "margin-top:16px;" }, cancelBtn, startBtn));

      startBtn.addEventListener("click", async () => {
        startBtn.disabled = true; startBtn.textContent = "Starting\u2026";
        const start = await api.start_image_upscale(t.vid, t.rel || null, target, useAi);
        if (!start.ok) { toast(start.error || "Couldn't start", "error"); startBtn.disabled = false; startBtn.textContent = "Increase Quality"; return; }
        renderProgress(start.job_id);
      });
    }

    function renderProgress(jobId) {
      bodyHost.innerHTML = "";
      const prog = buildProgressUI(jobId);
      bodyHost.appendChild(prog.wrap);
      pollJob(jobId, prog.update).then(job => {
        if (job.status === "done") renderCompare(job);
        else if (job.status === "cancelled") { toast("Increase Quality cancelled", "warn"); close(); }
        else { toast(job.error || "Couldn't increase quality", "error"); close(); }
      });
    }

    function renderCompare(job) {
      const res = job.result || {};
      const before_url = res.before_preview_data_url || fallback_before_url;
      bodyHost.innerHTML = "";
      if (res.ai_note) {
        bodyHost.appendChild(h("p", { style: "background:var(--card-2);border-radius:8px;padding:8px 12px;font-size:12px;" }, res.ai_note));
      } else if (!res.ai_used && res.resized === false) {
        bodyHost.appendChild(h("p", { style: "background:var(--card-2);border-radius:8px;padding:8px 12px;font-size:12px;" },
          "This photo is already at or above the target size, so its resolution wasn't changed \u2014 only the sharpening pass ran."));
      }
      bodyHost.appendChild(h("div", { class: "iq-compare" },
        h("div", { class: "iq-compare-col" },
          h("div", { class: "iq-compare-label" }, "Before"),
          h("div", { class: "iq-compare-frame" }, h("img", { class: "iq-compare-img", src: before_url })),
          h("div", { class: "iq-compare-dims" }, `${res.before_w} \u00d7 ${res.before_h}`),
        ),
        h("div", { class: "iq-compare-col" },
          h("div", { class: "iq-compare-label" }, res.ai_used ? "After \u2014 \u2728 AI Enhanced" : "After"),
          h("div", { class: "iq-compare-frame" }, h("img", { class: "iq-compare-img", src: res.preview_data_url })),
          h("div", { class: "iq-compare-dims" }, `${res.after_w} \u00d7 ${res.after_h}  \u00b7  ${res.after_size_h || ""}`),
        ),
      ));

      const discardBtn = h("button", { class: "btn btn-ghost" }, "Discard");
      const copyBtn = h("button", { class: "btn btn-ghost" }, "Save as Copy");
      const overwriteBtn = h("button", { class: "btn btn-primary" }, "Save as Original");
      bodyHost.appendChild(h("div", { class: "row", style: "margin-top:16px;justify-content:space-between;" },
        discardBtn,
        h("div", { style: "display:flex;gap:8px;" }, copyBtn, overwriteBtn),
      ));

      async function finalize(action, btn, busyLabel) {
        [discardBtn, copyBtn, overwriteBtn].forEach(b => b.disabled = true);
        btn.textContent = busyLabel;
        const res2 = await api.finalize_image_upscale(job.id, action);
        if (!res2.ok) {
          toast(res2.error || "Couldn't save the result", "error");
          [discardBtn, copyBtn, overwriteBtn].forEach(b => b.disabled = false);
          btn.textContent = action === "copy" ? "Save as Copy" : "Save as Original";
          return;
        }
        close();
        toast(action === "copy" ? `Saved as "${res2.name}"` : "Original updated", "success");
        if (opts.onSaved) opts.onSaved(action);
        await refreshAfterItemAction(); render();
      }

      discardBtn.addEventListener("click", async () => {
        await api.discard_image_upscale(job.id);
        close();
      });
      copyBtn.addEventListener("click", () => finalize("copy", copyBtn, "Saving\u2026"));
      overwriteBtn.addEventListener("click", () => finalize("overwrite", overwriteBtn, "Saving\u2026"));
    }

    renderSetup();
  }
})();