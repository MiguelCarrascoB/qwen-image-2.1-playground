#!/bin/bash
# Start ComfyUI (Qwen-Image-2.1 playground) on macOS.
# Prereqs: ./setup_mac.sh has created ComfyUI/.venv and downloaded weights.
# CORS is required: the UI is served from a different origin (default
# http://127.0.0.1:8080) and ComfyUI otherwise rejects cross-origin requests
# with HTTP 403. Scope the header to that exact origin -- a bare
# --enable-cors-header answers "*", which lets any website read ComfyUI's files.
# Override the origin by passing your own, e.g.
#   ./scripts/start_comfyui_mac.sh --enable-cors-header http://127.0.0.1:8137
set -euo pipefail
cd "$(dirname "$0")/../ComfyUI"
exec ./.venv/bin/python main.py --port 8188 --enable-cors-header http://127.0.0.1:8080 "$@"
