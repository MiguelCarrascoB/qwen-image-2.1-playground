# Qwen-Image-2.1 Playground

A polished, dependency-free frontend for generating images with **Qwen-Image-2.1**
via a local **ComfyUI** server (`http://127.0.0.1:8188`, GGUF checkpoint).
No build step, no CDNs, no external fonts — plain ES modules + CSS.

## Structure

```
app/
├── index.html      # Shell: header, status pill, setup banner, layout, CSP meta
├── styles.css      # Dark theme, CSS-variable tokens, responsive rules
├── README.md
└── js/
    ├── config.js   # All model filenames, node types, UI defaults, presets
    ├── api.js      # ComfyUI client: WS (reconnect+backoff), /prompt,
    │               # /interrupt, /history, /view, /upload/image, /object_info
    │               # validation, and the T2I + image-edit graph builders
    ├── ui.js       # DOM building, events, progress, gallery, metadata panel,
    │               # edit mode + reference uploads, localStorage persistence
    └── main.js     # Entry point — boots initUI()
```

## Running

ES modules require http(s) — `file://` will not work for `js/main.js`.
Serve statically from the repository root with the bundled no-cache server
(Python 3.12+, stdlib only):

```sh
python scripts/serve_app.py
# then open http://127.0.0.1:8080
```

It sends `Cache-Control: no-store`, so `styles.css` and the ES modules are
never stale. With a plain `python -m http.server`, a hard reload
(Ctrl/Cmd+Shift+R) may be needed because browsers heuristically cache assets.

**ComfyUI must be running** at `http://127.0.0.1:8188` with CORS enabled for the
UI's origin, e.g. `--enable-cors-header http://127.0.0.1:8080` (the UI is served
from a different origin; without the flag ComfyUI rejects cross-origin requests
with HTTP 403, and a bare flag opens CORS to every site), plus:
- `ComfyUI-GGUF` custom node installed
- `models/unet/qwen_image_2.1_Q4_K_M.gguf`
- `models/text_encoders/qwen3vl_8b_w4a8.safetensors`
- `models/vae/qwen_image_2.1_vae_bf16.safetensors`

On connect the app validates required node classes against `/object_info`
and warns (verbatim, monospace) if any are missing.

## Security notes

- **No `innerHTML` anywhere** — every server-derived or user-derived string is
  rendered via `textContent` / DOM APIs.
- Meta **CSP** restricts `connect-src` / `img-src` to `'self'` and
  `http://127.0.0.1:8188` (+ its `ws://` counterpart; `blob:`/`data:` for local
  upload previews) and adds `object-src 'none'` / `base-uri 'self'`. ES modules
  require http(s), so serve the page from `scripts/serve_app.py` — opening
  `index.html` via `file://` does not work.
- **Uploads** are limited to raster images (PNG/JPEG/WebP/GIF/BMP) of ≤20 MB,
  validated client-side before upload. Each file is sent under a random
  `qwen21_ref_<id>.<ext>` name with `overwrite=false`, so it cannot overwrite an
  existing ComfyUI input or escape its folder. Previews render in an `<img>`
  only — uploaded files are never loaded as documents/HTML.
- `localStorage` holds only UI settings (mode, prompt, edit instruction, negative
  prompt, size, steps, cfg, seed, seed-lock, sampler, scheduler, denoise, batch).
  Nothing sensitive is ever persisted; reference files are never stored.

## Features

- Live server/device panel — GPU name, free/total VRAM, ComfyUI + PyTorch version
- **Text → Image / Edit image** mode switch
- **Image edit**: drag & drop, click-to-browse, or Ctrl·⌘+V paste up to 16
  reference images (validated, thumbnailed, removable) plus an edit instruction;
  reuses the size / steps / CFG / seed / advanced controls. References upload to
  ComfyUI and drive `TextEncodeQwenImage21`'s autogrow `images` inputs; results
  record the mode + references so Apply / Re-run restores the whole edit
- Prompt, collapsible negative prompt, size presets + custom w/h
- Steps slider (live value), CFG, seed with 🎲 randomize + 🔓 lock toggle
- Advanced sampler / scheduler / denoise / batch controls, populated from the
  server's `/object_info` enums (defaults: euler + simple, denoise 1.0)
- Generate with step counter, ETA, monotonic progress bar, live queue position,
  and cancel (works for a running or a still-queued job)
- Result viewer with Open / Copy prompt / Apply / Re-run / Download actions
- Session gallery with lazy WebP thumbnails, per-image delete + clear
- Verbatim ComfyUI error display (monospace) with Copy / Dismiss
- Connection status pill — click to retry; auto-reconnect with backoff;
  setup-hint banner when the server is unreachable
- Reconciles with the server's live queue: flags a job still running on the GPU
  after a reload (with a stop button) and recovers its result into the gallery
- Accessible: ARIA live regions, focus-visible rings, `prefers-reduced-motion`
- Last-used settings (incl. seed and advanced options) restored from `localStorage`
