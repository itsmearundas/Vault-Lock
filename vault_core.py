"""
VaultLock — core engine (no UI code here).

Every file and folder placed in the vault is encrypted at rest with
AES-256-CTR + an HMAC-SHA256 integrity tag, using a per-vault random Data
Encryption Key (DEK). The DEK itself is never stored in the clear — it's
wrapped (encrypted) with a key derived from your password via PBKDF2, and
unwrapped back into memory only after a successful login.

This applies uniformly to every item type: individual files, folders (every
file inside, recursively), and cached thumbnail previews. For folders, the
real file/folder NAMES and directory structure are hidden too — every entry
on disk gets a random token name, and the real names/tree are recorded only
in an encrypted manifest (`_index.enc`), decrypted in memory only for an
unlocked session. Someone browsing straight to the vault's storage folder on
disk — outside the app — sees nothing but random tokens and ciphertext, with
no way to tell what any of it is.
"""
import os, sys, json, shutil, hashlib, ctypes, subprocess, secrets, base64, io, random
import threading, time
from datetime import datetime
from pathlib import Path

import bcrypt
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes as _hashes, hmac as _hmac
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.fernet import Fernet, InvalidToken

try:
    from PIL import Image, ImageFilter
    PIL_OK = True
except ImportError:
    PIL_OK = False

try:
    import cv2
    CV2_OK = True
except ImportError:
    CV2_OK = False

try:
    import numpy as np
    NUMPY_OK = True
except ImportError:
    NUMPY_OK = False

try:
    import requests
    REQUESTS_OK = True
except ImportError:
    REQUESTS_OK = False

# ══════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════════════════
APP_VERSION = "4.0"

_POINTER_FILE = Path(os.environ.get("APPDATA", str(Path.home()))) / "VaultLock" / "location.json"

# Settings for the optional free "AI Enhance" upscaler (Hugging Face's free
# Serverless Inference API). This is app-level config, not vault content —
# same trust level as the vault-location pointer above, stored unencrypted
# in the OS user profile. It holds nothing about your photos, only your own
# free Hugging Face API token, and is only read when you explicitly turn AI
# enhancement on for a given "Increase Quality" run.
_AI_SETTINGS_FILE = Path(os.environ.get("APPDATA", str(Path.home()))) / "VaultLock" / "ai_settings.json"


def load_ai_settings():
    try:
        if _AI_SETTINGS_FILE.exists():
            data = json.loads(_AI_SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {"hf_token": data.get("hf_token", "") or "", "enabled": bool(data.get("enabled", False))}
    except Exception:
        pass
    return {"hf_token": "", "enabled": False}


def save_ai_settings(hf_token, enabled):
    """hf_token=None preserves whatever token is already saved — used when
    just flipping the enabled toggle without re-entering the key."""
    try:
        _AI_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        token = load_ai_settings()["hf_token"] if hf_token is None else (hf_token or "").strip()
        _AI_SETTINGS_FILE.write_text(json.dumps({"hf_token": token, "enabled": bool(enabled)}),
                                      encoding="utf-8")
        return True
    except Exception:
        return False


# Free Hugging Face models used for the AI enhancer — Swin2SR, a real
# super-resolution transformer that reconstructs plausible detail rather
# than just resampling pixels. "x2"/"x4" are the model's fixed native
# scale factors; whatever target size the person picked is reached by a
# local resize of the AI's output afterwards, so the final dimensions
# always match what they chose regardless of which model ran.
_HF_UPSCALE_MODELS = {
    "2x": "caidas/swin2SR-classical-sr-x2-64",
    "4x": "caidas/swin2SR-classical-sr-x4-64",
}
_HF_AI_INPUT_CAP = 1400  # keep the upload modest — free shared inference hardware is slow/limited on huge images


def _hf_upscale_call(token, model_id, image_bytes, job_id=None, max_wait=90):
    """POSTs an image to Hugging Face's free Serverless Inference API and
    returns the enhanced image bytes. On a cold start the model can take
    ~20-60s to load, during which HF returns a 503 with an estimated wait
    time — this waits and retries automatically, up to max_wait seconds."""
    if not REQUESTS_OK:
        raise RuntimeError("the 'requests' package isn't installed")
    url = f"https://api-inference.huggingface.co/models/{model_id}"
    headers = {"Authorization": f"Bearer {token}"}
    waited = 0
    while True:
        resp = requests.post(url, headers=headers, data=image_bytes, timeout=60)
        ctype = resp.headers.get("content-type", "")
        if resp.status_code == 200 and ctype.startswith("image/"):
            return resp.content
        try:
            payload = resp.json()
        except Exception:
            payload = {}
        if resp.status_code in (503, 500) and isinstance(payload, dict) and "estimated_time" in payload and waited < max_wait:
            wait_s = min(15, max(2, float(payload.get("estimated_time", 5))))
            if job_id:
                _job_update(job_id, message=f"AI model is waking up \u2014 waiting {int(wait_s)}s\u2026")
            time.sleep(wait_s)
            waited += wait_s
            continue
        if resp.status_code == 401:
            raise RuntimeError("Hugging Face rejected that API key")
        detail = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(detail or f"Hugging Face returned HTTP {resp.status_code}")



# ══════════════════════════════════════════════════════════════════════════
# FACE GROUPS — "same face, everywhere in your vault" auto-collections.
#
# Detection uses YuNet (a small ONNX face detector) and recognition uses
# SFace (an ONNX embedding model that turns a cropped face into a 128-d
# vector such that two faces of the same person land close together, by
# cosine similarity). Both ship as tiny/moderate ONNX files from OpenCV's
# own model zoo — not bundled with the app (keeps install size down), so
# they're fetched once on first use and cached in the app's own data
# folder (same trust tier as the AI-enhance settings above: app-level
# config, not vault content, and it holds no photos or vault data — just
# two small public model files anyone could download from the same URL).
# Everything else — every photo pixel touched during a scan — stays
# in-memory only, exactly like the duplicate-finder's hashing pass.
# ══════════════════════════════════════════════════════════════════════════
_FACE_MODELS_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "VaultLock" / "face_models"
_YUNET_NAME = "face_detection_yunet_2023mar.onnx"
_SFACE_NAME = "face_recognition_sface_2021dec.onnx"
_YUNET_URL = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/" + _YUNET_NAME
_SFACE_URL = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/" + _SFACE_NAME
# Both files are Git-LFS-tracked in opencv_zoo. raw.githubusercontent.com
# (the previous host used here) serves the LFS *pointer stub* for
# LFS-tracked paths, not the actual binary — a ~130-byte text file like
# "version https://git-lfs.github.com/spec/v1\noid sha256:...\nsize ..."
# that OpenCV's ONNX loader can't parse. media.githubusercontent.com is
# GitHub's actual LFS media host (what github.com/.../raw/... 302-redirects
# to for an LFS path) and returns the real binary directly. Keeping the
# pointer-stub/HTML-error detection below anyway, as a safety net against
# any future interrupted/blocked/rate-limited fetch — these are the known
# minimum real sizes (with slack) used to catch that case before it's cached.
_YUNET_MIN_BYTES = 100_000
_SFACE_MIN_BYTES = 10_000_000

# SFace's own documented cosine-similarity cutoffs for "same person" — above
# the chosen cutoff, two face crops are considered a match; below it,
# different people. The model zoo publishes two: 0.363 at a 1-in-1,000
# false-accept rate, and a stricter 0.404 at 1-in-10,000. 0.363 is tuned
# for one-off verification (compare exactly two faces, decide same/
# different) where an occasional false accept is cheap. Clustering is a
# different game: every face gets compared against every running group,
# so the false-accept opportunities multiply across a whole vault, and
# a single bad merge silently and permanently folds one person's photos
# into another's group. 0.404 trades a bit of recall (occasionally two
# photos of the same person land in separate groups instead of one) for
# meaningfully fewer different-people-merged mistakes, which matters far
# more here.
FACE_MATCH_THRESHOLD = 0.404

# Detected faces smaller than this (in pixels, measured on the possibly-
# downscaled working copy — see _detect_face_embeddings) are skipped
# entirely rather than embedded. Small crops are usually background
# people, not the photo's subject, and low-resolution crops produce
# noisier embeddings that are far more likely to drift into the wrong
# cluster. Excluding them removes a leading source of "different faces
# ended up in one group" without touching the threshold that governs
# well-formed detections.
_FACE_MIN_SIZE_PX = 60

_face_engines_lock = threading.Lock()
_face_detector = None
_face_recognizer = None


def _looks_like_valid_model_file(path, min_bytes):
    """Best-effort check that what's on disk is really the binary model
    and not a Git-LFS pointer stub or an HTML/JSON error page saved under
    the right filename — all of which are plain text and much smaller
    than the real model, and all of which OpenCV's ONNX importer will
    reject with an opaque C++ error if allowed through."""
    try:
        if not path.exists() or path.stat().st_size < min_bytes:
            return False
        with open(path, "rb") as f:
            head = f.read(200)
        if head.startswith(b"version https://git-lfs") or head.lstrip().startswith((b"<", b"{")):
            return False
        return True
    except Exception:
        return False


def _download_face_model(url, dest, min_bytes, job_id=None):
    if _looks_like_valid_model_file(dest, min_bytes):
        return
    if not REQUESTS_OK:
        raise RuntimeError("Face grouping needs the 'requests' package, which isn't installed")
    if job_id:
        _job_update(job_id, message="Downloading face-recognition model \u2014 one-time setup\u2026")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    resp = requests.get(url, timeout=60, stream=True, headers={"Accept": "application/octet-stream"})
    if resp.status_code != 200:
        raise RuntimeError(f"Couldn't download face model (HTTP {resp.status_code})")
    with open(tmp, "wb") as f:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                f.write(chunk)
    if not _looks_like_valid_model_file(tmp, min_bytes):
        tmp.unlink(missing_ok=True)
        raise RuntimeError(
            "The face-recognition model download looked incomplete or blocked "
            "(got a placeholder instead of the real file) \u2014 check your internet "
            "connection and try scanning again."
        )
    tmp.replace(dest)


def _ensure_face_models(job_id=None):
    yunet_path = _FACE_MODELS_DIR / _YUNET_NAME
    sface_path = _FACE_MODELS_DIR / _SFACE_NAME
    _download_face_model(_YUNET_URL, yunet_path, _YUNET_MIN_BYTES, job_id)
    _download_face_model(_SFACE_URL, sface_path, _SFACE_MIN_BYTES, job_id)
    return yunet_path, sface_path


def _get_face_engines(job_id=None):
    """Lazily creates (and caches) the detector/recognizer for this process.
    Raises RuntimeError with a person-readable message on any failure —
    missing OpenCV, no network for the one-time model download, a model
    file OpenCV itself can't parse, etc. A model file that fails to load
    is deleted so the next attempt re-downloads instead of repeating the
    same failure forever."""
    global _face_detector, _face_recognizer
    if not CV2_OK:
        raise RuntimeError("Face grouping needs OpenCV, which isn't installed")
    if not NUMPY_OK:
        raise RuntimeError("Face grouping needs NumPy, which isn't installed")
    with _face_engines_lock:
        if _face_detector is None or _face_recognizer is None:
            yunet_path, sface_path = _ensure_face_models(job_id)
            try:
                det = cv2.FaceDetectorYN.create(str(yunet_path), "", (320, 320), score_threshold=0.8)
                rec = cv2.FaceRecognizerSF.create(str(sface_path), "")
            except Exception as e:
                # A file that downloaded cleanly but still won't load is
                # corrupt or truncated (or, rarely, incompatible with this
                # OpenCV build) — remove it so the next scan starts from a
                # fresh download rather than hitting the same error
                # forever, and surface a plain-language message instead
                # of the raw OpenCV/C++ exception text.
                for p in (yunet_path, sface_path):
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:
                        pass
                raise RuntimeError(
                    "Couldn't load the face-recognition model (it may have downloaded "
                    "incompletely) \u2014 it's been cleared, so the next scan will fetch it "
                    f"fresh. Details: {e}"
                )
            _face_detector, _face_recognizer = det, rec
        return _face_detector, _face_recognizer


def _detect_face_embeddings(image_bytes, max_faces=10):
    """Decodes an image and returns one L2-normalizable embedding vector
    per detected face (empty list if none found or the file isn't a
    readable image). Large images are downscaled before detection purely
    for speed — the returned embeddings are computed from that same
    working copy, which doesn't affect match quality since SFace compares
    faces at its own fixed internal crop size regardless."""
    detector, recognizer = _get_face_engines()
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None or img.size == 0:
        return []
    h, w = img.shape[:2]
    MAX_DIM = 1600
    if max(h, w) > MAX_DIM:
        scale = MAX_DIM / max(h, w)
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))))
        h, w = img.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    if faces is None:
        return []
    out = []
    for face in faces[:max_faces]:
        # face layout is [x, y, w, h, <5 landmark pairs>, score] — skip
        # small/background detections before spending an embedding on
        # them; see _FACE_MIN_SIZE_PX above for why.
        box_w, box_h = float(face[2]), float(face[3])
        if box_w < _FACE_MIN_SIZE_PX or box_h < _FACE_MIN_SIZE_PX:
            continue
        try:
            aligned = recognizer.alignCrop(img, face)
            emb = recognizer.feature(aligned)
            out.append(np.asarray(emb, dtype="float32").flatten())
        except Exception:
            continue
    return out


def _cosine_sim(a, b):
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _cluster_faces(faces, threshold):
    """Groups face entries (dicts with an "emb" embedding) by identity.

    Deliberately NOT single-linkage/union-find: merging two faces the
    moment *any single pair* clears the similarity threshold lets one
    borderline false-positive permanently fuse two different people's
    entire clusters together — and once fused, the merged blob keeps
    sweeping up anyone even loosely similar to ANY face already inside
    it. At real-vault scale (thousands of faces, so millions of pairs
    checked) at least one such stray link is close to guaranteed, and
    the result is exactly the symptom this replaced: one giant
    catch-all group full of different people, plus a couple of small
    "leftover" groups that just never happened to touch a bad link.

    Instead, each face joins the group whose CENTROID (running average
    of every member so far) it's most similar to, and only if that
    similarity clears the threshold — matching against an average of
    many faces is far more resistant to a single noisy embedding than
    matching against any one member ever was. A face that doesn't clear
    the threshold against any existing centroid starts a new group.
    This is also O(faces \u00d7 groups) instead of O(faces\u00b2), which matters
    once a vault has thousands of photos.
    """
    clusters = []  # each: {"members": [...], "sum": ndarray, "n": int}
    for f in faces:
        emb = f["emb"]
        best_idx, best_sim = -1, threshold
        for idx, c in enumerate(clusters):
            centroid = c["sum"] / c["n"]
            sim = _cosine_sim(emb, centroid)
            if sim >= best_sim:
                best_sim, best_idx = sim, idx
        if best_idx == -1:
            clusters.append({"members": [f], "sum": emb.copy(), "n": 1})
        else:
            c = clusters[best_idx]
            c["members"].append(f)
            c["sum"] = c["sum"] + emb
            c["n"] += 1
    return [c["members"] for c in clusters]


# Prefer D:, otherwise fall back to C:
if Path("D:/").exists():
    _DEFAULT_BASE = Path("D:/VaultLockData")
else:
    _DEFAULT_BASE = Path(os.environ.get("APPDATA", str(Path.home()))) / ".vaultlock_data"

_location_cache = None


def get_base_dir(force_reload=False):
    global _location_cache
    if force_reload:
        _location_cache = None
    if _location_cache is not None:
        return _location_cache
    try:
        if _POINTER_FILE.exists():
            data = json.loads(_POINTER_FILE.read_text())
            raw = data.get("base_dir", "")
            if raw:
                _location_cache = Path(raw)
                return _location_cache
    except Exception:
        pass
    _location_cache = _DEFAULT_BASE
    return _DEFAULT_BASE


def set_base_dir(new_base):
    global _location_cache
    new_base = Path(new_base)
    _POINTER_FILE.parent.mkdir(parents=True, exist_ok=True)
    _POINTER_FILE.write_text(json.dumps({"base_dir": str(new_base)}, indent=2))
    _location_cache = new_base


def default_base_dir():
    return _DEFAULT_BASE


def vault_base():      return get_base_dir()
def config_file():     return vault_base() / "config.json"
def vault_dir_path():  return vault_base() / "vault"
def decoy_dir_path():  return vault_base() / "dvault"
def meta_file():       return vault_base() / "meta.json"
def decoy_meta_file(): return vault_base() / "dmeta.json"
def thumb_dir():       return vault_base() / "thumbs"


def ui_prefs_file(is_decoy=False):
    return vault_base() / ("ui_prefs_decoy.json" if is_decoy else "ui_prefs.json")


def ui_bg_dir(is_decoy=False):
    return vault_base() / ("ui_bg_decoy" if is_decoy else "ui_bg")


def dynbg_file(is_decoy=False):
    """Dynamic Content-Based Background storage — unlike ui_bg_dir (a
    single deliberately-chosen image, kept plaintext by design since the
    person explicitly picked that exact photo, same as restoring a file),
    this is auto-composited from MULTIPLE vault photos the person didn't
    individually pick. That's exactly the case the encrypted-derived-data
    rule is for, so this stays encrypted with the vault's own DEK and is
    only ever decrypted in memory when the media server serves it."""
    return vault_base() / ("dynbg_decoy.enc" if is_decoy else "dynbg.enc")


def load_ui_prefs(is_decoy=False):
    """Cosmetic app appearance (background) — not vault content, so it's
    kept as plain JSON rather than encrypted. Master and decoy each get
    their own background, kept in separate files, so the entrance
    animation reveals the right one for whichever account just logged in."""
    f = ui_prefs_file(is_decoy)
    if f.exists():
        try:
            return json.loads(f.read_text())
        except Exception:
            pass
    return {"type": "default"}


def save_ui_prefs(prefs, is_decoy=False):
    f = ui_prefs_file(is_decoy)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(prefs, indent=2))


def disk_free_bytes(path):
    try:
        return shutil.disk_usage(str(path)).free
    except Exception:
        return None


def list_drives():
    drives = []
    if sys.platform == "win32":
        import string
        for letter in string.ascii_uppercase:
            root = Path(f"{letter}:\\")
            if root.exists():
                free = disk_free_bytes(root)
                drives.append({"path": str(root), "free": free, "free_h": human_size(free) if free else "?"})
    else:
        for root in [Path("/")] + list(Path("/mnt").glob("*")) + list(Path("/media").glob("*")):
            if root.exists():
                free = disk_free_bytes(root)
                drives.append({"path": str(root), "free": free, "free_h": human_size(free) if free else "?"})
    return drives


IMG_EXT = {".jpg",".jpeg",".png",".gif",".bmp",".webp",".tiff",".heic",".avif"}
VID_EXT = {".mp4",".mkv",".avi",".mov",".wmv",".flv",".webm",".m4v",".ts"}
AUD_EXT = {".mp3",".wav",".flac",".aac",".ogg",".m4a",".wma",".opus"}
TXT_EXT = {".txt",".md",".py",".js",".ts",".html",".css",".json",".xml",
           ".csv",".log",".ini",".cfg",".bat",".ps1",".sh",".yaml",".toml"}

def file_cat(name):
    ext = Path(name).suffix.lower()
    if ext in IMG_EXT: return "image"
    if ext in VID_EXT: return "video"
    if ext in AUD_EXT: return "audio"
    if ext in TXT_EXT: return "text"
    if ext == ".pdf":  return "pdf"
    return "other"

def file_icon(name, is_dir=False):
    if is_dir: return "📁"
    ext = Path(name).suffix.lower()
    if ext in IMG_EXT: return "🖼️"
    if ext in VID_EXT: return "🎬"
    if ext in AUD_EXT: return "🎵"
    if ext == ".pdf":  return "📄"
    if ext in {".zip",".rar",".7z",".tar",".gz"}: return "🗜️"
    if ext in {".doc",".docx",".odt"}:            return "📝"
    if ext in {".txt",".md"}:                     return "📋"
    if ext in {".xls",".xlsx",".csv"}:            return "📊"
    if ext in {".exe",".msi"}:                    return "⚙️"
    if ext in {".py",".js",".ts",".html"}:        return "💻"
    return "📎"

def human_size(n):
    if n is None: return "?"
    n = float(n)
    for u in ["B","KB","MB","GB"]:
        if n < 1024: return f"{n:.0f} {u}" if u=="B" else f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} TB"

def time_ago(iso):
    try:
        dt   = datetime.fromisoformat(iso)
        diff = datetime.now() - dt
        s    = diff.total_seconds()
        if s < 60:   return "just now"
        if s < 3600: return f"{int(s//60)}m ago"
        if s < 86400:return f"{int(s//3600)}h ago"
        return dt.strftime("%b %d")
    except Exception:
        return ""

