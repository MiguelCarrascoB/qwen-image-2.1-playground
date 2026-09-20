/* ============================================================================
 * config.js — every model / node-type / file name lives here so it's trivial
 * to tweak. Values are copied verbatim from the verified single-file version
 * (../pruebaImage/index.html); do not "improve" them without re-testing
 * against the live ComfyUI server.
 *
 * Validation: on connect the app GETs /object_info and checks that these node
 * classes exist on the server, warning in the UI if any are missing.
 * ========================================================================== */

export const CONFIG = {
  SERVER: "http://127.0.0.1:8188",

  // --- Model files (edit if the installed filenames differ) -----------------
  UNET_GGUF: "qwen_image_2.1_Q4_K_M.gguf",          // ComfyUI-GGUF UnetLoaderGGUF
  // NOTE: verified against live /object_info on 2026-09-20 — the file on disk
  // uses underscores: qwen_image_2.1_Q4_K_M.gguf (the hyphenated
  // "qwen_image_2.1-Q4_K_M.gguf" from the prototype was rejected by the server).
  CLIP_NAME: "qwen3vl_8b_w4a8.safetensors",          // CLIPLoader, type "qwen_image"
  VAE_NAME:  "qwen_image_2.1_vae_bf16.safetensors",  // VAELoader

  // --- Loader node types ----------------------------------------------------
  UNET_LOADER_TYPE: "UnetLoaderGGUF",   // from ComfyUI-GGUF
  CLIP_LOADER_TYPE: "CLIPLoader",
  CLIP_TYPE: "qwen_image",
  VAE_LOADER_TYPE: "VAELoader",

  // --- Latent node ----------------------------------------------------------
  // ComfyUI's official Qwen-Image-2.1 T2I template uses EmptyLatentImage. The
  // model's internal latent is 64-channel at 16x downscale, but ComfyUI's
  // fix_empty_latent_channels() pads/rescales the empty 4-channel latent
  // automatically (all zeros), so EmptyLatentImage is correct here.
  EMPTY_LATENT_TYPE: "EmptyLatentImage",

  // --- Sampler / encode / decode / save ------------------------------------
  // TextEncodeQwenImage21 takes prompt + negative_prompt + resolution, and
  // emits two outputs: [0] positive cond, [1] negative cond (verified format).
  TEXT_ENCODE_TYPE: "TextEncodeQwenImage21",
  KSAMPLER_TYPE:    "KSampler",
  CFG_NORM_TYPE:    null,        // cfg = 1.0 for Qwen-Image-2.1, no CFGNorm needed
  VAE_DECODE_TYPE:  "VAEDecode",
  SAVE_IMAGE_TYPE:  "SaveImage",
  FILENAME_PREFIX:  "qwen21",

  // --- Sampler defaults (UI can override) ----------------------------------
  SAMPLER_NAME: "euler",
  SCHEDULER:    "simple",
  DENOISE:      1.0,

  // --- UI defaults ----------------------------------------------------------
  DEFAULTS: {
    prompt: "A cozy cabin in a snowy forest at dusk, warm light in the windows, cinematic lighting",
    negPrompt: "blurry, low quality, watermark, text",
    width: 1024,
    height: 1024,
    steps: 40,
    cfg: 1,
    seed: 42,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
    batch: 1,
  },

  // --- UI constants ---------------------------------------------------------
  MIN_SIZE: 512,
  MAX_SIZE: 2048,
  SIZE_STEP: 64,
  MIN_STEPS: 1,
  MAX_STEPS: 100,
  // Size presets shown as chips (square). "custom" reveals w/h inputs.
  SIZE_PRESETS: [512, 768, 1024, 1280, 1536],
};

/* localStorage key for last-used settings. Only non-sensitive UI settings are
 * persisted here (prompt, size, steps, cfg, seed-lock flag). */
export const STORAGE_KEY = "qwen21-playground-settings";
