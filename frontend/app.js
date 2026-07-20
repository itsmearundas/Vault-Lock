(function () {
  "use strict";

  // ────────────────────────────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────────────────────────────
  const state = {
    screen: "loading",        // loading | setup | login | app
    view: "gallery",          // gallery | settings
    viewMode: "grid",         // grid | list
    path: [],                 // stack of {vid, rel, name} — [] = vault root
    items: [],
    search: "",
    selectMode: false,
    selected: new Set(),
    stats: { count: 0, size_h: "0 B" },
    busy: false,
  };

  let api = null;

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
        box.appendChild(inputEl);
      }
      const row = h("div", { class: "row" });
      (buttons || [{ label: "OK", value: true, variant: "btn-primary" }]).forEach(b => {
        row.appendChild(h("button", {
          class: `btn ${b.variant || "btn-ghost"}`,
          onclick: () => { close(); resolve(input ? (inputEl.value || null) : b.value); }
        }, b.label));
      });
      box.appendChild(row);
      backdrop.appendChild(box);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { close(); resolve(input ? null : false); } });
      host.appendChild(backdrop);
      if (inputEl) setTimeout(() => inputEl.focus(), 30);
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

  let booted = false;
  onReady(async () => {
    if (booted) return;
    booted = true;
    try {
      api = window.pywebview.api;
      const has = await api.has_vault();
      state.screen = has ? "login" : "setup";
      render();
    } catch (err) {
      mount(h("div", { class: "auth-wrap" }, h("div", { class: "auth-card" },
        h("h1", { class: "auth-title" }, "Couldn't start VaultLock"),
        h("p", { class: "auth-sub" }, String(err && err.message || err)),
      )));
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Render dispatcher
  // ────────────────────────────────────────────────────────────────────────
  function render() {
    if (state.screen === "setup") mount(renderSetup());
    else if (state.screen === "login") mount(renderLogin());
    else if (state.screen === "app") mount(renderApp());
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
          await loadCurrentView();
          render();
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
  async function loadCurrentView() {
    state.stats = await api.get_stats();
    if (state.path.length === 0) {
      state.items = await api.list_root();
    } else {
      const top = state.path[state.path.length - 1];
      const res = await api.browse(top.vid, top.rel);
      state.items = res.ok ? res.items : [];
    }
  }

  function renderApp() {
    const shell = h("div", { class: "shell screen-fade" });
    shell.appendChild(renderSidebar());
    const main = h("div", { class: "main" });
    main.appendChild(renderTopbar());
    main.appendChild(state.view === "settings" ? renderSettings() : renderContent());
    if (state.selectMode) main.appendChild(renderBulkBar());
    shell.appendChild(main);
    return shell;
  }

  function renderSidebar() {
    const nav = (icon, label, key) => h("div", {
      class: `nav-item ${state.view === key ? "active" : ""}`,
      onclick: async () => { state.view = key; if (key === "gallery") { state.path = []; await loadCurrentView(); } render(); }
    }, h("span", { class: "nav-ico" }, icon), label);

    return h("div", { class: "sidebar" },
      h("div", { class: "brand" },
        h("div", { class: "brand-badge" }, "\u{1F512}"),
        h("div", { class: "brand-name" }, "VaultLock")
      ),
      nav("\u{1F5C2}\uFE0F", "My Vault", "gallery"),
      nav("\u2699\uFE0F", "Settings", "settings"),
      h("div", { class: "sidebar-spacer" }),
      h("div", { class: "sidebar-stats" },
        h("b", {}, `${state.stats.count} item${state.stats.count === 1 ? "" : "s"} locked`),
        state.stats.size_h
      )
    );
  }

  function renderTopbar() {
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
    const row2 = h("div", { class: "topbar-row2" },
      !atRoot ? crumbs : h("div", { class: "meta-line" }, `${state.stats.count} items \u00B7 ${state.stats.size_h}`),
      h("div", { style: "display:flex;align-items:center;gap:14px;" }, search, viewToggle)
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
    actions.push(h("button", { class: "btn btn-primary btn-sm", onclick: onAddFile }, "\uFF0B File"));
    if (atRoot) actions.push(h("button", { class: "btn btn-secondary btn-sm", onclick: onAddFolder }, "\uFF0B Folder"));
    return actions;
  }

  async function onAddFile() {
    const res = await api.add_files();
    if (res.added) toast(`Locked ${res.added} file${res.added > 1 ? "s" : ""}`, "success");
    res.errors.forEach(e => toast(e, "error"));
    if (res.added) { await loadCurrentView(); render(); }
  }
  async function onAddFolder() {
    const res = await api.add_folder();
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
  function selectAllVisible() {
    filteredItems().forEach(it => state.selected.add(itemKey(it)));
    render();
  }
  function deselectAll() {
    state.selected.clear();
    render();
  }

  function renderBulkBar() {
    const n = state.selected.size;
    const total = filteredItems().length;
    const vids = Array.from(state.selected);
    const allSelected = total > 0 && n === total;

    return h("div", { class: "bulk-bar" },
      h("span", { class: "bulk-count" }, n > 0 ? `${n} selected` : "Select items\u2026"),
      h("div", { class: "divider-v" }),
      h("button", {
        class: "btn btn-ghost", disabled: allSelected || total === 0, onclick: selectAllVisible
      }, "\u2611 Select All"),
      h("button", {
        class: "btn btn-ghost", disabled: n === 0, onclick: deselectAll
      }, "\u2610 Deselect All"),
      h("div", { class: "divider-v" }),
      h("button", { class: "btn btn-ghost", disabled: n === 0, onclick: async () => {
        const res = await api.restore_batch(vids, null);
        finishBulk(res, "restored");
      } }, "\u21A9 Restore to original"),
      h("button", { class: "btn btn-ghost", disabled: n === 0, onclick: async () => {
        const dest = await api.choose_folder();
        if (!dest) return;
        const res = await api.restore_batch(vids, dest);
        finishBulk(res, "restored");
      } }, "\u{1F4C2} Restore to folder\u2026"),
      h("button", { class: "btn btn-danger", disabled: n === 0, onclick: async () => {
        const yes = await confirmDanger(`Delete ${n} item${n > 1 ? "s" : ""}?`, "This permanently deletes the selected files/folders. This cannot be undone.", "Delete");
        if (!yes) return;
        const res = await api.delete_batch(vids);
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
    return wrap;
  }
  function renderContentInPlace() {
    const wrap = document.getElementById("content-area");
    if (!wrap) return;
    wrap.className = `content ${state.selectMode ? "select-mode" : ""}`;
    fillContent(wrap);
  }

  function fillContent(wrap) {
    wrap.innerHTML = "";
    const items = filteredItems();
    if (items.length === 0) {
      wrap.appendChild(h("div", { class: "empty-state" },
        h("div", { class: "empty-badge" }, "\u{1F5BC}\uFE0F"),
        h("h3", {}, state.search ? "No matches" : "This is empty"),
        h("p", {}, state.search ? "Try a different search term." : "Add files or folders using the buttons above.")
      ));
      return;
    }

    const atRoot = state.path.length === 0;
    if (atRoot) {
      const groups = [
        { key: "folder", title: "Folders" },
        { key: ["image", "video"], title: "Photos & Videos" },
        { key: "audio", title: "Audio" },
        { key: ["text", "pdf", "other"], title: "Files" },
      ];
      groups.forEach(g => {
        const match = Array.isArray(g.key) ? (c) => g.key.includes(c) : (c) => c === g.key;
        const group = items.filter(i => match(i.cat));
        if (group.length === 0) return;
        wrap.appendChild(h("div", { class: "section-hdr" },
          h("h2", {}, g.title), h("span", { class: "section-count" }, group.length), h("div", { class: "section-line" })
        ));
        wrap.appendChild(state.viewMode === "grid" ? buildGrid(group, true) : buildList(group, true));
      });
    } else {
      wrap.appendChild(state.viewMode === "grid" ? buildGrid(items, false) : buildList(items, false));
    }
  }

  function catIcon(cat, isDir) {
    if (isDir) return "\u{1F4C1}";
    return { image: "\u{1F5BC}\uFE0F", video: "\u{1F3AC}", audio: "\u{1F3B5}", pdf: "\u{1F4C4}", text: "\u{1F4CB}", other: "\u{1F4CE}" }[cat] || "\u{1F4CE}";
  }

  function buildGrid(items, canManage) {
    const grid = h("div", { class: "grid" });
    items.forEach((it, idx) => grid.appendChild(buildTile(it, idx, items, canManage)));
    return grid;
  }

  function itemKey(it) { return canonicalKey(it); }
  function canonicalKey(it) { return it.vid || it.rel; }

  function buildTile(it, idx, siblings, canManage) {
    const key = itemKey(it);
    const selected = state.selected.has(key);
    const thumbBox = h("div", { class: "tile-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: it.thumb_url, loading: "lazy" });
      img.addEventListener("error", () => { img.remove(); thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir))); });
      thumbBox.appendChild(img);
    } else {
      thumbBox.appendChild(h("div", { class: "icon-fallback" }, catIcon(it.cat, it.is_dir)));
    }
    if (it.cat === "video") thumbBox.appendChild(h("div", { class: "badge-play" }, h("div", { class: "circle", html: ICON.play })));
    if (it.is_dir) thumbBox.appendChild(h("div", { class: "badge-folder" }, "\u{1F4C1}"));

    const selBox = h("div", {
      class: "tile-select", onclick: (e) => { e.stopPropagation(); toggleSelect(key); }
    }, selected ? ICON.check : "");

    const actions = h("div", { class: "tile-hover-actions" });
    if (canManage && !state.selectMode) {
      actions.appendChild(actBtn("\u25B6", "Open", () => openItem(it, idx, siblings)));
      actions.appendChild(actBtn("\u21A9", "Restore to original", () => restoreOne(it, null)));
      actions.appendChild(actBtn("\u{1F4C2}", "Restore to folder\u2026", () => restoreOneChoose(it)));
      actions.appendChild(actBtn("\u{1F5D1}", "Delete", () => deleteOne(it), true));
    }

    const tile = h("div", { class: `tile ${selected ? "selected" : ""}` },
      thumbBox, selBox, actions,
      h("div", { class: "tile-info" },
        h("div", { class: "tile-name" }, it.name),
        h("div", { class: "tile-meta" }, it.size_h + (it.time_ago ? `  \u00B7  ${it.time_ago}` : ""))
      )
    );
    tile.addEventListener("click", () => {
      if (state.selectMode && canManage) toggleSelect(key);
      else openItem(it, idx, siblings);
    });
    return tile;
  }

  function actBtn(icon, title, fn, danger) {
    const b = h("button", { class: `tile-action-btn ${danger ? "danger" : ""}`, title }, icon);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function buildList(items, canManage) {
    const list = h("div", { class: "list" });
    list.appendChild(h("div", { class: "list-hdr" },
      h("div", { style: "width:32px" }), h("div", { style: "width:38px" }),
      h("div", { class: "list-name" }, "Name"),
      h("div", { class: "list-col type" }, "Type"), h("div", { class: "list-col" }, "Size"),
      h("div", { class: "list-col" }, "Added"), h("div", { style: "width:120px" })
    ));
    items.forEach((it, idx) => list.appendChild(buildRow(it, idx, items, canManage)));
    return list;
  }

  function buildRow(it, idx, siblings, canManage) {
    const key = itemKey(it);
    const selected = state.selected.has(key);
    const check = h("div", {
      class: "list-check", onclick: (e) => { e.stopPropagation(); toggleSelect(key); }
    }, selected ? ICON.check : "");
    const thumb = h("div", { class: "list-thumb" });
    if (it.thumb_url) {
      const img = h("img", { src: it.thumb_url });
      img.addEventListener("error", () => { img.remove(); thumb.textContent = catIcon(it.cat, it.is_dir); });
      thumb.appendChild(img);
    } else thumb.textContent = catIcon(it.cat, it.is_dir);

    const row = h("div", { class: `list-row ${selected ? "selected" : ""}` },
      check, thumb,
      h("div", { class: "list-name" }, it.name),
      h("div", { class: "list-col type" }, it.is_dir ? "Folder" : (it.ext || it.cat).replace(".", "").toUpperCase()),
      h("div", { class: "list-col" }, it.size_h),
      h("div", { class: "list-col" }, it.time_ago || ""),
    );
    const actions = h("div", { class: "list-actions" });
    actions.appendChild(actBtn("\u25B6", "Open", () => openItem(it, idx, siblings)));
    if (canManage) {
      actions.appendChild(actBtn("\u21A9", "Restore to original", () => restoreOne(it, null)));
      actions.appendChild(actBtn("\u{1F4C2}", "Restore to folder\u2026", () => restoreOneChoose(it)));
      actions.appendChild(actBtn("\u{1F5D1}", "Delete", () => deleteOne(it), true));
    }
    row.appendChild(actions);
    row.addEventListener("click", () => {
      if (state.selectMode && canManage) toggleSelect(key);
      else openItem(it, idx, siblings);
    });
    return row;
  }

  function toggleSelect(key) {
    if (state.selected.has(key)) state.selected.delete(key); else state.selected.add(key);
    state.selectMode = true;
    render();
  }

  // ── Single-item restore / delete ────────────────────────────────────────
  async function restoreOne(it, dest) {
    const res = await api.restore_item(it.vid, dest);
    toast(res.ok ? `Restored "${it.name}"` : `Failed: ${res.result}`, res.ok ? "success" : "error");
    if (res.ok) { await loadCurrentView(); render(); }
  }
  async function restoreOneChoose(it) {
    const dest = await api.choose_folder();
    if (!dest) return;
    restoreOne(it, dest);
  }
  async function deleteOne(it) {
    const yes = await confirmDanger(`Delete "${it.name}"?`, "This permanently deletes it from the vault. This cannot be undone.", "Delete");
    if (!yes) return;
    const res = await api.delete_item(it.vid);
    toast(res.ok ? `Deleted "${it.name}"` : `Failed: ${res.result}`, res.ok ? "success" : "error");
    if (res.ok) { await loadCurrentView(); render(); }
  }

  // ── Opening items (folders navigate in-place, media opens the lightbox) ─
  async function openItem(it, idx, siblings) {
    if (it.is_dir) {
      const atRoot = state.path.length === 0;
      const vid = atRoot ? it.vid : state.path[state.path.length - 1].vid;
      const rel = atRoot ? "" : it.rel;
      state.path.push({ vid, rel, name: it.name });
      await loadCurrentView();
      render();
      return;
    }
    if (it.cat === "image" || it.cat === "video") {
      const mediaSiblings = siblings.filter(s => !s.is_dir && s.cat === it.cat);
      openLightbox(mediaSiblings, mediaSiblings.findIndex(s => itemKey(s) === itemKey(it)));
      return;
    }
    // audio / pdf / text / other → hand off to the system app
    const top = state.path[state.path.length - 1];
    const vid = it.vid || (top && top.vid);
    const rel = it.rel || null;
    await api.open_with_system(vid, rel);
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

    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft" && items.length > 1) { i = (i - 1 + items.length) % items.length; draw(); }
      else if (e.key === "ArrowRight" && items.length > 1) { i = (i + 1) % items.length; draw(); }
    }
    document.addEventListener("keydown", onKey);
    _closeActiveLightbox = close;

    function draw() {
      host.innerHTML = "";
      const it = items[i];
      const bar = h("div", { class: "lb-bar" },
        h("span", { class: "lb-title" }, it.name),
        h("span", { class: "lb-counter" }, `${i + 1} / ${items.length}`),
        h("div", { class: "lb-spacer" }),
        h("button", { class: "lb-btn", onclick: close }, "\u2715")
      );
      const stage = h("div", { class: "lb-stage" });
      if (items.length > 1) {
        stage.appendChild(h("button", { class: "lb-nav prev", onclick: () => { i = (i - 1 + items.length) % items.length; draw(); } }, "\u2039"));
        stage.appendChild(h("button", { class: "lb-nav next", onclick: () => { i = (i + 1) % items.length; draw(); } }, "\u203A"));
      }

      const box = h("div", { class: "lightbox" }, bar);
      if (it.cat === "image") {
        stage.appendChild(h("img", { src: it.media_url }));
        box.appendChild(stage);
      } else {
        stage.appendChild(h("video", { src: it.media_url, controls: "controls", autoplay: "autoplay" }));
        box.appendChild(stage);
      }
      host.appendChild(box);
    }
    function close() {
      document.removeEventListener("keydown", onKey);
      host.innerHTML = "";
      if (_closeActiveLightbox === close) _closeActiveLightbox = null;
    }
    draw();
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
      renderStorageLocationRow()
    ));

    inner.appendChild(h("div", { class: "settings-card" },
      h("h3", {}, "Danger zone"),
      h("p", { class: "desc" }, "Permanently deletes every file and folder currently in this vault."),
      h("button", { class: "btn btn-danger", onclick: onWipeVault }, "\u{1F4A3} Wipe entire vault")
    ));

    wrap.appendChild(inner);
    return wrap;
  }
})();
