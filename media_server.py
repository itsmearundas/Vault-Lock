"""
A tiny localhost-only HTTP server that streams DECRYPTED vault media to the
webview frontend. Every file on disk is encrypted (see vault_core.py) — this
server is the only place plaintext bytes ever get produced, and only for the
current logged-in session's DEK, entirely in memory (nothing decrypted is
ever written back to disk here).

Endpoints (all 127.0.0.1-only, never bound to 0.0.0.0):
    GET /thumb/<vid>                     -> cached root-level thumbnail (decrypted on the fly)
    GET /media/<vid>/<relpath...>        -> raw file bytes (Range-aware, decrypted on the fly)
    GET /nested_thumb?vid=..&rel=..      -> on-the-fly small jpg for a file inside a locked folder
    GET /folder_preview?vid=..&rel=..    -> on-the-fly preview jpg for a *sub-folder* (recursive scan)
    GET /bg/<filename>                   -> the plain (unencrypted) custom background image, if set
"""
import hmac
import io
import threading
import urllib.parse
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import vault_core as core
from vault_core import IMG_EXT, VID_EXT, PIL_OK, CV2_OK

if PIL_OK:
    from PIL import Image
if CV2_OK:
    import cv2

# Populated by main.py once the user logs in / switches vault / locks out.
# "token" is the per-session auth token (§2 fix) — every request must carry
# a matching ?token=... or gets refused, regardless of endpoint.
STATE = {"engine": None, "dek": None, "token": None}

_nested_cache = {}   # (vid, rel) -> decrypted+resized jpg bytes, in-memory only
_preview_cache = {}  # (vid, rel) -> decrypted+resized jpg bytes or None


def _jpeg_bytes_from_image(img, box=(960, 960)):
    img.thumbnail(box, Image.LANCZOS)
    if img.mode not in ("RGB",):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=93)
    return buf.getvalue()


def _video_frame_jpeg_from_encrypted(enc_path, dek, box=(960, 960)):
    """Decrypts an encrypted video to a private temp file just long enough
    to grab a preview frame, then removes the temp file."""
    import tempfile, os
    fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        core.decrypt_file(enc_path, tmp_path, dek, verify=False)
        cap = cv2.VideoCapture(tmp_path)
        total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(total * 0.1)))
        ret, frame = cap.read()
        cap.release()
        if not ret:
            return None
        img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        return _jpeg_bytes_from_image(img, box)
    finally:
        try: os.remove(tmp_path)
        except Exception: pass


