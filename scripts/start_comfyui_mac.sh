#!/bin/bash
# Start ComfyUI (Qwen-Image-2.1 playground) on macOS.
# Prereqs: ./setup_mac.sh has created ComfyUI/.venv and downloaded weights.
set -euo pipefail
cd "$(dirname "$0")/../ComfyUI"
exec ./.venv/bin/python main.py --port 8188 -- "$@"
