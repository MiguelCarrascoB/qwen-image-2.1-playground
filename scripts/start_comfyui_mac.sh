#!/bin/bash
# Start ComfyUI (Qwen-Image-2.1 playground) on macOS.
# Prereqs: ./setup_mac.sh has created ComfyUI/.venv and downloaded weights.
# --enable-cors-header is required: the UI is served from a different origin
# (e.g. http://127.0.0.1:8080) and ComfyUI otherwise rejects cross-origin
# requests with HTTP 403.
set -euo pipefail
cd "$(dirname "$0")/../ComfyUI"
exec ./.venv/bin/python main.py --port 8188 --enable-cors-header "$@"