def _image_jpeg_from_encrypted(enc_path, dek, box=(960, 960)):
    data = core.decrypt_to_bytes(enc_path, dek, verify=False)
    img = Image.open(io.BytesIO(data))
    return _jpeg_bytes_from_image(img, box)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep stdout clean

    def _engine(self):
        return STATE["engine"]

    def _dek(self):
        return STATE["dek"]

    def _token_ok(self, qs):
        """§2 fix: every request must carry the current session's token.
        Fails closed — if no session has ever set a token (e.g. app just
        started, no login yet), STATE["token"] is None and nothing matches
        it, so every request is refused until a real login happens."""
        expected = STATE["token"]
        if not expected:
            return False
        got = qs.get("token", [""])[0]
        # Constant-time compare — this is a short-lived per-session token,
        # not a password, but there's no reason to leak timing either.
        return hmac.compare_digest(got, expected)

    def _safe_target(self, base, rel):
        """§2 fix: shared path-traversal guard, now applied uniformly to
        every endpoint that resolves a vid/rel into a real filesystem path
        (previously only /media had this) — resolves the target and
        confirms it's actually inside base, refusing anything that escapes
        it (e.g. via '..' segments or a symlink)."""
        target = (base / rel) if rel else base
        try:
            target.resolve().relative_to(base.resolve())
        except Exception:
            if target.resolve() != base.resolve():
                return None
        return target

    def _cors_headers(self):
        # This server binds 127.0.0.1-only, but without a scoped CORS
        # header, ANY other origin on the same machine (a tab in the
        # user's regular browser, not just this app) could read responses
        # back via fetch()+canvas, since browsers only block cross-origin
        # *reads* using CORS, not the request itself. The frontend here
        # loads over file:// (Origin: null), so only that origin is ever
        # allowed to read the response — everything else gets no header at
        # all, which keeps the browser's default same-origin block in place.
        origin = self.headers.get("Origin")
        if origin == "null":
            self.send_header("Access-Control-Allow-Origin", "null")

    def _real_ext(self, engine, dek, vid, rel, target):
        """Token filenames on disk have no real extension — look it up
        instead of trusting the filesystem name.

        A ROOT-level single file has no manifest of its own (only folders
        get an `_index.enc`) — its real name/extension lives in the
        vault's top-level meta.json, keyed by vid. Nested files (inside a
        locked folder) go through that folder's decrypted manifest.
        Previously this always tried the manifest path first even for
        root files, where `base` is a plain file — `base / "_index.enc"`
        never exists, so it silently fell through to `target.suffix`,
        and `target` there is just the vid token itself (no dot in it),
        so root-level media was *always* served as
        application/octet-stream, regardless of the item's real
        extension or whether it had ever been renamed."""
        if not rel:
            try:
                meta = core.load_meta(getattr(engine, "is_decoy", False), dek)
                info = meta.get("files", {}).get(vid)
                if info and info.get("type") == "file":
                    ext = info.get("ext") or Path(info.get("original_name", "")).suffix
                    return ext.lower()
            except Exception:
                pass
            return target.suffix.lower()
        base = engine.vault_path(vid)
        manifest = core.load_tree_manifest(base, dek)
        if manifest is not None:
            node = core.manifest_node_at(manifest, rel)
            if node and node.get("type") == "file":
                return Path(node.get("name", "")).suffix.lower()
            return ""
        return target.suffix.lower()

    def _send_bytes(self, data, ctype="application/octet-stream"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Belt-and-braces against stale thumbnails: some WebView2/Windows
        # HTTP cache configurations have been seen to hang onto a response
        # a little longer than a bare "no-store" implies, especially for
        # images. Sending all three legacy+modern no-cache directives
        # closes that gap; combined with the frontend's cache-busting query
        # param (see versionedThumbUrl in app.js) this is fully redundant
        # in the normal case, but cheap insurance against the "have to
        # relaunch the app to see the new thumbnail" symptom.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # See _cors_headers() — scoped to the app's own file:// origin
        # instead of a wildcard (§2 fix).
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _send_404(self):
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_plain_file(self, path, ctype):
        """Serves a small plain (unencrypted) file straight off disk — used
        only for the cosmetic background image, which is never vault
        content and is stored unencrypted on purpose."""
        try:
            data = Path(path).read_bytes()
        except Exception:
            return self._send_404()
        return self._send_bytes(data, ctype)

    def _send_encrypted_file_range(self, enc_path, ctype, dek):
        """Serves the DECRYPTED content of an encrypted file, honoring HTTP
        Range requests via true random-access AES-CTR decryption (needed for
        video seeking) — never decrypts more than the requested byte range."""
        try:
            size = core.plaintext_size(enc_path)
        except Exception:
            return self._send_404()
        if size <= 0:
            return self._send_404()

        range_header = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if range_header and range_header.startswith("bytes="):
            status = 206
            spec = range_header.split("=", 1)[1]
            s, _, e = spec.partition("-")
            if s: start = int(s)
            if e: end = int(e)
            end = min(end, size - 1)

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        # See _send_bytes() above for why all three headers are sent.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self._cors_headers()
        self.end_headers()

        # Decrypt and stream in bounded windows so we never hold huge
        # plaintext ranges (e.g. a multi-GB video Range) fully in memory.
        window = 4 * 1024 * 1024
        pos = start
        while pos <= end:
            chunk_end = min(pos + window - 1, end)
            try:
                pt = core.decrypt_range(enc_path, dek, pos, chunk_end)
            except Exception:
                return
            try:
                self.wfile.write(pt)
            except (BrokenPipeError, ConnectionAbortedError):
                return
            pos = chunk_end + 1

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        parts  = [p for p in parsed.path.split("/") if p != ""]
        qs     = urllib.parse.parse_qs(parsed.query)
        engine = self._engine()
        dek    = self._dek()

        if not self._token_ok(qs):
            return self._send_404()

        try:
            if parts[:1] == ["bg"] and len(parts) == 2:
                fname = parts[1]
                if "/" in fname or "\\" in fname or ".." in fname:
                    return self._send_404()
                # Master and decoy each have their own background — resolve
                # against whichever account is actually logged in right now.
                is_decoy = bool(getattr(engine, "is_decoy", False)) if engine else False
                p = core.ui_bg_dir(is_decoy) / fname
                if not p.exists() or not p.is_file():
                    return self._send_404()
                ext = p.suffix.lower()
                ctype = ("image/png" if ext == ".png" else
                          "image/webp" if ext == ".webp" else
                          "image/bmp" if ext == ".bmp" else "image/jpeg")
                return self._send_plain_file(p, ctype)

            if parsed.path == "/dynbg":
                # Unlike /bg (plaintext, cosmetic), the dynamic background
                # is derived from vault content, so it's encrypted like any
                # other vault-derived asset and needs the engine/dek to
                # read it back.
                if engine is None or not dek:
                    return self._send_404()
                p = core.dynbg_file(getattr(engine, "is_decoy", False))
                if not p.exists():
                    return self._send_404()
                return self._send_encrypted_file_range(p, "image/jpeg", dek)

            if parts[:1] == ["thumb"] and len(parts) == 2:
                vid = parts[1]
                p = core.thumb_dir() / f"{vid}.jpg"
                if p.exists() and dek:
                    return self._send_encrypted_file_range(p, "image/jpeg", dek)
                return self._send_404()

            if parts[:1] == ["media"] and len(parts) >= 2 and engine is not None and dek:
                vid = parts[1]
                rel = "/".join(parts[2:])
                base = engine.vault_path(vid)
                target = self._safe_target(base, rel)
                if target is None:
                    return self._send_404()
                if not target.exists() or target.is_dir():
                    return self._send_404()
                ext = self._real_ext(engine, dek, vid, rel, target)
                ctype = ("video/mp4" if ext in VID_EXT else
                          "image/jpeg" if ext in IMG_EXT else
                          "application/octet-stream")
                return self._send_encrypted_file_range(target, ctype, dek)

            if parsed.path == "/nested_thumb" and engine is not None and dek:
                vid = qs.get("vid", [""])[0]
                rel = qs.get("rel", [""])[0]
                key = (vid, rel)
                if key in _nested_cache:
                    data = _nested_cache[key]
                    return self._send_bytes(data, "image/jpeg") if data else self._send_404()
                base = engine.vault_path(vid)
                target = self._safe_target(base, rel)
                if target is None:
                    return self._send_404()
                # NOTE: files no longer have any custom cropped/positioned
                # thumbnail path at all — that "adjust thumb" feature was
                # removed (see cleanup_deprecated_file_thumb_crops() in
                # vault_core.py for the one-time migration that cleans up
                # any stale square crop left over from it on older vaults).
                # Every file's thumbnail is always freshly generated here,
                # at its own real, uncropped aspect ratio.
                data = None
                if data is None:
                    ext = self._real_ext(engine, dek, vid, rel, target)
                    try:
                        if PIL_OK and ext in IMG_EXT:
                            data = _image_jpeg_from_encrypted(target, dek)
                        elif PIL_OK and CV2_OK and ext in VID_EXT:
                            data = _video_frame_jpeg_from_encrypted(target, dek)
                    except Exception:
                        data = None
                _nested_cache[key] = data
                return self._send_bytes(data, "image/jpeg") if data else self._send_404()

            if parsed.path == "/folder_preview" and engine is not None and dek:
                vid = qs.get("vid", [""])[0]
                rel = qs.get("rel", [""])[0]
                key = (vid, rel)
                if key in _preview_cache:
                    data = _preview_cache[key]
                    return self._send_bytes(data, "image/jpeg") if data else self._send_404()
                base = engine.vault_path(vid)
                # find_preview() does its own recursive scan under base, so
                # just confirm base itself resolves sanely for this vid —
                # the traversal guard matters for the vid/rel *entry point*,
                # which is what an attacker controls via the query string.
                if self._safe_target(base, "") is None:
                    return self._send_404()
                # A custom cropped/positioned thumbnail (set via the in-app
                # position & zoom editor) always wins over the automatic
                # "first image found" scan below.
                data = engine.get_custom_folder_thumb(vid, rel)
                if data is None:
                    found = engine.find_preview(base, rel)
                    if found:
                        kind, fp = found
                        try:
                            if kind == "image" and PIL_OK:
                                data = _image_jpeg_from_encrypted(fp, dek)
                            elif kind == "video" and PIL_OK and CV2_OK:
                                data = _video_frame_jpeg_from_encrypted(fp, dek)
                        except Exception:
                            data = None
                _preview_cache[key] = data
                return self._send_bytes(data, "image/jpeg") if data else self._send_404()

            return self._send_404()
        except Exception:
            try:
                self._send_404()
            except Exception:
                pass


def clear_caches():
    _nested_cache.clear()
    _preview_cache.clear()


def clear_preview_cache_for(vid, rel=None):
    """Scoped invalidation for the three "set this folder's thumbnail"
    operations (manual crop, collage, choose-from-vault), which only ever
    change ONE folder's own cached preview. Those call sites used to call
    clear_caches() and wipe every folder's cached preview/thumbnail in the
    whole vault for a change that only affected one of them — so setting
    one folder's thumbnail made every other folder's tile appear to reload
    from scratch (each one re-decrypted and re-fetched) the next time the
    gallery re-rendered. /folder_preview keys its cache the same way it
    parses the request: rel defaults to "" (never None), so mirror that
    here or a None-vs-"" mismatch would leave the stale entry in place.
    """
    _preview_cache.pop((vid, rel or ""), None)


def start_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, port