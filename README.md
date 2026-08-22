<div align="center">
  <h1>🔐 VaultLock</h1>
  <p><strong>A native desktop vault that actually encrypts your files — not just hides them.</strong></p>
  <p><em>AES‑256 encryption · hidden folder names · a decoy vault with its own nuke password · AI face grouping — all in one distraction‑free window.</em></p>
  <p>
    <a href="#-getting-started"><img src="https://img.shields.io/badge/platform-Windows-0A0A0C?style=for-the-badge&logo=windows&logoColor=white" alt="Platform"/></a>
    <a href="#-tech-stack"><img src="https://img.shields.io/badge/python-3.11+-3D5AFE?style=for-the-badge&logo=python&logoColor=white" alt="Python"/></a>
    <a href="#-security-model"><img src="https://img.shields.io/badge/encryption-AES--256--CTR%20%2B%20HMAC-1FAE63?style=for-the-badge&logo=letsencrypt&logoColor=white" alt="Encryption"/></a>
    <a href=".github/workflows/build-windows.yml"><img src="https://img.shields.io/badge/build-PyInstaller%20%2B%20GitHub%20Actions-17181D?style=for-the-badge&logo=githubactions&logoColor=white" alt="Build"/></a>
  </p>
  <br/>
  <p>
    <img src="https://img.shields.io/badge/-Every%20byte%20encrypted%20at%20rest-0A0A0C?style=flat-square" alt=""/>
    <img src="https://img.shields.io/badge/-Zero%20telemetry%2C%20zero%20cloud-0A0A0C?style=flat-square" alt=""/>
    <img src="https://img.shields.io/badge/-Runs%20fully%20offline-0A0A0C?style=flat-square" alt=""/>
  </p>
</div>

<br>

> **VaultLock** is a private photo/video/file vault built as a real desktop app — not a browser tab, not a wrapped website. Everything you lock away is encrypted with AES‑256‑CTR + HMAC‑SHA‑256 before it ever touches disk, and folder/file *names* are hidden too, so someone browsing your storage directly sees nothing but random tokens and ciphertext.

<br>

## ✨ Why VaultLock

Most "vault" or "file locker" apps just rename a file or move it into a hidden folder — the content sits on disk in the clear the entire time. VaultLock doesn't do that.

| | |
|---|---|
| 🔒 **Real encryption, not obfuscation** | Every file is AES‑256‑CTR encrypted with an HMAC‑SHA‑256 integrity tag *before* the plaintext is deleted — never the other way around. |
| 🕵️ **Names and structure disappear too** | Locking a folder tokenizes every file/folder name on disk. The real names live only in an encrypted manifest, decrypted in memory for the length of your session. |
| 🎭 **A second, fully independent vault** | The decoy vault has its own password and its own encryption key — it cannot be used to derive or unlock the real one. |
| 💣 **A silent panic button** | A third password wipes the real vault instantly and drops you into an empty one. No warning dialog, no trace, nothing an onlooker would notice. |
| 🧠 **AI that runs locally** | Face grouping, duplicate detection, and privacy metadata scanning all run on‑device — nothing is uploaded anywhere. |
| 🪟 **Feels native, because it is** | Built on `pywebview` over the OS's own WebView2 engine — one chrome‑less window, no Electron, no background browser process. |

<br>

## 📋 Table of Contents

