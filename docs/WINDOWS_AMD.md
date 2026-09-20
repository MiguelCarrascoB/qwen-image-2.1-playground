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

:: Launch
python main.py --port 8188 --use-pytorch-cross-attention
```

Then open `app/index.html`.

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
