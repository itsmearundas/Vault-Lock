"""
VaultLock — native desktop app (pywebview).

This is NOT a browser app: pywebview renders the UI using the OS's built-in
web-rendering engine (Edge WebView2 on Windows) inside a plain, chrome-less
native window — no address bar, no tabs, no browser UI. It's the same
approach apps like Slack, VS Code and Discord use under the hood; the person
using it just sees a normal desktop window.
"""
import os, sys, json, threading, base64
from pathlib import Path

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
        if not master_pw or len(master_pw) < 4:
            return {"ok": False, "error": "Master password must be at least 4 characters."}
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
        if decoy_pw:
            decoy_salt = os.urandom(16)
            decoy_dek = core.new_dek()
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
        core.save_meta({"files": {}}, False)
        core.save_meta({"files": {}}, True)
        return {"ok": True}

    def login(self, password):
        cfg = core.load_cfg()
        if not cfg.get("master_hash"):
            return {"status": "no_vault"}
        iterations = cfg.get("kdf_iterations", core.KDF_ITERATIONS)

        # Nuke check first — must never leave a trace either way
        if cfg.get("nuke_hash") and core.verify_pw(password, cfg["nuke_hash"]):
            dek = None
            if cfg.get("nuke_wrapped_dek") and cfg.get("nuke_salt"):
                nuke_salt = base64.b64decode(cfg["nuke_salt"])
                kek = core.derive_kek(password, nuke_salt, iterations)
                dek = core.unwrap_dek(kek, base64.b64decode(cfg["nuke_wrapped_dek"]))
            core.nuke_main_vault()
            # Fall back to a fresh key only for legacy configs saved before
            # nuke had its own wrapped key — nothing to decrypt after a wipe
            # anyway, but this keeps the vault usable going forward.
            self._dek = dek if dek is not None else core.new_dek()
            self._engine = core.VaultEngine(False, self._dek)
            self._is_decoy = False
            media_server.STATE["engine"] = self._engine
            media_server.STATE["dek"] = self._dek
            media_server.clear_caches()
            return {"status": "ok", "decoy": False}

        if core.verify_pw(password, cfg["master_hash"]):
            master_salt = base64.b64decode(cfg["master_salt"])
            kek = core.derive_kek(password, master_salt, iterations)
            dek = core.unwrap_dek(kek, base64.b64decode(cfg["master_wrapped_dek"]))
            if dek is None:
                return {"status": "fail"}
            self._dek = dek
            self._engine = core.VaultEngine(False, self._dek)
            self._is_decoy = False
            media_server.STATE["engine"] = self._engine
            media_server.STATE["dek"] = self._dek
            media_server.clear_caches()
            return {"status": "ok", "decoy": False}

        if cfg.get("decoy_hash") and core.verify_pw(password, cfg["decoy_hash"]):
            decoy_salt = base64.b64decode(cfg["decoy_salt"])
            kek = core.derive_kek(password, decoy_salt, iterations)
            dek = core.unwrap_dek(kek, base64.b64decode(cfg["decoy_wrapped_dek"]))
            if dek is None:
                return {"status": "fail"}
            self._dek = dek
            self._engine = core.VaultEngine(True, self._dek)
            self._is_decoy = True
            media_server.STATE["engine"] = self._engine
            media_server.STATE["dek"] = self._dek
            media_server.clear_caches()
            return {"status": "ok", "decoy": True}

        return {"status": "fail"}

    def lock_out(self):
        self._engine = None
        self._dek = None
        media_server.STATE["engine"] = None
        media_server.STATE["dek"] = None
        media_server.clear_caches()
        return {"ok": True}

    # ── listing ──────────────────────────────────────────────────────────
    def _item_payload(self, vid, info):
        is_dir = info["type"] == "folder"
        payload = {
            "vid": vid, "name": info["original_name"], "is_dir": is_dir,
            "cat": "folder" if is_dir else core.file_cat(info["original_name"]),
            "size": info["size"], "size_h": core.human_size(info["size"]),
            "locked_at": info["locked_at"], "time_ago": core.time_ago(info["locked_at"]),
            "ext": info.get("ext", ""),
            "thumb_url": f"http://127.0.0.1:{PORT}/thumb/{vid}",
            "media_url": None if is_dir else f"http://127.0.0.1:{PORT}/media/{vid}",
        }
        return payload

    def list_root(self):
        if not self._engine: return []
        meta = core.load_meta(self._is_decoy)
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
                "thumb_url": (f"http://127.0.0.1:{PORT}/folder_preview?vid={vid}&rel={rel_path}"
                              if is_dir else
                              f"http://127.0.0.1:{PORT}/nested_thumb?vid={vid}&rel={rel_path}"),
                "media_url": f"http://127.0.0.1:{PORT}/media/{vid}/{rel_path}",
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
                "thumb_url": (f"http://127.0.0.1:{PORT}/folder_preview?vid={vid}&rel={rel_path}"
                              if is_dir else
                              f"http://127.0.0.1:{PORT}/nested_thumb?vid={vid}&rel={rel_path}"),
                "media_url": f"http://127.0.0.1:{PORT}/media/{vid}/{rel_path}",
            })
        return {"ok": True, "items": items}

    def get_stats(self):
        if not self._engine: return {"count": 0, "size_h": "0 B"}
        meta = core.load_meta(self._is_decoy)
        total = sum(i["size"] for i in meta["files"].values())
        return {"count": len(meta["files"]), "size_h": core.human_size(total)}

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
        return {"ok": ok, "result": res}

    def restore_batch(self, vids, dest_dir=None):
        """Restore many files/folders at once. If dest_dir is given, every
        item goes into that single chosen location; otherwise each item
        returns to its own original path."""
        if not self._engine: return {"ok": False, "results": []}
        results = []
        for vid in vids:
            ok, res = self._engine.unlock_item(vid, dest_dir)
            results.append({"vid": vid, "ok": ok, "result": res})
        return {"ok": True, "results": results}

    def delete_item(self, vid):
        if not self._engine: return {"ok": False, "error": "No vault open"}
        ok, res = self._engine.delete_item(vid)
        return {"ok": ok, "result": res}

    def delete_batch(self, vids):
        if not self._engine: return {"ok": False, "results": []}
        results = []
        for vid in vids:
            ok, res = self._engine.delete_item(vid)
            results.append({"vid": vid, "ok": ok, "result": res})
        return {"ok": True, "results": results}

    def restore_all(self, dest_dir=None):
        if not self._engine: return {"ok": False, "results": []}
        meta = core.load_meta(self._is_decoy)
        vids = list(meta["files"].keys())
        return self.restore_batch(vids, dest_dir)

    def wipe_vault(self):
        if not self._engine: return {"ok": False}
        meta = core.load_meta(self._is_decoy)
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
            meta = core.load_meta(self._is_decoy)
            info = meta["files"].get(vid, {})
            suffix = info.get("ext", "") or target.suffix
        import tempfile
        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        try:
            core.decrypt_file(target, tmp_path, self._dek, verify=False)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        ok, err = core.open_with_system(tmp_path)
        # The system app needs the decrypted temp file to still exist after
        # we return, so it isn't deleted here — it lives in the OS temp
        # folder until the system cleans it up, same trade-off any "open
        # with default app" feature has once it hands a file to another app.
        return {"ok": ok, "error": err}

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
            if len(new_master) < 4:
                return {"ok": False, "error": "New master password must be at least 4 characters."}
            new_salt = os.urandom(16)
            cfg["master_hash"] = core.hash_pw(new_master)
            cfg["master_salt"] = base64.b64encode(new_salt).decode()
            cfg["master_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(new_master, new_salt, iterations), self._dek)).decode()

        if new_decoy:
            decoy_meta = core.load_meta(True)
            if decoy_meta["files"]:
                return {"ok": False, "error": "The decoy vault still has files in it — empty it first, "
                                               "or log into the decoy vault to change its own password there."}
            decoy_salt = os.urandom(16)
            decoy_dek = core.new_dek()
            cfg["decoy_hash"] = core.hash_pw(new_decoy)
            cfg["decoy_salt"] = base64.b64encode(decoy_salt).decode()
            cfg["decoy_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(new_decoy, decoy_salt, iterations), decoy_dek)).decode()

        if new_nuke:
            nuke_salt = os.urandom(16)
            cfg["nuke_hash"] = core.hash_pw(new_nuke)
            cfg["nuke_salt"] = base64.b64encode(nuke_salt).decode()
            cfg["nuke_wrapped_dek"] = base64.b64encode(
                core.wrap_dek(core.derive_kek(new_nuke, nuke_salt, iterations), self._dek)).decode()

        core.save_cfg(cfg)
        return {"ok": True}


def main():
    core.ensure_dirs()
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