- [Feature Tour](#-feature-tour)
- [Security Model](#-security-model)
- [Screenshots](#-screenshots)
- [Getting Started](#-getting-started)
- [Choosing Where the Vault Lives](#-choosing-where-the-vault-lives)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Building a Standalone .exe](#-building-a-standalone-exe)
- [Troubleshooting](#-troubleshooting)
- [Roadmap Ideas](#-roadmap-ideas)
- [License](#-license)

<br>

## 🧭 Feature Tour

<table>
<tr>
<td width="33%" valign="top">

### 🗂️ Organize

- Lock individual files <strong>or entire folders</strong>, nested to any depth
- Move / copy items between folders — root ↔ folder, folder ↔ folder
- Batch rename with numbering, separators, and preview-before-apply
- Custom folder thumbnails, drag‑to‑reorder, grid & list views
- Full‑window lightbox with keyboard navigation

</td>
<td width="33%" valign="top">

### 🤖 Smart Tools

- <strong>Face grouping</strong> — on‑device clustering groups photos by the people in them
- <strong>Duplicate finder</strong> across the whole vault
- <strong>Privacy scan &amp; scrub</strong> — strip GPS/EXIF metadata from photos and videos before you ever share them
- <strong>AI image upscale</strong> for old or low‑res photos
- <strong>Video frame extraction</strong> — by timestamp, interval, FPS, or every‑Nth‑frame
- Auto‑generated <strong>mosaic backgrounds</strong> built from your own vault photos

</td>
<td width="33%" valign="top">

### 🛡️ Privacy & Stealth

- <strong>Decoy vault</strong> with an entirely separate password and encryption key
- <strong>Nuke password</strong> — instant, silent wipe of the real vault
- <strong>Quick‑hide</strong> (<code>Ctrl+Shift+H</code>) — cover the window instantly
- Automatic <strong>privacy screen</strong> on window blur / screen‑share detection
- <strong>Auto‑lock</strong> after inactivity
- Move your entire vault to any drive — internal, external, or NAS

</td>
</tr>
</table>

Plus: Favorites, Albums, a "Your Text" secure notes board, video snapshot capture, and a background job system with cancel/progress for anything long‑running (face scans, frame extraction, upscaling).

<br>

## 🔐 Security Model

Everything below is what's actually implemented — no marketing gloss.

```
┌─────────────────────────────────────────────────────────────────┐
│  Your password                                                    │
│      │                                                             │
│      ▼  PBKDF2‑HMAC‑SHA256, 480,000 iterations                     │
│  Key‑Encryption Key (KEK)                                          │
│      │                                                             │
│      ▼  unwraps                                                    │
│  Data‑Encryption Key (DEK)  ── random 256‑bit, generated once ──   │
│      │        per vault, NEVER stored in the clear                 │
│      ▼                                                             │
│  AES‑256‑CTR encrypt + HMAC‑SHA256 integrity tag                   │
│      │                                                             │
│      ▼                                                             │
│  Ciphertext on disk, random token filename, plaintext deleted      │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | What happens |
|---|---|
| **File content** | Encrypted with AES‑256‑CTR + HMAC‑SHA‑256 before it ever touches the vault folder. The plaintext copy is deleted the instant the encrypted copy is safely written. |
| **File & folder names** | Locking a folder replaces every file/folder name on disk with a random token. The real names and tree structure live only inside an encrypted manifest (`_index.enc`), decrypted in memory for the duration of your session. Point File Explorer straight at the vault folder and you'll see nothing but tokens and ciphertext. |
| **Thumbnails** | Cached previews are encrypted the same way as the originals — there's no unencrypted "shortcut" copy sitting on disk anywhere. |
| **The encryption key** | A random 256‑bit key generated once per vault, wrapped with a PBKDF2‑derived key (480,000 iterations) from your password, and unwrapped into memory only after a successful login. |
| **Decoy vault** | Uses a completely independent encryption key from the real vault — one can't be used to derive or reveal the other. |
| **Changing your password** | Only re‑wraps the encryption key — your files are never re‑encrypted, so this stays fast no matter how much is in the vault. |

> **No back door, on purpose.** If you forget your master password and don't have the decoy password either, nothing in the vault is recoverable. That's the trade‑off of real encryption instead of obfuscation.

<br>

## 🖼️ Screenshots

<div align="center">
<img src="docs/screenshots/gallery.png" width="32%" alt="Gallery view" />
<img src="docs/screenshots/faces.png" width="32%" alt="Face groups" />
<img src="docs/screenshots/organize.png" width="32%" alt="Move / copy between folders" />
</div>

<sub>Drop your own screenshots into `docs/screenshots/` and update the paths above — this is a private vault app, so none are bundled by default.</sub>

<br>

## 🚀 Getting Started

### Option A — Run from source

```bash
git clone https://github.com/<your-username>/VaultLock.git
cd VaultLock
pip install -r requirements.txt
python main.py
```

Or on Windows, just double‑click **`launch_vaultlock.bat`** — it installs dependencies automatically and starts the app.

### Option B — Download a build

Every tagged release (`v*`) is built automatically by [GitHub Actions](.github/workflows/build-windows.yml) into a standalone Windows executable — grab it from the **Releases** tab, no Python required.

**Requirements:** Windows 10/11 with the Edge WebView2 Runtime (already installed on almost all modern Windows machines — see [Troubleshooting](#-troubleshooting) if not).

<br>

## 📁 Choosing Where the Vault Lives

By default, everything is stored under your Windows profile. To use a different drive:

- **First run** — the setup screen has a **Storage location** field with a **Choose…** button. Point it at an internal drive, external/USB drive, or NAS mount before creating your vault.
- **Anytime after** — go to **Settings → Storage → Change location…** to move an existing vault (with everything already in it) to a new drive. It copies everything to the new location first, then removes the old copy — safe even on a vault that's already full.

A tiny pointer file (a few bytes — just *where* your vault is, nothing from inside it) stays under `%APPDATA%\VaultLock\`. The actual encrypted files go wherever you choose.

<br>

## 🏗️ Architecture

```
┌──────────────────────────┐        JS API bridge        ┌───────────────────────────┐
│   frontend/  (UI layer)   │ ───────────────────────────▶│   main.py  (Api class)     │
│   index.html / app.js /   │◀─────────────────────────── │   window + bridge wiring   │
│   style.css — single‑page │        JSON responses        └─────────────┬─────────────┘
│   app, no framework       │                                            │
└──────────────┬────────────┘                                            ▼
               │  streams media over                          ┌───────────────────────────┐
               │  localhost, token‑gated                       │   vault_core.py            │
               ▼                                               │   encryption engine,       │
┌──────────────────────────┐                                   │   manifest/tree storage,   │
│  media_server.py           │◀──────────────────────────────  │   face AI, privacy tools    │
│  local‑only HTTP server,   │        decrypts on demand        └───────────────────────────┘
│  decrypts + streams thumbs │
└──────────────────────────┘
```

- **`frontend/`** — the entire UI, a hand‑rolled single‑page app (no React/Vue) talking to Python only through `window.pywebview.api`.
- **`main.py`** — creates the native window and exposes every backend action to the frontend as a plain async‑callable method.
- **`vault_core.py`** — the actual engine: encryption/decryption, encrypted tree manifests, face clustering, duplicate detection, privacy scrubbing, batch operations, background job tracking.
- **`media_server.py`** — a `127.0.0.1`‑only server that decrypts images/video on the fly and streams them to the UI, gated behind a per‑session token so nothing is ever reachable from outside the app.

<br>

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [`pywebview`](https://pywebview.flowrl.com/) over Edge WebView2 |
| Encryption | AES‑256‑CTR + HMAC‑SHA‑256 (`cryptography`), PBKDF2 key wrapping |
| Password hashing | `bcrypt` |
| Image processing | `Pillow` |
| Video processing / face AI | `opencv-python`, `numpy` |
| Packaging | `PyInstaller` + GitHub Actions (cloud Windows build, zero setup needed) |
| Frontend | Vanilla HTML / CSS / JS — no framework, no bundler, no build step |

<br>

## 📂 Project Structure

```
VaultLock/
├── main.py                     entry point — creates the window, exposes the API to JS
├── vault_core.py                encryption engine, storage, face AI, privacy tools
├── media_server.py               localhost‑only server that decrypts + streams media
├── frontend/
│   ├── index.html                 shell + launch animation
│   ├── app.js                       all UI logic (single‑page app)
│   └── style.css                    design system / styling
├── vaultlock.spec                PyInstaller build spec
├── build_exe.bat                 one‑click local Windows build
├── launch_vaultlock.bat          one‑click run (installs deps first)
├── requirements.txt
└── .github/workflows/
    └── build-windows.yml         CI: builds + releases the .exe on every version tag
```

<br>

## 📦 Building a Standalone .exe

```bash
pip install -r requirements.txt pyinstaller
pyinstaller vaultlock.spec
```

Or just push a version tag (`git tag v1.0.0 && git push --tags`) and let [GitHub Actions](.github/workflows/build-windows.yml) build it on a real cloud Windows machine and attach it to a GitHub Release automatically — no Windows PC of your own required.

<br>

## 🩹 Troubleshooting

<details>
<summary><strong>"maximum recursion depth exceeded" / <code>window.native.AccessibilityObject...</code> on startup</strong></summary>

<br>

This happens when `pywebview` falls back to the old, deprecated Internet Explorer engine (MSHTML) instead of the modern Edge WebView2 engine — MSHTML has a known bug where its accessibility tree recurses into itself forever.

The root cause is `pywebview`'s own detection logic: it additionally requires an old **.NET Framework 4.6.2** registry key that often doesn't exist on modern Windows setups — so it silently falls back to MSHTML even on PCs that already have WebView2 properly installed.

VaultLock works around this directly: it makes `pywebview` skip that legacy check and use the system's real WebView2 runtime, and it verifies the WebView2 installation itself before starting. If WebView2 genuinely isn't installed, you'll get a clear popup with a download link instead of a crash: [get WebView2](https://go.microsoft.com/fwlink/p/?LinkId=2124703) — a small Microsoft system component, separate from the Edge browser, that's already on most Windows 11 machines.

</details>

<details>
<summary><strong>Files locked before the encryption update</strong></summary>

<br>

If you locked files before VaultLock's encrypted‑manifest format existed, those older items were stored unencrypted with real names on disk. VaultLock still opens and restores them correctly (it recognizes the older format automatically) — but for full protection, restore them and re‑lock them so they're rewritten in the current encrypted format.

</details>

<br>

## 🗺️ Roadmap Ideas

- [ ] Cross‑platform builds (macOS / Linux via `pywebview`'s other backends)
- [ ] Optional cloud‑encrypted backup (client‑side encrypted before upload)
- [ ] Biometric unlock (Windows Hello) as a convenience layer on top of the password
- [ ] Mobile companion app

Contributions and ideas are welcome — open an issue to discuss before sending a large PR.

<br>

## 📄 License

*No license file is currently bundled with this project — add a `LICENSE` file (MIT, Apache‑2.0, or whichever you prefer) before treating this as open source.*

<br>

---

<div align="center">
  <p><strong>Built for people who want their private files to actually stay private.</strong></p>
  <sub>VaultLock encrypts everything locally on your own machine. There is no cloud sync, no telemetry, and no way for anyone — including the developer — to access what's in your vault.</sub>
</div>
