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
    │               # /interrupt, /history, /view, /object_info validation,
    │               # graph construction (verbatim from the verified prototype)
    ├── ui.js       # DOM building, events, progress, gallery, metadata panel,
    │               # localStorage persistence
    └── main.js     # Entry point — boots initUI()
```

## Running

ES modules require http(s) — `file://` will not work for `js/main.js`.
From this directory, serve statically with any server, e.g.:

```sh
cd app
python3 -m http.server 8080
# then open http://localhost:8080
```

**ComfyUI must be running** at `http://127.0.0.1:8188` with:
- `ComfyUI-GGUF` custom node installed
- `models/unet/diffusion_models/qwen_image_2.1-Q4_K_M.gguf`
- `models/text_encoders/qwen3vl_8b_w4a8.safetensors`
- `models/vae/qwen_image_2.1_vae_bf16.safetensors`

On connect the app validates required node classes against `/object_info`
and warns (verbatim, monospace) if any are missing.

## Security notes

- **No `innerHTML` anywhere** — every server-derived or user-derived string is
  rendered via `textContent` / DOM APIs.
- Meta **CSP** restricts `connect-src` / `img-src` to `'self'` and
  `http://127.0.0.1:8188` (+ its `ws://` counterpart).
  If you must open the page via `file://`, a commented-out relaxed CSP is
  included in `index.html` (local static serving is strongly preferred).
- `localStorage` holds only UI settings (prompt, size, steps, cfg, seed-lock).
  Nothing sensitive is ever persisted.

## Features

- Prompt, collapsible negative prompt, size presets + custom w/h
- Steps slider (live value), CFG, seed with 🎲 randomize + 🔓 lock toggle
- Generate with loading state, WS progress bar, elapsed timer, cancel (`/interrupt`)
- Result viewer with metadata panel (prompt, seed, steps, cfg, size, time, file)
- Session gallery with click-to-select and blob-based download
- Verbatim ComfyUI error display (monospace, pre-wrapped)
- Connection status pill — click to retry; auto-reconnect with backoff;
  setup-hint banner when the server is unreachable
- Last-used settings restored from `localStorage` on load
