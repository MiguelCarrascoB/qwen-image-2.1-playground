# macOS Setup (Apple Silicon)

Tested on **Apple M4 Pro, 48 GB unified memory, macOS 27**. Any Apple Silicon Mac with
16 GB+ unified memory works with the recommended quant; 24 GB+ is comfortable.

Qwen-Image-2.1 is an image model (7B DiT + Qwen3-VL 8B text encoder + VAE).
llama.cpp / LM Studio do **not** apply — the supported local path is **ComfyUI with
GGUF weights** (quantization is llama.cpp-style, the runtime is ComfyUI on PyTorch/MPS).

## One-shot install

```bash
./scripts/setup_mac.sh
```

What it does (≈11 GB downloads):
1. Clones ComfyUI and `city96/ComfyUI-GGUF` into `ComfyUI/custom_nodes/`
2. Creates a Python **3.13** venv (pip torch has no 3.14 wheels yet)
3. Downloads:
   - `Abiray/Qwen-Image-2.1-GGUF` → `qwen_image_2.1_Q4_K_M.gguf` (4.0 GB) → `models/unet/`
   - `Comfy-Org/Qwen-Image-2.1` → `qwen3vl_8b_w4a8.safetensors` (6.0 GB) → `models/text_encoders/`
   - `Comfy-Org/Qwen-Image-2.1` → `qwen_image_2.1_vae_bf16.safetensors` (644 MB) → `models/vae/`

## Run

```bash
./scripts/start_comfyui_mac.sh   # ComfyUI on http://127.0.0.1:8188 (CORS enabled)
python3 scripts/serve_app.py     # serve the playground UI (Cache-Control: no-store)
# then open http://127.0.0.1:8080
```

The bundled server sends `Cache-Control: no-store`, so CSS/ES modules are never
stale. With a plain `python3 -m http.server`, a hard reload (Cmd+Shift+R) may be
needed because browsers heuristically cache assets.

First generation after a server start is slow (~2 min: GGUF dequant + 6 GB text
encoder load). Subsequent generations run at roughly **13 s/step at 1024×1024** on
an M4 Pro.

## Manual install (if you prefer)

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git
git clone https://github.com/city96/ComfyUI-GGUF.git ComfyUI/custom_nodes/ComfyUI-GGUF
python3.13 -m venv ComfyUI/.venv
ComfyUI/.venv/bin/pip install --upgrade torch -r ComfyUI/requirements.txt -r ComfyUI/custom_nodes/ComfyUI-GGUF/requirements.txt
ComfyUI/.venv/bin/hf download Abiray/Qwen-Image-2.1-GGUF qwen_image_2.1_Q4_K_M.gguf --local-dir ComfyUI/models/unet
# + text encoder and VAE as listed above
ComfyUI/.venv/bin/python ComfyUI/main.py --port 8188
```

## Choosing a quant (24 vs 48 GB Macs)

| Unified memory | DiT GGUF | Text encoder |
|---|---|---|
| 16 GB | `Q3_K_M` (3.2 GB) | `w4a8` |
| 24–48 GB | `Q4_K_M` / `Q5_K_M` | `w4a8` |
| 64 GB+ | `Q8_0` (7.6 GB) | `int8_convrot` (9.4 GB) |

Notes:
- GGUF runs on MPS with on-the-fly dequant; no MLX runtime needed.
- An MLX 4-bit conversion (`toxicdog/Qwen-Image-2.1-MLX`, 10.7 GB) exists but currently
  requires a custom runtime — ComfyUI is the practical choice.
- Expected quality: Q4_K_M is visibly good; step up to Q6_K/Q8_0 if text rendering
  or fine detail looks degraded.
