# Windows 11 Setup (AMD Radeon RX 7900 XTX, 24 GB)

Since January 2026, **native ROCm on Windows is officially supported** by both AMD
and ComfyUI — no ZLUDA, no DirectML, no WSL. The 7900 XTX (gfx1100) is on AMD's
supported list for PyTorch on Windows.

## Option A — ComfyUI Desktop (easiest, recommended)

1. Install the AMD **"PyTorch on Windows Edition" preview driver**
   (`25.20.01.17`) from AMD's release notes and reboot. Regular Adrenalin drivers
   do not expose ROCm.
2. Install [ComfyUI Desktop](https://www.comfy.org/download) (v0.7.0+). The
   installer auto-detects AMD and ships ROCm 7.1.1.
3. Download the weights (table below) into the corresponding `models/` folders of
   the ComfyUI data directory, and install the `ComfyUI-GGUF` node via ComfyUI-Manager.
4. Launch with `--use-pytorch-cross-attention` (set in Desktop settings or command line).

## Option B — Manual CLI install (Portable path)

Run in **cmd.exe** (`^` line continuations):

```bat
:: Python 3.12 is mandatory - the AMD Windows ROCm wheels are cp312 only
winget install Python.Python.3.12
cd %USERPROFILE%\Documents
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
py -3.12 -m venv venv
venv\Scripts\activate.bat
python -m pip install --upgrade pip

:: ROCm SDK + PyTorch wheels from repo.radeon.com (NOT pytorch.org; note %2B for "+")
pip install --no-cache-dir ^
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl ^
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl ^
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl ^
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz
pip install --no-cache-dir ^
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl ^
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl

:: ComfyUI deps + GGUF loader
pip install -r requirements.txt
git clone https://github.com/city96/ComfyUI-GGUF.git custom_nodes\ComfyUI-GGUF
git clone https://github.com/ltdrdata/ComfyUI-Manager.git custom_nodes\ComfyUI-Manager

:: Verify
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
:: expect: 2.9.1+rocm7.2.1 / True / AMD Radeon RX 7900 XTX

:: Launch (CORS is required by the web UI, which is served from a different
:: local origin; scope it to that origin -- not the bare flag, which opens CORS
:: to every website. Use :8137 if you serve the UI with --port 8137.)
python main.py --port 8188 --use-pytorch-cross-attention --enable-cors-header http://127.0.0.1:8080
```

Then serve `app/` over http (`python scripts\serve_app.py`) and open
`http://127.0.0.1:8080`. The bundled server sends `Cache-Control: no-store`, so
CSS/ES modules are never stale. With a plain `python -m http.server`, a hard
reload (Ctrl+Shift+R) may be needed because browsers heuristically cache assets.

## Model weights (24 GB VRAM plan)

Download into the ComfyUI directory root's `models/` subfolders:

| File | Repo | Size | Folder |
|---|---|---|---|
| `qwen_image_2.1_Q6_K.gguf` | `Abiray/Qwen-Image-2.1-GGUF` | 5.9 GB | `models/unet/` |
| `qwen3vl_8b_w4a8.safetensors` | `Comfy-Org/Qwen-Image-2.1` | 6.3 GB | `models/text_encoders/` |
| `qwen_image_2.1_vae_bf16.safetensors` | `Comfy-Org/Qwen-Image-2.1` | 0.7 GB | `models/vae/` |

Peak VRAM ≈ **12–14 GB** (encoder loads, encodes, then offloads before the DiT
loads). Fits in 24 GB with room for 1536–2048 px renders; `Q8_0` DiT also fits.
No `--lowvram` flags should be needed. If you prefer to skip GGUF entirely, the
Comfy-native quant pair (`qwen_image_2.1_int8_convrot.safetensors` + `qwen3vl_8b_int8_convrot.safetensors`)
goes into `models/diffusion_models/` and `models/text_encoders/`.

## Verified environment / results

First verified real GPU generation on Windows + ROCm:

| Item | Version |
|---|---|
| GPU | AMD Radeon RX 7900 XTX 24 GB (25.7 GB VRAM reported) |
| Driver | 32.0.31041.1004 |
| Python | 3.12.3 |
| ComfyUI | 0.37.0 (+ `ComfyUI-GGUF`) |
| PyTorch | 2.9.1+rocm7.2.1 (ROCm 7.2.1 Windows wheels, `repo.radeon.com`) |

- **Smoke test** — prompt "a red apple on a wooden table, studio light",
  512×512, 8 steps, CFG 1.0, seed 42, sampler `euler` / scheduler `simple`,
  GGUF `Q4_K_M` DiT + `qwen3vl_8b_w4a8` text encoder + `qwen_image_2.1_vae_bf16`.
- **Result** — total wall time **18.1 s** on the first (cold) run, including
  ~14 s of one-time model loading; steady-state sampler ~**0.6 s/step** at
  512×512. No errors. Output `qwen21_00001_.png`.
- **Launch** — `python main.py --port 8188 --enable-cors-header http://127.0.0.1:8080 --use-pytorch-cross-attention`.

## Why not ZLUDA / DirectML (2026 status)

| Option | Verdict |
|---|---|
| **Native ROCm on Windows** | Official, fastest, most stable — recommended |
| ZLUDA (`patientx/ComfyUI-Zluda`) | Legacy fallback; frozen on HIP SDK 6.4.2, HIPBLAS crashes, Defender false positives |
| DirectML | Dead end — `torch-directml` stuck on torch 2.3-era preview, fails on modern DiT ops |
| WSL2 ROCm | Works but superseded; extra complexity |

## Pitfalls

1. **Driver**: must be the AMD *preview* "PyTorch on Windows Edition" driver; do a
   clean (factory reset) install.
2. **Wheel source**: ROCm wheels exist only on `repo.radeon.com/rocm/windows/`;
   the `%2B` encoding of `+` in URLs matters.
3. **Python 3.12 only** for these wheels.
4. Always launch with `--use-pytorch-cross-attention` (documented perf inconsistency
   on 7900 XTX without it — ROCm issue #5834).
5. Keep ComfyUI updated same-day; Qwen-Image-2.1 loaders landed days before this guide.
6. The `Comfy-Org/Qwen-Image-2.1` repo was still being reorganized at write time —
   re-check exact filenames before downloading.
7. **Hugging Face CDN stalls**: `huggingface.co`'s CDN (`us.aws.cdn.hf.co`) hung
   while downloading the weights. Downloading via
   `https://hf-mirror.com/<repo>/resolve/main/<path>` worked and was fast. Also,
   when the app path contains a space, background download helpers may mishandle
   it — run them from a properly-quoted shell.
