"""
VaultLock — native desktop app (pywebview).

This is NOT a browser app: pywebview renders the UI using the OS's built-in
web-rendering engine (Edge WebView2 on Windows) inside a plain, chrome-less
native window — no address bar, no tabs, no browser UI. It's the same
approach apps like Slack, VS Code and Discord use under the hood; the person
using it just sees a normal desktop window.
"""
import os, sys, json, threading, base64, shutil
from pathlib import Path
from datetime import datetime, timedelta

import webview

if sys.platform == "win32":
    # pywebview decides whether to use EdgeChromium (WebView2) or fall back to
    # the deprecated, crash-prone MSHTML/Internet Explorer engine by checking
    # a classic .NET Framework 4.6.2 registry key IN ADDITION to WebView2
    # itself — a check that can fail on modern pythonnet/.NET (CoreCLR) setups
    # even when WebView2 is installed and working fine. Pointing this setting
    # at a path that doesn't exist makes pywebview skip that broken gate and
    # just use the normal system-installed WebView2 runtime instead (see
    # webview/platforms/edgechromium.py's own graceful fallback for this).
    webview.settings['WEBVIEW2_RUNTIME_PATH'] = r'C:\__vaultlock_use_system_webview2__'

import vault_core as core
import media_server

FRONTEND_DIR = Path(__file__).parent / "frontend"

server, PORT = media_server.start_server()

# Same client GUIDs pywebview itself checks for the WebView2 Runtime family
# (stable / beta / dev / canary), reused here without its extra unrelated
# .NET Framework requirement, which is what was producing false negatives.
_WEBVIEW2_CLIENT_GUIDS = [
    "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",  # Runtime
    "{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}",  # Beta
    "{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}",  # Dev
    "{65C35B14-6C1D-4122-AC46-7148CC9D6497}",  # Canary
]


