# Qwen-Image-2.1 Playground

Local image generation with [Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1) (7B DiT, unified text→image and image edit, native text rendering and RGBA) via **ComfyUI**, driven by a dependency-free web UI for **macOS (Apple Silicon)** and **Windows 11 (AMD ROCm)**.

![Example output](docs/images/qwen21_demo_00001_.png)

> A cozy bookshop cafe at golden hour, sunlight streaming through tall windows, a cat sleeping on a stack of books, a chalkboard sign that reads "QWEN IMAGE 2.1" — 1024×1024, 40 steps, ~550 s on an M4 Pro (first run, models loaded from disk).

## What's inside

| Path | Purpose |
|---|---|
| `app/` | Web UI (vanilla HTML/CSS/ES modules, no build step) — talks to ComfyUI's HTTP + WebSocket API |
| `scripts/` | macOS setup & start scripts |
| `docs/` | Platform guides: [macOS](docs/MACOS.md) · [Windows 11 + AMD 7900 XTX](docs/WINDOWS_AMD.md) |
| `docs/workflow_t2i_comfyui_template.json` | Official ComfyUI T2I workflow template |

## Quick start

1. Install + download weights (~11 GB):
   - **macOS:** `./scripts/setup_mac.sh` — full guide: [docs/MACOS.md](docs/MACOS.md)
   - **Windows 11 + RX 7900 XTX:** official ComfyUI Desktop or portable (AMD ROCm auto-selected) — full guide: [docs/WINDOWS_AMD.md](docs/WINDOWS_AMD.md)
2. Start ComfyUI on port 8188 (macOS: `./scripts/start_comfyui_mac.sh`).
3. Open `app/index.html` in a browser and generate (⌘/Ctrl+Enter). The page validates node availability against the running server and shows ComfyUI errors verbatim.

## Which quant fits your machine

| Hardware | DiT | Text encoder | Peak memory |
|---|---|---|---|
| Mac 24–48 GB unified | GGUF `Q4_K_M` (4.2 GB) | `qwen3vl_8b_w4a8` (6.3 GB) | ~14 GB |
| Mac 64 GB+ unified | GGUF `Q8_0` (7.6 GB) | `w4a8` / `int8_convrot` | ~18 GB |
| 7900 XTX 24 GB | GGUF `Q6_K` (5.9 GB) | `qwen3vl_8b_w4a8` | ~12–14 GB |

## Results

All runs use euler / simple / cfg 1.0 (FLUX-style), negative prompt empty.

| # | Image | Prompt | Size | Steps | Hardware | Backend | Seed | Total time |
|---|---|---|---|---|---|---|---|---|
| 1 | ![Apple smoke](docs/images/apple_gguf_smoke_512.png) | a red apple | 512×512 | 8 | M4 Pro, 48 GB | MPS, GGUF Q4_K_M | 42 | ~116 s (incl. first model load) |
| 2 | (graph validation render, not archived) | an orange cat sitting on a yellow bookshelf | 512×512 | 8 | M4 Pro, 48 GB | MPS, GGUF Q4_K_M | 42 | ~56 s |
| 3 | ![Bookshop cafe](docs/images/qwen21_demo_00001_.png) | cozy bookshop cafe…chalkboard reads "QWEN IMAGE 2.1" | 1024×1024 | 40 | M4 Pro, 48 GB | MPS, GGUF Q4_K_M | 7 | ~550 s (≈13.5 s/step) |

Main output, full size:

![Bookshop cafe result](docs/images/qwen21_demo_00001_.png)

## License note

Qwen-Image-2.1 is released under the **Qwen Research License** — non-commercial use only unless you obtain a separate commercial license from Alibaba.

## Security notes

- ComfyUI listens only on `127.0.0.1:8188`; slots are looked up via the app's `POST /prompt`/`/interrupt` rather than trusting the client UI.
- The web UI is fully offline: no external assets; never uses `innerHTML`/eval for server- or user-derived data; a strict CSP meta policy restricts `connect-src`/`img-src` to localhost:8188; `fetch`/`WS` requests use `AbortController` with reconnection backoff.
