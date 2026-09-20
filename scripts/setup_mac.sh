#!/bin/bash
# One-shot macOS (Apple Silicon) setup: ComfyUI + ComfyUI-GGUF + Qwen-Image-2.1 weights.
# Tested on M4 Pro / 48 GB. ~11 GB of downloads.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v git >/dev/null; then echo "git not found"; exit 1; fi
PY="python3.13"
command -v "$PY" >/dev/null || { echo "python3.13 not found (torch wheels target max 3.13, 3.14 has none yet)"; exit 1; }

cd "$ROOT"
[ -d ComfyUI ] || git clone https://github.com/comfyanonymous/ComfyUI.git
[ -d ComfyUI/custom_nodes/ComfyUI-GGUF ] || git clone https://github.com/city96/ComfyUI-GGUF.git ComfyUI/custom_nodes/ComfyUI-GGUF
[ -d ComfyUI/.venv ] || "$PY" -m venv ComfyUI/.venv
ComfyUI/.venv/bin/python -m pip install --upgrade pip
ComfyUI/.venv/bin/python -m pip install --upgrade torch -r ComfyUI/requirements.txt -r ComfyUI/custom_nodes/ComfyUI-GGUF/requirements.txt

ComfyUI/.venv/bin/python - <<'EOF'
from huggingface_hub import hf_hub_download
hf_hub_download("Abiray/Qwen-Image-2.1-GGUF", "qwen_image_2.1_Q4_K_M.gguf",
                local_dir="ComfyUI/models/unet", local_dir_use_symlinks=False)
hf_hub_download("Comfy-Org/Qwen-Image-2.1", "text_encoders/qwen3vl_8b_w4a8.safetensors",
                local_dir="ComfyUI/models/text_encoders", local_dir_use_symlinks=False)
hf_hub_download("Comfy-Org/Qwen-Image-2.1", "vae/qwen_image_2.1_vae_bf16.safetensors",
                local_dir="ComfyUI/models/vae", local_dir_use_symlinks=False)
EOF

echo "Done. Start with ./scripts/start_comfyui_mac.sh, then open app/index.html"
