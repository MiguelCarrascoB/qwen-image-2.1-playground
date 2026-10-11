# Qwen-Image-2.1 Turbo + uncensored text encoder

The playground has a **Model** selector with three presets:

| Preset | DiT (denoiser) | Text encoder | Sampling |
|---|---|---|---|
| Qwen-Image-2.1 | `qwen_image_2.1_Q4_K_M.gguf` (base) | stock `qwen3vl_8b_w4a8` | KSampler, your steps / scheduler |
| Qwen-Image-2.1 Turbo (8 steps) | `qwen_image_2.1_turbo_<quant>.gguf` | stock `qwen3vl_8b_w4a8` | fixed 8-step schedule, CFG 1 |
| Turbo + uncensored encoder | same Turbo DiT | `qwen3vl_8b_abliterated_bf16` (built locally) | fixed 8-step schedule, CFG 1 |

Each preset lists candidate quants (Q8_0 → Q6_K → Q5_K_M → Q4_K_M) and the UI
uses the first one the server has, so the Mac and the PC can hold different
quants. If a preset's files are missing, the hint under the selector says
which ones.

## What the two Hugging Face repos actually are

- **[Qwen/Qwen-Image-2.1-Turbo](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo)**
  is the official 8-step distilled checkpoint: the same 7B DiT architecture,
  CFG 1, with its own fixed sigma schedule. The repo itself is a diffusers
  checkpoint (~32 GB, CUDA-oriented). We use the ComfyUI-native GGUF quants of
  it from [`Abiray/Qwen-Image-2.1-Turbo-GGUF`](https://huggingface.co/Abiray/Qwen-Image-2.1-Turbo-GGUF),
  made by the same quantizer as the base GGUF this repo already runs. The text
  encoder and VAE are unchanged from Qwen-Image-2.1.
- **[AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF)**
  is **not an image model**. It's only the **text encoder** (Qwen3-VL-8B) with
  its refusal direction projected out ("abliterated"), packaged for
  stable-diffusion.cpp. It has to be paired with a Turbo DiT.
  - Its own model card says that **on images it changed nothing they could
    measure**. The open Qwen-Image pipeline has no safety filter, and the
    stock encoder already draws every sensitive category they tested (0 of 45
    prompts flipped). Pictures shift slightly (LPIPS ≈ 0.08, about a sixth of
    a new seed), and that happens equally on neutral prompts.
  - What the DiT never learned to draw, no encoder can add.
  - Treat it as an experiment, not an unlock.

### Why the uncensored encoder gets converted

ComfyUI treats a text encoder as the Qwen-Image-2.1 encoder (Qwen3-VL-8B) only
when its vision-tower tensors are present. The AtomicChat GGUF has the
language model only (its vision tower is a separate `mmproj`), and
ComfyUI-GGUF does not attach an `mmproj` for `qwen3vl`. Loaded directly, it
would be detected as a plain Qwen3-8B and routed to the wrong encoder.

[`scripts/build_uncensored_encoder.py`](../scripts/build_uncensored_encoder.py)
fixes that. It takes every language-model tensor from the abliterated GGUF
(dequantized to BF16) and the unmodified vision tower from your stock
`qwen3vl_8b_w4a8.safetensors`. It writes one file in the exact layout of
Comfy-Org's `qwen3vl_8b_bf16.safetensors`, which the core `CLIPLoader` loads
like the stock encoder. Edit mode keeps working because the vision tower is
included. The output is **17.5 GB** (BF16, the same size as Comfy-Org's
stock `qwen3vl_8b_bf16`). The conversion takes under a minute and needs about
10 GB of RAM (mostly memory-mapped input) plus the free disk space.

## Turbo sampling

Turbo must use its distilled schedule. Without it, ComfyUI's normal scheduler
produces a different (worse) image. The Turbo presets therefore build
`ManualSigmas → KSamplerSelect(euler) → SamplerCustom` instead of `KSampler`,
with the sigmas from the checkpoint's `model_index.json`
(`sample_sigmas` plus a final 0; scheduler shift is 1.0):

```
1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0
```

While a Turbo preset is selected, the UI pins Steps to 8 and disables
Steps / CFG / Scheduler / Denoise (CFG is pinned to 1). Your own step count and CFG come back
when you switch to the base model. Qwen recommends ~2 MP output for Turbo
(e.g. 1536 or 2048 square). 1024 is a good fast default.

## Setup

### Windows 11 + RX 7900 XTX (24 GB)

ComfyUI must already be installed per [WINDOWS_AMD.md](WINDOWS_AMD.md). Then,
from this repo in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1              # Turbo Q8_0 (7.6 GB)
powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -Uncensored  # + encoder (8.7 GB download, 17.5 GB built)
```

Options:

| Option | Effect |
|---|---|
| `-ComfyDir D:\ComfyUI` | ComfyUI install location (default `%USERPROFILE%\Documents\ComfyUI`) |
| `-ModelsDir …` | Models folder, for a ComfyUI Desktop data folder that lives elsewhere |
| `-TurboQuant Q6_K` | Use a smaller Turbo quant |
| `-Mirror` | Download through hf-mirror.com (the HF CDN stalled on this PC before) |

The script `git pull`s ComfyUI and ComfyUI-GGUF. Turbo needs a current ComfyUI.
ComfyUI Desktop updates itself, so update it from its menu instead.

### macOS (M4 Pro, 48 GB)

```bash
./scripts/setup_mac.sh                 # base + Turbo Q6_K (5.9 GB)
./scripts/setup_mac.sh --uncensored    # + encoder (8.7 GB download, 17.5 GB built)
TURBO_QUANT=Q8_0 ./scripts/setup_mac.sh
```

### Memory

| Machine | Turbo | Turbo + uncensored encoder |
|---|---|---|
| RX 7900 XTX 24 GB | Q8_0 DiT 7.6 GB + w4a8 encoder 6.3 GB: ~12–14 GB peak, the same as base | 17.5 GB encoder + 7.6 GB DiT don't fit in 24 GB together. ComfyUI moves the encoder to system RAM after encoding, so it needs ~18 GB free RAM and adds reload time when the prompt changes. |
| M4 Pro 48 GB | ~15 GB | ~27 GB unified memory; close other heavy apps |

Then start ComfyUI as usual. On Windows:
`python main.py --port 8188 --use-pytorch-cross-attention --enable-cors-header http://127.0.0.1:8080`.
On the Mac: `./scripts/start_comfyui_mac.sh`. Serve the UI with
`python scripts/serve_app.py`, open `http://127.0.0.1:8080`, and pick the
model.

## Verification status

**Not yet run on GPU hardware.** This was set up from a GPU-less dev box. What
was checked:

- **Graphs:** all six graphs (3 presets × text→image / edit), built by the
  app's own `api.js`, were accepted by ComfyUI's `/prompt` validation
  (ComfyUI master 2026-10-10 + ComfyUI-GGUF). That covers node types, input
  names, sigma string and filenames.
- **Turbo DiT:** the real `qwen_image_2.1_turbo_Q4_K_M.gguf` loads through
  `UnetLoaderGGUF`, and ComfyUI detects it as `QwenImage21` (32 blocks). A
  2-step `euler` pass with Turbo sigmas through ComfyUI's `sample_custom` (the
  code path `SamplerCustom` uses) returned finite latents on CPU. Random
  conditioning was used, so this proves loading and wiring, not image quality.
