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
  // emits three outputs: [0] positive, [1] negative, [2] latent (verified on
  // 2026-09-20 against the live server and the official edit template).
  TEXT_ENCODE_TYPE: "TextEncodeQwenImage21",
  KSAMPLER_TYPE:    "KSampler",
  CFG_NORM_TYPE:    null,        // cfg = 1.0 for Qwen-Image-2.1, no CFGNorm needed
  VAE_DECODE_TYPE:  "VAEDecode",
  SAVE_IMAGE_TYPE:  "SaveImage",
  FILENAME_PREFIX:  "qwen21",

  // --- Image edit -----------------------------------------------------------
  // The same TextEncodeQwenImage21 node powers text→image and image edit. For
  // edits, reference images go into its autogrow `images` inputs (API keys
  // `images.image_1` … `images.image_16`) together with the optional `vae`, and
  // its third output (`latent`, sized to the first reference) seeds KSampler.
  // No VAEEncode / ImageScaleToTotalPixels is needed — the node resizes refs to
  // the `resolution` pixel budget itself. Verified end-to-end on the RX 7900 XTX.
  LOAD_IMAGE_TYPE:   "LoadImage",     // LoadImage -> encoder `images.image_N`
  EDIT_FILENAME_PREFIX: "qwen21_edit",
  EDIT_MAX_IMAGES:   16,              // server advertises image_1 … image_16
  EDIT_DENOISE:      1.0,             // edits start from an empty latent; refs live in conditioning
  // Upload constraints enforced client-side before POST /upload/image.
  // The UI uploads under a randomized `prefix<uuid>.<ext>` name with overwrite
  // off, so a user filename can never overwrite an existing input file.
  UPLOAD: {
    type: "input",
    prefix: "qwen21_ref_",
    maxBytes: 20 * 1024 * 1024,
    // Raster formats only — no SVG/HTML, which load as documents, not images.
    accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"],
  },

  // --- Sampler defaults (UI can override) ----------------------------------
  SAMPLER_NAME: "euler",
  SCHEDULER:    "simple",
  DENOISE:      1.0,

  // --- UI defaults ----------------------------------------------------------
  DEFAULTS: {
    mode: "t2i",                     // "t2i" | "edit"
    prompt: "A cozy cabin in a snowy forest at dusk, warm light in the windows, cinematic lighting",
    editInstruction: "Describe the change here, e.g. \u201cmake the jacket bright red, keep the pose and background\u201d",
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