# ══════════════════════════════════════════════════════════════════════════
# ENCRYPTION — AES-256-CTR + HMAC-SHA256, streaming, applied to EVERY item
# ══════════════════════════════════════════════════════════════════════════
# On-disk format for every encrypted file (thumbnails included):
#   [16-byte nonce][ciphertext, same length as plaintext][32-byte HMAC tag]
# CTR mode is used specifically because it supports true random access —
# required to serve arbitrary HTTP Range requests (video seeking) and to
# decrypt a single frame's worth of a file without reading it from the start.
ENC_OVERHEAD = 16 + 32   # nonce + hmac tag
_CHUNK = 1024 * 1024
KDF_ITERATIONS = 480_000


def derive_kek(password, salt, iterations=KDF_ITERATIONS):
    kdf = PBKDF2HMAC(algorithm=_hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode())

def wrap_dek(kek, dek):
    return Fernet(base64.urlsafe_b64encode(kek)).encrypt(dek)

def unwrap_dek(kek, wrapped):
    """Returns the raw DEK bytes, or None if the password/kek was wrong."""
    try:
        return Fernet(base64.urlsafe_b64encode(kek)).decrypt(wrapped)
    except InvalidToken:
        return None

def new_dek():
    return secrets.token_bytes(32)


def new_session_token():
    """A fresh per-session token media_server requires on every request
    (§2 fix) — url-safe so it drops straight into a query string."""
    return secrets.token_urlsafe(32)


def encrypt_file(src_path, dest_path, dek):
    """Streams src_path -> dest_path as [nonce][ciphertext][hmac]."""
    nonce = secrets.token_bytes(16)
    cipher = Cipher(algorithms.AES(dek), modes.CTR(nonce))
    encryptor = cipher.encryptor()
    mac = _hmac.HMAC(dek, _hashes.SHA256())
    mac.update(nonce)
    with open(src_path, "rb") as fin, open(dest_path, "wb") as fout:
        fout.write(nonce)
        while True:
            chunk = fin.read(_CHUNK)
            if not chunk:
                break
            ct = encryptor.update(chunk)
            fout.write(ct)
            mac.update(ct)
        fout.write(encryptor.finalize())
        fout.write(mac.finalize())


def encrypt_bytes(data, dek):
    nonce = secrets.token_bytes(16)
    cipher = Cipher(algorithms.AES(dek), modes.CTR(nonce))
    encryptor = cipher.encryptor()
    ct = encryptor.update(data) + encryptor.finalize()
    mac = _hmac.HMAC(dek, _hashes.SHA256())
    mac.update(nonce); mac.update(ct)
    return nonce + ct + mac.finalize()


def decrypt_file(src_path, dest_path, dek, verify=True):
    """Streams an encrypted file back to plaintext at dest_path."""
    size = Path(src_path).stat().st_size
    ct_len = size - ENC_OVERHEAD
    if ct_len < 0:
        raise ValueError("Encrypted file is corrupt or truncated")
    with open(src_path, "rb") as fin:
        nonce = fin.read(16)
        cipher = Cipher(algorithms.AES(dek), modes.CTR(nonce))
        decryptor = cipher.decryptor()
        mac = _hmac.HMAC(dek, _hashes.SHA256())
        mac.update(nonce)
        remaining = ct_len
        with open(dest_path, "wb") as fout:
            while remaining > 0:
                chunk = fin.read(min(_CHUNK, remaining))
                if not chunk:
                    break
                mac.update(chunk)
                fout.write(decryptor.update(chunk))
                remaining -= len(chunk)
            fout.write(decryptor.finalize())
        tag = fin.read(32)
    if verify:
        mac.verify(tag)  # raises InvalidSignature on tamper / wrong key


def decrypt_to_bytes(src_path, dek, verify=True):
    size = Path(src_path).stat().st_size
    ct_len = size - ENC_OVERHEAD
    if ct_len < 0:
        raise ValueError("Encrypted file is corrupt or truncated")
    with open(src_path, "rb") as fin:
        nonce = fin.read(16)
        ct = fin.read(ct_len)
        tag = fin.read(32)
    if verify:
        mac = _hmac.HMAC(dek, _hashes.SHA256())
        mac.update(nonce); mac.update(ct)
        mac.verify(tag)
    cipher = Cipher(algorithms.AES(dek), modes.CTR(nonce))
    decryptor = cipher.decryptor()
    return decryptor.update(ct) + decryptor.finalize()


def plaintext_size(enc_path):
    return max(0, Path(enc_path).stat().st_size - ENC_OVERHEAD)


def decrypt_range(enc_path, dek, start, end):
    """Decrypts only plaintext byte range [start, end] (inclusive) — true
    random access via AES-CTR, without reading/decrypting from the start.
    No HMAC check here (streaming partial reads can't cheaply verify a
    whole-file tag); full integrity is verified on restore/unlock instead."""
    with open(enc_path, "rb") as f:
        nonce = f.read(16)
        block_offset = start // 16
        skip = start % 16
        nonce_int = int.from_bytes(nonce, "big")
        new_counter = (nonce_int + block_offset) % (2 ** 128)
        block_nonce = new_counter.to_bytes(16, "big")
        cipher = Cipher(algorithms.AES(dek), modes.CTR(block_nonce))
        decryptor = cipher.decryptor()
        f.seek(16 + block_offset * 16)
        to_read = (end - start + 1) + skip
        ct = f.read(to_read)
        pt = decryptor.update(ct) + decryptor.finalize()
        return pt[skip:skip + (end - start + 1)]


def encrypt_tree(src_dir, dest_dir, dek):
    """Recursively encrypts every file in src_dir into dest_dir. Unlike a
    plain mirror, every file AND folder on disk gets a random token name —
    the real names and directory structure are recorded only in an encrypted
    manifest (`_index.enc`) inside dest_dir. Someone browsing the raw vault
    folder on disk sees nothing but random-looking tokens and ciphertext;
    the real tree is only ever reconstructed in memory, after login, to
    answer the app's own requests."""
    src_dir, dest_dir = Path(src_dir), Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    manifest = _encrypt_dir_recursive(src_dir, dest_dir, dek)
    blob = encrypt_bytes(json.dumps(manifest).encode(), dek)
    (dest_dir / "_index.enc").write_bytes(blob)


def _encrypt_dir_recursive(src, dest, dek):
    node = {"type": "dir", "children": {}}
    try:
        entries = sorted(src.iterdir(), key=lambda p: p.name.lower())
    except Exception:
        entries = []
    for e in entries:
        token = secrets.token_hex(8)
        if e.is_dir():
            child_dest = dest / token
            child_dest.mkdir(parents=True, exist_ok=True)
            child = _encrypt_dir_recursive(e, child_dest, dek)
            child["name"] = e.name
            child["locked_at"] = datetime.now().isoformat()
            node["children"][token] = child
        else:
            encrypt_file(e, dest / token, dek)
            node["children"][token] = {
                "type": "file", "name": e.name, "size": e.stat().st_size,
                "locked_at": datetime.now().isoformat(),
            }
    return node


def load_tree_manifest(enc_dir, dek):
    """Decrypts and returns the folder's name/structure manifest, or None if
    this folder predates the manifest scheme (kept readable for backward
    compatibility with anything locked by an earlier version)."""
    p = Path(enc_dir) / "_index.enc"
    if not p.exists() or dek is None:
        return None
    try:
        data = decrypt_to_bytes(p, dek, verify=False)
        return json.loads(data.decode())
    except Exception:
        return None


def save_tree_manifest(enc_dir, manifest, dek):
    """Re-encrypts and writes a folder's name/structure manifest back to its
    `_index.enc` — used whenever an item is added, moved, or removed inside
    an already-locked folder (organizing in place, single-item restore)."""
    blob = encrypt_bytes(json.dumps(manifest).encode(), dek)
    (Path(enc_dir) / "_index.enc").write_bytes(blob)


def manifest_real_names_path(manifest, tokens):
    """Walks a list of tokens and returns the corresponding real names,
    stopping early if the path doesn't fully resolve."""
    names = []
    node = manifest
    for t in tokens:
        node = (node or {}).get("children", {}).get(t)
        if node is None:
            break
        names.append(node.get("name") or t)
    return names


def manifest_node_at(manifest, rel):
    """Walks a '/'-joined token path inside a decrypted manifest tree."""
    node = manifest
    if rel:
        for token in rel.split("/"):
            node = (node or {}).get("children", {}).get(token)
            if node is None:
                return None
    return node


def manifest_dir_size(node):
    total = 0
    for child in node.get("children", {}).values():
        total += manifest_dir_size(child) if child["type"] == "dir" else child.get("size", 0)
    return total


def manifest_dir_stats(node):
    """Recursive (size, file_count, folder_count) rollup for a manifest dir
    node — used by Custom Folder Headers (Phase 3) and the Hierarchical
    Storage Visualization drill-down (Phase 4), which share this exact
    computation."""
    size = 0; files = 0; folders = 0
    for child in node.get("children", {}).values():
        if child["type"] == "dir":
            folders += 1
            cs, cf, cd = manifest_dir_stats(child)
            size += cs; files += cf; folders += cd
        else:
            files += 1
            size += child.get("size", 0)
    return size, files, folders


def _decrypt_dir_recursive(enc_dir, dest, node, dek):
    dest.mkdir(parents=True, exist_ok=True)
    for token, child in node.get("children", {}).items():
        name = child.get("name") or token
        if child["type"] == "dir":
            _decrypt_dir_recursive(Path(enc_dir) / token, dest / name, child, dek)
        else:
            decrypt_file(Path(enc_dir) / token, dest / name, dek, verify=False)


def decrypt_tree(src_dir, dest_dir, dek):
    """Recursively decrypts an encrypted folder back to real, readable
    content (real names included) at dest_dir."""
    src_dir, dest_dir = Path(src_dir), Path(dest_dir)
    manifest = load_tree_manifest(src_dir, dek)
    if manifest is not None:
        _decrypt_dir_recursive(src_dir, dest_dir, manifest, dek)
        return
    # Legacy fallback: folders locked before the manifest scheme existed
    # kept real names directly on disk — just mirror them back out.
    for root, dirs, files in os.walk(src_dir):
        rel = Path(root).relative_to(src_dir)
        out_root = dest_dir / rel
        out_root.mkdir(parents=True, exist_ok=True)
        for name in files:
            if name == "_index.enc":
                continue
            decrypt_file(Path(root) / name, out_root / name, dek, verify=False)

# ══════════════════════════════════════════════════════════════════════════
# CORE VAULT UTILS
# ══════════════════════════════════════════════════════════════════════════
def ensure_dirs():
    for d in [vault_base(), vault_dir_path(), decoy_dir_path(), thumb_dir(), ui_bg_dir(False), ui_bg_dir(True)]:
        d.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        try: ctypes.windll.kernel32.SetFileAttributesW(str(vault_base()), 0x02)
        except Exception: pass

def hash_pw(p):     return bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode()
def verify_pw(p,h): return bcrypt.checkpw(p.encode(), h.encode())

def load_cfg():
    f = config_file()
    return json.loads(f.read_text()) if f.exists() else {}
def save_cfg(c): config_file().write_text(json.dumps(c, indent=2))


# ══════════════════════════════════════════════════════════════════════════
# ITEM SCHEMA — optional fields added on top of the existing index entries.
# All default to falsy values so pre-existing items (and legacy plaintext
# meta.json content) keep working without any explicit migration pass.
# ══════════════════════════════════════════════════════════════════════════
ITEM_META_DEFAULTS = {
    "favorite": False,
    "pinned": False,
    "color": None,
    "icon": None,
    "tags": [],
    "description": None,
    "display_name": None,
    "background": None,
    "metadata": {},
    "sort_override": None,
    # List of album vids this item has been added to. Reference-only, same
    # spirit as `favorite`: adding an item to an album never moves or
    # copies it — it just records that the album should surface it. An
    # item can belong to any number of albums at once.
    "album_ids": [],
}


def item_meta_view(entry):
    """Read-only extraction of the optional metadata fields from an
    already-loaded index entry or manifest node — no decrypt/reload needed,
    since set_item_meta() writes these fields directly onto that same
    dict. Used when building listing payloads for many items at once."""
    return {k: entry.get(k, d) for k, d in ITEM_META_DEFAULTS.items()}


def _apply_item_meta_defaults(entry):
    """Mutates a single index/manifest node in place, filling in any of the
    new optional fields that are missing. Idempotent — safe to call on
    every load."""
    changed = False
    for key, default in ITEM_META_DEFAULTS.items():
        if key not in entry:
            # Copy mutable defaults (list/dict) so entries don't share state.
            entry[key] = list(default) if isinstance(default, list) else \
                         dict(default) if isinstance(default, dict) else default
            changed = True
    return changed


def _migrate_meta_schema(meta):
    """Idempotent, in-memory-only migration: fills in the new optional item
    fields for every root-level index entry that predates them. Does not
    force a disk write — the caller's next real save() persists it."""
    for entry in meta.get("files", {}).values():
        _apply_item_meta_defaults(entry)
    return meta


def load_meta(d=False, dek=None):
    """Loads the (now-encrypted) top-level item index for a vault. Falls
    back to reading legacy plaintext meta.json/dmeta.json written by older
    versions of the app, and transparently upgrades in memory — the next
    save_meta() call with a real dek re-writes it encrypted."""
    p = decoy_meta_file() if d else meta_file()
    if not p.exists():
        return {"files": {}}
    if dek is not None:
        try:
            data = decrypt_to_bytes(p, dek, verify=False)
            return _migrate_meta_schema(json.loads(data.decode()))
        except Exception:
            pass  # not an encrypted blob (or wrong key) — fall through to legacy plaintext
    try:
        return _migrate_meta_schema(json.loads(p.read_text()))
    except Exception:
        return {"files": {}}


def save_meta(m, d=False, dek=None):
    p = decoy_meta_file() if d else meta_file()
    if dek is not None:
        p.write_bytes(encrypt_bytes(json.dumps(m).encode(), dek))
    else:
        # No key available (shouldn't normally happen post-login) — avoid
        # silently corrupting an already-encrypted file with plaintext.
        if p.exists():
            try:
                json.loads(p.read_text())  # only a legacy plaintext file parses here
            except Exception:
                return  # refuse to overwrite an encrypted file without a key
        p.write_text(json.dumps(m, indent=2))


# ── get_item_meta / set_item_meta — work uniformly at any depth ───────────
def get_item_meta(engine, vid, rel=None):
    """Reads the optional metadata fields for a root-level item (rel=None)
    or a nested item inside a locked folder (rel = token path)."""
    if rel:
        manifest = load_tree_manifest(engine.vault_path(vid), engine.dek)
        if manifest is None:
            return dict(ITEM_META_DEFAULTS)
        node = manifest_node_at(manifest, rel)
        if node is None:
            return dict(ITEM_META_DEFAULTS)
        _apply_item_meta_defaults(node)
        return {k: node.get(k, d) for k, d in ITEM_META_DEFAULTS.items()}
    meta = load_meta(engine.is_decoy, engine.dek)
    entry = meta["files"].get(vid)
    if entry is None:
        return dict(ITEM_META_DEFAULTS)
    _apply_item_meta_defaults(entry)
    return {k: entry.get(k, d) for k, d in ITEM_META_DEFAULTS.items()}


def set_item_meta(engine, vid, updates, rel=None):
    """Writes one or more of the optional metadata fields. `updates` is a
    dict of {field: value}; unknown keys are ignored. Returns (ok, error)."""
    updates = {k: v for k, v in updates.items() if k in ITEM_META_DEFAULTS}
    if not updates:
        return False, "No recognized metadata fields in update"
    if rel:
        base = engine.vault_path(vid)
        manifest = load_tree_manifest(base, engine.dek)
        if manifest is None:
            return False, ("This folder predates the organize feature — "
                            "restore and re-lock it first.")
        node = manifest_node_at(manifest, rel)
        if node is None:
            return False, "Item not found"
        _apply_item_meta_defaults(node)
        node.update(updates)
        save_tree_manifest(base, manifest, engine.dek)
        return True, None
    meta = load_meta(engine.is_decoy, engine.dek)
    if vid not in meta["files"]:
        return False, "Item not found"
    entry = meta["files"][vid]
    _apply_item_meta_defaults(entry)
    entry.update(updates)
    save_meta(meta, engine.is_decoy, engine.dek)
    return True, None


# ══════════════════════════════════════════════════════════════════════════
# PREFERENCES STORE — encrypted, one file per vault identity (mirrors the
# existing ui_prefs.json / ui_prefs_decoy.json split), so master and decoy
# preferences (favorites, dashboard layout, viewer defaults, shortcuts,
# etc.) never mix or leak into one another. Unlike ui_prefs (purely
# cosmetic, deliberately left plaintext), this can hold vault-identifying
# content like favorites lists, so it's encrypted with that vault's DEK.
# ══════════════════════════════════════════════════════════════════════════
PREF_SCOPES = ("application", "vault", "viewer", "shortcuts")


def prefs_file(is_decoy=False):
    return vault_base() / ("prefs_decoy.enc" if is_decoy else "prefs.enc")


def load_prefs(is_decoy=False, dek=None):
    p = prefs_file(is_decoy)
    empty = {s: {} for s in PREF_SCOPES}
    if not p.exists() or dek is None:
        return empty
    try:
        data = decrypt_to_bytes(p, dek, verify=False)
        prefs = json.loads(data.decode())
    except Exception:
        return empty
    for s in PREF_SCOPES:
        prefs.setdefault(s, {})
    return prefs


def save_prefs(prefs, is_decoy=False, dek=None):
    if dek is None:
        return False
    p = prefs_file(is_decoy)
    p.write_bytes(encrypt_bytes(json.dumps(prefs).encode(), dek))
    return True


def get_pref(scope, key, default, is_decoy=False, dek=None):
    prefs = load_prefs(is_decoy, dek)
    return prefs.get(scope, {}).get(key, default)


def set_pref(scope, key, value, is_decoy=False, dek=None):
    if scope not in PREF_SCOPES:
        return False, f"Unknown preference scope: {scope}"
    prefs = load_prefs(is_decoy, dek)
    prefs.setdefault(scope, {})[key] = value
    if not save_prefs(prefs, is_decoy, dek):
        return False, "Vault is locked (no encryption key available)"
    return True, None

def factory_reset_everything():
    """Wipes the ENTIRE current vault storage location (both vaults, config,
    prefs, thumbnails) — wherever it currently lives, including a relocated
    drive — then resets the location pointer back to the default so the app
    genuinely returns to first-launch state. Deliberately does not call, or
    get called by, nuke_main_vault()."""
    try:
        base = get_base_dir(force_reload=True)
        if base.exists():
            shutil.rmtree(str(base), ignore_errors=False)
        if _POINTER_FILE.exists():
            _POINTER_FILE.unlink()
        global _location_cache
        _location_cache = None
        sweep_orphaned_temp_files()
        return True, None
    except Exception as e:
        return False, str(e)


def nuke_main_vault(dek=None):
    """Silently wipes the real vault's files, index, and thumbnails. If a
    dek is available (nuke logins carry one, wrapping the same master DEK),
    the freshly emptied index is written back out encrypted, matching the
    normal on-disk format; new per-item metadata is gone along with the
    files it belonged to, exactly like the files themselves."""
    try:
        vd = vault_dir_path()
        if vd.exists(): shutil.rmtree(str(vd))
        vd.mkdir(parents=True, exist_ok=True)
        empty = {"files": {}}
        if dek is not None:
            meta_file().write_bytes(encrypt_bytes(json.dumps(empty).encode(), dek))
        else:
            meta_file().write_text(json.dumps(empty, indent=2))
        td = thumb_dir()
        if td.exists():
            for f in td.glob("*.jpg"):
                try: f.unlink()
                except Exception: pass
        pf = prefs_file(False)
        if pf.exists():
            try: pf.unlink()
            except Exception: pass
    except Exception:
        pass

def _nested_thumb_cache_path(vid, folder_rel):
    """On-disk location for a nested folder's custom cropped thumbnail —
    same tamper-protected thumb_dir() as everything else, keyed by a hash
    since folder_rel can contain '/' and isn't safe as a bare filename."""
    key = hashlib.sha1(f"{vid}:{folder_rel}".encode()).hexdigest()
    return thumb_dir() / f"{vid}__{key}.jpg"


def make_thumb(src_plain_path, vid, dek):
    """Builds a thumbnail from a DECRYPTED source path and stores it
    encrypted in thumb_dir() — thumbnails get exactly the same protection
    as the originals."""
    if not PIL_OK: return
    try:
        img = Image.open(str(src_plain_path))
        img.thumbnail((960, 960), Image.LANCZOS)
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=93)
        enc = encrypt_bytes(buf.getvalue(), dek)
        (thumb_dir() / f"{vid}.jpg").write_bytes(enc)
    except Exception:
        pass

def make_video_thumb(src_plain_path, vid, dek):
    if not CV2_OK or not PIL_OK: return
    try:
        cap = cv2.VideoCapture(str(src_plain_path))
        total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(total * 0.1)))
        ret, frame = cap.read()
        cap.release()
        if ret:
            img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            img.thumbnail((960, 960), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=93)
            enc = encrypt_bytes(buf.getvalue(), dek)
            (thumb_dir() / f"{vid}.jpg").write_bytes(enc)
    except Exception:
        pass