- **UI:** driven in headless Chromium against that ComfyUI:
  - Model switching pins and unlocks Steps / CFG / Scheduler / Denoise, and the
    choice survives a reload.
  - Switching back to base restores your own step count.
  - Generate posts `SamplerCustom` with the exact sigma list.
  - The page threw no JS errors.
- **Converter:** run end to end on the real Q8_0 GGUF + stock w4a8 file
  (35 s). Results:
  - The output's 750 keys, shapes and dtypes match Comfy-Org's
    `qwen3vl_8b_bf16` header exactly, and ComfyUI's own `detect_te_model`
    identifies it as `QWEN3VL_8B`.
  - Against the stock BF16 encoder:

    | Tensors | Cosine | Max abs diff | Meaning |
    |---|---|---|---|
    | Vision tower, norms | 1.0 | 0 (bit-exact) | copied unchanged |
    | Untouched weights (`q_proj`, `k_proj`, `gate_proj`) | 0.99998 | ~0.002 | Q8_0 rounding |
    | Residual writers (`o_proj`, `down_proj`) | 0.9999 | up to 0.024 | the abliteration edit |
- **Not checked:** actual image quality and speed. The dev box has no GPU and
  11 GB of RAM, so the full 17.5 GB encoder couldn't be loaded there.

### Smoke test (per machine)

1. Pick **Qwen-Image-2.1 Turbo**, prompt `a red apple on a wooden table, studio light`,
   512×512, seed 42. The hint under the selector should be the "Fixed 8-step"
   note, not "Not installed". Expect ~8 × 0.7 s of sampling warm on the 7900 XTX.
2. Same with **Turbo + uncensored encoder**. The image should be close to, but
   not identical to, step 1's.
3. Switch to **Edit image** with the result as reference and
   `make the apple green`, once per Turbo preset.

Add the times to the Results table in the README.
