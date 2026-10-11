#!/bin/bash
# One-shot macOS (Apple Silicon) setup: ComfyUI + ComfyUI-GGUF + Qwen-Image-2.1 weights.
# Tested on M4 Pro / 48 GB.
#
#   ./scripts/setup_mac.sh                 # base model + Turbo (~17 GB of downloads)
#   ./scripts/setup_mac.sh --uncensored    # + abliterated text encoder (~9 GB more,
#                                          #   builds a 17.5 GB BF16 encoder file)
#
# Re-running is safe: existing clones are updated (git pull) and finished
# downloads are skipped. Override quants with TURBO_QUANT=Q8_0 (or Q4_K_M), and
# set HF_ENDPOINT=https://hf-mirror.com if huggingface.co's CDN stalls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

UNCENSORED=0
for arg in "$@"; do
  case "$arg" in
    --uncensored) UNCENSORED=1 ;;
    *) echo "unknown option: $arg"; exit 1 ;;
  esac
done
TURBO_QUANT="${TURBO_QUANT:-Q6_K}"
HF="${HF_ENDPOINT:-https://huggingface.co}"

if ! command -v git >/dev/null; then echo "git not found"; exit 1; fi
PY="python3.13"
command -v "$PY" >/dev/null || { echo "python3.13 not found (torch wheels target max 3.13, 3.14 has none yet)"; exit 1; }

cd "$ROOT"
# Qwen-Image-2.1 Turbo needs a current ComfyUI (fused-MLP DiT detection,
# ManualSigmas) -- update existing clones instead of skipping them.
if [ -d ComfyUI ]; then git -C ComfyUI pull --ff-only; else git clone https://github.com/comfyanonymous/ComfyUI.git; fi
if [ -d ComfyUI/custom_nodes/ComfyUI-GGUF ]; then git -C ComfyUI/custom_nodes/ComfyUI-GGUF pull --ff-only
else git clone https://github.com/city96/ComfyUI-GGUF.git ComfyUI/custom_nodes/ComfyUI-GGUF; fi
[ -d ComfyUI/.venv ] || "$PY" -m venv ComfyUI/.venv
ComfyUI/.venv/bin/python -m pip install --upgrade pip
ComfyUI/.venv/bin/python -m pip install --upgrade torch -r ComfyUI/requirements.txt -r ComfyUI/custom_nodes/ComfyUI-GGUF/requirements.txt

# fetch <repo> <path-in-repo> <dest-dir>: resumable, skips finished files.
fetch() {
  local dest="$3/$(basename "$2")"
  if [ -f "$dest" ]; then echo "have $dest"; return; fi
  mkdir -p "$3"
  # Earlier versions of this script saved repo subpaths nested
  # (models/vae/vae/...); move those into place instead of re-downloading.
  if [ -f "$3/$2" ]; then mv "$3/$2" "$dest"; echo "moved $3/$2 -> $dest"; return; fi
  echo "downloading $1/$2"
  curl -fL --retry 5 -C - -o "$dest.part" "$HF/$1/resolve/main/$2"
  mv "$dest.part" "$dest"
}

M=ComfyUI/models
# Base Qwen-Image-2.1
fetch Abiray/Qwen-Image-2.1-GGUF qwen_image_2.1_Q4_K_M.gguf "$M/unet"
fetch Comfy-Org/Qwen-Image-2.1 text_encoders/qwen3vl_8b_w4a8.safetensors "$M/text_encoders"
fetch Comfy-Org/Qwen-Image-2.1 vae/qwen_image_2.1_vae_bf16.safetensors "$M/vae"
# Qwen-Image-2.1-Turbo (8-step distilled DiT; same encoder + VAE)
fetch Abiray/Qwen-Image-2.1-Turbo-GGUF "qwen_image_2.1_turbo_${TURBO_QUANT}.gguf" "$M/unet"

if [ "$UNCENSORED" = 1 ]; then
  # AtomicChat's abliterated encoder, converted into a ComfyUI-native encoder
  # (see scripts/build_uncensored_encoder.py for why the GGUF can't be used as-is).
  OUT="$M/text_encoders/qwen3vl_8b_abliterated_bf16.safetensors"
  if [ ! -f "$OUT" ]; then
    fetch AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF Qwen-Image-2.1-Turbo-Abliterated-Uncensored-Q8_0.gguf "$ROOT/downloads"
    ComfyUI/.venv/bin/python scripts/build_uncensored_encoder.py \
      --gguf downloads/Qwen-Image-2.1-Turbo-Abliterated-Uncensored-Q8_0.gguf \
      --vision "$M/text_encoders/qwen3vl_8b_w4a8.safetensors" \
      --out "$OUT"
    echo "Built $OUT -- you can delete downloads/ now."
  else
    echo "have $OUT"
  fi
fi

echo "Done. Start ComfyUI with ./scripts/start_comfyui_mac.sh, serve the UI with"
echo "python3 scripts/serve_app.py, then browse to http://127.0.0.1:8080 and pick a model."