def _make_thumb_from_encrypted(enc_src, vid, dek, is_video):
    """Decrypts enc_src into a private temp file just long enough to build
    a thumbnail from it, then removes the temp file either way."""
    import tempfile
    suffix = Path(enc_src).suffix or (".mp4" if is_video else ".jpg")
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, dir=str(temp_dir()))
    os.close(fd)
    try:
        decrypt_file(enc_src, tmp_path, dek, verify=False)
        if is_video:
            make_video_thumb(tmp_path, vid, dek)
        else:
            make_thumb(tmp_path, vid, dek)
    finally:
        try: os.remove(tmp_path)
        except Exception: pass

def open_with_system(path):
    """Open file with the default system application (used for audio, and
    files pywebview/the browser can't render itself). Callers must pass an
    already-decrypted (plaintext) path — usually a temp file. Returns a
    handle usable with wait_for_exit() when the OS gives us one, so the
    caller can clean the temp file up once the external app is done with
    it, instead of leaving it on disk indefinitely."""
    try:
        if sys.platform == "win32":
            proc_handle = _win_shell_execute_tracked(path)
            return True, "", proc_handle
        elif sys.platform == "darwin":
            proc = subprocess.Popen(["open", "-W", str(path)])
            return True, "", proc
        else:
            proc = subprocess.Popen(["xdg-open", str(path)])
            return True, "", proc
    except PermissionError:
        return False, "Permission denied opening that file.", None
    except Exception as e:
        return False, str(e), None


def _win_shell_execute_tracked(path):
    """Launches path with the OS default handler via ShellExecuteEx, asking
    Windows NOT to auto-close the resulting process handle (SEE_MASK_NOCLOSEPROCESS)
    so we get a real HANDLE back and can wait on it. Returns that handle, or
    None if Windows didn't give us one (e.g. it reused an already-running
    instance of the target app) — callers fall back to a timed sweep in
    that case instead of leaving the temp file untracked forever."""
    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SW_SHOWNORMAL = 1

    class SHELLEXECUTEINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.c_ulong), ("fMask", ctypes.c_ulong),
            ("hwnd", ctypes.c_void_p), ("lpVerb", ctypes.c_wchar_p),
            ("lpFile", ctypes.c_wchar_p), ("lpParameters", ctypes.c_wchar_p),
            ("lpDirectory", ctypes.c_wchar_p), ("nShow", ctypes.c_int),
            ("hInstApp", ctypes.c_void_p), ("lpIDList", ctypes.c_void_p),
            ("lpClass", ctypes.c_wchar_p), ("hkeyClass", ctypes.c_void_p),
            ("dwHotKey", ctypes.c_ulong), ("hIconOrMonitor", ctypes.c_void_p),
            ("hProcess", ctypes.c_void_p),
        ]

    sei = SHELLEXECUTEINFO()
    sei.cbSize = ctypes.sizeof(sei)
    sei.fMask = SEE_MASK_NOCLOSEPROCESS
    sei.lpVerb = "open"
    sei.lpFile = str(path)
    sei.nShow = SW_SHOWNORMAL
    ok = ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(sei))
    if not ok or not sei.hProcess:
        return None
    return sei.hProcess


def wait_for_exit_and_delete(proc_handle, tmp_path, timeout_seconds=3600):
    """Runs in a background thread: blocks until the external app that
    opened tmp_path exits (or a generous timeout elapses, as a backstop for
    the cases where the OS didn't give us a waitable handle at all), then
    deletes the temp file. Never raises into the caller's thread."""
    try:
        if proc_handle is None:
            time.sleep(timeout_seconds)
        elif sys.platform == "win32":
            WAIT_TIMEOUT = 0x00000102
            INFINITE = 0xFFFFFFFF
            ms = min(timeout_seconds * 1000, INFINITE)
            ctypes.windll.kernel32.WaitForSingleObject(proc_handle, ms)
            ctypes.windll.kernel32.CloseHandle(proc_handle)
        else:
            # proc_handle is a subprocess.Popen on mac/linux
            proc_handle.wait(timeout=timeout_seconds)
    except Exception:
        pass
    finally:
        try:
            p = Path(tmp_path)
            if p.exists():
                p.unlink()
        except Exception:
            pass


def temp_dir():
    """Dedicated subfolder under the OS temp directory for VaultLock's own
    decrypted-on-open temp files, kept separate from unrelated temp files
    so orphan-sweeping never touches anything that isn't ours."""
    import tempfile as _tempfile
    d = Path(_tempfile.gettempdir()) / "VaultLockTmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def sweep_orphaned_temp_files():
    """Called once at app startup. Any file still sitting in our temp
    folder at that point belongs to a previous session that ended (crash,
    force-quit, OS shutdown) before its own cleanup thread could run —
    safe to delete unconditionally, since a fresh app start means nothing
    is still using them."""
    d = temp_dir()
    removed = 0
    try:
        for f in d.iterdir():
            try:
                if f.is_file():
                    f.unlink()
                    removed += 1
                elif f.is_dir():
                    shutil.rmtree(str(f), ignore_errors=True)
                    removed += 1
            except Exception:
                pass
    except Exception:
        pass
    return removed


def _retry_fs_op(fn, attempts=6, delay=0.25):
    """Runs fn() and retries briefly on PermissionError/OSError — on Windows,
    a file can be transiently locked (antivirus scanning it, or this app's
    own media server having just closed a read handle a moment earlier) and
    a delete/move issued at that exact instant fails with WinError 5, even
    though the same operation would succeed a fraction of a second later.
    Re-raises the last error if it still fails after all attempts."""
    last_err = None
    for attempt in range(attempts):
        try:
            return fn()
        except (PermissionError, OSError) as e:
            last_err = e
            time.sleep(delay * (attempt + 1))
    raise last_err


def move_vault_data(new_parent_dir, progress_cb=None):
    """Moves the ENTIRE vault (still encrypted — no re-encryption needed)
    to a new parent folder/drive the person picked."""
    old_base = vault_base()
    new_base = Path(new_parent_dir) / "VaultLockData"
    try:
        if new_base.resolve() == old_base.resolve():
            return False, "That's already the current storage location."
    except Exception:
        pass
    if new_base.exists() and any(new_base.iterdir()):
        return False, "That location already has a VaultLockData folder with files in it — choose an empty location."

    free = disk_free_bytes(new_parent_dir)
    try:
        used = sum(f.stat().st_size for f in old_base.rglob("*") if f.is_file()) if old_base.exists() else 0
    except Exception:
        used = 0
    if free is not None and used > free:
        return False, f"Not enough free space at that location ({human_size(free)} free, need {human_size(used)})."

    try:
        new_base.parent.mkdir(parents=True, exist_ok=True)
        if progress_cb: progress_cb("Copying files\u2026")
        if old_base.exists():
            # shutil.move() moves the source *inside* the destination if the
            # destination already exists as a directory (even an empty one),
            # instead of renaming it to that exact path. Since we already
            # confirmed above that new_base is either absent or empty, remove
            # it first so the move lands exactly at new_base itself — not at
            # new_base/<old folder name>/... where the app would never look.
            if new_base.exists():
                new_base.rmdir()
            _retry_fs_op(lambda: shutil.move(str(old_base), str(new_base)))
        else:
            new_base.mkdir(parents=True, exist_ok=True)
        set_base_dir(new_base)
        ensure_dirs()
        return True, str(new_base)
    except PermissionError:
        return False, ("Permission denied moving the vault. Close any files or folders from the vault that "
                        "might still be open (previews, restored copies, etc.) and try again.")
    except Exception as e:
        return False, str(e)

# ══════════════════════════════════════════════════════════════════════════
# BACKGROUND JOBS — shared progress registry for the long-running Gallery
# Tools operations (advanced frame extraction, contact sheet generation).
# Each job runs on its own daemon thread; the frontend polls get_job() every
# few hundred ms instead of blocking the UI thread for the whole operation.
# ══════════════════════════════════════════════════════════════════════════
_jobs_lock = threading.Lock()
_jobs = {}


def _job_new(kind, total=0):
    job_id = secrets.token_hex(8)
    with _jobs_lock:
        _jobs[job_id] = {
            "id": job_id, "kind": kind, "status": "running",
            "done": 0, "total": total, "message": "Starting\u2026",
            "result": None, "error": None, "cancel": False,
        }
    return job_id


def _job_update(job_id, **fields):
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j: j.update(fields)


def _job_get(job_id):
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None


def _job_cancel_requested(job_id):
    with _jobs_lock:
        j = _jobs.get(job_id)
        return bool(j and j.get("cancel"))


def request_job_cancel(job_id):
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j and j["status"] == "running":
            j["cancel"] = True
            return True
        return False


def get_job(job_id):
    return _job_get(job_id)


# ══════════════════════════════════════════════════════════════════════════
# IMAGE UPSCALE RESULT CACHE — the "Increase Quality" tool processes an
# image on a background job and holds the enhanced result (plaintext bytes,
# in memory only — never written to disk unencrypted) until the person
# decides whether to save it as the original or as a copy, from the
# side-by-side comparison screen. Keyed by job_id, same lifetime idea as
# the jobs registry above but separate since a job's own record is small
# and polled frequently, while this holds the actual image bytes.
# ══════════════════════════════════════════════════════════════════════════
_upscale_lock = threading.Lock()
_upscale_cache = {}
_UPSCALE_CACHE_MAX_AGE = 30 * 60  # 30 minutes — plenty for someone to look at the comparison and decide


def _sweep_upscale_cache():
    now = time.time()
    with _upscale_lock:
        stale = [k for k, v in _upscale_cache.items() if now - v.get("created", now) > _UPSCALE_CACHE_MAX_AGE]
        for k in stale:
            _upscale_cache.pop(k, None)


def clear_upscale_cache():
    """Called on lock_out()/logout — the cached bytes are decrypted image
    data, so they shouldn't linger in memory past the session that
    produced them."""
    with _upscale_lock:
        _upscale_cache.clear()


def discard_upscale_result(job_id):
    with _upscale_lock:
        _upscale_cache.pop(job_id, None)


# ══════════════════════════════════════════════════════════════════════════
# PRIVACY METADATA — image metadata read via Pillow, video metadata (when
# present) read/stripped via an external ffmpeg/ffprobe if one is installed
# on the machine. Neither is a hard dependency of VaultLock, so every call
# here degrades gracefully (reports "unavailable" rather than crashing) when
# the binaries aren't found on PATH.
# ══════════════════════════════════════════════════════════════════════════
_FFMPEG = shutil.which("ffmpeg")
_FFPROBE = shutil.which("ffprobe")

# Pillow EXIF tag ids we care about, grouped the way the Privacy Scrubber UI
# groups them. (Full EXIF tag table: PIL.ExifTags.TAGS)
_EXIF_GPS_TAG = 34853       # GPSInfo IFD pointer
_EXIF_DEVICE_TAGS = {271, 272, 42036}          # Make, Model, LensModel
_EXIF_SOFTWARE_TAG = 305                        # Software
_EXIF_PERSONAL_TAGS = {315, 33432, 37510, 40092}  # Artist, Copyright, UserComment, XPComment
_EXIF_DATETIME_TAGS = {306, 36867, 36868}       # DateTime, DateTimeOriginal, DateTimeDigitized


def scan_image_privacy(path):
    """Returns a dict of category -> bool ('was this found?') for a plain
    (already-decrypted) image file on disk."""
    found = {
        "gps": False, "device": False, "software": False, "personal": False,
        "datetime": False, "embedded_thumb": False, "xmp": False, "iptc": False,
    }
    if not PIL_OK:
        return found
    try:
        with Image.open(path) as img:
            exif = img.getexif()
            if exif:
                if _EXIF_GPS_TAG in exif or exif.get_ifd(_EXIF_GPS_TAG):
                    found["gps"] = True
                if any(t in exif for t in _EXIF_DEVICE_TAGS):
                    found["device"] = True
                if _EXIF_SOFTWARE_TAG in exif:
                    found["software"] = True
                if any(t in exif for t in _EXIF_PERSONAL_TAGS):
                    found["personal"] = True
                if any(t in exif for t in _EXIF_DATETIME_TAGS):
                    found["datetime"] = True
            info = img.info or {}
            if info.get("exif"):
                found["embedded_thumb"] = True  # thumbnail travels inside the raw EXIF blob
            if info.get("xmp") or b"<x:xmpmeta" in (info.get("XML:com.adobe.xmp", b"") or b""):
                found["xmp"] = True
            if "photoshop" in info or "iptc" in info:
                found["iptc"] = True
    except Exception:
        pass
    return found


def strip_image_privacy(src_path, dest_path, options):
    """Re-saves the image at src_path to dest_path with the metadata
    categories selected in `options` (dict of bool flags, see
    DEFAULT_SCRUB_OPTIONS) removed. Any category not explicitly disabled is
    left untouched by simply carrying `img.info` through unchanged for that
    piece; since EXIF/XMP/IPTC/thumbnail are all bundled together in
    practice, a partial selection still removes everything technically
    feasible to remove independently (GPS-only, when possible) and leaves a
    note in the return value about what full-strip covers."""
    if not PIL_OK:
        return False, "Image processing isn't available (Pillow not installed)"
    try:
        with Image.open(src_path) as img:
            img.load()
            fmt = (img.format or Path(src_path).suffix.lstrip(".").upper() or "JPEG")
            remove_all = options.get("all", False) or all(options.get(k, True) for k in (
                "gps", "device", "software", "personal", "exif", "iptc", "xmp", "embedded_thumb"))

            if remove_all:
                # Cheapest, most reliable strip: rebuild the image from raw
                # pixels only — no .info dict (which is where EXIF/XMP/IPTC/
                # ICC/embedded-thumbnail bytes all live) survives the copy.
                clean = Image.new(img.mode, img.size)
                clean.putdata(list(img.getdata()))
                save_kwargs = {}
                if fmt.upper() in ("JPEG", "JPG"):
                    save_kwargs["quality"] = 95
                clean.save(dest_path, format=fmt, **save_kwargs)
            else:
                # Selective removal: only GPS can be reliably edited out of
                # an EXIF blob in isolation without Pillow's low-level exif
                # IFD editing; everything else selected still triggers a
                # full strip since VaultLock doesn't ship a partial-EXIF
                # editor and a half-removed EXIF blob is worse than none.
                exif = img.getexif()
                if options.get("gps") and _EXIF_GPS_TAG in exif:
                    del exif[_EXIF_GPS_TAG]
                any_other = any(options.get(k) for k in
                                 ("device", "software", "personal", "exif", "iptc", "xmp", "embedded_thumb"))
                if any_other:
                    clean = Image.new(img.mode, img.size)
                    clean.putdata(list(img.getdata()))
                    save_kwargs = {}
                    if fmt.upper() in ("JPEG", "JPG"):
                        save_kwargs["quality"] = 95
                    clean.save(dest_path, format=fmt, **save_kwargs)
                else:
                    save_kwargs = {"exif": exif.tobytes()} if exif else {}
                    if fmt.upper() in ("JPEG", "JPG"):
                        save_kwargs["quality"] = 95
                    img.save(dest_path, format=fmt, **save_kwargs)
        return True, None
    except Exception as e:
        return False, str(e)