def _webview2_available():
    if sys.platform != "win32":
        return True
    import winreg
    for guid in _WEBVIEW2_CLIENT_GUIDS:
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for path in (rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{guid}",
                         rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{guid}"):
                try:
                    with winreg.OpenKey(hive, path) as k:
                        version, _ = winreg.QueryValueEx(k, "pv")
                        if version and version not in ("0.0.0.0", "0"):
                            return True
                except (FileNotFoundError, OSError):
                    continue
    return False


def _warn_missing_webview2():
    import ctypes
    url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    msg = (
        "VaultLock needs the Microsoft Edge WebView2 Runtime to display its "
        "interface, and it wasn't detected on this PC.\n\n"
        "This is a small, one-time Microsoft install (not related to the Edge "
        "browser itself) — most Windows 11 PCs already have it, but yours may "
        "be missing it or have it in a spot this check can't see.\n\n"
        "Download it here, install it, then run VaultLock again:\n" + url
    )
    try:
        ctypes.windll.user32.MessageBoxW(0, msg, "VaultLock — WebView2 Runtime required", 0x10)
    except Exception:
        print(msg)
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass


class Api:
    def __init__(self):
        self._engine = None
        self._is_decoy = False
        self._dek = None
        self._window = None
        # A fresh per-session token, required on every media_server request
        # (§2 fix) — rotated again on every login and on lock_out(), so a
        # URL captured from one session (e.g. left in a screenshot, or from
        # before a lock) can never be replayed against a later one.
        self._session_token = core.new_session_token()

    # ── bootstrap ────────────────────────────────────────────────────────
    def _bind_window(self, window):
        self._window = window

    def has_vault(self):
        core.ensure_dirs()
        cfg = core.load_cfg()
        return bool(cfg.get("master_hash"))

    def app_info(self):
        return {"version": core.APP_VERSION, "media_port": PORT}

    def default_location_info(self):
        """Where the vault would live if the person doesn't pick a custom
        location — shown on the setup screen as the pre-filled default."""
        base = core.default_base_dir()
        free = core.disk_free_bytes(base.anchor or str(base))
        return {"path": str(base), "free_h": core.human_size(free)}

    def choose_location(self):
        """Native folder picker for choosing ANY drive/folder to store the
        vault in (used both on first-time setup and later in Settings)."""
        if not self._window: return None
        paths = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        if not paths: return None
        chosen = paths[0]
        free = core.disk_free_bytes(chosen)
        return {"path": chosen, "free_h": core.human_size(free)}

    # ── setup / auth ─────────────────────────────────────────────────────
    def create_vault(self, master_pw, decoy_pw, nuke_pw, location=None):
        if location:
            core.set_base_dir(Path(location) / "VaultLockData")
        core.ensure_dirs()
        if not master_pw or len(master_pw) < 8:
            return {"ok": False, "error": "Master password must be at least 8 characters."}
        if decoy_pw and len(decoy_pw) < 8:
            return {"ok": False, "error": "Decoy password must be at least 8 characters."}
        if nuke_pw and len(nuke_pw) < 8:
            return {"ok": False, "error": "Nuke password must be at least 8 characters."}
        if decoy_pw and decoy_pw == master_pw:
            return {"ok": False, "error": "Decoy password must differ from the master password."}
        if nuke_pw and nuke_pw in (master_pw, decoy_pw):
            return {"ok": False, "error": "Nuke password must be unique."}

        master_salt = os.urandom(16)
        master_dek = core.new_dek()
        cfg = {
            "master_hash": core.hash_pw(master_pw),
            "decoy_hash": core.hash_pw(decoy_pw) if decoy_pw else None,
            "nuke_hash": core.hash_pw(nuke_pw) if nuke_pw else None,
            "kdf_iterations": core.KDF_ITERATIONS,
            "master_salt": base64.b64encode(master_salt).decode(),
            "master_wrapped_dek": base64.b64encode(
                core.wrap_dek(core.derive_kek(master_pw, master_salt), master_dek)).decode(),
            "decoy_salt": None,
            "decoy_wrapped_dek": None,
            "nuke_salt": None,
            "nuke_wrapped_dek": None,
        }
        # A decoy DEK is generated even without a decoy password, purely so
        # dmeta.json can be written in the same encrypted format as the
        # master index — it's unreachable either way without decoy_hash set.
        decoy_dek = core.new_dek()
        if decoy_pw:
            decoy_salt = os.urandom(16)
            cfg["decoy_salt"] = base64.b64encode(decoy_salt).decode()
            cfg["decoy_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(decoy_pw, decoy_salt), decoy_dek)).decode()
        if nuke_pw:
            # Nuke wipes the vault's *contents*, not its encryption key — it
            # wraps the SAME master_dek under a different password so a nuke
            # login still decrypts consistently with the (now emptied) vault.
            nuke_salt = os.urandom(16)
            cfg["nuke_salt"] = base64.b64encode(nuke_salt).decode()
            cfg["nuke_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(nuke_pw, nuke_salt), master_dek)).decode()
        core.save_cfg(cfg)
        core.save_meta({"files": {}}, False, master_dek)
        core.save_meta({"files": {}}, True, decoy_dek)
        return {"ok": True}

    # ── login lockout ────────────────────────────────────────────────────
    # Escalating lockout after repeated failed attempts: 5 wrong passwords
    # in a row triggers a lockout window that doubles each time it's
    # triggered again (30s, 1m, 2m, 4m, ... capped at 30m). Correctly
    # entering ANY of the three passwords (master/decoy/nuke) resets this —
    # deliberately uniform across all three so a lockout can never be used
    # to infer which slots exist or which one was tried.
    _LOCKOUT_THRESHOLD = 5
    _LOCKOUT_BASE_SECONDS = 30
    _LOCKOUT_CAP_SECONDS = 1800

    def _check_lockout(self, cfg):
        until = cfg.get("lockout_until")
        if not until:
            return None
        try:
            remaining = (datetime.fromisoformat(until) - datetime.now()).total_seconds()
        except Exception:
            return None
        if remaining <= 0:
            return None
        return int(remaining)

    def _record_login_result(self, cfg, success):
        if success:
            cfg["failed_attempts"] = 0
            cfg["lockout_until"] = None
            core.save_cfg(cfg)
            return
        cfg["failed_attempts"] = cfg.get("failed_attempts", 0) + 1
        if cfg["failed_attempts"] >= self._LOCKOUT_THRESHOLD:
            stage = cfg.get("lockout_stage", 0) + 1
            cfg["lockout_stage"] = stage
            delay = min(self._LOCKOUT_BASE_SECONDS * (2 ** (stage - 1)), self._LOCKOUT_CAP_SECONDS)
            cfg["lockout_until"] = (datetime.now() + timedelta(seconds=delay)).isoformat()
            cfg["failed_attempts"] = 0
        core.save_cfg(cfg)

    def login(self, password):
        cfg = core.load_cfg()
        if not cfg.get("master_hash"):
            return {"status": "no_vault"}
        locked_for = self._check_lockout(cfg)
        if locked_for is not None:
            return {"status": "locked", "retry_after_seconds": locked_for}
        iterations = cfg.get("kdf_iterations", core.KDF_ITERATIONS)

        # Nuke check first — must never leave a trace either way
        if cfg.get("nuke_hash") and core.verify_pw(password, cfg["nuke_hash"]):
            dek = None
            if cfg.get("nuke_wrapped_dek") and cfg.get("nuke_salt"):
                nuke_salt = base64.b64decode(cfg["nuke_salt"])
                kek = core.derive_kek(password, nuke_salt, iterations)
                dek = core.unwrap_dek(kek, base64.b64decode(cfg["nuke_wrapped_dek"]))
            core.nuke_main_vault(dek)
            # Fall back to a fresh key only for legacy configs saved before
            # nuke had its own wrapped key — nothing to decrypt after a wipe
            # anyway, but this keeps the vault usable going forward.
            self._dek = dek if dek is not None else core.new_dek()
            self._engine = core.VaultEngine(False, self._dek)
            self._is_decoy = False
            self._session_token = core.new_session_token()
            media_server.STATE["engine"] = self._engine
            media_server.STATE["dek"] = self._dek
            media_server.STATE["token"] = self._session_token
            media_server.clear_caches()
            self._record_login_result(cfg, True)
            return {"status": "ok", "decoy": False, "token": self._session_token}

        if core.verify_pw(password, cfg["master_hash"]):
            master_salt = base64.b64decode(cfg["master_salt"])
            kek = core.derive_kek(password, master_salt, iterations)
            dek = core.unwrap_dek(kek, base64.b64decode(cfg["master_wrapped_dek"]))
            if dek is None:
                self._record_login_result(cfg, False)
                return {"status": "fail"}
            self._dek = dek
            self._engine = core.VaultEngine(False, self._dek)
            self._is_decoy = False
            self._session_token = core.new_session_token()
            media_server.STATE["engine"] = self._engine
            media_server.STATE["dek"] = self._dek
            media_server.STATE["token"] = self._session_token
            media_server.clear_caches()
            # Idempotent cleanup of stray thumb_custom flags/crops left
            # over from the (now-removed) thumbnail-adjust feature — see
            # _run_thumb_crop_cleanup() below. Runs in the background so
            # it never delays login.
            threading.Thread(target=self._run_thumb_crop_cleanup, daemon=True).start()
            self._record_login_result(cfg, True)
            return {"status": "ok", "decoy": False, "token": self._session_token}

        if cfg.get("decoy_hash") and core.verify_pw(password, cfg["decoy_hash"]):
            decoy_salt = base64.b64decode(cfg["decoy_salt"])
            kek = core.derive_kek(password, decoy_salt, iterations)
            dek = core.unwrap_dek(kek, base64.b64decode(cfg["decoy_wrapped_dek"]))
            if dek is None:
                self._record_login_result(cfg, False)
                return {"status": "fail"}
            self._dek = dek
            self._engine = core.VaultEngine(True, self._dek)
            self._is_decoy = True
            self._session_token = core.new_session_token()
            media_server.STATE["engine"] = self._engine
            media_server.STATE["dek"] = self._dek
            media_server.STATE["token"] = self._session_token
            media_server.clear_caches()
            threading.Thread(target=self._run_thumb_crop_cleanup, daemon=True).start()
            self._record_login_result(cfg, True)
            return {"status": "ok", "decoy": True, "token": self._session_token}

        self._record_login_result(cfg, False)
        return {"status": "fail"}

    def _run_thumb_crop_cleanup(self):
        """Runs the one remaining one-time migration that cleans up
        leftover square crops from the removed per-FILE thumbnail-adjust
        feature (see cleanup_deprecated_file_thumb_crops()'s docstring in
        vault_core.py). Called on a background thread right after unlock;
        best-effort, so a failure here never blocks login.

        NOTE: this used to also run cleanup_deprecated_folder_thumb_crops(),
        but that pass is unsafe and has been disabled. It identified
        "leftover" folder thumbnails purely by the thumb_custom flag —
        but thumb_custom is also the flag set by the still-active
        "Choose thumb…" / "Use background as thumb" buttons
        (set_folder_thumbnail_from_crop). With no way to tell an old
        leftover crop apart from a thumbnail the user picked five seconds
        ago, every login was silently wiping people's custom folder
        thumbnails back to the auto-detected default. Do not re-enable
        cleanup_deprecated_folder_thumb_crops() unless it's rewritten to
        distinguish the two cases (e.g. a dedicated legacy marker written
        only by the old feature)."""
        engine = self._engine
        if not engine:
            return
        try:
            engine.cleanup_deprecated_file_thumb_crops()
        except Exception:
            pass

    def lock_out(self):
        self._engine = None
        self._dek = None
        self._session_token = core.new_session_token()  # invalidate any URLs issued this session
        media_server.STATE["engine"] = None
        media_server.STATE["dek"] = None
        media_server.STATE["token"] = self._session_token
        media_server.clear_caches()
        core.clear_upscale_cache()  # drop any un-finalized "Increase Quality" results
        return {"ok": True}

    # ── listing ──────────────────────────────────────────────────────────
    def _u(self, path):
        """Builds a media-server URL for the current session, always
        carrying the per-session auth token — every media/thumb/bg URL the
        app hands to the frontend goes through this, so media_server never
        serves anything to a request that doesn't have it (see §2 fix)."""
        sep = "&" if "?" in path else "?"
        return f"http://127.0.0.1:{PORT}{path}{sep}token={self._session_token}"

    def _item_payload(self, vid, info):
        is_dir = info["type"] == "folder"
        payload = {
            "vid": vid, "name": info["original_name"], "is_dir": is_dir,
            "cat": "folder" if is_dir else core.file_cat(info["original_name"]),
            "size": info["size"], "size_h": core.human_size(info["size"]),
            "locked_at": info["locked_at"], "time_ago": core.time_ago(info["locked_at"]),
            "ext": info.get("ext", ""),
            "thumb_url": self._u(f"/thumb/{vid}"),
            "media_url": None if is_dir else self._u(f"/media/{vid}"),
        }
        payload.update(core.item_meta_view(info))
        return payload

    def list_root(self):
        if not self._engine: return []
        meta = core.load_meta(self._is_decoy, self._dek)
        return [self._item_payload(vid, info) for vid, info in meta["files"].items()]

    def browse(self, vid, rel):
        """List the contents of a (possibly nested) path inside a locked
        folder. `rel` is a '/'-joined path of opaque tokens (not real names)
        — the real names are resolved from the folder's encrypted manifest."""
        if not self._engine or not self._dek: return {"ok": False, "items": []}
        base = self._engine.vault_path(vid)
        manifest = core.load_tree_manifest(base, self._dek)
        if manifest is None:
            return self._browse_legacy(vid, rel)

        node = core.manifest_node_at(manifest, rel)
        if node is None or node.get("type") != "dir":
            return {"ok": False, "items": []}

        items = []
        children = sorted(
            node.get("children", {}).items(),
            key=lambda kv: (kv[1]["type"] != "dir", kv[1].get("name", "").lower())
        )
        for token, child in children:
            is_dir = child["type"] == "dir"
            rel_path = f"{rel}/{token}" if rel else token
            name = child.get("name") or token
            size = core.manifest_dir_size(child) if is_dir else child.get("size", 0)
            items.append({
                "name": name, "rel": rel_path, "is_dir": is_dir,
                "cat": "folder" if is_dir else core.file_cat(name),
                "size": size, "size_h": core.human_size(size),
                "locked_at": child.get("locked_at"),
                "time_ago": core.time_ago(child["locked_at"]) if child.get("locked_at") else "",
                "thumb_url": (self._u(f"/folder_preview?vid={vid}&rel={rel_path}")
                              if is_dir else
                              self._u(f"/nested_thumb?vid={vid}&rel={rel_path}")),
                "media_url": self._u(f"/media/{vid}/{rel_path}"),
                **core.item_meta_view(child),
            })
        return {"ok": True, "items": items}

    def _browse_legacy(self, vid, rel):
        """Folders locked before the name-obfuscation manifest existed kept
        real names directly on disk — browse those the old way."""
        base = self._engine.vault_path(vid)
        target = (base / rel) if rel else base
        try:
            target.resolve().relative_to(base.resolve())
        except Exception:
            return {"ok": False, "items": []}
        if not target.exists():
            return {"ok": False, "items": []}
        items = []
        try:
            entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except Exception:
            return {"ok": False, "items": []}
        for e in entries:
            is_dir = e.is_dir()
            rel_path = str(e.relative_to(base)).replace(os.sep, "/")
            try:
                size = (sum(max(0, f.stat().st_size - core.ENC_OVERHEAD) for f in e.rglob("*") if f.is_file())
                        if is_dir else max(0, e.stat().st_size - core.ENC_OVERHEAD))
            except Exception:
                size = 0
            items.append({
                "name": e.name, "rel": rel_path, "is_dir": is_dir,
                "cat": "folder" if is_dir else core.file_cat(e.name),
                "size": size, "size_h": core.human_size(size),
                "thumb_url": (self._u(f"/folder_preview?vid={vid}&rel={rel_path}")
                              if is_dir else
                              self._u(f"/nested_thumb?vid={vid}&rel={rel_path}")),
                "media_url": self._u(f"/media/{vid}/{rel_path}"),
            })
        return {"ok": True, "items": items}

    def get_stats(self):
        if not self._engine: return {"count": 0, "size_h": "0 B"}
        meta = core.load_meta(self._is_decoy, self._dek)
        total = sum(i["size"] for i in meta["files"].values())
        return {"count": len(meta["files"]), "size_h": core.human_size(total)}

    def clear_temp_files(self):
        """Manual 'Clear temporary decrypted files' privacy control — sweeps
        VaultLock's own temp folder right now, on demand, in addition to the
        automatic sweep that already runs once at app startup."""
        removed = core.sweep_orphaned_temp_files()
        return {"ok": True, "removed": removed}

    def factory_reset(self, current_master_pw, confirm_phrase):
        """Erases EVERYTHING: both vaults, config (passwords/salts/hashes),
        every Phase 0 preference, cached thumbnails, temp files, and the
        stored-location pointer — wherever the vault currently lives, even
        on a relocated drive. Deliberately separate code path from nuke:
        explicit, visible, requires two confirmations, and wipes the decoy
        vault + all settings too (nuke never does either of those)."""
        cfg = core.load_cfg()
        if not cfg.get("master_hash"):
            return {"ok": False, "error": "No vault exists."}
        if not core.verify_pw(current_master_pw, cfg["master_hash"]):
            return {"ok": False, "error": "Current master password is incorrect."}
        if confirm_phrase != "DELETE EVERYTHING":
            return {"ok": False, "error": 'Type "DELETE EVERYTHING" exactly to confirm.'}

        # Drop the in-memory session first so nothing else touches vault
        # state mid-wipe.
        self._engine = None
        self._dek = None
        self._is_decoy = False
        media_server.STATE["engine"] = None
        media_server.STATE["dek"] = None
        media_server.clear_caches()

        ok, err = core.factory_reset_everything()
        return {"ok": ok, "error": err}

    def get_storage_info(self):
        base = core.get_base_dir(force_reload=True)
        anchor = base.anchor or str(base)
        free = core.disk_free_bytes(anchor)
        try:
            used = sum(f.stat().st_size for f in base.rglob("*") if f.is_file()) if base.exists() else 0
        except Exception:
            used = 0
        return {"path": str(base), "drive": anchor, "free_h": core.human_size(free), "used_h": core.human_size(used)}

    def move_vault(self, new_parent_dir):
        """Moves the whole vault (real + decoy + thumbnails) to a different
        drive/folder the person picked. Safe to call with an active session —
        the engine reads its paths live, so no re-login is needed afterward."""
        if not new_parent_dir:
            return {"ok": False, "error": "No location chosen."}
        ok, res = core.move_vault_data(new_parent_dir)
        if ok:
            media_server.clear_caches()
        return {"ok": ok, "result": res}

    # ── add ──────────────────────────────────────────────────────────────
    def add_files(self):
        if not self._engine or not self._window: return {"added": 0, "errors": []}
        paths = self._window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=True)
        if not paths: return {"added": 0, "errors": []}
        added, errors = 0, []
        for p in paths:
            ok, res = self._engine.lock_item(p)
            if ok: added += 1
            else: errors.append(f"{Path(p).name}: {res}")
        return {"added": added, "errors": errors}

    def add_folder(self):
        if not self._engine or not self._window: return {"added": 0, "errors": []}
        paths = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        if not paths: return {"added": 0, "errors": []}
        ok, res = self._engine.lock_item(paths[0])
        return {"added": 1, "errors": []} if ok else {"added": 0, "errors": [res]}

    # ── restore / delete (single + batch, gallery AND list view) ────────
    def choose_folder(self):
        """Native folder picker — used for both single 'Restore to…' and
        the batch 'Restore N items to one location' action."""
        if not self._window: return None
        paths = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        return paths[0] if paths else None

    def restore_item(self, vid, dest_dir=None):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.unlock_item(vid, dest_dir)
        if ok:
            media_server.clear_caches()  # the restored item may have been a folder's cached preview source
        return {"ok": ok, "result": res}

    def restore_nested_item(self, vid, rel, dest_dir=None):
        """Restores a single file/sub-folder from inside a locked folder,
        without disturbing anything else in that folder."""
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.unlock_nested_item(vid, rel, dest_dir)
        if ok:
            media_server.clear_caches()  # that item may have been this folder's cached preview source
        return {"ok": ok, "result": res}

    def delete_nested_item(self, vid, rel):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.delete_nested_item(vid, rel)
        if ok:
            media_server.clear_caches()  # that file may have been this folder's cached preview source
        return {"ok": ok, "result": res}

    # ── add into an existing (already-locked) folder ────────────────────────
    def add_files_into(self, dest_vid, dest_rel=None):
        if not self._engine or not self._window: return {"added": 0, "errors": []}
        paths = self._window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=True)
        if not paths: return {"added": 0, "errors": []}
        added, errors = 0, []
        for p in paths:
            ok, res = self._engine.lock_item_into(p, dest_vid, dest_rel or None)
            if ok: added += 1
            else: errors.append(f"{Path(p).name}: {res}")
        if added:
            # A folder that had no preview candidate before may now have
            # one — the "no thumbnail" result was cached too, so it must
            # be cleared or the new photo never appears as the preview.
            media_server.clear_caches()
        return {"added": added, "errors": errors}

    def add_folder_into(self, dest_vid, dest_rel=None):
        if not self._engine or not self._window: return {"added": 0, "errors": []}
        paths = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        if not paths: return {"added": 0, "errors": []}
        ok, res = self._engine.lock_item_into(paths[0], dest_vid, dest_rel or None)
        if ok:
            media_server.clear_caches()
        return {"added": 1, "errors": []} if ok else {"added": 0, "errors": [res]}

    # ── rename ───────────────────────────────────────────────────────────
    def rename_item(self, vid, new_name):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.rename_item(vid, new_name)
        return {"ok": ok, "result": res}

    def rename_nested_item(self, vid, rel, new_name):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.rename_nested_item(vid, rel, new_name)
        if ok:
            media_server.clear_caches()  # _real_ext() lookups for this item are keyed off the old manifest state
        return {"ok": ok, "result": res}

    # ── custom folder thumbnail ─────────────────────────────────────────────
    def set_folder_thumbnail(self, vid, folder_rel, file_rel):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.set_folder_thumbnail(vid, folder_rel or None, file_rel or None)
        if ok:
            # The "which folder shows which preview" cache is only in
            # memory — clear THIS folder's entry so the new choice shows
            # up right away. Scoped (not clear_caches()) so every other
            # folder's already-cached preview doesn't get thrown away too.
            media_server.clear_preview_cache_for(vid, folder_rel)
        return {"ok": ok, "result": res}

    def generate_folder_collage(self, vid, folder_rel=None):
        """Smart Thumbnail Collage: replaces this folder's thumbnail with
        an auto-generated collage of up to 4 images/frames found inside
        it. Complements the manual single-image picker (set_folder_thumbnail
        / set_folder_thumbnail_from_crop) rather than replacing it — either
        can overwrite the other since they share the same cache slot."""
        if not self._engine:
            return {"ok": False, "error": "No vault open"}
        ok, err = self._engine.generate_collage_thumbnail(vid, folder_rel or None)
        if ok:
            # Scoped — see set_folder_thumbnail() above for why not
            # clear_caches().
            media_server.clear_preview_cache_for(vid, folder_rel)
        return {"ok": ok, "error": err}

    def set_folder_thumbnail_from_crop(self, vid, folder_rel, data_url):
        """Same as set_folder_thumbnail, but the source is an already
        cropped/positioned image (the output of the in-app position & zoom
        editor) instead of an existing file picked from inside the
        folder."""
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.set_folder_thumbnail_from_crop(vid, folder_rel or None, data_url)
        if ok:
            # Scoped — see set_folder_thumbnail() above for why not
            # clear_caches().
            media_server.clear_preview_cache_for(vid, folder_rel)
        return {"ok": ok, "result": res}

    def get_item_preview_data_url(self, vid, rel=None):
        """A small JPEG preview of a root or nested vault item, handed
        straight back through the JS bridge as a data: URL instead of an
        http:// one. The position/zoom editor needs this (rather than the
        usual it.thumb_url) because it loads the image into an
        <img crossorigin> for canvas export, and that requires the media
        server's response to carry a matching CORS header — which depends
        on the OS webview's exact origin string and isn't guaranteed across
        environments. A data: URL sidesteps that entirely: it never leaves
        this process, so there's no cross-origin request to satisfy."""
        if not self._engine or not self._dek:
            return {"ok": False, "error": "No vault open"}
        try:
            base = self._engine.vault_path(vid).resolve()
            target = (base / rel).resolve() if rel else base
            try:
                target.relative_to(base)
            except Exception:
                if target != base:
                    return {"ok": False, "error": "Invalid path"}
            if not target.exists():
                return {"ok": False, "error": "Not found"}

            if rel:
                manifest = core.load_tree_manifest(base, self._dek)
                node = core.manifest_node_at(manifest, rel) if manifest is not None else None
                name = (node.get("name") if node else None) or Path(rel).name
            else:
                meta = core.load_meta(self._is_decoy, self._dek)
                name = meta["files"].get(vid, {}).get("original_name", "")
            ext = Path(name).suffix.lower()

            data = None
            if ext in core.IMG_EXT and media_server.PIL_OK:
                data = media_server._image_jpeg_from_encrypted(target, self._dek)
            elif ext in core.VID_EXT and media_server.PIL_OK and media_server.CV2_OK:
                data = media_server._video_frame_jpeg_from_encrypted(target, self._dek)
            if not data:
                return {"ok": False, "error": "Couldn't read that file"}
            return {"ok": True, "data_url": f"data:image/jpeg;base64,{base64.b64encode(data).decode()}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def restore_batch(self, vids, dest_dir=None):
        """Restore many files/folders at once. Each entry in `vids` is
        either a plain vid string (a root-level vault item — kept for
        restore_all(), which only ever deals with root items) or a
        {"vid": ..., "rel": ...} object identifying a single file/
        sub-folder living inside a locked folder, exactly like the
        single-item restore_nested_item() call uses. If dest_dir is
        given, every item goes into that single chosen location;
        otherwise each item returns to its own original path."""
        if not self._engine: return {"ok": False, "results": []}
        results = []
        for entry in vids:
            if isinstance(entry, dict):
                vid, rel = entry.get("vid"), entry.get("rel")
            else:
                vid, rel = entry, None
            if rel:
                ok, res = self._engine.unlock_nested_item(vid, rel, dest_dir)
            else:
                ok, res = self._engine.unlock_item(vid, dest_dir)
            results.append({"vid": vid, "rel": rel, "ok": ok, "result": res})
        if any(r["ok"] for r in results):
            media_server.clear_caches()
        return {"ok": True, "results": results}

    def delete_item(self, vid):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.delete_item(vid)
        if ok:
            media_server.clear_caches()
        return {"ok": ok, "result": res}

    def delete_batch(self, vids):
        """Delete many files/folders at once. Same entry shape as
        restore_batch() above: a plain vid string for a root-level vault
        item, or {"vid": ..., "rel": ...} for a file/sub-folder inside a
        locked folder — routed to delete_nested_item() so multi-selecting
        several photos inside an album and deleting them actually deletes
        each one instead of silently failing because a nested item's
        selection key isn't a real top-level vid."""
        if not self._engine: return {"ok": False, "results": []}
        results = []
        for entry in vids:
            if isinstance(entry, dict):
                vid, rel = entry.get("vid"), entry.get("rel")
            else:
                vid, rel = entry, None
            if rel:
                ok, res = self._engine.delete_nested_item(vid, rel)
            else:
                ok, res = self._engine.delete_item(vid)
            results.append({"vid": vid, "rel": rel, "ok": ok, "result": res})
        if any(r["ok"] for r in results):
            media_server.clear_caches()
        return {"ok": True, "results": results}

    def restore_all(self, dest_dir=None):
        if not self._engine: return {"ok": False, "results": []}
        meta = core.load_meta(self._is_decoy, self._dek)
        vids = list(meta["files"].keys())
        return self.restore_batch(vids, dest_dir)

    def wipe_vault(self):
        if not self._engine: return {"ok": False}
        meta = core.load_meta(self._is_decoy, self._dek)
        for vid in list(meta["files"].keys()):
            self._engine.delete_item(vid)
        return {"ok": True}

    # ── misc ─────────────────────────────────────────────────────────────
    def open_with_system(self, vid, rel=None):
        if not self._engine or not self._dek: return {"ok": False}
        base = self._engine.vault_path(vid)
        target = (base / rel) if rel else base
        if not target.exists() or target.is_dir():
            return {"ok": False, "error": "File not found"}
        suffix = ""
        if rel:
            manifest = core.load_tree_manifest(base, self._dek)
            if manifest is not None:
                node = core.manifest_node_at(manifest, rel)
                if node and node.get("type") == "file":
                    suffix = Path(node.get("name", "")).suffix
            if not suffix:
                suffix = target.suffix  # legacy pre-manifest folders
        else:
            meta = core.load_meta(self._is_decoy, self._dek)
            info = meta["files"].get(vid, {})
            suffix = info.get("ext", "") or target.suffix
        import tempfile
        fd, tmp_path = tempfile.mkstemp(suffix=suffix, dir=str(core.temp_dir()))
        os.close(fd)
        try:
            core.decrypt_file(target, tmp_path, self._dek, verify=False)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        ok, err, proc_handle = core.open_with_system(tmp_path)
        # The system app needs the decrypted temp file to still exist after
        # we return, so it isn't deleted here — instead a background thread
        # waits for that specific process to exit (or a backstop timeout,
        # for the rare case the OS didn't hand us a waitable handle) and
        # deletes it then, so nothing decrypted lingers on disk indefinitely.
        threading.Thread(
            target=core.wait_for_exit_and_delete, args=(proc_handle, tmp_path), daemon=True
        ).start()
        return {"ok": ok, "error": err}

    # ── organizing: folders created inside the vault, move/copy ────────────
    def create_folder(self, name):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.create_folder(name)
        return {"ok": ok, "result": res}

    def create_subfolder(self, vid, rel, name):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.create_subfolder(vid, rel, name)
        return {"ok": ok, "result": res}

    def list_vault_folders(self):
        if not self._engine: return []
        return self._engine.list_vault_folders()

    def move_item(self, src_vid, src_rel, dest_vid, dest_rel, copy=False):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.move_item(src_vid, src_rel or None, dest_vid, dest_rel or None, copy)
        if ok:
            # The item may have been the source folder's cached preview
            # source, and/or is now newly eligible as the destination
            # folder's preview — either way, stale entries for both sides
            # need to go.
            media_server.clear_caches()
        return {"ok": ok, "result": res}

    # ── appearance (background) — cosmetic only, not vault content ─────────
    def get_ui_prefs(self):
        """Master and decoy each keep their own background, so this only
        makes sense once a vault is actually open."""
        if not self._engine:
            return {"type": "default"}
        prefs = core.load_ui_prefs(self._is_decoy)
        if prefs.get("type") == "image" and prefs.get("image_name"):
            prefs = dict(prefs, url=self._u(f"/bg/{prefs['image_name']}"))
        elif prefs.get("type") == "dynamic":
            prefs = dict(prefs, url=self._u("/dynbg"))
        return prefs

    def generate_dynamic_background(self):
        """Dynamic Content-Based Background: (re)generates the auto-
        composited wallpaper from the vault's own photos and switches the
        current background to it. Served via /dynbg (encrypted, token-
        gated) rather than the plaintext ui_bg_dir the other background
        types use — see dynbg_file()'s docstring for why."""
        if not self._engine:
            return {"ok": False, "error": "No vault open"}
        ok, err = self._engine.generate_dynamic_background()
        if not ok:
            return {"ok": False, "error": err}
        prefs = {"type": "dynamic"}
        core.save_ui_prefs(prefs, self._is_decoy)
        media_server.clear_caches()
        return {"ok": True, "prefs": dict(prefs, url=self._u("/dynbg"))}

    def set_background(self, kind, value=None):
        if kind == "gradient":
            prefs = {"type": "gradient", "gradient_id": value}
        else:
            prefs = {"type": "default"}
        core.save_ui_prefs(prefs, self._is_decoy)
        return {"ok": True, "prefs": prefs}

    def choose_background_image(self):
        if not self._window: return {"ok": False}
        paths = self._window.create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=("Image Files (*.jpg;*.jpeg;*.png;*.webp;*.bmp)",))
        if not paths: return {"ok": False}
        src = Path(paths[0])
        dest_dir = core.ui_bg_dir(self._is_decoy)
        dest_dir.mkdir(parents=True, exist_ok=True)
        for old in dest_dir.glob("bg.*"):
            try: old.unlink()
            except Exception: pass
        dest = dest_dir / f"bg{src.suffix.lower() or '.jpg'}"
        try:
            shutil.copyfile(str(src), str(dest))
        except Exception as e:
            return {"ok": False, "error": str(e)}
        prefs = {"type": "image", "image_name": dest.name}
        core.save_ui_prefs(prefs, self._is_decoy)
        return {"ok": True, "prefs": dict(prefs, url=self._u(f"/bg/{dest.name}"))}

    def list_vault_images(self):
        """Every image currently in the vault (root-level and nested inside
        locked folders) — used to populate the 'Choose from vault' picker
        for the background, without needing to restore anything first."""
        if not self._engine or not self._dek: return []
        meta = core.load_meta(self._is_decoy, self._dek)
        out = []
        for vid, info in meta["files"].items():
            if info["type"] == "file" and core.file_cat(info["original_name"]) == "image":
                out.append({"vid": vid, "rel": None, "name": info["original_name"],
                            "thumb_url": self._u(f"/thumb/{vid}")})
            elif info["type"] == "folder":
                base = self._engine.vault_path(vid)
                manifest = core.load_tree_manifest(base, self._dek)
                if manifest is None: continue

                def walk(node, rel):
                    for tok, child in node.get("children", {}).items():
                        child_rel = f"{rel}/{tok}" if rel else tok
                        if child.get("type") == "file" and core.file_cat(child.get("name", "")) == "image":
                            out.append({"vid": vid, "rel": child_rel, "name": child.get("name", tok),
                                        "thumb_url": self._u(f"/nested_thumb?vid={vid}&rel={child_rel}")})
                        elif child.get("type") == "dir":
                            walk(child, child_rel)

                walk(manifest, "")
        return out

    def get_background_preview_data_url(self):
        """The currently-set background image, handed back as a data: URL
        instead of an http:// one — same reasoning as
        get_item_preview_data_url() above: the position/zoom editor loads
        the image into an <img crossorigin> for canvas export, which needs
        a CORS header matching the exact origin the OS webview reports.
        That isn't guaranteed across environments, and previously wasn't
        even attempted here, so the editor could show a broken image even
        though the background itself (plain <div> background-image, no
        crossorigin) applied and displayed just fine. A data: URL never
        leaves this process, so there's no cross-origin request to satisfy.
        The background image is stored as a small plaintext file (see
        ui_bg_dir's docstring), so — unlike the vault-content version —
        this just reads it straight off disk, no decryption involved."""
        prefs = core.load_ui_prefs(self._is_decoy)
        if prefs.get("type") != "image" or not prefs.get("image_name"):
            return {"ok": False, "error": "No background image set"}
        p = core.ui_bg_dir(self._is_decoy) / prefs["image_name"]
        try:
            raw = p.read_bytes()
        except Exception:
            return {"ok": False, "error": "Couldn't read the background image"}
        ext = p.suffix.lower()
        mime = ("image/png" if ext == ".png" else
                "image/webp" if ext == ".webp" else
                "image/bmp" if ext == ".bmp" else "image/jpeg")
        b64 = base64.b64encode(raw).decode("ascii")
        return {"ok": True, "data_url": f"data:{mime};base64,{b64}"}

    def set_background_from_vault(self, vid, rel=None):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.background_from_vault_item(vid, rel or None)
        if not ok:
            return {"ok": False, "error": res}
        prefs = {"type": "image", "image_name": res}
        core.save_ui_prefs(prefs, self._is_decoy)
        return {"ok": True, "prefs": dict(prefs, url=self._u(f"/bg/{res}"))}

    def save_background_data_url(self, data_url):
        """Saves the output of the in-app position/zoom background editor —
        a canvas-exported JPEG data URL already cropped and sized to fit the
        screen cleanly — as the new background image."""
        try:
            if not data_url or "," not in data_url:
                return {"ok": False, "error": "No image data received"}
            _, b64data = data_url.split(",", 1)
            raw = base64.b64decode(b64data)
            if len(raw) < 100:
                return {"ok": False, "error": "Edited image looked empty"}
            dest_dir = core.ui_bg_dir(self._is_decoy)
            dest_dir.mkdir(parents=True, exist_ok=True)
            for old in dest_dir.glob("bg.*"):
                try: old.unlink()
                except Exception: pass
            dest = dest_dir / "bg.jpg"
            dest.write_bytes(raw)
            prefs = {"type": "image", "image_name": dest.name}
            core.save_ui_prefs(prefs, self._is_decoy)
            return {"ok": True, "prefs": dict(prefs, url=self._u(f"/bg/{dest.name}"))}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def record_opened(self, vid, rel=None):
        """Timestamps an item as opened, for the 'Recently opened' sort
        mode — skipped entirely when the person has turned history off in
        Privacy settings, so nothing is written at all in that case."""
        if not self._engine:
            return {"ok": False}
        privacy = self._engine.get_pref("vault", "privacy", {})
        if not privacy.get("history_enabled", True):
            return {"ok": True, "skipped": True}
        cur = self._engine.get_item_meta(vid, rel or None)
        ok, err = self._engine.set_item_meta(
            vid, {"metadata": {**cur["metadata"], "last_opened": datetime.now().isoformat()}},
            rel or None)
        return {"ok": ok, "error": err}

    # ── Phase 0 foundation: preferences + per-item metadata ────────────────
    def get_prefs_bundle(self):
        """Returns the entire preferences store for the current vault
        identity in one call — used right after login so the frontend
        doesn't need a round trip per scope/key."""
        if not self._engine:
            return {"ok": False, "prefs": {}}
        return {"ok": True, "prefs": core.load_prefs(self._engine.is_decoy, self._engine.dek)}

    def _payload_for_walk_result(self, r):
        entry = r["entry"]
        is_dir = (entry.get("type") in ("folder", "dir"))
        name = entry.get("original_name") or entry.get("name") or ""
        payload = {
            "vid": r["vid"], "rel": r["rel"], "is_dir": is_dir,
            "name": name, "cat": "folder" if is_dir else core.file_cat(name),
            "size": entry.get("size", 0), "size_h": core.human_size(entry.get("size", 0)),
            "path_breadcrumb": " / ".join(p for p in r["path"] if p),
            "thumb_url": (self._u(f"/thumb/{r['vid']}") if r["rel"] is None
                          else (self._u(f"/folder_preview?vid={r['vid']}&rel={r['rel']}") if is_dir
                                else self._u(f"/nested_thumb?vid={r['vid']}&rel={r['rel']}"))),
            "media_url": (self._u(f"/media/{r['vid']}") if r["rel"] is None
                          else self._u(f"/media/{r['vid']}/{r['rel']}")),
        }
        payload.update(core.item_meta_view(entry))
        return payload

    def find_duplicates(self):
        """Phase 4.4 Duplicate Finder: content-hash scan across the whole
        vault. Never deletes anything — just returns groups of identical
        files for the person to review and choose from."""
        if not self._engine:
            return {"ok": False, "groups": []}
        raw_groups = self._engine.find_duplicates()
        groups = []
        for members in raw_groups:
            items = []
            for e in members:
                is_dir = False
                items.append({
                    "vid": e["vid"], "rel": e["rel"], "is_dir": is_dir,
                    "name": e["name"], "cat": core.file_cat(e["name"]),
                    "size": e["size"], "size_h": core.human_size(e["size"]),
                    "path_breadcrumb": " / ".join(p for p in e["path"] if p),
                    "thumb_url": (self._u(f"/thumb/{e['vid']}") if e["rel"] is None
                                  else self._u(f"/nested_thumb?vid={e['vid']}&rel={e['rel']}")),
                })
            groups.append({"size": members[0]["size"], "count": len(members), "items": items})
        return {"ok": True, "groups": groups}

    def list_favorites(self):
        if not self._engine:
            return {"ok": False, "items": []}
        raw = self._engine.list_favorites()
        return {"ok": True, "items": [self._payload_for_walk_result(r) for r in raw]}

    def list_recent(self, limit=12):
        if not self._engine:
            return {"ok": False, "items": []}
        raw = self._engine.list_recent(limit)
        items = [self._payload_for_walk_result(r) for r in raw]
        for it, r in zip(items, raw):
            it["last_opened"] = r["last_opened"]
        return {"ok": True, "items": items}

    def list_album_items(self, album_vid):
        """Everything currently collected into this album — files and
        folders picked from anywhere in the vault, referenced in place
        (never moved or duplicated), same walk pattern as favorites."""
        if not self._engine:
            return {"ok": False, "items": []}
        raw = self._engine.list_album_items(album_vid)
        return {"ok": True, "items": [self._payload_for_walk_result(r) for r in raw]}

    def clear_album_membership(self, album_vid):
        if not self._engine:
            return {"ok": False}
        return {"ok": self._engine.clear_album_membership(album_vid)}

    # ── Face Groups: "same face, everywhere" auto-collections ──────────────
    def list_face_scan_targets(self):
        """Folders to offer in the 'Scan for faces' picker \u2014 'Entire
        Vault' plus every real folder, so a scan can be limited to just
        one folder instead of the whole vault."""
        if not self._engine:
            return []
        return self._engine.list_face_scan_targets()

    def start_face_scan(self, scope_vid=None, scope_rel=None, threshold=None, container_vid=None):
        """Kicks off a background scan that groups photos of the same
        person together. With no scope, scans the whole vault (however
        many folders they're spread across); pass scope_vid (and
        optionally scope_rel for a nested folder, from
        list_face_scan_targets) to limit the scan to just that one
        folder. container_vid (from list_face_group_containers, or
        create_face_group_container) is required \u2014 it's the Face Group
        folder the resulting Person N groups get created inside, kept
        isolated from every other container's groups. threshold
        optionally overrides the default match cutoff (stricter = fewer
        different-people-merged mistakes, at some cost to recall). Poll
        with get_job(job_id), same as any other long-running task. Never
        moves, copies, or re-uploads anything \u2014 every match is a
        reference, exactly like Albums."""
        if not self._engine:
            return {"ok": False, "error": "No vault open"}
        return self._engine.start_face_scan(scope_vid, scope_rel, threshold, container_vid)

    def list_face_groups(self, container_vid=None):
        if not self._engine:
            return []
        meta = core.load_meta(self._is_decoy, self._dek)
        return [self._item_payload(vid, meta["files"][vid]) for vid, _ in self._engine.list_face_groups(container_vid)]

    def delete_all_face_groups(self, container_vid=None):
        """Deletes every Face Group album at once (or, with container_vid,
        just the ones inside that one container). Every real photo they
        referenced is untouched \u2014 only the auto-generated group
        containers go away. Run 'Scan for faces' again anytime to rebuild
        them from scratch."""
        if not self._engine:
            return {"ok": False, "error": "No vault open"}
        deleted, errors = self._engine.delete_all_face_groups(container_vid)
        media_server.clear_caches()
        return {"ok": not errors, "deleted": deleted, "errors": errors}

    def create_face_group_container(self, name):
        """Creates a new, empty Face Group folder shown on the Face Groups
        dashboard \u2014 open it and run a scan from inside it to fill it
        with that scan's own Person N groups, kept isolated from every
        other container."""
        if not self._engine:
            return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.create_face_group_container(name)
        return {"ok": ok, "result": res}

    def list_face_group_containers(self):
        if not self._engine:
            return []
        meta = core.load_meta(self._is_decoy, self._dek)
        return [self._item_payload(vid, meta["files"][vid]) for vid, _ in self._engine.list_face_group_containers()]

    def delete_all_face_group_containers(self):
        """Deletes every Face Group folder and everything it collected \u2014
        every real photo referenced by any group inside any container is
        untouched."""
        if not self._engine:
            return {"ok": False, "error": "No vault open"}
        deleted, errors = self._engine.delete_all_face_group_containers()
        media_server.clear_caches()
        return {"ok": not errors, "deleted": deleted, "errors": errors}

    def get_pref(self, scope, key, default=None):
        if not self._engine:
            return {"ok": False, "error": "Not logged in"}
        return {"ok": True, "value": self._engine.get_pref(scope, key, default)}

    def set_pref(self, scope, key, value):
        if not self._engine:
            return {"ok": False, "error": "Not logged in"}
        ok, err = self._engine.set_pref(scope, key, value)
        return {"ok": ok, "error": err}

    def get_item_meta(self, vid, rel=None):
        if not self._engine:
            return {"ok": False, "error": "Not logged in"}
        return {"ok": True, "meta": self._engine.get_item_meta(vid, rel or None)}

    def folder_stats(self, vid, rel=None):
        if not self._engine:
            return {"ok": False, "error": "Not logged in"}
        stats = self._engine.folder_stats(vid, rel or None)
        if stats is None:
            return {"ok": False, "error": "Not a folder, or predates the folder-organizing feature"}
        return {"ok": True, "stats": stats}

    def set_item_meta(self, vid, updates, rel=None):
        if not self._engine:
            return {"ok": False, "error": "Not logged in"}
        if not isinstance(updates, dict):
            return {"ok": False, "error": "updates must be an object"}
        ok, err = self._engine.set_item_meta(vid, updates, rel or None)
        return {"ok": ok, "error": err}

    # ── quick-hide cover (master account only) ──────────────────────────────
    def verify_master_password(self, password):
        """Used only to dismiss the quick-hide cover — checks the password
        against the MASTER hash specifically (never the decoy/nuke ones),
        regardless of which vault is currently open."""
        cfg = core.load_cfg()
        ok = bool(password) and bool(cfg.get("master_hash")) and core.verify_pw(password, cfg["master_hash"])
        return {"ok": ok}

    def change_passwords(self, current_master, new_master, new_decoy, new_nuke):
        if self._is_decoy:
            return {"ok": False, "error": "Security settings can only be changed from the real vault."}
        cfg = core.load_cfg()
        if not core.verify_pw(current_master, cfg.get("master_hash", "")):
            return {"ok": False, "error": "Current master password is incorrect."}
        if not self._dek:
            return {"ok": False, "error": "Vault isn't unlocked in this session."}
        iterations = cfg.get("kdf_iterations", core.KDF_ITERATIONS)

        if new_master:
            if len(new_master) < 8:
                return {"ok": False, "error": "New master password must be at least 8 characters."}
            new_salt = os.urandom(16)
            cfg["master_hash"] = core.hash_pw(new_master)
            cfg["master_salt"] = base64.b64encode(new_salt).decode()
            cfg["master_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(new_master, new_salt, iterations), self._dek)).decode()

        if new_decoy:
            if len(new_decoy) < 8:
                return {"ok": False, "error": "New decoy password must be at least 8 characters."}
            # Can't decrypt dmeta.json here (it's wrapped under the decoy
            # DEK, which a master session never has) — check the actual
            # on-disk vault contents instead, which is the source of truth
            # anyway and doesn't require the decoy password to inspect.
            decoy_dir = core.decoy_dir_path()
            has_items = decoy_dir.exists() and any(decoy_dir.iterdir())
            if has_items:
                return {"ok": False, "error": "The decoy vault still has files in it — empty it first, "
                                               "or log into the decoy vault to change its own password there."}
            decoy_salt = os.urandom(16)
            decoy_dek = core.new_dek()
            cfg["decoy_hash"] = core.hash_pw(new_decoy)
            cfg["decoy_salt"] = base64.b64encode(decoy_salt).decode()
            cfg["decoy_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(new_decoy, decoy_salt, iterations), decoy_dek)).decode()
            # Re-write the (already-confirmed-empty) decoy index under the
            # new decoy DEK so it stays readable on the next decoy login.
            core.save_meta({"files": {}}, True, decoy_dek)

        if new_nuke:
            if len(new_nuke) < 8:
                return {"ok": False, "error": "New nuke password must be at least 8 characters."}
            nuke_salt = os.urandom(16)
            cfg["nuke_hash"] = core.hash_pw(new_nuke)
            cfg["nuke_salt"] = base64.b64encode(nuke_salt).decode()
            cfg["nuke_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(new_nuke, nuke_salt, iterations), self._dek)).decode()

        core.save_cfg(cfg)
        return {"ok": True}

    # ── Gallery Tools: Advanced Batch Rename ────────────────────────────
    def batch_rename_preview(self, items, base_name, start_num, separator, padding):
        if not self._engine: return {"ok": False, "error": "No vault open", "entries": []}
        return self._engine.batch_rename_preview(items, base_name, start_num, separator, padding)

    def batch_rename_apply(self, items, base_name, start_num, separator, padding):
        if not self._engine: return {"ok": False, "error": "No vault open", "entries": []}
        res = self._engine.batch_rename_apply(items, base_name, start_num, separator, padding)
        if res.get("ok"):
            media_server.clear_caches()
        return res

    def batch_rename_undo(self):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        res = self._engine.batch_rename_undo()
        if res.get("ok"):
            media_server.clear_caches()
        return res

    # ── Gallery Tools: Privacy Scrubber ─────────────────────────────────
    def privacy_scan(self, items):
        if not self._engine: return {"ok": False, "error": "No vault open", "results": []}
        return self._engine.privacy_scan(items)

    def privacy_scrub(self, items, options):
        if not self._engine: return {"ok": False, "error": "No vault open", "processed": 0, "errors": []}
        res = self._engine.privacy_scrub(items, options)
        if res.get("ok"):
            media_server.clear_caches()
        return res

    # ── Gallery Tools: Advanced Video Frame Extractor ───────────────────
    def start_advanced_frame_extraction(self, vid, rel, dest_vid, dest_rel, mode, params, output_opts):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        return self._engine.start_advanced_frame_extraction(vid, rel or None, dest_vid, dest_rel or None,
                                                              mode, params, output_opts)

    # ── Video Snapshot — grab the current frame from the in-lightbox
    # player and save it into a chosen folder. Synchronous (a single
    # frame is quick), unlike the job-based Advanced Frame Extractor.
    def capture_video_snapshot(self, vid, rel, timestamp_sec, dest_vid, dest_rel):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.capture_video_snapshot(vid, rel or None, timestamp_sec, dest_vid, dest_rel or None)
        if ok:
            # The snapshot landed in the destination folder — its cached
            # preview/thumbnail may now be stale (e.g. it was empty
            # before), and if the destination is the same folder the
            # source video lives in, that folder's listing needs to
            # reflect the new photo too.
            media_server.clear_caches()
        return {"ok": ok, "result": res}

    # ── Gallery Tools: Increase Quality (image upscale) ─────────────────
    def start_image_upscale(self, vid, rel, target, use_ai=False):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        return self._engine.start_image_upscale(vid, rel or None, target, bool(use_ai))

    def finalize_image_upscale(self, job_id, action, dest_name=None):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        res = self._engine.finalize_image_upscale(job_id, action, dest_name)
        if res.get("ok"):
            media_server.clear_caches()
        return res

    def discard_image_upscale(self, job_id):
        core.discard_upscale_result(job_id)
        return {"ok": True}

    # AI enhancer settings live at the app level (not inside any one vault)
    # since it's just the person's own free API key, not vault content.
    def get_ai_settings(self):
        s = core.load_ai_settings()
        token = s.get("hf_token", "")
        return {"ok": True, "has_token": bool(token),
                "token_preview": (token[:6] + "\u2026" + token[-4:]) if len(token) > 12 else ("\u2022" * len(token)),
                "enabled": s.get("enabled", False)}

    def save_ai_key(self, hf_token, enabled=True):
        ok = core.save_ai_settings(hf_token, enabled)
        return {"ok": ok}

    def clear_ai_key(self):
        ok = core.save_ai_settings("", False)
        return {"ok": ok}

    def set_ai_enabled(self, enabled):
        ok = core.save_ai_settings(None, bool(enabled))
        return {"ok": ok}

    # ── Gallery Tools: shared background-job polling/cancellation ──────
    def get_job(self, job_id):
        job = core.get_job(job_id)
        if job is None:
            return {"ok": False, "error": "Unknown job"}
        if job.get("status") == "done":
            media_server.clear_caches()
        return {"ok": True, "job": job}

    def cancel_job(self, job_id):
        return {"ok": core.request_job_cancel(job_id)}


def main():
    core.ensure_dirs()
    # One-time-per-process-start cleanup of any decrypted temp files a prior
    # run left behind (crash, force-quit, OS shutdown mid-session) — safe
    # here specifically because this only runs once, at the real app
    # entrypoint, never on every ensure_dirs() call during a live session.
    core.sweep_orphaned_temp_files()
    if not _webview2_available():
        _warn_missing_webview2()
        return
    api = Api()
    window = webview.create_window(
        "VaultLock", str(FRONTEND_DIR / "index.html"),
        js_api=api, width=1240, height=800, min_size=(980, 640),
        background_color="#F1F2F6",
    )
    api._bind_window(window)
    webview.start()


if __name__ == "__main__":
    main()