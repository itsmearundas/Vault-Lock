# VaultLock — Desktop App (v3.0)

A real native desktop app — not a browser tab. It's built with **pywebview**,
which shows the UI using your OS's built-in web-rendering engine (Edge
WebView2 on Windows) inside a plain window: no address bar, no tabs, no
browser chrome. Same approach used by apps like Slack, VS Code, and Discord.

## Running it

1. Double-click `launch_vaultlock.bat` (installs dependencies automatically), or:
   ```
   pip install -r requirements.txt
   python main.py
   ```

## What's new vs. the previous (Tkinter) version

- **Everything happens in one window.** Opening a folder no longer pops up a
  separate window — it navigates in place, with a breadcrumb trail at the top
  (`My Vault > nested > sub`) and a Back button, just like a real gallery app.
- **Restore is available everywhere**, not just List view:
  - Hover any tile in Gallery view (or a row in List view) for quick actions:
    Open, Restore to original, Restore to folder…, Delete.
  - **Select mode** (top bar → "☑ Select") lets you multi-select files *and
    folders* together, then:
    - **Restore to original** — each item goes back where it came from.
    - **Restore to folder…** — pick one destination folder and every
      selected item is restored into it, regardless of where it originally
      came from.
    - **Delete** the selection.
  - "Restore All" in the top bar offers the same original-locations vs.
    one-chosen-folder choice for the entire vault at once.
- Real CSS: actual rounded corners, soft shadows, hover/press micro-animations,
  a proper full-window image/video lightbox with prev/next and keyboard
  arrows — the things Tkinter couldn't do.

## Security — what's actually encrypted

Everything placed in the vault is encrypted at rest — not just hidden:

- **File content**: every file (photos, videos, anything) is encrypted with
  **AES-256-CTR + HMAC-SHA256** before it ever touches the vault folder. The
  plaintext version is deleted the moment the encrypted copy is written.
- **Folder names and structure**: locking a folder doesn't just encrypt the
  files inside it — every file *and folder name* becomes a random token on
  disk. The real names and folder tree are recorded only in an encrypted
  manifest (`_index.enc`) inside it, decrypted in memory only while you're
  logged in. If you open the vault folder directly in File Explorer, you see
  meaningless random tokens and ciphertext — nothing that hints at what's
  inside or what anything is called.
- **Thumbnails**: cached preview images are encrypted the same way as the
  originals — there's no unencrypted "shortcut" version sitting on disk.
- **The encryption key itself** (a random 256-bit key, generated once per
  vault) is never stored in the clear. It's wrapped with a key derived from
  your password via PBKDF2 (480,000 iterations) and only unwrapped into
  memory after you log in successfully. The decoy vault uses a completely
  separate key from the real vault, so one can't be used to derive the other.
- Changing your master/decoy/nuke password re-wraps the encryption key under
  the new password — it doesn't touch or re-encrypt your actual files, so
  this is fast regardless of how much is in the vault.

**Trade-off worth knowing:** because this is *real* encryption and not just
hiding, there's no back door — if you forget your master password (and don't
have the decoy password either), there is no way to recover what's in the
vault. Nothing is recoverable without the correct password.

## File layout

```
main.py            entry point — creates the window, exposes the Api to JS
vault_core.py       storage + encryption engine (AES-256-CTR/HMAC, PBKDF2 key wrapping)
media_server.py     tiny localhost-only server that decrypts + streams thumbnails/media to the UI
frontend/
  index.html
  style.css
  app.js            all UI logic (single-page app, in-window navigation)
requirements.txt
launch_vaultlock.bat
```

Your vault lives in the same place as before (`%APPDATA%\.vaultlock_data`
by default, or wherever you've chosen — see below).

**Note on upgrading from an older copy:** if you already had files locked
before this encryption update, those older files/folders were stored
unencrypted with real names on disk. VaultLock still opens and restores them
correctly (it recognizes the older format automatically), but they won't
gain encryption/name-hiding retroactively — for full protection, restore
them and re-lock them so they're written using the new encrypted format.

## Notes

- The decoy and nuke passwords work exactly as before (nuke silently wipes
  the real vault and drops you into an empty one — no trace, no error shown).
- Video playback and thumbnailing require `opencv-python`; image handling
  requires `Pillow`. Both install automatically via `requirements.txt`.

## Choosing where the vault is stored

By default VaultLock stores everything under your Windows profile (the C:
drive). To use a different drive instead:

- **On first run**, the setup screen shows a "Storage location" field with a
  **Choose…** button — pick any drive or folder (a second internal drive, an
  external/USB drive, a NAS mount, etc.) before creating your vault.
- **Later on**, open **Settings → Storage → Change location…** to move an
  existing vault (with all its files) to a different drive at any time. This
  copies everything to the new location first, then removes it from the old
  one — safe to use even with a vault that already has data in it.

A tiny pointer file (a few bytes, just remembering *where* your vault is)
still lives on the C: drive under `%APPDATA%\VaultLock\` — but the actual
photos, videos, and files go wherever you choose.

## Troubleshooting

**"maximum recursion depth exceeded" / `window.native.AccessibilityObject...` on startup (Windows)**
This happens when pywebview falls back to the old, deprecated Internet
Explorer engine (MSHTML) instead of the modern Edge WebView2 engine — MSHTML
has a known bug where its accessibility tree recurses into itself forever.

The underlying cause turned out to be pywebview's own detection logic: it
additionally requires an old **.NET Framework 4.6.2** registry key that
often doesn't exist on modern Windows setups (which typically use a newer
.NET runtime under the hood) — so it would silently fall back to MSHTML
even on PCs that already have WebView2 properly installed.

VaultLock now works around this directly: it forces pywebview to skip that
broken legacy check and use the system's real WebView2 runtime, and it also
checks the WebView2 installation itself before starting. If WebView2 truly
isn't installed on your PC, you'll now get a clear popup with a download
link instead of the crash:
https://go.microsoft.com/fwlink/p/?LinkId=2124703
(This is a small Microsoft system component, separate from the Edge browser —
most Windows 11 PCs already have it.)
