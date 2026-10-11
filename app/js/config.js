/* ============================================================================
 * config.js — every model / node-type / file name lives here so it's trivial
 * to tweak. Values were verified against a live ComfyUI server (2026-09-20);
 * re-test with the server before changing them.
 *
 * Validation: on connect the app GETs /object_info and checks that these node
 * classes exist on the server, warning in the UI if any are missing.
 * ========================================================================== */

export const CONFIG = {
  SERVER: "http://127.0.0.1:8188",

  // --- Model files ----------------------------------------------------------
  // DiT + text-encoder filenames live in MODELS below (edit there if the
  // installed filenames differ). NOTE: verified against live /object_info on
  // 2026-09-20 — the base file on disk uses underscores:
  // qwen_image_2.1_Q4_K_M.gguf (the hyphenated "qwen_image_2.1-Q4_K_M.gguf"
  // from the prototype was rejected by the server).
  VAE_NAME:  "qwen_image_2.1_vae_bf16.safetensors",  // VAELoader, shared by all presets

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

  // --- Model presets --------------------------------------------------------
  // Each preset names candidate files in preference order; the first one the
  // server lists in the loader's /object_info enum is used, so a Mac with Q4
  // and a 7900 XTX with Q8 run the same UI unchanged. VAE is shared.
  //
  // Turbo is the 8-step distilled checkpoint (Qwen/Qwen-Image-2.1-Turbo). It
  // must run its own sigma schedule at CFG 1 — `sample_sigmas` from the
  // checkpoint's model_index.json plus a final 0 (scheduler shift is 1.0, so
  // the values are used as-is). KSampler can't take explicit sigmas, so Turbo
  // graphs use ManualSigmas -> SamplerCustom instead.
  //
  // "turbo-uncensored" swaps only the text encoder for AtomicChat's abliterated
  // Qwen3-VL-8B (refusal direction projected out). The denoiser is the same
  // Turbo DiT. AtomicChat ships it as a text-only GGUF for stable-diffusion.cpp,
  // which ComfyUI can't use as a Qwen-Image-2.1 encoder (no vision tower), so
  // scripts/build_uncensored_encoder.py converts it into this BF16 file, loaded
  // by the core CLIPLoader like the stock encoder.
  DEFAULT_MODEL: "base",
  MODELS: {
    base: {
      label: "Qwen-Image-2.1",
      unet: ["qwen_image_2.1_Q4_K_M.gguf", "qwen_image_2.1_Q6_K.gguf", "qwen_image_2.1_Q8_0.gguf"],
      clipLoader: "CLIPLoader",
      clip: ["qwen3vl_8b_w4a8.safetensors"],
      sigmas: null,                  // KSampler with the user's steps/scheduler
    },
    turbo: {
      label: "Qwen-Image-2.1 Turbo (8 steps)",
      unet: [
        "qwen_image_2.1_turbo_Q8_0.gguf", "qwen_image_2.1_turbo_Q6_K.gguf",
        "qwen_image_2.1_turbo_Q5_K_M.gguf", "qwen_image_2.1_turbo_Q4_K_M.gguf",
      ],
      clipLoader: "CLIPLoader",
      clip: ["qwen3vl_8b_w4a8.safetensors"],
      sigmas: "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0",
    },
    "turbo-uncensored": {
      label: "Turbo + uncensored encoder",
      unet: [
        "qwen_image_2.1_turbo_Q8_0.gguf", "qwen_image_2.1_turbo_Q6_K.gguf",
        "qwen_image_2.1_turbo_Q5_K_M.gguf", "qwen_image_2.1_turbo_Q4_K_M.gguf",
      ],
      clipLoader: "CLIPLoader",
      clip: ["qwen3vl_8b_abliterated_bf16.safetensors"],
      sigmas: "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0",
    },
  },
  // Turbo graph nodes (ComfyUI core).
  MANUAL_SIGMAS_TYPE:  "ManualSigmas",
  SAMPLER_SELECT_TYPE: "KSamplerSelect",
  SAMPLER_CUSTOM_TYPE: "SamplerCustom",

  // --- Memory ---------------------------------------------------------------
  // Start ComfyUI with --highvram so it keeps models in GPU memory after a job.
  // The playground then asks it to unload models and free VRAM once it has been
  // idle this many minutes (0 disables). Only runs while the tab is open.
  IDLE_UNLOAD_MINUTES: 5,

  // --- Sampler defaults (UI can override) ----------------------------------
  SAMPLER_NAME: "euler",
  SCHEDULER:    "simple",
  DENOISE:      1.0,

  // --- UI defaults ----------------------------------------------------------
  DEFAULTS: {
    mode: "t2i",                     // "t2i" | "edit"
    model: "base",                   // key of CONFIG.MODELS
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
