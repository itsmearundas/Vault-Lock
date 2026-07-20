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
"""
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
STATE = {"engine": None, "dek": None}

_nested_cache = {}   # (vid, rel) -> decrypted+resized jpg bytes, in-memory only
_preview_cache = {}  # (vid, rel) -> decrypted+resized jpg bytes or None


def _jpeg_bytes_from_image(img, box=(420, 320)):
    img.thumbnail(box, Image.LANCZOS)
    if img.mode not in ("RGB",):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=87)
    return buf.getvalue()


def _video_frame_jpeg_from_encrypted(enc_path, dek, box=(420, 320)):
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


def _image_jpeg_from_encrypted(enc_path, dek, box=(420, 320)):
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

    def _real_ext(self, base, dek, rel, target):
        """Token filenames on disk have no real extension — look it up via
        the folder's decrypted manifest. Legacy (pre-manifest) folders still
        have real names on disk, so fall back to the raw suffix for those."""
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
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_404(self):
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

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
        self.send_header("Cache-Control", "no-store")
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

        try:
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
                target = (base / rel) if rel else base
                try:
                    target.resolve().relative_to(base.resolve())
                except Exception:
                    if target.resolve() != base.resolve():
                        return self._send_404()
                if not target.exists() or target.is_dir():
                    return self._send_404()
                ext = self._real_ext(base, dek, rel, target)
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
                target = (base / rel) if rel else base
                ext = self._real_ext(base, dek, rel, target)
                data = None
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
                data = None
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


def start_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, port