def scan_video_privacy(path):
    found = {
        "gps": False, "device": False, "software": False, "personal": False,
        "datetime": False, "embedded_thumb": False, "xmp": False, "iptc": False,
        "unavailable": not _FFPROBE,
    }
    if not _FFPROBE:
        return found
    try:
        out = subprocess.run(
            [_FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=20,
            creationflags=(subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0),
        )
        data = json.loads(out.stdout or "{}")
        tags = {}
        tags.update((data.get("format") or {}).get("tags") or {})
        for s in data.get("streams") or []:
            tags.update(s.get("tags") or {})
        keys_lower = {k.lower(): v for k, v in tags.items()}
        if any(k in keys_lower for k in ("location", "location-eng", "com.apple.quicktime.location.iso6709", "gps")):
            found["gps"] = True
        if any(k in keys_lower for k in ("make", "com.apple.quicktime.make", "model", "com.apple.quicktime.model")):
            found["device"] = True
        if any(k in keys_lower for k in ("encoder", "software", "com.apple.quicktime.software")):
            found["software"] = True
        if any(k in keys_lower for k in ("artist", "author", "com.apple.quicktime.author", "copyright", "comment")):
            found["personal"] = True
        if any(k in keys_lower for k in ("creation_time", "com.apple.quicktime.creationdate", "date")):
            found["datetime"] = True
    except Exception:
        pass
    return found


def strip_video_privacy(src_path, dest_path, options):
    """Remuxes (no re-encode — `-c copy`) with all container/stream
    metadata dropped. Requires an ffmpeg binary on PATH; VaultLock doesn't
    bundle one, so this cleanly reports unavailability instead of pretending
    to succeed."""
    if not _FFMPEG:
        return False, "Video metadata scrubbing needs ffmpeg installed and on PATH"
    try:
        cmd = [_FFMPEG, "-y", "-i", str(src_path), "-map_metadata", "-1",
               "-map", "0", "-c", "copy", str(dest_path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                               creationflags=(subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0))
        if proc.returncode != 0 or not Path(dest_path).exists() or Path(dest_path).stat().st_size == 0:
            return False, (proc.stderr or "ffmpeg failed").strip()[-300:]
        return True, None
    except Exception as e:
        return False, str(e)


DEFAULT_SCRUB_OPTIONS = {
    "gps": True, "device": True, "personal": True, "software": True,
    "embedded_thumb": True, "exif": True, "iptc": True, "xmp": True,
}


# ══════════════════════════════════════════════════════════════════════════
# VAULT ENGINE — every item encrypted uniformly (files, folders, thumbnails)
# ══════════════════════════════════════════════════════════════════════════
class VaultEngine:
    def __init__(self, is_decoy=False, dek=None):
        self.is_decoy = is_decoy
        self.dek = dek  # 32-byte key, unwrapped at login; required for all ops

    @property
    def vault_dir(self):
        return decoy_dir_path() if self.is_decoy else vault_dir_path()

    def lock_item(self, src_path):
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        try:
            src = Path(src_path)
            if not src.exists(): return False, "Path not found"
            meta = load_meta(self.is_decoy, self.dek)
            vid  = hashlib.sha256((str(src)+str(time.time())).encode()).hexdigest()[:16]
            dest = self.vault_dir / vid
            if src.is_dir():
                encrypt_tree(src, dest, self.dek)
                shutil.rmtree(str(src))
                size  = sum(max(0, f.stat().st_size - ENC_OVERHEAD)
                            for f in dest.rglob("*") if f.is_file() and f.name != "_index.enc")
                itype = "folder"
                threading.Thread(target=self._thumb_folder, args=(dest, vid), daemon=True).start()
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                encrypt_file(src, dest, self.dek)
                size = src.stat().st_size
                os.remove(str(src))
                itype = "file"
                ext = src.suffix.lower()
                if ext in IMG_EXT:
                    threading.Thread(target=_make_thumb_from_encrypted, args=(dest, vid, self.dek, False), daemon=True).start()
                elif ext in VID_EXT:
                    threading.Thread(target=_make_thumb_from_encrypted, args=(dest, vid, self.dek, True), daemon=True).start()
            meta["files"][vid] = {
                "original_path": str(src), "original_name": src.name,
                "type": itype, "size": size,
                "locked_at": datetime.now().isoformat(), "ext": src.suffix.lower(),
            }
            save_meta(meta, self.is_decoy, self.dek)
            return True, vid
        except PermissionError: return False, "Permission denied — close the file first"
        except Exception as e:  return False, str(e)

    def lock_item_into(self, src_path, dest_vid, dest_rel):
        """Encrypts a file/folder from disk directly into a folder that's
        already locked inside the vault — same encryption path as
        lock_item(), it just splices the result into that folder's existing
        manifest instead of creating a new top-level vault item."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        try:
            src = Path(src_path)
            if not src.exists(): return False, "Path not found"
            meta = load_meta(self.is_decoy, self.dek)
            if dest_vid not in meta["files"] or meta["files"][dest_vid].get("type") != "folder":
                return False, "Destination is not a folder"

            base_dest = self.vault_dir / dest_vid
            dest_manifest = load_tree_manifest(base_dest, self.dek)
            if dest_manifest is None:
                return False, ("This folder predates the organize feature — "
                                "restore and re-lock it first.")
            dest_parent = manifest_node_at(dest_manifest, dest_rel) if dest_rel else dest_manifest
            if dest_parent is None or dest_parent.get("type") != "dir":
                return False, "Destination not found"

            token = secrets.token_hex(8)
            dest_disk = base_dest / (f"{dest_rel}/{token}" if dest_rel else token)
            dest_disk.parent.mkdir(parents=True, exist_ok=True)

            if src.is_dir():
                encrypt_tree(src, dest_disk, self.dek)
                # encrypt_tree() writes its own standalone _index.enc for
                # this subtree, but nested folders share ONE manifest with
                # their top ancestor — fold the fresh one in and drop it.
                inner_manifest = load_tree_manifest(dest_disk, self.dek) or {"type": "dir", "children": {}}
                new_node = {"type": "dir", "name": src.name, "children": inner_manifest.get("children", {}),
                            "locked_at": datetime.now().isoformat()}
                idx = dest_disk / "_index.enc"
                if idx.exists(): idx.unlink()
                shutil.rmtree(str(src))
            else:
                encrypt_file(src, dest_disk, self.dek)
                new_node = {"type": "file", "name": src.name, "size": src.stat().st_size,
                            "locked_at": datetime.now().isoformat()}
                os.remove(str(src))

            dest_parent.setdefault("children", {})[token] = new_node
            save_tree_manifest(base_dest, dest_manifest, self.dek)
            meta["files"][dest_vid]["size"] = manifest_dir_size(dest_manifest)
            save_meta(meta, self.is_decoy, self.dek)

            # Keep the folder's own card thumbnail fresh (nested items use
            # on-the-fly previews, so no thumbnail work needed for them).
            threading.Thread(target=self._thumb_folder, args=(base_dest, dest_vid), daemon=True).start()

            return True, token
        except PermissionError: return False, "Permission denied — close the file first"
        except Exception as e:  return False, str(e)

    def _thumb_folder(self, encrypted_folder, vid):
        found = self.find_preview(encrypted_folder)
        if not found: return
        kind, enc_fp = found
        _make_thumb_from_encrypted(enc_fp, vid, self.dek, is_video=(kind == "video"))

    def unlock_item(self, vid, restore_path=None):
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]: return False, "Not in vault"
            info = meta["files"][vid]
            if not restore_path and not info.get("original_path"):
                return False, ("This item has no remembered original location "
                                "(it was created or organized inside the vault) — "
                                "use \u201cRestore to folder\u2026\u201d instead.")
            src  = self.vault_dir / vid
            dest = Path(restore_path)/info["original_name"] if restore_path \
                   else Path(info["original_path"])
            if not restore_path: dest.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                if dest.exists(): dest = dest.parent/(dest.name+"_restored")
                decrypt_tree(src, dest, self.dek)
                shutil.rmtree(str(src))
            else:
                if dest.exists(): dest = dest.parent/(dest.stem+"_restored"+dest.suffix)
                decrypt_file(src, dest, self.dek, verify=False)
                src.unlink()
            del meta["files"][vid]; save_meta(meta, self.is_decoy, self.dek)
            t = thumb_dir()/f"{vid}.jpg"
            if t.exists(): t.unlink()
            return True, str(dest)
        except PermissionError: return False, "Permission denied at destination"
        except Exception as e:  return False, str(e)

    def delete_item(self, vid):
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]: return False, "Not found"
            info = meta["files"][vid]
            src  = self.vault_dir / vid
            if src.is_dir(): shutil.rmtree(str(src))
            elif src.exists(): src.unlink()
            t = thumb_dir()/f"{vid}.jpg"
            if t.exists(): t.unlink()
            del meta["files"][vid]; save_meta(meta, self.is_decoy, self.dek)
            return True, info["original_name"]
        except Exception as e: return False, str(e)

    def vault_path(self, vid):
        return self.vault_dir / vid

    # ── Phase 0 foundation: preferences + per-item metadata ────────────────
    def get_pref(self, scope, key, default=None):
        return get_pref(scope, key, default, self.is_decoy, self.dek)

    def set_pref(self, scope, key, value):
        return set_pref(scope, key, value, self.is_decoy, self.dek)

    def get_item_meta(self, vid, rel=None):
        return get_item_meta(self, vid, rel)

    def set_item_meta(self, vid, updates, rel=None):
        return set_item_meta(self, vid, updates, rel)

    def folder_stats(self, vid, rel=None):
        """Recursive size/item-count rollup for a folder at any depth —
        the current folder itself if rel is falsy, or a nested sub-folder
        inside it otherwise. Returns None if the target isn't a folder or
        predates the manifest scheme (legacy vaults without _index.enc)."""
        base = self.vault_path(vid)
        manifest = load_tree_manifest(base, self.dek)
        if manifest is None:
            return None
        node = manifest_node_at(manifest, rel) if rel else manifest
        if node is None or node.get("type") not in ("dir", None):
            return None
        size, files, folders = manifest_dir_stats(node)
        return {"size": size, "size_h": human_size(size), "file_count": files, "folder_count": folders}

    def find_duplicates(self):
        """Content-hash scan across the ENTIRE vault (root files + every
        nested file inside locked folders), grouping files with identical
        DECRYPTED content. Ciphertext alone can't be compared for this —
        every file is encrypted with its own random nonce, so identical
        plaintext produces different bytes on disk — so hashing happens on
        the decrypted content, entirely in memory, never written to disk.
        Groups by size first (cheap) and only decrypts+hashes within a
        matching-size bucket, so unrelated files are never touched. Very
        large files (over DUP_SCAN_MAX_BYTES) are skipped from hashing
        rather than fully decrypted into memory — they're rare duplicate
        candidates anyway and this keeps memory use bounded. Returns only
        groups with 2+ members; never deletes anything itself."""
        entries = []
        meta = load_meta(self.is_decoy, self.dek)
        for vid, entry in meta["files"].items():
            if entry.get("type") == "file":
                entries.append({"vid": vid, "rel": None, "path": [], "name": entry.get("original_name", ""),
                                 "size": entry.get("size", 0)})
            elif entry.get("type") == "folder":
                base = self.vault_path(vid)
                manifest = load_tree_manifest(base, self.dek)
                if manifest is not None:
                    self._collect_files_for_dup_scan(manifest, vid, "", [entry.get("original_name", "")], entries)

        by_size = {}
        for e in entries:
            if e["size"] > 0:
                by_size.setdefault(e["size"], []).append(e)

        DUP_SCAN_MAX_BYTES = 150 * 1024 * 1024  # 150MB — see docstring
        groups = []
        for size, bucket in by_size.items():
            if len(bucket) < 2 or size > DUP_SCAN_MAX_BYTES:
                continue
            by_hash = {}
            for e in bucket:
                fp = self.vault_path(e["vid"]) if e["rel"] is None else (self.vault_path(e["vid"]) / e["rel"])
                try:
                    data = decrypt_to_bytes(fp, self.dek, verify=False)
                except Exception:
                    continue
                h = hashlib.sha256(data).hexdigest()
                by_hash.setdefault(h, []).append(e)
            for h, members in by_hash.items():
                if len(members) >= 2:
                    groups.append(members)
        groups.sort(key=lambda g: g[0]["size"] * len(g), reverse=True)
        return groups

    def _collect_files_for_dup_scan(self, node, vid, rel_prefix, path_names, out):
        for token, child in node.get("children", {}).items():
            rel_path = f"{rel_prefix}/{token}" if rel_prefix else token
            child_path = path_names + [child.get("name", token)]
            if child.get("type") == "file":
                out.append({"vid": vid, "rel": rel_path, "path": child_path[:-1],
                             "name": child.get("name", token), "size": child.get("size", 0)})
            elif child.get("type") == "dir":
                self._collect_files_for_dup_scan(child, vid, rel_path, child_path, out)

    def list_favorites(self):
        """Walks the ENTIRE vault — every root item, then recursively into
        every locked folder's manifest — collecting anything flagged
        favorite=True. Works at any depth by construction: it's just
        reading the same optional field every node already carries."""
        results = []
        meta = load_meta(self.is_decoy, self.dek)
        for vid, entry in meta["files"].items():
            if entry.get("favorite"):
                results.append({"vid": vid, "rel": None, "path": [], "entry": entry})
            if entry.get("type") == "folder":
                base = self.vault_path(vid)
                manifest = load_tree_manifest(base, self.dek)
                if manifest is not None:
                    self._walk_favorites(manifest, vid, "", [entry.get("original_name", "")], results)
        return results

    def _walk_favorites(self, node, vid, rel_prefix, path_names, results):
        for token, child in node.get("children", {}).items():
            rel_path = f"{rel_prefix}/{token}" if rel_prefix else token
            child_path = path_names + [child.get("name", token)]
            if child.get("favorite"):
                results.append({"vid": vid, "rel": rel_path, "path": child_path[:-1], "entry": child})
            if child.get("type") == "dir":
                self._walk_favorites(child, vid, rel_path, child_path, results)

    def list_album_items(self, album_vid):
        """Walks the ENTIRE vault — same shape as list_favorites — collecting
        anything whose album_ids includes album_vid. Membership is a pure
        reference (a vid/rel pointer stored on the item itself), so items
        keep living wherever they already are; an album is just a
        hand-picked view over the vault, not a second copy of anything."""
        results = []
        meta = load_meta(self.is_decoy, self.dek)
        for vid, entry in meta["files"].items():
            if album_vid in (entry.get("album_ids") or []):
                results.append({"vid": vid, "rel": None, "path": [], "entry": entry})
            if entry.get("type") == "folder":
                base = self.vault_path(vid)
                manifest = load_tree_manifest(base, self.dek)
                if manifest is not None:
                    self._walk_album_items(manifest, vid, album_vid, "", [entry.get("original_name", "")], results)
        return results

    def _walk_album_items(self, node, vid, album_vid, rel_prefix, path_names, results):
        for token, child in node.get("children", {}).items():
            rel_path = f"{rel_prefix}/{token}" if rel_prefix else token
            child_path = path_names + [child.get("name", token)]
            if album_vid in (child.get("album_ids") or []):
                results.append({"vid": vid, "rel": rel_path, "path": child_path[:-1], "entry": child})
            if child.get("type") == "dir":
                self._walk_album_items(child, vid, album_vid, rel_path, child_path, results)

    def clear_album_membership(self, album_vid):
        """Strips album_vid from every item that currently references it —
        used when an album is removed from Albums (un-flagged), so member
        items don't keep a dangling pointer to a folder that no longer
        curates them. Never touches the member files/folders themselves."""
        for r in self.list_album_items(album_vid):
            ids = [a for a in (r["entry"].get("album_ids") or []) if a != album_vid]
            self.set_item_meta(r["vid"], {"album_ids": ids}, r["rel"])
        return True

    # ── Face Groups — "same face, everywhere" auto-collections ─────────────
    # A face group IS an album under the hood (metadata.is_album = True,
    # same reference-only membership via album_ids), plus metadata.
    # is_face_group = True so the UI can list it separately and so a
    # rescan can find and update it again later instead of creating a
    # duplicate group each time. Nothing is ever moved, copied, or
    # re-uploaded — scanning only reads photos to compute embeddings and
    # writes album_ids, exactly like adding something to a hand-picked
    # album.
    #
    # Every Face Group also carries metadata.face_group_container — the
    # vid of the container folder it was created under (see
    # create_face_group_container below). Matching against "existing
    # groups" during a scan is always scoped to one container's groups,
    # never the whole vault, so two unrelated scans (e.g. one folder of
    # family photos, one folder of coworkers) can never merge into each
    # other's groups just because they happen to share the vault. Each
    # container is a fully isolated batch of results.
    def list_face_groups(self, container_vid=None):
        meta = load_meta(self.is_decoy, self.dek)
        out = []
        for vid, entry in meta["files"].items():
            if entry.get("type") != "folder":
                continue
            m = entry.get("metadata") or {}
            if not m.get("is_face_group"):
                continue
            if container_vid is not None and m.get("face_group_container") != container_vid:
                continue
            out.append((vid, entry))
        return out

    def delete_all_face_groups(self, container_vid=None):
        """Deletes every existing Face Group album at once (or, with
        container_vid, just the ones inside that one container) — same
        per-group effect as deleting one at a time (strip the dangling
        album_ids pointer from every member first, then remove the
        group folder itself), just batched. Only the auto-generated
        group containers are removed; every real photo they referenced
        stays exactly where it already lives in the vault, untouched.
        Returns (deleted_count, errors)."""
        deleted, errors = 0, []
        for vid, entry in self.list_face_groups(container_vid):
            name = entry.get("original_name", vid)
            self.clear_album_membership(vid)
            ok, err = self.delete_item(vid)
            if ok:
                deleted += 1
            else:
                errors.append(f"{name}: {err}")
        return deleted, errors

    # ── Face Group Containers — one isolated "batch" per scan run ──────────
    # A container is a plain vault folder (own vid, created the same way
    # as any organizational folder) flagged metadata.is_face_group_container
    # so the Face Groups dashboard can list containers instead of a flat
    # pool of Person-N groups. It starts out empty; running a scan from
    # inside it fills it with that scan's Person-N groups. Running another
    # scan from inside a DIFFERENT container never touches this one's
    # groups — that separation is the entire point (see list_face_groups
    # above for how matching stays container-scoped).
    def create_face_group_container(self, name):
        ok, res = self.create_folder(name)
        if not ok:
            return ok, res
        vid = res
        ok2, err2 = self.set_item_meta(vid, {"metadata": {"is_face_group_container": True}})
        if not ok2:
            # Folder exists but couldn't be flagged — surface the error
            # rather than silently leaving an unflagged folder behind.
            return False, err2
        return True, vid

    def list_face_group_containers(self):
        meta = load_meta(self.is_decoy, self.dek)
        return [(vid, entry) for vid, entry in meta["files"].items()
                if entry.get("type") == "folder" and (entry.get("metadata") or {}).get("is_face_group_container")]

    def delete_all_face_group_containers(self):
        """Deletes every container AND every Person-N group nested inside
        each one (cascading) — same real-photos-untouched guarantee as
        delete_all_face_groups. Returns (deleted_count, errors), where
        deleted_count counts containers (not their nested groups)."""
        deleted, errors = 0, []
        for vid, entry in self.list_face_group_containers():
            name = entry.get("original_name", vid)
            _, sub_errors = self.delete_all_face_groups(container_vid=vid)
            errors.extend(sub_errors)
            ok, err = self.delete_item(vid)
            if ok:
                deleted += 1
            else:
                errors.append(f"{name}: {err}")
        return deleted, errors

    def list_face_scan_targets(self):
        """Folders the person can point a face scan at — used by the 'Scan
        for faces' folder picker so a scan can be limited to one folder
        instead of always walking the whole vault (fewer, more visually
        similar photos per scan means far less chance of two different
        people's embeddings ever landing close enough to be confused,
        and it's much faster on a large vault). Leads with an 'Entire
        Vault' option that reproduces the original whole-vault behavior.
        Albums, existing Face Groups, and Face Group Containers are all
        excluded — they're reference-only (or, for a fresh container,
        simply empty) with no photos of their own to walk; the real
        images already live in whichever real folder this list offers,
        so 'scanning' one would just find nothing."""
        if not self.dek:
            return []
        meta = load_meta(self.is_decoy, self.dek)
        out = [{"vid": None, "rel": None, "label": "Entire Vault"}]
        for vid, info in meta["files"].items():
            if info.get("type") != "folder":
                continue
            m = info.get("metadata") or {}
            if m.get("is_album") or m.get("is_face_group_container"):
                continue
            out.append({"vid": vid, "rel": None, "label": info["original_name"]})
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                continue

            def walk(node, rel, path_label):
                children = sorted(node.get("children", {}).items(),
                                   key=lambda kv: kv[1].get("name", "").lower())
                for token, child in children:
                    if child.get("type") != "dir":
                        continue
                    child_rel = f"{rel}/{token}" if rel else token
                    child_label = f"{path_label} / {child.get('name', token)}"
                    out.append({"vid": vid, "rel": child_rel, "label": child_label})
                    walk(child, child_rel, child_label)

            walk(manifest, "", info["original_name"])
        return out

    def start_face_scan(self, scope_vid=None, scope_rel=None, threshold=None, container_vid=None):
        if not self.dek:
            return {"ok": False, "error": "Vault is locked"}
        if not container_vid:
            return {"ok": False, "error": "Open (or create) a Face Group folder first, then scan from inside it"}
        if not CV2_OK:
            return {"ok": False, "error": "Face grouping needs OpenCV, which isn't installed"}
        if not NUMPY_OK:
            return {"ok": False, "error": "Face grouping needs NumPy, which isn't installed"}
        job_id = _job_new("face_scan", total=0)
        t = threading.Thread(target=self._run_face_scan, args=(job_id, scope_vid, scope_rel, threshold, container_vid), daemon=True)
        t.start()
        return {"ok": True, "job_id": job_id}

    def _collect_images(self, node, vid, rel_prefix, path_names, out):
        for token, child in node.get("children", {}).items():
            rel_path = f"{rel_prefix}/{token}" if rel_prefix else token
            child_path = path_names + [child.get("name", token)]
            if child.get("type") == "file" and file_cat(child.get("name", "")) == "image":
                out.append({"vid": vid, "rel": rel_path, "path": child_path[:-1], "name": child.get("name", token)})
            elif child.get("type") == "dir":
                self._collect_images(child, vid, rel_path, child_path, out)

    def _run_face_scan(self, job_id, scope_vid=None, scope_rel=None, threshold=None, container_vid=None):
        # A person can override the default cutoff from the scan picker
        # (see FACE_MATCH_THRESHOLD's own comment for why 0.404 is the
        # baseline) — pushing it higher demands closer matches, which
        # trades away a bit of recall for fewer different-people-merged
        # mistakes on vaults with lookalike faces or trickier lighting.
        match_threshold = FACE_MATCH_THRESHOLD if not threshold else float(threshold)
        try:
            _job_update(job_id, message="Setting up face recognition\u2026")
            _get_face_engines(job_id)
        except Exception as e:
            _job_update(job_id, status="error", error=str(e))
            return
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if container_vid and meta["files"].get(container_vid) is None:
                _job_update(job_id, status="error", error="That Face Group folder no longer exists")
                return
            images = []
            if scope_vid is None:
                # Full-vault scan — every standalone image plus every
                # image inside every locked folder, same as before.
                for vid, entry in meta["files"].items():
                    if entry.get("type") == "file" and file_cat(entry.get("original_name", "")) == "image":
                        images.append({"vid": vid, "rel": None, "path": [], "name": entry.get("original_name", "")})
                    elif entry.get("type") == "folder":
                        base = self.vault_path(vid)
                        manifest = load_tree_manifest(base, self.dek)
                        if manifest is not None:
                            self._collect_images(manifest, vid, "", [entry.get("original_name", "")], images)
            else:
                # Scoped scan — only the one folder (and its subfolders)
                # the person picked. Keeps each scan's photo set small and
                # visually coherent, which is the whole point: fewer,
                # more-related photos per run means far less chance of
                # two different people's faces ever landing close enough
                # in embedding space to be mistaken for one another.
                entry = meta["files"].get(scope_vid)
                if entry is None or entry.get("type") != "folder":
                    _job_update(job_id, status="error", error="That folder no longer exists")
                    return
                base = self.vault_path(scope_vid)
                manifest = load_tree_manifest(base, self.dek)
                if manifest is None:
                    _job_update(job_id, status="error",
                                 error="This folder predates the organize feature \u2014 restore and re-lock it first.")
                    return
                start_node = manifest_node_at(manifest, scope_rel) if scope_rel else manifest
                if start_node is None or start_node.get("type") != "dir":
                    _job_update(job_id, status="error", error="That folder was not found")
                    return
                self._collect_images(start_node, scope_vid, scope_rel or "", [entry.get("original_name", "")], images)

            _job_update(job_id, total=max(1, len(images)), message=f"Scanning {len(images)} photo(s) for faces\u2026")

            faces = []
            for i, im in enumerate(images):
                if _job_cancel_requested(job_id):
                    _job_update(job_id, status="cancelled")
                    return
                fp = self.vault_path(im["vid"]) if im["rel"] is None else (self.vault_path(im["vid"]) / im["rel"])
                try:
                    raw = decrypt_to_bytes(fp, self.dek, verify=False)
                    embs = _detect_face_embeddings(raw)
                except Exception:
                    embs = []
                for e in embs:
                    faces.append({**im, "emb": e})
                _job_update(job_id, done=i + 1, message=f"Scanning photos for faces\u2026 ({i + 1}/{len(images)})")

            if not faces:
                _job_update(job_id, status="done",
                             result={"groups_created": 0, "groups_updated": 0, "faces_found": 0, "photos_scanned": len(images)})
                return

            _job_update(job_id, message="Grouping matching faces\u2026")
            raw_clusters = _cluster_faces(faces, match_threshold)

            cluster_list = []
            for members in raw_clusters:
                distinct_photos = {(m["vid"], m["rel"]) for m in members}
                # Only surface a group once the same face shows up in 2+
                # different photos — that's the whole point of the
                # feature ("route this person's photos together"); a
                # single photo with one face isn't a group of anything.
                if len(distinct_photos) >= 2:
                    centroid = np.mean(np.stack([m["emb"] for m in members]), axis=0)
                    cluster_list.append({"members": members, "centroid": centroid, "photo_count": len(distinct_photos)})
            cluster_list.sort(key=lambda c: -c["photo_count"])

            _job_update(job_id, message="Updating Face Groups\u2026")
            created, updated = self._reconcile_face_groups(cluster_list, match_threshold, container_vid)

            _job_update(job_id, status="done", result={
                "groups_created": created, "groups_updated": updated,
                "faces_found": len(faces), "photos_scanned": len(images),
            })
        except Exception as e:
            _job_update(job_id, status="error", error=str(e))

    def _reconcile_face_groups(self, cluster_list, threshold=FACE_MATCH_THRESHOLD, container_vid=None):
        """Matches each newly-found cluster against existing Face Group
        albums within the same container (by comparing face centroids) so
        re-running a scan updates the same groups instead of creating
        duplicates every time — any pin/rename/custom thumbnail the
        person already set stays put. Never matches against another
        container's groups, so different scans stay fully isolated from
        each other. New people get a fresh, empty-named group, created
        (and tagged) inside container_vid. Returns (created, updated)."""
        existing = self.list_face_groups(container_vid)  # [(vid, entry), ...] — scoped to this container only
        existing_centroids = []
        for vid, entry in existing:
            c = (entry.get("metadata") or {}).get("face_centroid")
            if c:
                existing_centroids.append((vid, np.asarray(c, dtype="float32")))

        created, updated = 0, 0
        used_group_names = {e.get("original_name", "") for _, e in existing}
        next_person_num = len(existing) + 1

        for cluster in cluster_list:
            centroid = cluster["centroid"]
            match_vid = None
            best_sim = threshold
            for vid, ex_centroid in existing_centroids:
                sim = _cosine_sim(centroid, ex_centroid)
                if sim >= best_sim:
                    best_sim, match_vid = sim, vid

            if match_vid is None:
                name = f"Person {next_person_num}"
                while name in used_group_names:
                    next_person_num += 1
                    name = f"Person {next_person_num}"
                used_group_names.add(name)
                next_person_num += 1
                ok, group_vid = self.create_folder(name)
                if not ok:
                    continue
                self.set_item_meta(group_vid, {"metadata": {
                    "is_album": True, "is_face_group": True,
                    "face_group_container": container_vid,
                    "face_centroid": centroid.tolist(), "auto_named": True,
                }})
                created += 1
            else:
                group_vid = match_vid
                meta = self.get_item_meta(group_vid)
                merged_meta = dict(meta.get("metadata") or {})
                merged_meta["face_centroid"] = centroid.tolist()
                self.set_item_meta(group_vid, {"metadata": merged_meta})
                updated += 1

            # Membership: make sure every photo carrying this face
            # references the group, without disturbing any of the
            # group's OTHER references (e.g. if it was also matched from
            # a different cluster's photo, which shouldn't happen but
            # costs nothing to be defensive about).
            wanted = {(m["vid"], m["rel"]) for m in cluster["members"]}
            for vid, rel in wanted:
                cur = self.get_item_meta(vid, rel)
                ids = list(cur.get("album_ids") or [])
                if group_vid not in ids:
                    ids.append(group_vid)
                    self.set_item_meta(vid, {"album_ids": ids}, rel)

            try:
                self.generate_collage_thumbnail(group_vid)
            except Exception:
                pass

        return created, updated

    def list_recent(self, limit=12):
        """Same whole-vault walk as list_favorites, but collecting anything
        with a metadata.last_opened timestamp (written by record_opened(),
        itself gated on the Privacy > history toggle) — so when history is
        off, this naturally stays empty rather than needing its own gate."""
        results = []
        meta = load_meta(self.is_decoy, self.dek)
        for vid, entry in meta["files"].items():
            ts = entry.get("metadata", {}).get("last_opened")
            if ts:
                results.append({"vid": vid, "rel": None, "path": [], "entry": entry, "last_opened": ts})
            if entry.get("type") == "folder":
                base = self.vault_path(vid)
                manifest = load_tree_manifest(base, self.dek)
                if manifest is not None:
                    self._walk_recent(manifest, vid, "", [entry.get("original_name", "")], results)
        results.sort(key=lambda r: r["last_opened"], reverse=True)
        return results[:limit]

    def _walk_recent(self, node, vid, rel_prefix, path_names, results):
        for token, child in node.get("children", {}).items():
            rel_path = f"{rel_prefix}/{token}" if rel_prefix else token
            child_path = path_names + [child.get("name", token)]
            ts = child.get("metadata", {}).get("last_opened")
            if ts:
                results.append({"vid": vid, "rel": rel_path, "path": child_path[:-1], "entry": child, "last_opened": ts})
            if child.get("type") == "dir":
                self._walk_recent(child, vid, rel_path, child_path, results)

    # ── appearance: use an existing vault image as the app background ──────
    def background_from_vault_item(self, vid, rel=None):
        """Decrypts an image that's already in the vault and copies the
        plain bytes into the cosmetic background folder, so people can pick
        one of their own vault photos as wallpaper without exporting it
        first. The vault's encrypted copy is left completely untouched."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]:
                return False, "Not found"
            if rel:
                base = self.vault_dir / vid
                manifest = load_tree_manifest(base, self.dek)
                if manifest is None:
                    return False, "This folder predates that feature — restore and re-lock it first."
                parent, last, node = self._locate_nested(manifest, rel)
                if node is None or node.get("type") != "file":
                    return False, "Not a file"
                name = node.get("name") or last
                enc_path = base / rel
            else:
                info = meta["files"][vid]
                if info["type"] != "file":
                    return False, "Not a file"
                name = info["original_name"]
                enc_path = self.vault_dir / vid

            ext = Path(name).suffix.lower()
            if ext not in (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"):
                return False, "Choose an image file"

            dest_dir = ui_bg_dir(self.is_decoy)
            dest_dir.mkdir(parents=True, exist_ok=True)
            for old in dest_dir.glob("bg.*"):
                try: old.unlink()
                except Exception: pass
            dest = dest_dir / f"bg{ext}"
            decrypt_file(enc_path, dest, self.dek, verify=False)
            return True, dest.name
        except Exception as e:
            return False, str(e)

    # ── per-item restore / delete inside a locked folder ───────────────────
    def _collect_vault_images(self, limit_pool=40):
        """Walks the whole vault (root files + everything nested inside
        locked folders) collecting up to `limit_pool` image/video
        candidates — the sampling pool for the dynamic background."""
        results = []
        meta = load_meta(self.is_decoy, self.dek)
        for vid, entry in meta["files"].items():
            if len(results) >= limit_pool:
                break
            if entry.get("type") == "file":
                ext = entry.get("ext", "")
                if ext in IMG_EXT:
                    results.append(("image", self.vault_dir / vid))
                elif ext in VID_EXT:
                    results.append(("video", self.vault_dir / vid))
            elif entry.get("type") == "folder":
                base = self.vault_dir / vid
                results.extend(self.find_preview_multi(base, "", limit=limit_pool - len(results)))
        return results

    def generate_dynamic_background(self):
        """Dynamic Content-Based Background: auto-composites a wallpaper
        from up to 6 randomly-sampled photos/frames already in the vault —
        generated fully in memory and saved encrypted (see dynbg_file),
        never as a plaintext derived file, since this is bulk/automatic
        sampling rather than one photo the person explicitly picked."""
        if not PIL_OK:
            return False, "Image support isn't available"
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        pool = self._collect_vault_images(limit_pool=40)
        if not pool:
            return False, "No photos or videos in the vault yet"
        random.shuffle(pool)
        chosen = pool[:6]
        tiles = []
        for kind, fp in chosen:
            img = self._pil_image_from_encrypted(fp, is_video=(kind == "video"))
            if img:
                tiles.append(img)
        if not tiles:
            return False, "Couldn't read any of the sampled photos"

        mosaic = self._build_mosaic_background(tiles, size=(1600, 1000))
        buf = io.BytesIO()
        mosaic.save(buf, "JPEG", quality=87)
        enc = encrypt_bytes(buf.getvalue(), self.dek)
        dynbg_file(self.is_decoy).write_bytes(enc)
        return True, None

    @staticmethod
    def _build_mosaic_background(tiles, size=(1600, 1000)):
        """Tiles N photos across a wide canvas (roughly even columns, last
        column absorbing any remainder) and applies a soft blur + gentle
        darkening so foreground UI text stays legible over it, the way a
        deliberately-designed wallpaper would be softened."""
        w, h = size
        n = max(1, len(tiles))
        cols = min(n, 4) or 1
        col_w = w // cols
        canvas = Image.new("RGB", (w, h), (20, 20, 24))
        for i, img in enumerate(tiles[:cols]):
            cw = col_w if i < cols - 1 else (w - col_w * (cols - 1))
            iw, ih = img.size
            scale = max(cw / iw, h / ih)
            resized = img.resize((max(1, round(iw * scale)), max(1, round(ih * scale))), Image.LANCZOS)
            rw, rh = resized.size
            left, top = (rw - cw) // 2, (rh - h) // 2
            cropped = resized.crop((left, top, left + cw, top + h))
            canvas.paste(cropped, (i * col_w, 0))
        canvas = canvas.filter(ImageFilter.GaussianBlur(radius=14))
        overlay = Image.new("RGB", (w, h), (10, 10, 14))
        canvas = Image.blend(canvas, overlay, 0.35)
        return canvas

    def _locate_nested(self, manifest, rel):
        """Returns (parent_node, last_token, node) for a '/'-joined token
        path, or (None, None, None) if any segment doesn't resolve."""
        tokens = rel.split("/")
        parent = manifest
        for t in tokens[:-1]:
            parent = (parent or {}).get("children", {}).get(t)
            if parent is None:
                return None, None, None
        last = tokens[-1]
        node = (parent or {}).get("children", {}).get(last)
        if node is None:
            return None, None, None
        return parent, last, node

    def unlock_nested_item(self, vid, rel, restore_path=None):
        """Restores a single file (or sub-folder) from inside an already
        locked folder — without touching anything else in that folder."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        if not rel:
            return False, "No item specified"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]:
                return False, "Not in vault"
            info = meta["files"][vid]
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                return False, ("This folder was locked before per-item restore existed — "
                                "restore the whole folder and re-lock it to enable this.")
            parent, last, node = self._locate_nested(manifest, rel)
            if node is None:
                return False, "Item not found"

            real_names = manifest_real_names_path(manifest, rel.split("/"))
            if restore_path:
                dest = Path(restore_path) / (node.get("name") or last)
            elif info.get("original_path"):
                dest = Path(info["original_path"]).joinpath(*real_names) if real_names \
                       else Path(info["original_path"]) / (node.get("name") or last)
            else:
                return False, ("This folder has no remembered original location — "
                                "use \u201cRestore to folder\u2026\u201d instead.")

            dest.parent.mkdir(parents=True, exist_ok=True)
            enc_target = base / rel
            if node["type"] == "dir":
                if dest.exists(): dest = dest.parent / (dest.name + "_restored")
                _decrypt_dir_recursive(enc_target, dest, node, self.dek)
                shutil.rmtree(str(enc_target))
            else:
                if dest.exists(): dest = dest.parent / (dest.stem + "_restored" + dest.suffix)
                decrypt_file(enc_target, dest, self.dek, verify=False)
                enc_target.unlink()

            del parent["children"][last]
            save_tree_manifest(base, manifest, self.dek)
            info["size"] = manifest_dir_size(manifest)
            save_meta(meta, self.is_decoy, self.dek)
            return True, str(dest)
        except PermissionError:
            return False, "Permission denied at destination"
        except Exception as e:
            return False, str(e)

    def delete_nested_item(self, vid, rel):
        """Permanently deletes a single file (or sub-folder) from inside an
        already locked folder."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        if not rel:
            return False, "No item specified"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]:
                return False, "Not found"
            info = meta["files"][vid]
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                return False, ("This folder was locked before per-item delete existed — "
                                "restore the whole folder and re-lock it to enable this.")
            parent, last, node = self._locate_nested(manifest, rel)
            if node is None:
                return False, "Item not found"

            target = base / rel
            if node["type"] == "dir":
                if target.exists(): shutil.rmtree(str(target))
            elif target.exists():
                target.unlink()

            name = node.get("name") or last
            del parent["children"][last]
            save_tree_manifest(base, manifest, self.dek)
            info["size"] = manifest_dir_size(manifest)
            save_meta(meta, self.is_decoy, self.dek)
            return True, name
        except Exception as e:
            return False, str(e)

    # ── rename ───────────────────────────────────────────────────────────
    def rename_item(self, vid, new_name):
        """Renames a root-level vault item. Only the display name changes —
        the encrypted bytes stay exactly where they are on disk."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        new_name = (new_name or "").strip()
        if not new_name:
            return False, "Enter a name"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]:
                return False, "Not found"
            info = meta["files"][vid]
            info["original_name"] = new_name
            if info.get("type") == "file":
                info["ext"] = Path(new_name).suffix.lower()
            save_meta(meta, self.is_decoy, self.dek)
            return True, new_name
        except Exception as e:
            return False, str(e)

    def rename_nested_item(self, vid, rel, new_name):
        """Renames a file/sub-folder living inside an already locked folder."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        new_name = (new_name or "").strip()
        if not new_name:
            return False, "Enter a name"
        if not rel:
            return False, "No item specified"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]:
                return False, "Not found"
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                return False, ("This folder predates the rename feature — "
                                "restore and re-lock it first.")
            parent, last, node = self._locate_nested(manifest, rel)
            if node is None:
                return False, "Item not found"
            node["name"] = new_name
            save_tree_manifest(base, manifest, self.dek)
            return True, new_name
        except Exception as e:
            return False, str(e)

    # ── custom folder thumbnail ─────────────────────────────────────────────
    def find_preview_multi(self, base_folder, rel="", limit=4):
        """Like find_preview, but collects up to `limit` distinct image/
        video candidates instead of stopping at the first — used to build
        a Smart Thumbnail collage from multiple sources inside the folder
        rather than a single picked/auto-found image."""
        manifest = load_tree_manifest(base_folder, self.dek)
        if manifest is None:
            return []
        node = manifest_node_at(manifest, rel)
        if node is None or node.get("type") != "dir":
            return []
        start_path = (Path(base_folder) / rel) if rel else Path(base_folder)
        results = []

        def walk(node, base):
            if len(results) >= limit:
                return
            files, dirs = [], []
            for token, child in node.get("children", {}).items():
                (files if child["type"] == "file" else dirs).append((token, child))
            files.sort(key=lambda tc: tc[1].get("name", "").lower())
            for token, child in files:
                if len(results) >= limit:
                    return
                ext = Path(child.get("name", "")).suffix.lower()
                if ext in IMG_EXT:
                    results.append(("image", base / token))
                elif ext in VID_EXT:
                    results.append(("video", base / token))
            dirs.sort(key=lambda tc: tc[1].get("name", "").lower())
            for token, child in dirs:
                if len(results) >= limit:
                    return
                walk(child, base / token)

        walk(node, start_path)
        return results

    def find_album_preview_multi(self, album_vid, limit=4):
        """Same job as find_preview_multi(), but for an ALBUM: an album's
        own physical folder has no real files inside it (membership is a
        pure vid/rel reference living on each item elsewhere in the
        vault — see list_album_items()), so a physical-subtree scan would
        always come back empty. This instead resolves up to `limit` of the
        album's actual member files to real encrypted paths, in the same
        order list_album_items() returns them."""
        results = []
        for ref in self.list_album_items(album_vid):
            if len(results) >= limit:
                break
            entry = ref["entry"]
            if entry.get("type") != "file":
                continue
            name = entry.get("name") or entry.get("original_name") or ""
            ext = Path(name).suffix.lower()
            if ext in IMG_EXT:
                kind = "image"
            elif ext in VID_EXT:
                kind = "video"
            else:
                continue
            base = self.vault_path(ref["vid"]).resolve()
            fp = (base / ref["rel"]).resolve() if ref["rel"] else base
            if not fp.exists():
                continue
            results.append((kind, fp))
        return results

    def _pil_image_from_encrypted(self, enc_fp, is_video):
        """Decrypts a single image, or grabs one frame of a video, straight
        into memory as a PIL Image — never writes plaintext to disk. Shared
        by the collage builder and dynamic-background generator."""
        if not PIL_OK:
            return None
        try:
            if not is_video:
                data = decrypt_to_bytes(enc_fp, self.dek, verify=False)
                return Image.open(io.BytesIO(data)).convert("RGB")
            if not CV2_OK:
                return None
            import tempfile
            suffix = Path(enc_fp).suffix or ".mp4"
            fd, tmp_path = tempfile.mkstemp(suffix=suffix, dir=str(temp_dir()))
            os.close(fd)
            try:
                decrypt_file(enc_fp, tmp_path, self.dek, verify=False)
                cap = cv2.VideoCapture(tmp_path)
                total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(total * 0.1)))
                ret, frame = cap.read()
                cap.release()
                if not ret:
                    return None
                return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            finally:
                try: os.remove(tmp_path)
                except Exception: pass
        except Exception:
            return None

    @staticmethod
    def _build_collage_image(tiles, size=640):
        """Arranges 1-4 source images into a single square collage: one tile
        fills the whole frame, two sit side by side, three are one-big-two-
        small, four form a 2x2 grid. Each source is center-cropped to fit
        its cell without distortion, matching how a real photo collage app
        would frame mismatched aspect ratios."""
        def cover_crop(img, w, h):
            iw, ih = img.size
            scale = max(w / iw, h / ih)
            img = img.resize((max(1, round(iw * scale)), max(1, round(ih * scale))), Image.LANCZOS)
            iw, ih = img.size
            left, top = (iw - w) // 2, (ih - h) // 2
            return img.crop((left, top, left + w, top + h))

        canvas = Image.new("RGB", (size, size), (30, 30, 34))
        n = len(tiles)
        if n == 1:
            canvas.paste(cover_crop(tiles[0], size, size), (0, 0))
        elif n == 2:
            half = size // 2
            canvas.paste(cover_crop(tiles[0], half, size), (0, 0))
            canvas.paste(cover_crop(tiles[1], size - half, size), (half, 0))
        elif n == 3:
            half = size // 2
            canvas.paste(cover_crop(tiles[0], size, half), (0, 0))
            canvas.paste(cover_crop(tiles[1], half, size - half), (0, half))
            canvas.paste(cover_crop(tiles[2], size - half, size - half), (half, half))
        else:
            half = size // 2
            canvas.paste(cover_crop(tiles[0], half, half), (0, 0))
            canvas.paste(cover_crop(tiles[1], size - half, half), (half, 0))
            canvas.paste(cover_crop(tiles[2], half, size - half), (0, half))
            canvas.paste(cover_crop(tiles[3], size - half, size - half), (half, half))
        return canvas

    def generate_collage_thumbnail(self, vid, folder_rel=None):
        """Smart Thumbnail: builds a collage from up to 4 images/video
        frames found inside the folder (searched depth-first, same order
        as the automatic single-image preview), generated fully in memory
        and saved encrypted — same protection tier as any other thumbnail,
        via the exact cache files/flags the manual crop picker already
        uses, so no media_server changes are needed to serve it."""
        if not PIL_OK:
            return False, "Image support isn't available"
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        meta = load_meta(self.is_decoy, self.dek)
        if vid not in meta["files"] or meta["files"][vid].get("type") != "folder":
            return False, "Not a folder"
        base = self.vault_dir / vid
        manifest = load_tree_manifest(base, self.dek)
        if manifest is None:
            return False, "This folder predates that feature — restore and re-lock it first."
        target_node = manifest_node_at(manifest, folder_rel) if folder_rel else manifest
        if target_node is None or target_node.get("type") != "dir":
            return False, "Folder not found"

        start_path = (base / folder_rel) if folder_rel else base
        is_album = (not folder_rel) and bool((meta["files"][vid].get("metadata") or {}).get("is_album"))
        candidates = (
            self.find_album_preview_multi(vid, limit=4) if is_album
            else self.find_preview_multi(base, folder_rel or "", limit=4)
        )
        if not candidates:
            return False, ("No images collected in this album yet" if is_album
                            else "No images found inside this folder")

        tiles = []
        for kind, fp in candidates:
            img = self._pil_image_from_encrypted(fp, is_video=(kind == "video"))
            if img:
                tiles.append(img)
        if not tiles:
            return False, "Couldn't read any candidate images"

        collage = self._build_collage_image(tiles)
        buf = io.BytesIO()
        collage.save(buf, "JPEG", quality=90)
        enc = encrypt_bytes(buf.getvalue(), self.dek)

        if not folder_rel:
            (thumb_dir() / f"{vid}.jpg").write_bytes(enc)
        else:
            _nested_thumb_cache_path(vid, folder_rel).write_bytes(enc)
        target_node.pop("thumb_rel", None)
        target_node["thumb_custom"] = True
        target_node["thumb_collage"] = True  # informational only, so Customize can show "collage" as the current mode
        save_tree_manifest(base, manifest, self.dek)
        return True, None

    def set_folder_thumbnail(self, vid, folder_rel, file_rel):
        """Sets a custom thumbnail for a folder inside the vault — either
        the top-level vault item itself (folder_rel empty) or any nested
        child folder within it (folder_rel = that folder's own path).
        `file_rel` is the chosen image/video's path, both measured from
        this vault item's root. The choice is remembered in the folder's
        manifest, so it keeps showing even after the vault is re-opened,
        and it always wins over the automatic "first image found" scan."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        if not file_rel:
            return False, "Choose a file inside the folder"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"] or meta["files"][vid].get("type") != "folder":
                return False, "Not a folder"
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                return False, "This folder predates that feature — restore and re-lock it first."

            target_node = manifest_node_at(manifest, folder_rel) if folder_rel else manifest
            if target_node is None or target_node.get("type") != "dir":
                return False, "Folder not found"

            # The chosen file must actually live inside the target folder.
            if folder_rel:
                if file_rel == folder_rel or not file_rel.startswith(folder_rel + "/"):
                    return False, "That file isn't inside this folder"
                relative = file_rel[len(folder_rel) + 1:]
            else:
                relative = file_rel

            file_node = manifest_node_at(target_node, relative)
            if file_node is None or file_node.get("type") != "file":
                return False, "Choose an image or video file"
            name = file_node.get("name") or relative.rsplit("/", 1)[-1]
            ext = Path(name).suffix.lower()
            if ext not in IMG_EXT and ext not in VID_EXT:
                return False, "Choose an image or video file"

            target_node["thumb_rel"] = relative
            # A plain file-based thumbnail always replaces any previous
            # custom crop, so the two mechanisms never disagree about which
            # one is currently in effect.
            target_node.pop("thumb_custom", None)
            save_tree_manifest(base, manifest, self.dek)
            if folder_rel:
                cache = _nested_thumb_cache_path(vid, folder_rel)
                if cache.exists():
                    try: cache.unlink()
                    except Exception: pass

            if not folder_rel:
                # Root of this vault item — also refresh the cached, fast
                # thumbnail used by /thumb/<vid> so it updates immediately.
                _make_thumb_from_encrypted(base / relative, vid, self.dek, is_video=(ext in VID_EXT))

            return True, vid
        except Exception as e:
            return False, str(e)

    def set_folder_thumbnail_from_crop(self, vid, folder_rel, data_url):
        """Same effect as set_folder_thumbnail(), but the source is an
        already positioned/zoomed image — a data URL from the same in-app
        editor used for the app background — rather than picking an
        existing file from inside the folder outright. Used for fitting a
        chosen photo to the tile before it's applied, and for reusing a
        folder's own custom background as its thumbnail."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        if not data_url or "," not in data_url:
            return False, "No image data received"
        if not PIL_OK:
            return False, "Image support isn't available"
        try:
            _, b64data = data_url.split(",", 1)
            raw = base64.b64decode(b64data)
            if len(raw) < 100:
                return False, "Edited image looked empty"
        except Exception as e:
            return False, str(e)
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"] or meta["files"][vid].get("type") != "folder":
                return False, "Not a folder"
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                return False, "This folder predates that feature — restore and re-lock it first."

            target_node = manifest_node_at(manifest, folder_rel) if folder_rel else manifest
            if target_node is None or target_node.get("type") != "dir":
                return False, "Folder not found"

            img = Image.open(io.BytesIO(raw))
            img.thumbnail((960, 960), Image.LANCZOS)
            buf = io.BytesIO()
            img.convert("RGB").save(buf, "JPEG", quality=93)
            jpeg_bytes = buf.getvalue()
            enc = encrypt_bytes(jpeg_bytes, self.dek)

            if not folder_rel:
                (thumb_dir() / f"{vid}.jpg").write_bytes(enc)
            else:
                _nested_thumb_cache_path(vid, folder_rel).write_bytes(enc)

            target_node.pop("thumb_rel", None)
            target_node["thumb_custom"] = True
            save_tree_manifest(base, manifest, self.dek)
            return True, vid
        except Exception as e:
            return False, str(e)

    def get_custom_folder_thumb(self, vid, folder_rel):
        """Decrypted JPEG bytes for a nested folder's custom cropped
        thumbnail (set via set_folder_thumbnail_from_crop), if any — else
        None. The media server checks this ahead of the automatic "first
        image found" preview. Root-level items need no equivalent here:
        they're served straight from /thumb/<vid>, which already reads the
        exact same cache file this writes."""
        if not self.dek or not folder_rel:
            return None
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"] or meta["files"][vid].get("type") != "folder":
                return None
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                return None
            node = manifest_node_at(manifest, folder_rel)
            if node is None or not node.get("thumb_custom"):
                return None
            p = _nested_thumb_cache_path(vid, folder_rel)
            if not p.exists():
                return None
            return decrypt_to_bytes(p, self.dek, verify=False)
        except Exception:
            return None

    def cleanup_deprecated_file_thumb_crops(self):
        """One-time-per-item, idempotent cleanup for vaults that predate the
        removal of the per-file "adjust thumb" (crop/reposition) feature
        from the UI. Any FILE that still carries a leftover thumb_custom
        flag from that old feature gets it cleared, and its now-unused
        cached crop deleted, so it falls back to the fresh, real-aspect-
        ratio thumbnail the media server generates on the fly instead of a
        stale square crop. This is what used to make some files show
        their true aspect ratio in the gallery and others (the ones
        someone had previously adjusted) show up square. Safe to call on
        every unlock — a vault with nothing left to clean does no work.
        Best-effort: a single folder's manifest failing to load/save is
        skipped rather than aborting the whole pass. See
        cleanup_deprecated_folder_thumb_crops() for the folder-side
        equivalent — that old editor also forced folder thumbnails square,
        which is a separate cleanup since folders keep their own custom-
        thumbnail feature (just without the crop step now)."""
        if not self.dek:
            return
        try:
            meta = load_meta(self.is_decoy, self.dek)
        except Exception:
            return
        for vid, entry in meta.get("files", {}).items():
            if entry.get("type") != "folder":
                continue
            try:
                base = self.vault_dir / vid
                manifest = load_tree_manifest(base, self.dek)
                if manifest is None:
                    continue
                if self._strip_deprecated_file_crops(manifest, vid, ""):
                    save_tree_manifest(base, manifest, self.dek)
            except Exception:
                continue

    def _strip_deprecated_file_crops(self, node, vid, rel_prefix):
        """Recursive helper for cleanup_deprecated_file_thumb_crops().
        Returns True if anything in this subtree was changed."""
        changed = False
        for token, child in node.get("children", {}).items():
            rel = f"{rel_prefix}/{token}" if rel_prefix else token
            if child.get("type") == "file":
                if child.pop("thumb_custom", None):
                    changed = True
                    cache = _nested_thumb_cache_path(vid, rel)
                    if cache.exists():
                        try: cache.unlink()
                        except Exception: pass
            elif child.get("type") == "dir":
                if self._strip_deprecated_file_crops(child, vid, rel):
                    changed = True
        return changed

    def cleanup_deprecated_folder_thumb_crops(self):
        """DISABLED — DO NOT CALL. Kept only for reference; no longer
        invoked anywhere (see main.py's _run_thumb_crop_cleanup).

        setAsFolderThumb / useFolderBackgroundAsThumb /
        chooseFolderThumbFromVault are NOT deprecated — they're the
        still-active "Choose thumb…" / "Use background as thumb"
        buttons, and they set exactly the same thumb_custom flag this
        function treats as leftover junk. Calling this wipes a user's
        just-picked custom folder thumbnail back to the auto-detected
        default the next time the vault is unlocked, with no way for
        this code to tell "old leftover crop" and "thumbnail picked five
        seconds ago" apart. A folder's thumbnail set via the Collage
        feature is the only case left alone (flagged thumb_collage).
        Do not wire this back into the login/unlock path unless it's
        rewritten with a real marker that only the old, removed crop step
        ever wrote."""
        if not self.dek:
            return
        try:
            meta = load_meta(self.is_decoy, self.dek)
        except Exception:
            return
        for vid, entry in meta.get("files", {}).items():
            if entry.get("type") != "folder":
                continue
            try:
                base = self.vault_dir / vid
                manifest = load_tree_manifest(base, self.dek)
                if manifest is None:
                    continue
                changed = self._strip_deprecated_folder_crop(manifest, vid, "", base)
                if changed:
                    save_tree_manifest(base, manifest, self.dek)
            except Exception:
                continue

    def _strip_deprecated_folder_crop(self, node, vid, rel, base):
        """Recursive helper for cleanup_deprecated_folder_thumb_crops().
        `node` may be the manifest root itself (rel=="") or any "dir"
        child within it. Returns True if anything in this subtree was
        changed."""
        changed = False
        if node.get("thumb_custom") and not node.get("thumb_collage"):
            node.pop("thumb_custom", None)
            changed = True
            if not rel:
                # Root-of-item cache lives at thumb_dir()/{vid}.jpg —
                # regenerate it right away from the folder's own
                # auto-detected preview so /thumb/<vid> immediately goes
                # back to a real, proportional photo instead of sitting on
                # the stale square crop until something else happens to
                # touch it.
                self._thumb_folder(base, vid)
            else:
                cache = _nested_thumb_cache_path(vid, rel)
                if cache.exists():
                    try: cache.unlink()
                    except Exception: pass
        for token, child in node.get("children", {}).items():
            child_rel = f"{rel}/{token}" if rel else token
            if child.get("type") == "dir":
                if self._strip_deprecated_folder_crop(child, vid, child_rel, base):
                    changed = True
        return changed

    # ── organizing: folders created inside the vault, move/copy items ──────
    def create_folder(self, name):
        """Creates a brand-new, empty organizational folder at the vault
        root — nothing from the computer is added; it exists purely to hold
        items moved/copied into it later."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        name = (name or "").strip()
        if not name:
            return False, "Enter a folder name"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            vid = hashlib.sha256((name + str(time.time())).encode()).hexdigest()[:16]
            dest = self.vault_dir / vid
            dest.mkdir(parents=True, exist_ok=True)
            save_tree_manifest(dest, {"type": "dir", "children": {}}, self.dek)
            meta["files"][vid] = {
                "original_path": None, "original_name": name, "type": "folder",
                "size": 0, "locked_at": datetime.now().isoformat(), "ext": "",
                "virtual": True,
            }
            save_meta(meta, self.is_decoy, self.dek)
            return True, vid
        except Exception as e:
            return False, str(e)

    def create_subfolder(self, vid, rel, name):
        """Creates a new empty folder nested inside an already locked
        folder, at the currently browsed location."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        name = (name or "").strip()
        if not name:
            return False, "Enter a folder name"
        try:
            meta = load_meta(self.is_decoy, self.dek)
            if vid not in meta["files"]:
                return False, "Not found"
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                return False, ("This folder predates the organize feature — "
                                "restore and re-lock it first.")
            parent = manifest_node_at(manifest, rel) if rel else manifest
            if parent is None or parent.get("type") != "dir":
                return False, "Not a folder"
            token = secrets.token_hex(8)
            (base / (f"{rel}/{token}" if rel else token)).mkdir(parents=True, exist_ok=True)
            parent.setdefault("children", {})[token] = {"type": "dir", "name": name, "children": {},
                                                          "locked_at": datetime.now().isoformat()}
            save_tree_manifest(base, manifest, self.dek)
            return True, token
        except Exception as e:
            return False, str(e)

    def list_vault_folders(self):
        """Flattened list of every folder currently in the vault (root-level
        locked folders and every nested sub-folder inside them) — used to
        populate the 'Move / Copy to\u2026' destination picker."""
        if not self.dek:
            return []
        meta = load_meta(self.is_decoy, self.dek)
        out = [{"vid": None, "rel": None, "label": "My Vault (root)"}]
        for vid, info in meta["files"].items():
            if info.get("type") != "folder":
                continue
            out.append({"vid": vid, "rel": None, "label": info["original_name"]})
            base = self.vault_dir / vid
            manifest = load_tree_manifest(base, self.dek)
            if manifest is None:
                continue

            def walk(node, rel, path_label):
                children = sorted(node.get("children", {}).items(),
                                   key=lambda kv: kv[1].get("name", "").lower())
                for token, child in children:
                    if child.get("type") != "dir":
                        continue
                    child_rel = f"{rel}/{token}" if rel else token
                    child_label = f"{path_label} / {child.get('name', token)}"
                    out.append({"vid": vid, "rel": child_rel, "label": child_label})
                    walk(child, child_rel, child_label)

            walk(manifest, "", info["original_name"])
        return out

    def move_item(self, src_vid, src_rel, dest_vid, dest_rel, copy=False):
        """Moves (or copies) a file/folder from one place in the vault to
        another — root \u2194 folder, folder \u2194 folder, any depth. Everything
        stays encrypted the whole time; only encrypted bytes and manifest
        entries are relocated, nothing is ever written to disk in the clear."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        try:
            meta = load_meta(self.is_decoy, self.dek)

            # Manifests touched during this call, keyed by vid, loaded at
            # most once each and saved at most once each at the very end.
            # This matters when src and dest are two locations *inside the
            # same* top-level locked folder (e.g. moving a file between two
            # sibling sub-folders): both the deletion and the insertion
            # happen against the very same on-disk manifest file. Loading
            # it twice into two independent dicts — one mutated for the
            # "add to destination" step, a separate one mutated for the
            # "remove from source" step — and saving both would make
            # whichever save ran last silently overwrite the other, so the
            # item would end up in neither copy: physically moved on disk,
            # but with no manifest entry pointing at it anywhere (it
            # "vanishes"). Sharing one loaded object per vid and deferring
            # every save to the end avoids that entirely.
            loaded_manifests = {}  # vid -> (base_path, manifest_dict_or_None)

            def get_manifest(vid):
                if vid not in loaded_manifests:
                    base = self.vault_dir / vid
                    loaded_manifests[vid] = (base, load_tree_manifest(base, self.dek))
                return loaded_manifests[vid]

            # ---- resolve source ----
            parent_node = last = node = None
            if src_rel:
                if src_vid not in meta["files"]:
                    return False, "Source not found"
                src_base, src_manifest = get_manifest(src_vid)
                if src_manifest is None:
                    return False, ("This folder predates the organize feature — "
                                    "restore and re-lock it first.")
                parent_node, last, node = self._locate_nested(src_manifest, src_rel)
                if node is None:
                    return False, "Item not found"
                name = node.get("name") or last
                item_type = node["type"]
                src_disk = src_base / src_rel
            else:
                if src_vid not in meta["files"]:
                    return False, "Source not found"
                name = meta["files"][src_vid]["original_name"]
                item_type = meta["files"][src_vid]["type"]
                src_disk = self.vault_dir / src_vid

            # ---- guards ----
            if dest_vid is not None:
                if src_rel is None and dest_vid == src_vid:
                    return False, "Can't move a folder into itself."
                if src_rel and dest_vid == src_vid and dest_rel is not None and \
                   (dest_rel == src_rel or dest_rel.startswith(src_rel + "/")):
                    return False, "Can't move a folder into its own sub-folder."
            elif src_rel is None:
                return False, "That item is already at the vault root."

            # ---- resolve / perform destination ----
            if dest_vid is None:
                new_vid = hashlib.sha256((name + str(time.time())).encode()).hexdigest()[:16]
                dest_disk = self.vault_dir / new_vid
                if item_type == "dir":
                    if copy: shutil.copytree(str(src_disk), str(dest_disk))
                    else: shutil.move(str(src_disk), str(dest_disk))
                    if node is not None:
                        sub_manifest = {"type": "dir", "children": node.get("children", {})}
                    else:
                        sub_manifest = load_tree_manifest(dest_disk, self.dek) or {"type": "dir", "children": {}}
                    save_tree_manifest(dest_disk, sub_manifest, self.dek)
                    size = manifest_dir_size(sub_manifest)
                else:
                    dest_disk.parent.mkdir(parents=True, exist_ok=True)
                    if copy: shutil.copy2(str(src_disk), str(dest_disk))
                    else: shutil.move(str(src_disk), str(dest_disk))
                    size = max(0, dest_disk.stat().st_size - ENC_OVERHEAD)
                meta["files"][new_vid] = {
                    "original_path": None, "original_name": name, "type": item_type,
                    "size": size, "locked_at": (node or {}).get("locked_at", datetime.now().isoformat()),
                    "ext": Path(name).suffix.lower() if item_type == "file" else "",
                    "virtual": True,
                }
            else:
                if dest_vid not in meta["files"] or meta["files"][dest_vid].get("type") != "folder":
                    return False, "Destination is not a folder"
                base_dest, dest_manifest = get_manifest(dest_vid)
                if dest_manifest is None:
                    return False, ("The destination folder predates the organize feature — "
                                    "restore and re-lock it first.")
                dest_parent = manifest_node_at(dest_manifest, dest_rel) if dest_rel else dest_manifest
                if dest_parent is None or dest_parent.get("type") != "dir":
                    return False, "Destination not found"
                new_token = secrets.token_hex(8)
                dest_disk = base_dest / (f"{dest_rel}/{new_token}" if dest_rel else new_token)
                dest_disk.parent.mkdir(parents=True, exist_ok=True)
                if item_type == "dir":
                    if copy: shutil.copytree(str(src_disk), str(dest_disk))
                    else: shutil.move(str(src_disk), str(dest_disk))
                    if node is not None:
                        new_node = {"type": "dir", "name": name, "children": node.get("children", {}),
                                    "locked_at": node.get("locked_at", datetime.now().isoformat())}
                    else:
                        inner_manifest = load_tree_manifest(dest_disk, self.dek) or {"type": "dir", "children": {}}
                        new_node = {"type": "dir", "name": name, "children": inner_manifest.get("children", {}),
                                    "locked_at": datetime.now().isoformat()}
                        idx = dest_disk / "_index.enc"
                        if idx.exists(): idx.unlink()
                else:
                    if copy: shutil.copy2(str(src_disk), str(dest_disk))
                    else: shutil.move(str(src_disk), str(dest_disk))
                    new_node = {"type": "file", "name": name,
                                "size": max(0, dest_disk.stat().st_size - ENC_OVERHEAD),
                                "locked_at": (node or {}).get("locked_at", datetime.now().isoformat())}
                dest_parent.setdefault("children", {})[new_token] = new_node

            # ---- clean up source (moves only) ----
            if not copy:
                if src_rel:
                    del parent_node["children"][last]
                else:
                    del meta["files"][src_vid]
                    t = thumb_dir() / f"{src_vid}.jpg"
                    if t.exists(): t.unlink()

            # ---- persist every touched manifest exactly once ----
            # (deferred from the add/remove steps above so a same-folder
            # move only ever writes its shared manifest a single time)
            for vid, (base, m) in loaded_manifests.items():
                if m is None:
                    continue
                save_tree_manifest(base, m, self.dek)
                if vid in meta["files"]:
                    meta["files"][vid]["size"] = manifest_dir_size(m)

            save_meta(meta, self.is_decoy, self.dek)
            return True, name
        except PermissionError:
            return False, "Permission denied moving that item."
        except Exception as e:
            return False, str(e)

    def find_preview(self, base_folder, rel="", max_depth=3, max_scan=500):
        """Finds the first image/video inside a (possibly nested) locked
        folder, to use as that folder's own thumbnail preview. `base_folder`
        is always the TOP of the locked item (where its manifest lives);
        `rel` optionally points at a nested sub-folder within it to start
        from. Since real names/extensions no longer exist on disk, this
        reads them from the folder's encrypted manifest instead of scanning
        raw filenames."""
        manifest = load_tree_manifest(base_folder, self.dek)
        if manifest is None:
            legacy_target = (Path(base_folder) / rel) if rel else Path(base_folder)
            return self._find_preview_legacy(legacy_target, max_depth, max_scan)

        node = manifest_node_at(manifest, rel)
        if node is None or node.get("type") != "dir":
            return None
        start_path = (Path(base_folder) / rel) if rel else Path(base_folder)

        # A thumbnail chosen for this specific folder always wins over the
        # automatic "first image found" scan below.
        override = node.get("thumb_rel")
        if override:
            ov_node = manifest_node_at(node, override)
            if ov_node and ov_node.get("type") == "file":
                ext = Path(ov_node.get("name", "")).suffix.lower()
                if ext in IMG_EXT: return ("image", start_path / override)
                if ext in VID_EXT: return ("video", start_path / override)

        scanned = [0]

        def walk(node, base):
            files, dirs = [], []
            for token, child in node.get("children", {}).items():
                (files if child["type"] == "file" else dirs).append((token, child))
            files.sort(key=lambda tc: tc[1].get("name", "").lower())
            for token, child in files:
                scanned[0] += 1
                if scanned[0] > max_scan:
                    return None
                ext = Path(child.get("name", "")).suffix.lower()
                if ext in IMG_EXT: return ("image", base / token)
                if ext in VID_EXT: return ("video", base / token)
            dirs.sort(key=lambda tc: tc[1].get("name", "").lower())
            for token, child in dirs:
                result = walk(child, base / token)
                if result: return result
            return None

        return walk(node, start_path)

    def _find_preview_legacy(self, folder, max_depth=3, max_scan=500):
        """Pre-manifest folders kept real filenames on disk — scan those."""
        scanned = 0
        queue = [(Path(folder), 0)]
        while queue:
            cur, depth = queue.pop(0)
            try:
                kids = sorted(cur.iterdir(), key=lambda p: p.name.lower())
            except Exception:
                continue
            subdirs = []
            for k in kids:
                if k.name == "_index.enc":
                    continue
                scanned += 1
                if scanned > max_scan: return None
                if k.is_file():
                    ext = k.suffix.lower()
                    if ext in IMG_EXT: return ("image", k)
                    if ext in VID_EXT: return ("video", k)
                elif k.is_dir() and depth < max_depth:
                    subdirs.append(k)
            queue.extend((s, depth + 1) for s in subdirs)
        return None
    # ════════════════════════════════════════════════════════════════════
    # GALLERY TOOLS — shared item resolution helper
    # ════════════════════════════════════════════════════════════════════
    def _resolve_file(self, vid, rel, meta=None, manifest_cache=None):
        """Resolves a (vid, rel) pair — rel is None/"" for a root item —
        to a uniform dict describing where it lives and how to rename/
        replace it in place. Returns None if it can't be found or isn't a
        file. `meta` can be passed in to reuse an already-loaded meta.json
        across many calls (batch operations).

        `manifest_cache`, if passed, is a {vid: (base, manifest)} dict
        that batch callers keep for the whole operation. Without it, a
        locked folder's manifest gets reloaded fresh from disk on every
        call — harmless for a single lookup, but fatal across a loop of
        several files in the SAME folder: each reload discards every
        earlier file's in-memory rename/edit, so only the last file
        processed in that folder ever actually gets saved. Passing a
        cache means every call for that folder returns the SAME
        (already-mutated) manifest object, so edits accumulate correctly
        before the caller saves it once at the end."""
        if meta is None:
            meta = load_meta(self.is_decoy, self.dek)
        if vid not in meta["files"]:
            return None
        if rel:
            base = self.vault_dir / vid
            if manifest_cache is not None and vid in manifest_cache:
                base, manifest = manifest_cache[vid]
            else:
                manifest = load_tree_manifest(base, self.dek)
                if manifest_cache is not None and manifest is not None:
                    manifest_cache[vid] = (base, manifest)
            if manifest is None:
                return None
            parent, last, node = self._locate_nested(manifest, rel)
            if node is None or node.get("type") != "file":
                return None
            return {
                "kind": "nested", "vid": vid, "rel": rel, "meta": meta,
                "name": node.get("name") or "file", "size": node.get("size", 0),
                "target": base / rel, "base": base, "manifest": manifest,
                "parent": parent, "node": node,
            }
        else:
            info = meta["files"][vid]
            if info.get("type") != "file":
                return None
            return {
                "kind": "root", "vid": vid, "rel": None, "meta": meta,
                "name": info.get("original_name") or "file", "size": info.get("size", 0),
                "target": self.vault_dir / vid, "info": info,
            }

    def _set_file_name(self, r, new_name):
        """Applies a rename to a dict returned by _resolve_file(). Caller
        is responsible for calling save_meta/save_tree_manifest once all
        changes to that particular container are done (batch callers group
        these to avoid re-writing the same manifest N times)."""
        if r["kind"] == "root":
            r["info"]["original_name"] = new_name
            r["info"]["ext"] = Path(new_name).suffix.lower()
        else:
            r["node"]["name"] = new_name

    def _sibling_names(self, r, meta):
        """Names of every OTHER file/folder sharing this item's container
        (vault root, or the same locked folder) — used for rename collision
        detection against items not part of the current selection."""
        if r["kind"] == "root":
            return {info.get("original_name", "") for v, info in meta["files"].items() if v != r["vid"]}
        else:
            return {c.get("name", "") for tok, c in (r["parent"] or {}).get("children", {}).items()
                    if c is not r["node"]}

    # ════════════════════════════════════════════════════════════════════
    # 1. ADVANCED BATCH RENAME
    # ════════════════════════════════════════════════════════════════════
    def batch_rename_preview(self, items, base_name, start_num, separator, padding):
        """items: ordered list of {vid, rel}. Returns
        {ok, entries:[{vid, rel, old_name, new_name, conflict}], error}.
        Pure/read-only — makes no changes."""
        base_name = (base_name or "").strip()
        if not base_name:
            return {"ok": False, "error": "Enter a base name", "entries": []}
        try:
            start_num = int(start_num)
        except (TypeError, ValueError):
            start_num = 1
        padding = int(padding) if padding else 0
        separator = separator if separator is not None else ""

        meta = load_meta(self.is_decoy, self.dek)
        entries = []
        planned_by_container = {}   # container key -> set of new names planned so far
        for i, it in enumerate(items):
            vid, rel = it.get("vid"), it.get("rel") or None
            r = self._resolve_file(vid, rel, meta)
            if r is None:
                entries.append({"vid": vid, "rel": rel, "old_name": it.get("name", "?"),
                                 "new_name": None, "conflict": True, "error": "File not found"})
                continue
            ext = Path(r["name"]).suffix
            num = start_num + i
            numstr = str(num).zfill(padding) if padding > 0 else str(num)
            new_name = f"{base_name}{separator}{numstr}{ext}"

            container_key = (r["vid"], r["kind"] == "nested" and id(r["parent"]) or None)
            siblings = self._sibling_names(r, meta)
            planned = planned_by_container.setdefault(container_key, set())
            conflict = (new_name in siblings) or (new_name in planned)
            planned.add(new_name)

            entries.append({
                "vid": vid, "rel": rel, "old_name": r["name"],
                "new_name": new_name, "conflict": conflict, "error": None,
            })
        return {"ok": True, "entries": entries}

    def batch_rename_apply(self, items, base_name, start_num, separator, padding):
        if not self.dek:
            return {"ok": False, "error": "Vault is locked", "entries": []}
        preview = self.batch_rename_preview(items, base_name, start_num, separator, padding)
        if not preview["ok"]:
            return preview
        if any(e["conflict"] or e["error"] for e in preview["entries"]):
            return {"ok": False, "error": "Resolve name conflicts before renaming", "entries": preview["entries"]}

        meta = load_meta(self.is_decoy, self.dek)
        manifest_cache = {}   # {vid: (base, manifest)} — shared across the whole loop; see
                               # _resolve_file's docstring for why this is required, not optional,
                               # whenever more than one file in the SAME locked folder is touched.
        dirty_manifests = {}   # base path -> (base, manifest)
        undo = []
        try:
            for e in preview["entries"]:
                r = self._resolve_file(e["vid"], e["rel"], meta, manifest_cache)
                if r is None:
                    continue
                self._set_file_name(r, e["new_name"])
                undo.append({"vid": e["vid"], "rel": e["rel"], "old_name": e["old_name"], "new_name": e["new_name"]})
                if r["kind"] == "nested":
                    dirty_manifests[str(r["base"])] = (r["base"], r["manifest"])
            save_meta(meta, self.is_decoy, self.dek)
            for base, manifest in dirty_manifests.values():
                save_tree_manifest(base, manifest, self.dek)
            self._last_rename_undo = undo
            return {"ok": True, "entries": preview["entries"], "renamed": len(undo)}
        except Exception as e:
            return {"ok": False, "error": str(e), "entries": preview["entries"]}

    def batch_rename_undo(self):
        undo = getattr(self, "_last_rename_undo", None)
        if not undo:
            return {"ok": False, "error": "Nothing to undo"}
        if not self.dek:
            return {"ok": False, "error": "Vault is locked"}
        meta = load_meta(self.is_decoy, self.dek)
        manifest_cache = {}
        dirty_manifests = {}
        try:
            for e in reversed(undo):
                r = self._resolve_file(e["vid"], e["rel"], meta, manifest_cache)
                if r is None:
                    continue
                self._set_file_name(r, e["old_name"])
                if r["kind"] == "nested":
                    dirty_manifests[str(r["base"])] = (r["base"], r["manifest"])
            save_meta(meta, self.is_decoy, self.dek)
            for base, manifest in dirty_manifests.values():
                save_tree_manifest(base, manifest, self.dek)
            self._last_rename_undo = None
            return {"ok": True, "restored": len(undo)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ════════════════════════════════════════════════════════════════════
    # 2. PRIVACY SCRUBBER
    # ════════════════════════════════════════════════════════════════════
    def privacy_scan(self, items):
        """Decrypts each item to a temp file just long enough to read its
        metadata, then deletes the temp copy immediately. Returns a list of
        {vid, rel, name, kind, fields, error}."""
        if not self.dek:
            return {"ok": False, "error": "Vault is locked", "results": []}
        meta = load_meta(self.is_decoy, self.dek)
        results = []
        for it in items:
            vid, rel = it.get("vid"), it.get("rel") or None
            r = self._resolve_file(vid, rel, meta)
            if r is None:
                results.append({"vid": vid, "rel": rel, "name": it.get("name", "?"),
                                 "error": "File not found", "fields": {}})
                continue
            ext = Path(r["name"]).suffix.lower()
            tmp = None
            try:
                if ext in IMG_EXT:
                    tmp = temp_dir() / f"{secrets.token_hex(8)}{ext}"
                    decrypt_file(r["target"], str(tmp), self.dek, verify=False)
                    fields = scan_image_privacy(tmp)
                    kind = "image"
                elif ext in VID_EXT:
                    tmp = temp_dir() / f"{secrets.token_hex(8)}{ext}"
                    decrypt_file(r["target"], str(tmp), self.dek, verify=False)
                    fields = scan_video_privacy(tmp)
                    kind = "video"
                else:
                    fields, kind = {}, "other"
                results.append({"vid": vid, "rel": rel, "name": r["name"], "kind": kind,
                                 "fields": fields, "found_count": sum(1 for v in fields.values() if v is True),
                                 "error": None})
            except Exception as e:
                results.append({"vid": vid, "rel": rel, "name": r["name"], "error": str(e), "fields": {}})
            finally:
                if tmp is not None:
                    try:
                        if tmp.exists(): tmp.unlink()
                    except Exception:
                        pass
        return {"ok": True, "results": results}

    def privacy_scrub(self, items, options):
        """Batch-scrubs metadata in place: for each item, decrypt -> strip
        -> verify -> re-encrypt over the SAME vault slot (same vid/token),
        only after the scrubbed version is confirmed good — the original
        encrypted bytes are never touched until then. Returns
        {ok, processed, errors:[{name, error}]}."""
        if not self.dek:
            return {"ok": False, "error": "Vault is locked", "processed": 0, "errors": []}
        options = {**DEFAULT_SCRUB_OPTIONS, **(options or {})}
        meta = load_meta(self.is_decoy, self.dek)
        manifest_cache = {}   # see _resolve_file's docstring — required so several
                               # files scrubbed from the SAME locked folder all persist,
                               # not just the last one processed
        processed = 0
        errors = []
        dirty_manifests = {}
        meta_dirty = False
        for it in items:
            vid, rel = it.get("vid"), it.get("rel") or None
            r = self._resolve_file(vid, rel, meta, manifest_cache)
            if r is None:
                errors.append({"name": it.get("name", "?"), "error": "File not found"})
                continue
            ext = Path(r["name"]).suffix.lower()
            if ext not in IMG_EXT and ext not in VID_EXT:
                errors.append({"name": r["name"], "error": "Unsupported file type"})
                continue
            tmp_in = temp_dir() / f"{secrets.token_hex(8)}{ext}"
            tmp_out = temp_dir() / f"{secrets.token_hex(8)}{ext}"
            try:
                decrypt_file(r["target"], str(tmp_in), self.dek, verify=False)
                if ext in IMG_EXT:
                    ok, err = strip_image_privacy(tmp_in, tmp_out, options)
                else:
                    ok, err = strip_video_privacy(tmp_in, tmp_out, options)
                if not ok:
                    errors.append({"name": r["name"], "error": err or "Couldn't process this file"})
                    continue
                if not tmp_out.exists() or tmp_out.stat().st_size == 0:
                    errors.append({"name": r["name"], "error": "Processed file came out empty — original left untouched"})
                    continue
                # Verified good — now, and only now, overwrite the vault slot.
                new_size = tmp_out.stat().st_size
                encrypt_file(str(tmp_out), r["target"], self.dek)
                if r["kind"] == "root":
                    r["info"]["size"] = new_size
                    meta_dirty = True
                else:
                    r["node"]["size"] = new_size
                    dirty_manifests[str(r["base"])] = (r["base"], r["manifest"])
                processed += 1
            except Exception as e:
                errors.append({"name": r["name"], "error": str(e)})
            finally:
                for t in (tmp_in, tmp_out):
                    try:
                        if t.exists(): t.unlink()
                    except Exception:
                        pass
        if meta_dirty:
            save_meta(meta, self.is_decoy, self.dek)
        for base, manifest in dirty_manifests.values():
            save_tree_manifest(base, manifest, self.dek)
        # invalidate cached thumbnails for scrubbed root items (their bytes changed)
        for it in items:
            if not it.get("rel"):
                t = thumb_dir() / f"{it.get('vid')}.jpg"
                try:
                    if t.exists(): t.unlink()
                except Exception:
                    pass
        return {"ok": True, "processed": processed, "errors": errors}

    # ════════════════════════════════════════════════════════════════════
    # 3. ADVANCED VIDEO FRAME EXTRACTOR (background job)
    # ════════════════════════════════════════════════════════════════════
    def start_advanced_frame_extraction(self, vid, rel, dest_vid, dest_rel, mode, params, output_opts):
        """Kicks off frame extraction on a background thread and returns a
        job_id immediately; poll get_job(job_id) for progress. `mode` is one
        of: every_frame, every_nth, fps, interval, frame_range, time_range,
        timestamps. `output_opts`: {format, quality, resize:{kind,value},
        base_name, start_num, separator, padding}."""
        if not self.dek:
            return {"ok": False, "error": "Vault is locked"}
        if not CV2_OK:
            return {"ok": False, "error": "Video support isn't available (OpenCV not installed)"}
        job_id = _job_new("frame_extract")
        t = threading.Thread(target=self._run_frame_extraction, args=(
            job_id, vid, rel, dest_vid, dest_rel, mode, dict(params or {}), dict(output_opts or {})
        ), daemon=True)
        t.start()
        return {"ok": True, "job_id": job_id}

    def _frame_indices_for_mode(self, mode, params, native_fps, total_frames):
        """Returns a sorted list of 0-based frame indices to capture, for
        every mode except `timestamps` (handled by direct seek instead,
        since it's independent of frame count)."""
        def clampi(v, lo, hi): return max(lo, min(hi, v))
        if mode == "every_frame":
            return list(range(total_frames)) if total_frames > 0 else None  # None => stream, don't precompute
        if mode == "every_nth":
            n = max(1, int(params.get("n", 10)))
            return list(range(0, total_frames, n)) if total_frames > 0 else None
        if mode == "fps":
            target = float(params.get("fps", 1))
            step = max(1, round((native_fps or 30) / max(target, 0.001)))
            return list(range(0, total_frames, step)) if total_frames > 0 else None
        if mode == "interval":
            secs = float(params.get("seconds", 5))
            step = max(1, round(secs * (native_fps or 30)))
            return list(range(0, total_frames, step)) if total_frames > 0 else None
        if mode == "frame_range":
            start = clampi(int(params.get("start", 0)), 0, max(total_frames - 1, 0))
            end = clampi(int(params.get("end", total_frames)), start, max(total_frames - 1, 0))
            every = max(1, int(params.get("every", 1)))
            return list(range(start, end + 1, every))
        if mode == "time_range":
            start_s = float(params.get("start_sec", 0))
            end_s = float(params.get("end_sec", 0))
            fps_t = float(params.get("fps", 1))
            step = max(1, round((native_fps or 30) / max(fps_t, 0.001)))
            start_f = clampi(round(start_s * (native_fps or 30)), 0, max(total_frames - 1, 0))
            end_f = clampi(round(end_s * (native_fps or 30)), start_f, max(total_frames - 1, 0))
            return list(range(start_f, end_f + 1, step))
        return []

    def _run_frame_extraction(self, job_id, vid, rel, dest_vid, dest_rel, mode, params, output_opts):
        tmp_video = None
        cap = None
        try:
            meta = load_meta(self.is_decoy, self.dek)
            src = self._resolve_file(vid, rel, meta)
            if src is None:
                _job_update(job_id, status="error", error="Source video not found"); return
            if dest_vid not in meta["files"] or meta["files"][dest_vid].get("type") != "folder":
                _job_update(job_id, status="error", error="Destination is not a folder"); return
            ext = Path(src["name"]).suffix.lower()
            if ext not in VID_EXT:
                _job_update(job_id, status="error", error="That file isn't a video"); return
            stem = Path(src["name"]).stem or "video"

            _job_update(job_id, message="Decrypting video\u2026")
            tmp_video = temp_dir() / f"{secrets.token_hex(8)}{ext}"
            decrypt_file(src["target"], str(tmp_video), self.dek, verify=False)

            cap = cv2.VideoCapture(str(tmp_video))
            if not cap.isOpened():
                _job_update(job_id, status="error", error="Couldn't read that video"); return
            native_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

            base_name = (output_opts.get("base_name") or f"{stem}_frame").strip()
            start_num = int(output_opts.get("start_num", 1) or 1)
            separator = output_opts.get("separator", "..")
            padding = int(output_opts.get("padding", 0) or 0)
            out_fmt = (output_opts.get("format") or "jpeg").lower()
            out_ext = {"jpeg": ".jpg", "jpg": ".jpg", "png": ".png", "webp": ".webp"}.get(out_fmt, ".jpg")
            quality = int(output_opts.get("quality", 95) or 95)
            resize = output_opts.get("resize") or {"kind": "original"}

            base_dest = self.vault_dir / dest_vid
            dest_manifest = load_tree_manifest(base_dest, self.dek)
            if dest_manifest is None:
                _job_update(job_id, status="error", error="Destination folder predates the organize feature"); return
            dest_parent = manifest_node_at(dest_manifest, dest_rel) if dest_rel else dest_manifest
            if dest_parent is None or dest_parent.get("type") != "dir":
                _job_update(job_id, status="error", error="Destination not found"); return
            dest_children = dest_parent.setdefault("children", {})

            def resize_frame(frame):
                if resize.get("kind") in (None, "original"):
                    return frame
                h, w = frame.shape[:2]
                if resize["kind"] == "percent":
                    scale = float(resize.get("value", 100)) / 100.0
                    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
                elif resize["kind"] == "width":
                    nw = int(resize.get("value", w)); nh = max(1, round(h * (nw / w)))
                elif resize["kind"] == "height":
                    nh = int(resize.get("value", h)); nw = max(1, round(w * (nh / h)))
                else:
                    return frame
                return cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)

            def encode(frame):
                frame = resize_frame(frame)
                if out_ext == ".jpg":
                    ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
                elif out_ext == ".png":
                    ok2, buf = cv2.imencode(".png", frame)
                else:  # webp
                    ok2, buf = cv2.imencode(".webp", frame, [cv2.IMWRITE_WEBP_QUALITY, quality])
                return buf.tobytes() if ok2 else None

            def save_frame(raw_bytes, seq):
                numstr = str(seq).zfill(padding) if padding > 0 else str(seq)
                name = f"{base_name}{separator}{numstr}{out_ext}"
                enc = encrypt_bytes(raw_bytes, self.dek)
                token = secrets.token_hex(8)
                frame_disk = base_dest / (f"{dest_rel}/{token}" if dest_rel else token)
                frame_disk.parent.mkdir(parents=True, exist_ok=True)
                frame_disk.write_bytes(enc)
                dest_children[token] = {"type": "file", "name": name, "size": len(raw_bytes),
                                         "locked_at": datetime.now().isoformat()}

            saved = 0
            if mode == "timestamps":
                stamps = params.get("timestamps") or []
                _job_update(job_id, total=len(stamps))
                for i, ts in enumerate(stamps):
                    if _job_cancel_requested(job_id):
                        _job_update(job_id, status="cancelled"); return
                    secs = _parse_timestamp(ts)
                    if secs is None: continue
                    cap.set(cv2.CAP_PROP_POS_MSEC, secs * 1000.0)
                    ok, frame = cap.read()
                    if ok:
                        raw = encode(frame)
                        if raw:
                            saved += 1
                            save_frame(raw, start_num + saved - 1)
                    _job_update(job_id, done=i + 1, message=f"Capturing timestamp {i + 1}/{len(stamps)}")
            else:
                indices = self._frame_indices_for_mode(mode, params, native_fps, total_frames)
                if indices is None:
                    # Unknown/unreliable total_frames — stream every frame and
                    # decide on the fly, still respecting the same modes.
                    step = 1
                    if mode == "every_nth": step = max(1, int(params.get("n", 10)))
                    elif mode == "fps": step = max(1, round(native_fps / max(float(params.get("fps", 1)), 0.001)))
                    elif mode == "interval": step = max(1, round(float(params.get("seconds", 5)) * native_fps))
                    _job_update(job_id, total=0)
                    idx = 0
                    while True:
                        if _job_cancel_requested(job_id):
                            _job_update(job_id, status="cancelled"); return
                        ok, frame = cap.read()
                        if not ok: break
                        if idx % step == 0:
                            raw = encode(frame)
                            if raw:
                                saved += 1
                                save_frame(raw, start_num + saved - 1)
                        idx += 1
                        if idx % 20 == 0:
                            _job_update(job_id, done=saved, message=f"Extracted {saved} frames\u2026")
                else:
                    _job_update(job_id, total=len(indices))
                    wanted = set(indices)
                    idx = 0
                    max_wanted = max(indices) if indices else -1
                    while idx <= max_wanted:
                        if _job_cancel_requested(job_id):
                            _job_update(job_id, status="cancelled"); return
                        ok, frame = cap.read()
                        if not ok: break
                        if idx in wanted:
                            raw = encode(frame)
                            if raw:
                                saved += 1
                                save_frame(raw, start_num + saved - 1)
                            _job_update(job_id, done=saved, message=f"Frame {idx} ({saved}/{len(indices)})")
                        idx += 1

            if saved == 0:
                _job_update(job_id, status="error", error="No frames could be extracted"); return

            save_tree_manifest(base_dest, dest_manifest, self.dek)
            meta["files"][dest_vid]["size"] = manifest_dir_size(dest_manifest)
            save_meta(meta, self.is_decoy, self.dek)
            _job_update(job_id, status="done", done=saved, total=max(saved, _job_get(job_id).get("total", 0)),
                        message=f"Saved {saved} frames", result={"saved": saved})
        except Exception as e:
            _job_update(job_id, status="error", error=str(e))
        finally:
            if cap is not None:
                cap.release()
            if tmp_video is not None:
                try:
                    if tmp_video.exists(): tmp_video.unlink()
                except Exception:
                    pass

    # ════════════════════════════════════════════════════════════════════
    # SNAPSHOT — grab the single frame the video is paused/sitting on
    # right now, from the in-lightbox video player, and lock it into a
    # chosen folder as its own photo. This is the lightweight counterpart
    # to the Advanced Frame Extractor's "timestamps" mode: no dialog full
    # of extraction options, no background job/progress bar — just "this
    # exact moment, save it there." Runs synchronously since a single
    # frame is fast; the frontend still shows a brief busy state for slow
    # disks/large videos.
    # ════════════════════════════════════════════════════════════════════
    def capture_video_snapshot(self, vid, rel, timestamp_sec, dest_vid, dest_rel):
        """Captures one frame from a video already in the vault at an
        exact playback position (`timestamp_sec`, seconds from the start)
        and locks it into the destination folder as its own JPEG file.
        `vid`/`rel` identify the source video the same way every other
        per-item vault call does (rel is None/"" for a root-level item,
        or the video's path within a locked folder). `dest_vid`/`dest_rel`
        identify the destination folder the same way — it can be the
        folder the video already lives in, any other existing folder, or
        a brand-new one the caller already created with create_folder() /
        create_subfolder() before calling this. Returns (True, saved
        file's name) on success, else (False, error_message)."""
        if not self.dek:
            return False, "Vault is locked (no encryption key available)"
        if not CV2_OK:
            return False, "Video support isn't available (OpenCV not installed)"
        try:
            timestamp_sec = max(0.0, float(timestamp_sec))
        except (TypeError, ValueError):
            return False, "Invalid timestamp"

        tmp_video = None
        cap = None
        try:
            meta = load_meta(self.is_decoy, self.dek)
            src = self._resolve_file(vid, rel, meta)
            if src is None:
                return False, "Source video not found"
            if dest_vid not in meta["files"] or meta["files"][dest_vid].get("type") != "folder":
                return False, "Destination is not a folder"
            ext = Path(src["name"]).suffix.lower()
            if ext not in VID_EXT:
                return False, "That file isn't a video"
            stem = Path(src["name"]).stem or "video"

            tmp_video = temp_dir() / f"{secrets.token_hex(8)}{ext}"
            decrypt_file(src["target"], str(tmp_video), self.dek, verify=False)

            cap = cv2.VideoCapture(str(tmp_video))
            if not cap.isOpened():
                return False, "Couldn't read that video"
            cap.set(cv2.CAP_PROP_POS_MSEC, timestamp_sec * 1000.0)
            ok, frame = cap.read()
            if not ok:
                # Right at/near the very end of the video, seeking by
                # milliseconds can overshoot past the last readable frame
                # — fall back to the last actual frame instead of failing
                # outright on a snapshot taken while paused at the end.
                total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
                if total > 0:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 1))
                    ok, frame = cap.read()
            if not ok:
                return False, "Couldn't capture a frame at that point in the video"

            ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if not ok2:
                return False, "Couldn't encode the captured frame"
            raw_bytes = buf.tobytes()

            base_dest = self.vault_dir / dest_vid
            dest_manifest = load_tree_manifest(base_dest, self.dek)
            if dest_manifest is None:
                return False, "Destination folder predates the organize feature \u2014 restore and re-lock it first."
            dest_parent = manifest_node_at(dest_manifest, dest_rel) if dest_rel else dest_manifest
            if dest_parent is None or dest_parent.get("type") != "dir":
                return False, "Destination not found"
            dest_children = dest_parent.setdefault("children", {})

            total_secs = max(0, int(timestamp_sec))
            hh, rem = divmod(total_secs, 3600)
            mm, ss = divmod(rem, 60)
            ts_label = f"{hh:02d}-{mm:02d}-{ss:02d}" if hh else f"{mm:02d}-{ss:02d}"
            name = f"{stem}_snapshot_{ts_label}.jpg"
            # Avoid clobbering an identically-timestamped earlier snapshot
            # of the same video saved into the same folder.
            existing_names = {c.get("name") for c in dest_children.values()}
            if name in existing_names:
                n = 2
                while f"{stem}_snapshot_{ts_label}_{n}.jpg" in existing_names:
                    n += 1
                name = f"{stem}_snapshot_{ts_label}_{n}.jpg"

            enc = encrypt_bytes(raw_bytes, self.dek)
            token = secrets.token_hex(8)
            frame_disk = base_dest / (f"{dest_rel}/{token}" if dest_rel else token)
            frame_disk.parent.mkdir(parents=True, exist_ok=True)
            frame_disk.write_bytes(enc)
            dest_children[token] = {"type": "file", "name": name, "size": len(raw_bytes),
                                     "locked_at": datetime.now().isoformat()}

            save_tree_manifest(base_dest, dest_manifest, self.dek)
            meta["files"][dest_vid]["size"] = manifest_dir_size(dest_manifest)
            save_meta(meta, self.is_decoy, self.dek)
            return True, name
        except Exception as e:
            return False, str(e)
        finally:
            if cap is not None:
                cap.release()
            if tmp_video is not None:
                try:
                    if tmp_video.exists(): tmp_video.unlink()
                except Exception:
                    pass

    # ════════════════════════════════════════════════════════════════════
    # 5. IMAGE QUALITY ENHANCER (background job)
    #
    # Increases a photo's pixel dimensions (up to 4K/8K, or a straight 2x/
    # 4x multiple) using high-quality Lanczos resampling plus a mild
    # sharpening pass. Worth being precise about what this is NOT: it's
    # not an AI super-resolution model inventing detail that isn't in the
    # source (VaultLock ships no such model and never phones out to the
    # internet) — it's the best a resize+sharpen pipeline can do, which
    # helps a photo look sharper/cleaner at a larger size but can't
    # recover detail the original simply doesn't have.
    #
    # Runs as a background job like frame extraction above; the result is
    # held in _upscale_cache (plaintext bytes, memory-only) until the
    # caller finalizes it via finalize_image_upscale() — nothing is
    # written back into the vault until the person explicitly chooses
    # "save as original" or "save as copy" from the comparison screen.
    # ════════════════════════════════════════════════════════════════════
    _UPSCALE_TARGETS = {
        "2x": {"kind": "scale", "value": 2},
        "4x": {"kind": "scale", "value": 4},
        "4k": {"kind": "long_edge", "value": 3840},
        "8k": {"kind": "long_edge", "value": 7680},
    }
    _UPSCALE_MAX_EDGE = 8000  # hard safety cap regardless of target, to bound memory use

    def start_image_upscale(self, vid, rel, target, use_ai=False):
        """Kicks off image enhancement on a background thread and returns
        a job_id immediately; poll get_job(job_id) for progress. `target`
        is one of '2x', '4x', '4k', '8k'. `use_ai` opts into the free
        Hugging Face AI enhancer (requires a saved token); it silently
        falls back to local resampling if that's unavailable, with a note
        in the result explaining why."""
        if not self.dek:
            return {"ok": False, "error": "Vault is locked"}
        if not PIL_OK:
            return {"ok": False, "error": "Image support isn't available (Pillow not installed)"}
        spec = self._UPSCALE_TARGETS.get(target)
        if spec is None:
            return {"ok": False, "error": "Unknown quality target"}
        _sweep_upscale_cache()
        job_id = _job_new("image_upscale", total=5)
        t = threading.Thread(target=self._run_image_upscale, args=(job_id, vid, rel or None, spec, bool(use_ai)), daemon=True)
        t.start()
        return {"ok": True, "job_id": job_id}

    def _run_image_upscale(self, job_id, vid, rel, spec, use_ai=False):
        # Long edge (px) used for BOTH the "before" and "after" comparison
        # images sent back to the UI. This used to be a small box matching
        # the gallery thumbnail size (~960px) shown in a ~250px-wide modal
        # column — at that size any real resolution/sharpness gain gets
        # hidden the moment the browser scales both images down to fit, so
        # the comparison looked like a no-op even when the upscale worked.
        # Using a much bigger box, shown in a much bigger modal, means a
        # low-res original actually has to be stretched up by the browser
        # to fill the frame (visibly softening it) while the enhanced
        # version — which has real extra pixels — renders sharp at the
        # same size. That contrast is the whole point of the comparison.
        COMPARE_BOX = 1600
        try:
            meta = load_meta(self.is_decoy, self.dek)
            src = self._resolve_file(vid, rel, meta)
            if src is None:
                _job_update(job_id, status="error", error="Source image not found"); return
            ext = Path(src["name"]).suffix.lower()
            if ext not in IMG_EXT:
                _job_update(job_id, status="error", error="That file isn't an image"); return

            _job_update(job_id, done=1, message="Decrypting image\u2026")
            raw = decrypt_to_bytes(src["target"], self.dek, verify=False)
            if _job_cancel_requested(job_id):
                _job_update(job_id, status="cancelled"); return

            img = Image.open(io.BytesIO(raw))
            img.load()
            orig_w, orig_h = img.size
            has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA" if has_alpha else "RGB")

            # Snapshot of the untouched original, before any resize/sharpen,
            # used to build the "before" side of the comparison — a real
            # rendering of the source at its own native resolution (only
            # downsized if it's bigger than COMPARE_BOX), not the small
            # cached gallery thumbnail.
            before_preview = img.copy()
            before_preview.thumbnail((COMPARE_BOX, COMPARE_BOX), Image.LANCZOS)
            if before_preview.mode not in ("RGB",):
                before_preview = before_preview.convert("RGB")
            bbuf = io.BytesIO()
            before_preview.save(bbuf, "JPEG", quality=90)
            before_preview_url = f"data:image/jpeg;base64,{base64.b64encode(bbuf.getvalue()).decode()}"

            _job_update(job_id, done=2, message="Calculating target size\u2026")
            if spec["kind"] == "scale":
                new_w, new_h = orig_w * spec["value"], orig_h * spec["value"]
            else:
                long_edge = spec["value"]
                if orig_w >= orig_h:
                    new_w, new_h = long_edge, max(1, round(orig_h * (long_edge / orig_w)))
                else:
                    new_h, new_w = long_edge, max(1, round(orig_w * (long_edge / orig_h)))
            # Never shrink — if the source already meets/exceeds the
            # target, leave its resolution as-is (it still gets sharpened).
            if new_w < orig_w or new_h < orig_h:
                new_w, new_h = orig_w, orig_h
            if new_w > self._UPSCALE_MAX_EDGE or new_h > self._UPSCALE_MAX_EDGE:
                ratio = min(self._UPSCALE_MAX_EDGE / new_w, self._UPSCALE_MAX_EDGE / new_h)
                new_w, new_h = max(1, round(new_w * ratio)), max(1, round(new_h * ratio))

            # ── Optional: free AI enhancement pass (Hugging Face) ──
            # Runs a real super-resolution model (Swin2SR) over the photo
            # before the final resize-to-target below, so detail actually
            # gets reconstructed rather than just resampled. Falls back to
            # local-only processing (silently, with a note for the UI) if
            # no key is saved, the package/network isn't available, or the
            # call fails for any reason — the local pipeline always still
            # runs, so this can only add quality, never break the feature.
            ai_used = False
            ai_note = None
            base_img = img
            if use_ai and has_alpha:
                ai_note = "AI enhancement doesn't support transparent images yet \u2014 used local upscaling instead."
            elif use_ai:
                ai_settings = load_ai_settings()
                token = (ai_settings.get("hf_token") or "").strip()
                if not token:
                    ai_note = "No Hugging Face API key saved \u2014 used local upscaling instead."
                elif not REQUESTS_OK:
                    ai_note = "The AI enhancer needs the 'requests' package, which isn't installed \u2014 used local upscaling instead."
                else:
                    try:
                        _job_update(job_id, done=2, message="Sending photo to AI model\u2026")
                        model_key = "4x" if (spec["kind"] == "long_edge" or spec.get("value", 0) >= 4) else "2x"
                        model_id = _HF_UPSCALE_MODELS[model_key]
                        ai_input = img.convert("RGB").copy()
                        ai_input.thumbnail((_HF_AI_INPUT_CAP, _HF_AI_INPUT_CAP), Image.LANCZOS)
                        ibuf = io.BytesIO()
                        ai_input.save(ibuf, "JPEG", quality=95)
                        out_bytes = _hf_upscale_call(token, model_id, ibuf.getvalue(), job_id=job_id)
                        base_img = Image.open(io.BytesIO(out_bytes)).convert("RGB")
                        ai_used = True
                        _job_update(job_id, done=3, message="Received AI-enhanced image\u2026")
                    except Exception as e:
                        ai_note = f"AI enhancement unavailable ({e}) \u2014 used local upscaling instead."

            if _job_cancel_requested(job_id):
                _job_update(job_id, status="cancelled"); return
            _job_update(job_id, done=3, message=f"Resizing to {new_w}\u00d7{new_h}\u2026")
            resized = (new_w, new_h) != base_img.size
            if resized:
                img = base_img.resize((new_w, new_h), Image.LANCZOS)
            else:
                img = base_img
            resized = (new_w, new_h) != (orig_w, orig_h)  # for the UI note, relative to the true original

            _job_update(job_id, done=4, message="Sharpening details\u2026")
            # Lighter sharpening pass when the AI model already reconstructed
            # detail — stacking a strong unsharp mask on top of that tends to
            # produce visible haloing rather than a genuine extra improvement.
            if ai_used:
                img = img.filter(ImageFilter.UnsharpMask(radius=1.0, percent=60, threshold=2))
            else:
                img = img.filter(ImageFilter.UnsharpMask(radius=1.6, percent=140, threshold=2))


            _job_update(job_id, message="Encoding result\u2026")
            out_ext = ".png" if has_alpha else (ext if ext in (".jpg", ".jpeg", ".png", ".webp") else ".jpg")
            buf = io.BytesIO()
            if out_ext == ".png":
                img.save(buf, "PNG", optimize=True)
            elif out_ext == ".webp":
                img.save(buf, "WEBP", quality=95)
            else:
                out_ext = ".jpg"
                img.save(buf, "JPEG", quality=95)
            data = buf.getvalue()

            preview = img.copy()
            preview.thumbnail((COMPARE_BOX, COMPARE_BOX), Image.LANCZOS)
            if preview.mode not in ("RGB",):
                preview = preview.convert("RGB")
            pbuf = io.BytesIO()
            preview.save(pbuf, "JPEG", quality=90)
            preview_url = f"data:image/jpeg;base64,{base64.b64encode(pbuf.getvalue()).decode()}"

            with _upscale_lock:
                _upscale_cache[job_id] = {
                    "vid": vid, "rel": rel, "data": data, "ext": out_ext,
                    "orig_name": src["name"], "created": time.time(),
                }

            _job_update(job_id, status="done", done=5, total=5, message="Done",
                        result={"before_w": orig_w, "before_h": orig_h,
                                "after_w": new_w, "after_h": new_h,
                                "after_size": len(data), "after_size_h": human_size(len(data)),
                                "resized": resized, "ai_used": ai_used, "ai_note": ai_note,
                                "before_preview_data_url": before_preview_url,
                                "preview_data_url": preview_url, "job_id": job_id})
        except Exception as e:
            _job_update(job_id, status="error", error=str(e))

    def finalize_image_upscale(self, job_id, action, dest_name=None):
        """action: 'overwrite' replaces the original file in place;
        'copy' saves the enhanced version as a new sibling file, leaving
        the original untouched. Either way the cached result is consumed
        (removed from memory) once this returns."""
        if not self.dek:
            return {"ok": False, "error": "Vault is locked"}
        with _upscale_lock:
            entry = _upscale_cache.pop(job_id, None)
        if entry is None:
            return {"ok": False, "error": "That result has expired \u2014 run Increase Quality again."}
        try:
            meta = load_meta(self.is_decoy, self.dek)
            r = self._resolve_file(entry["vid"], entry["rel"], meta)
            if r is None:
                return {"ok": False, "error": "The original file is no longer there"}
            enc = encrypt_bytes(entry["data"], self.dek)

            if action == "overwrite":
                r["target"].write_bytes(enc)
                if r["kind"] == "root":
                    r["info"]["size"] = len(entry["data"])
                    save_meta(meta, self.is_decoy, self.dek)
                    t = thumb_dir() / f"{entry['vid']}.jpg"
                    try:
                        if t.exists(): t.unlink()
                    except Exception:
                        pass
                    threading.Thread(target=_make_thumb_from_encrypted,
                                      args=(r["target"], entry["vid"], self.dek, False), daemon=True).start()
                else:
                    r["node"]["size"] = len(entry["data"])
                    save_tree_manifest(r["base"], r["manifest"], self.dek)
                return {"ok": True, "name": r["name"], "vid": entry["vid"], "rel": entry["rel"]}

            elif action == "copy":
                stem = Path(entry["orig_name"]).stem
                new_name = (dest_name or "").strip() or f"{stem}_enhanced{entry['ext']}"
                if r["kind"] == "root":
                    existing = {info.get("original_name", "") for info in meta["files"].values()}
                    new_name = _unique_name(new_name, existing)
                    new_vid = hashlib.sha256((new_name + str(time.time())).encode()).hexdigest()[:16]
                    dest = self.vault_dir / new_vid
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(enc)
                    meta["files"][new_vid] = {
                        "original_path": None, "original_name": new_name, "type": "file",
                        "size": len(entry["data"]), "locked_at": datetime.now().isoformat(),
                        "ext": entry["ext"],
                    }
                    save_meta(meta, self.is_decoy, self.dek)
                    threading.Thread(target=_make_thumb_from_encrypted,
                                      args=(dest, new_vid, self.dek, False), daemon=True).start()
                    return {"ok": True, "name": new_name, "vid": new_vid, "rel": None}
                else:
                    parent = r["parent"] or {}
                    children = parent.setdefault("children", {})
                    existing = {c.get("name", "") for c in children.values()}
                    new_name = _unique_name(new_name, existing)
                    rel_parts = entry["rel"].split("/")
                    parent_rel = "/".join(rel_parts[:-1])
                    token = secrets.token_hex(8)
                    frame_disk = r["base"] / (f"{parent_rel}/{token}" if parent_rel else token)
                    frame_disk.parent.mkdir(parents=True, exist_ok=True)
                    frame_disk.write_bytes(enc)
                    children[token] = {"type": "file", "name": new_name, "size": len(entry["data"]),
                                        "locked_at": datetime.now().isoformat()}
                    save_tree_manifest(r["base"], r["manifest"], self.dek)
                    meta["files"][entry["vid"]]["size"] = manifest_dir_size(r["manifest"])
                    save_meta(meta, self.is_decoy, self.dek)
                    new_rel = f"{parent_rel}/{token}" if parent_rel else token
                    return {"ok": True, "name": new_name, "vid": entry["vid"], "rel": new_rel}
            else:
                return {"ok": False, "error": "Unknown action"}
        except Exception as e:
            return {"ok": False, "error": str(e)}


def _unique_name(name, existing_names):
    """Appends ' (2)', ' (3)', ... before the extension until `name`
    doesn't collide with anything in `existing_names`."""
    if name not in existing_names:
        return name
    stem, ext = os.path.splitext(name)
    n = 2
    while f"{stem} ({n}){ext}" in existing_names:
        n += 1
    return f"{stem} ({n}){ext}"


def _parse_timestamp(ts):
    """Parses 'HH:MM:SS.mmm', 'MM:SS', or a bare number of seconds into
    float seconds. Returns None if unparseable."""
    if isinstance(ts, (int, float)):
        return float(ts)
    ts = str(ts).strip()
    if not ts:
        return None
    try:
        if ":" not in ts:
            return float(ts)
        parts = ts.split(":")
        parts = [float(p) for p in parts]
        while len(parts) < 3:
            parts.insert(0, 0.0)
        h, m, s = parts[-3], parts[-2], parts[-1]
        return h * 3600 + m * 60 + s
    except Exception:
        return None
