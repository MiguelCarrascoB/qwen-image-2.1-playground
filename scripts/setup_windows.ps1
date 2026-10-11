<#
  Windows 11 + AMD ROCm: update ComfyUI and download Qwen-Image-2.1 Turbo
  (and optionally the abliterated "uncensored" text encoder).

  Assumes ComfyUI is already installed per docs/WINDOWS_AMD.md (Option B
  portable clone with venv\, or ComfyUI Desktop with .venv\).

    powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
    powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -Uncensored
    powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -ComfyDir D:\ComfyUI -TurboQuant Q6_K
    powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -Mirror   # use hf-mirror.com

  Re-running is safe: finished downloads are skipped, partial ones resume.
#>
param(
  [string]$ComfyDir = "$env:USERPROFILE\Documents\ComfyUI",
  [string]$ModelsDir = "",
  [string]$TurboQuant = "Q8_0",
  [switch]$Uncensored,
  [switch]$Mirror
)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
if (-not $ModelsDir) { $ModelsDir = Join-Path $ComfyDir "models" }
# huggingface.co's CDN has stalled on this machine before; hf-mirror.com worked.
$Hf = if ($Mirror) { "https://hf-mirror.com" } else { "https://huggingface.co" }

if (-not (Test-Path $ComfyDir)) { throw "ComfyUI not found at $ComfyDir (pass -ComfyDir)" }
$Py = @("$ComfyDir\venv\Scripts\python.exe", "$ComfyDir\.venv\Scripts\python.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Py) { throw "No venv python under $ComfyDir (expected venv\ or .venv\)" }

# Turbo needs a current ComfyUI (fused-MLP DiT detection, ManualSigmas).
# ComfyUI Desktop updates itself; only pull git clones.
foreach ($dir in @($ComfyDir, "$ComfyDir\custom_nodes\ComfyUI-GGUF")) {
  if (Test-Path "$dir\.git") {
    Write-Host "git pull $dir"
    git -C $dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull failed in $dir" }
  }
}
if (-not (Test-Path "$ComfyDir\custom_nodes\ComfyUI-GGUF")) {
  git clone https://github.com/city96/ComfyUI-GGUF.git "$ComfyDir\custom_nodes\ComfyUI-GGUF"
}
# Never let pip touch the ROCm torch wheels: no --upgrade, install only what's
# missing (ComfyUI's requirements leave torch unpinned). ComfyUI Desktop keeps
# its own requirements, so only pass files that exist.
$reqs = @("$ComfyDir\requirements.txt", "$ComfyDir\custom_nodes\ComfyUI-GGUF\requirements.txt") |
  Where-Object { Test-Path $_ } | ForEach-Object { "-r"; $_ }
if ($reqs) {
  & $Py -m pip install @reqs
  if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
}

function Fetch([string]$RepoId, [string]$Path, [string]$DestDir) {
  $dest = Join-Path $DestDir (Split-Path $Path -Leaf)
  if (Test-Path $dest) { Write-Host "have $dest"; return }
  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
  Write-Host "downloading $RepoId/$Path"
  # Windows PowerShell 5.1 turns curl's stderr progress meter into a terminating
  # error under -ErrorAction Stop, so relax it for the native call only.
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  curl.exe -fL --retry 5 -C - -o "$dest.part" "$Hf/$RepoId/resolve/main/$Path"
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "download failed: $RepoId/$Path (re-run to resume, or add -Mirror)" }
  Move-Item -Force "$dest.part" $dest
}

# Shared encoder + VAE (already present if the base model works) and the Turbo DiT.
Fetch "Comfy-Org/Qwen-Image-2.1" "text_encoders/qwen3vl_8b_w4a8.safetensors" "$ModelsDir\text_encoders"
Fetch "Comfy-Org/Qwen-Image-2.1" "vae/qwen_image_2.1_vae_bf16.safetensors" "$ModelsDir\vae"
Fetch "Abiray/Qwen-Image-2.1-Turbo-GGUF" "qwen_image_2.1_turbo_$TurboQuant.gguf" "$ModelsDir\unet"

if ($Uncensored) {
  # AtomicChat's abliterated encoder -> ComfyUI-native BF16 encoder
  # (see scripts\build_uncensored_encoder.py for why the GGUF can't be used as-is).
  $out = "$ModelsDir\text_encoders\qwen3vl_8b_abliterated_bf16.safetensors"
  if (Test-Path $out) {
    Write-Host "have $out"
  } else {
    $dl = Join-Path $Repo "downloads"
    Fetch "AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF" "Qwen-Image-2.1-Turbo-Abliterated-Uncensored-Q8_0.gguf" $dl
    # Same PS 5.1 stderr quirk as the downloads: torch/ROCm warnings must not abort.
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $Py "$Repo\scripts\build_uncensored_encoder.py" `
      --gguf "$dl\Qwen-Image-2.1-Turbo-Abliterated-Uncensored-Q8_0.gguf" `
      --vision "$ModelsDir\text_encoders\qwen3vl_8b_w4a8.safetensors" `
      --out $out 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { throw "encoder conversion failed" }
    Write-Host "Built $out -- you can delete $dl now."
  }
}

Write-Host ""
Write-Host "Done. Start ComfyUI:"
Write-Host "  cd $ComfyDir"
Write-Host "  $Py main.py --port 8188 --use-pytorch-cross-attention --highvram --enable-cors-header http://127.0.0.1:8080"
Write-Host "then: python scripts\serve_app.py  and open http://127.0.0.1:8080, pick a model."
