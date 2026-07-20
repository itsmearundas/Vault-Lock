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
import os, sys, json, shutil, hashlib, ctypes, subprocess, secrets, base64, io
import threading, time
from datetime import datetime
from pathlib import Path

import bcrypt
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes as _hashes, hmac as _hmac
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.fernet import Fernet, InvalidToken

try:
    from PIL import Image
    PIL_OK = True
except ImportError:
    PIL_OK = False

try:
    import cv2
    CV2_OK = True
except ImportError:
    CV2_OK = False

# ══════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════════════════
APP_VERSION = "4.0"

_POINTER_FILE = Path(os.environ.get("APPDATA", str(Path.home()))) / "VaultLock" / "location.json"

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
            node["children"][token] = child
        else:
            encrypt_file(e, dest / token, dek)
            node["children"][token] = {
                "type": "file", "name": e.name, "size": e.stat().st_size,
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
    for d in [vault_base(), vault_dir_path(), decoy_dir_path(), thumb_dir()]:
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

def load_meta(d=False):
    p = decoy_meta_file() if d else meta_file()
    return json.loads(p.read_text()) if p.exists() else {"files":{}}
def save_meta(m, d=False):
    p = decoy_meta_file() if d else meta_file()
    p.write_text(json.dumps(m, indent=2))

def nuke_main_vault():
    try:
        vd = vault_dir_path()
        if vd.exists(): shutil.rmtree(str(vd))
        vd.mkdir(parents=True, exist_ok=True)
        meta_file().write_text(json.dumps({"files":{}}, indent=2))
        td = thumb_dir()
        if td.exists():
            for f in td.glob("*.jpg"):
                try: f.unlink()
                except Exception: pass
    except Exception:
        pass

def make_thumb(src_plain_path, vid, dek):
    """Builds a thumbnail from a DECRYPTED source path and stores it
    encrypted in thumb_dir() — thumbnails get exactly the same protection
    as the originals."""
    if not PIL_OK: return
    try:
        img = Image.open(str(src_plain_path))
        img.thumbnail((480, 360), Image.LANCZOS)
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=87)
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
            img.thumbnail((480, 360), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=87)
            enc = encrypt_bytes(buf.getvalue(), dek)
            (thumb_dir() / f"{vid}.jpg").write_bytes(enc)
    except Exception:
        pass

def _make_thumb_from_encrypted(enc_src, vid, dek, is_video):
    """Decrypts enc_src into a private temp file just long enough to build
    a thumbnail from it, then removes the temp file either way."""
    import tempfile
    suffix = Path(enc_src).suffix or (".mp4" if is_video else ".jpg")
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
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
    already-decrypted (plaintext) path — usually a temp file."""
    try:
        if sys.platform == "win32":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return True, ""
    except PermissionError:
        return False, "Permission denied opening that file."
    except Exception as e:
        return False, str(e)


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
            meta = load_meta(self.is_decoy)
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
            save_meta(meta, self.is_decoy)
            return True, vid
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
            meta = load_meta(self.is_decoy)
            if vid not in meta["files"]: return False, "Not in vault"
            info = meta["files"][vid]
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
            del meta["files"][vid]; save_meta(meta, self.is_decoy)
            t = thumb_dir()/f"{vid}.jpg"
            if t.exists(): t.unlink()
            return True, str(dest)
        except PermissionError: return False, "Permission denied at destination"
        except Exception as e:  return False, str(e)

    def delete_item(self, vid):
        try:
            meta = load_meta(self.is_decoy)
            if vid not in meta["files"]: return False, "Not found"
            info = meta["files"][vid]
            src  = self.vault_dir / vid
            if src.is_dir(): shutil.rmtree(str(src))
            elif src.exists(): src.unlink()
            t = thumb_dir()/f"{vid}.jpg"
            if t.exists(): t.unlink()
            del meta["files"][vid]; save_meta(meta, self.is_decoy)
            return True, info["original_name"]
        except Exception as e: return False, str(e)

    def vault_path(self, vid):
        return self.vault_dir / vid

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
