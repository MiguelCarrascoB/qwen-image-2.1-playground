/* ============================================================================
 * api.js — all communication with the local ComfyUI server.
 *
 * The base preset's workflow graphs were verified against a live ComfyUI
 * server; do not change node types, input names or wiring without re-testing.
 * ========================================================================== */

import { CONFIG } from "./config.js?v=5";

export const serverBase = CONFIG.SERVER.replace(/\/$/, "");

/* ============================================================================
 * Connection state + status listeners
 * ========================================================================== */

export const conn = {
  ws: null,
  // crypto.randomUUID() only exists in secure contexts (https / localhost).
  // Fall back so the whole app still boots when served over plain http.
  clientId: (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : "c" + Math.random().toString(36).slice(2) + Date.now().toString(36),
  connected: false,
  objectInfo: null,
  /** Set of callbacks (connected:boolean, extra?:string) => void */
  listeners: new Set(),
};

export function onConnectionChange(fn) {
  conn.listeners.add(fn);
  return () => conn.listeners.delete(fn);
}

function emitStatus(connected, extra) {
  const changed = connected !== conn.connected;
  conn.connected = connected;
  // Only notify on a real transition (or when there's detail to show). This
  // suppresses the duplicate checkConnection + ws.onopen notification that made
  // the UI refetch /system_stats and /queue twice per connect.
  if (!changed && !extra) return;
  for (const fn of conn.listeners) {
    try { fn(connected, extra); } catch { /* listener errors never break the loop */ }
  }
}

/* ============================================================================
 * WebSocket with reconnect + exponential backoff
 * ========================================================================== */

let wsBackoffMs = 1000;
const WS_BACKOFF_MAX_MS = 15000;
let wsReconnectTimer = null;
let wsIntentionalClose = false;

function wsUrl() {
  return serverBase.replace(/^http/, "ws") + "/ws?clientId=" + conn.clientId;
}

function scheduleReconnect() {
  if (wsIntentionalClose || wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    // Re-validate /object_info as well as the socket. Only checkConnection()
    // sets conn.objectInfo, so a socket-only reconnect would leave the UI
    // "Disconnected" forever after a transient outage.
    checkConnection();
  }, wsBackoffMs);
  wsBackoffMs = Math.min(WS_BACKOFF_MAX_MS, wsBackoffMs * 2);
}

function connectWs() {
  if (wsIntentionalClose) return;
  // Never stack sockets: an OPEN/CONNECTING socket already feeds handlers.
  if (conn.ws && (conn.ws.readyState === WebSocket.OPEN ||
                  conn.ws.readyState === WebSocket.CONNECTING)) return;
  try {
    conn.ws = new WebSocket(wsUrl());
  } catch (e) {
    emitStatus(false, "WS error: " + (e.message || e));
    scheduleReconnect();
    return;
  }
  conn.ws.onopen = () => {
    wsBackoffMs = 1000; // reset backoff on success
    // The status pill is driven by object_info; WS open alone is enough to
    // show "connected" only if object_info already succeeded.
    if (conn.objectInfo) emitStatus(true);
    else checkConnection(); // server came up after the last /object_info attempt
  };
  conn.ws.onclose = () => {
    emitStatus(false);
    scheduleReconnect();
  };
  conn.ws.onerror = () => { /* onclose always follows */ };
  conn.ws.onmessage = (event) => {
    if (typeof event.data !== "string") return; // binary previews — ignore
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    for (const fn of messageHandlers) {
      try { fn(msg); } catch { /* handler errors never break the loop */ }
    }
  };
}

export function onWsMessage(fn) {
  messageHandlers.add(fn);
  return () => messageHandlers.delete(fn);
}
const messageHandlers = new Set();

/** Close the current WS (if any) and reconnect immediately. Used by the
 * status-pill retry click. */
export function reconnectNow() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  // Tear down the old socket without letting its onclose schedule a competing
  // reconnect, then re-validate /object_info (which reopens the WS).
  wsIntentionalClose = true;
  if (conn.ws) {
    conn.ws.onopen = null;
    conn.ws.onmessage = null;
    conn.ws.onerror = null;
    conn.ws.onclose = null;
    try { conn.ws.close(); } catch { /* already closed */ }
    conn.ws = null;
  }
  wsIntentionalClose = false;
  wsBackoffMs = 1000;
  checkConnection(); // re-validate object_info + reopen WS
}

/* ============================================================================
 * /object_info validation + initial connect
 * ========================================================================== */

let inFlightCheck = null;

/** Fetch /object_info (AbortController-wrapped), validate node types, then
 * open the WebSocket. Safe to call repeatedly; concurrent calls share one
 * in-flight request. */
export async function checkConnection() {
  if (inFlightCheck) return inFlightCheck;
  inFlightCheck = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(serverBase + "/object_info", { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      conn.objectInfo = await res.json();
      const warnings = validateNodeTypes();
      emitStatus(true);
      connectWs();
      return { ok: true, warnings };
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === "AbortError" ? "timed out" : (e.message || String(e));
      emitStatus(false, "object_info unreachable: " + msg);
      scheduleReconnect(); // keep trying the WS side too
      return { ok: false, error: msg };
    } finally {
      inFlightCheck = null;
    }
  })();
  return inFlightCheck;
}

/** Returns a human-readable list of missing node classes (empty if all good).
 * Covers the nodes every preset needs; per-preset extras (Turbo sampler nodes,
 * the GGUF text-encoder loader) are reported by resolveModel(). */
export function validateNodeTypes() {
  const info = conn.objectInfo;
  if (!info) return [];
  const required = [
    CONFIG.UNET_LOADER_TYPE,
    CONFIG.CLIP_LOADER_TYPE,
    CONFIG.VAE_LOADER_TYPE,
    CONFIG.EMPTY_LATENT_TYPE,
    CONFIG.TEXT_ENCODE_TYPE,
    CONFIG.KSAMPLER_TYPE,
    CONFIG.VAE_DECODE_TYPE,
    CONFIG.SAVE_IMAGE_TYPE,
    // Image edit reuses the same encoder plus LoadImage for the references.
    CONFIG.LOAD_IMAGE_TYPE,
  ];
  if (CONFIG.CFG_NORM_TYPE) required.push(CONFIG.CFG_NORM_TYPE);
  return required.filter((t) => !(t in info));
}

/** Enum list of a loader input from /object_info (empty if unknown). */
function enumOf(nodeType, input) {
  const node = conn.objectInfo && conn.objectInfo[nodeType];
  const spec = node && node.input && node.input.required && node.input.required[input];
  return (spec && Array.isArray(spec[0])) ? spec[0] : [];
}

/** Resolve a preset to concrete files: the first candidate the server lists
 * wins. Returns { key, preset, unet, clip, missingFiles[], missingNodes[] }.
 * With no /object_info yet, falls back to the first candidate. */
export function resolveModel(key) {
  const k = CONFIG.MODELS[key] ? key : CONFIG.DEFAULT_MODEL;
  const preset = CONFIG.MODELS[k];
  const info = conn.objectInfo || {};
  const pick = (candidates, nodeType, input) => {
    const list = enumOf(nodeType, input);
    return { file: candidates.find((f) => list.includes(f)) || candidates[0], known: list.length > 0, list };
  };
  const unet = pick(preset.unet, CONFIG.UNET_LOADER_TYPE, "unet_name");
  const clip = pick(preset.clip, preset.clipLoader, "clip_name");
  const vae  = pick([CONFIG.VAE_NAME], CONFIG.VAE_LOADER_TYPE, "vae_name");

  const missingFiles = [];
  for (const [r, candidates] of [[unet, preset.unet], [clip, preset.clip], [vae, [CONFIG.VAE_NAME]]]) {
    if (r.known && !r.list.includes(r.file)) missingFiles.push(candidates.join(" | "));
  }
  const nodes = [preset.clipLoader];
  if (preset.sigmas) nodes.push(CONFIG.MANUAL_SIGMAS_TYPE, CONFIG.SAMPLER_SELECT_TYPE, CONFIG.SAMPLER_CUSTOM_TYPE);
  const missingNodes = conn.objectInfo ? nodes.filter((t) => !(t in info)) : [];
  return { key: k, preset, unet: unet.file, clip: clip.file, missingFiles, missingNodes };
}

/* ============================================================================
 * Graph construction — ComfyUI API-format graph (flat node map). The base
 * preset's wiring is VERBATIM from the verified single-file version; Turbo
 * presets only swap the loaders and replace KSampler with
 * ManualSigmas -> SamplerCustom (fixed 8-step schedule).
 * ========================================================================== */

/** Loader nodes ("unet", "clip", "vae") for the resolved preset. */
function addLoaders(add, m) {
  add("unet", CONFIG.UNET_LOADER_TYPE, { unet_name: m.unet });
  add("clip", m.preset.clipLoader, { clip_name: m.clip, type: CONFIG.CLIP_TYPE });
  add("vae",  CONFIG.VAE_LOADER_TYPE,  { vae_name: CONFIG.VAE_NAME });
}

/** Sampler node "ksampler" (output 0 = latent) for the resolved preset. */
function addSampler(add, m, p, latentRef, defaultDenoise) {
  let modelRef = ["unet", 0];
  if (CONFIG.CFG_NORM_TYPE) {
    add("cfgnorm", CONFIG.CFG_NORM_TYPE, { model: ["unet", 0] });
    modelRef = ["cfgnorm", 0];
  }

  if (m.preset.sigmas) {
    // Turbo: the distilled schedule replaces steps/scheduler/denoise.
    add("sigmas", CONFIG.MANUAL_SIGMAS_TYPE, { sigmas: m.preset.sigmas });
    add("samplerSelect", CONFIG.SAMPLER_SELECT_TYPE, { sampler_name: p.sampler || CONFIG.SAMPLER_NAME });
    add("ksampler", CONFIG.SAMPLER_CUSTOM_TYPE, {
      model: modelRef,
      add_noise: true,
      noise_seed: p.seed,
      cfg: p.cfg,
      positive: ["enc", 0],
      negative: ["enc", 1],
      sampler: ["samplerSelect", 0],
      sigmas: ["sigmas", 0],
      latent_image: latentRef,
    });
    return;
  }

  add("ksampler", CONFIG.KSAMPLER_TYPE, {
    seed: p.seed,
    steps: p.steps,
    cfg: p.cfg,
    sampler_name: p.sampler || CONFIG.SAMPLER_NAME,
    scheduler: p.scheduler || CONFIG.SCHEDULER,
    denoise: (p.denoise === undefined ? defaultDenoise : p.denoise),
    model: modelRef,
    positive: ["enc", 0],
    negative: ["enc", 1],
    latent_image: latentRef,
  });
}

export function buildGraph(p) {
  const g = {};
  const add = (id, classType, inputs) => { g[id] = { class_type: classType, inputs }; };
  const m = resolveModel(p.model);

  addLoaders(add, m);

  // Text encoding — single node, outputs [0]=positive, [1]=negative
  add("enc", CONFIG.TEXT_ENCODE_TYPE, {
    clip: ["clip", 0],
    prompt: p.prompt,
    negative_prompt: p.negPrompt,
    resolution: 1024,
  });

  // Latent — see CONFIG.EMPTY_LATENT_TYPE note re: 16ch vs 64ch variants.
  add("latent", CONFIG.EMPTY_LATENT_TYPE, { width: p.width, height: p.height, batch_size: p.batch || 1 });

  addSampler(add, m, p, ["latent", 0], CONFIG.DENOISE);

  add("decode", CONFIG.VAE_DECODE_TYPE, { samples: ["ksampler", 0], vae: ["vae", 0] });
  add("save", CONFIG.SAVE_IMAGE_TYPE, { images: ["decode", 0], filename_prefix: CONFIG.FILENAME_PREFIX });

  return g;
}

/** Image-edit graph. Reference images are uploaded first (see uploadImage);
 * each becomes a LoadImage feeding the encoder's autogrow `images.image_N`
 * inputs. The encoder's third output (`latent`, sized to the first reference)
 * seeds the sampler, so no EmptyLatentImage / VAEEncode is involved. Verified
 * end-to-end against the live server on 2026-09-20. */
export function buildEditGraph(p) {
  const g = {};
  const add = (id, classType, inputs) => { g[id] = { class_type: classType, inputs }; };
  const m = resolveModel(p.model);

  // Same loaders as the T2I path.
  addLoaders(add, m);

  // One LoadImage per reference + its `images.image_N` encoder input.
  const enc = {
    clip: ["clip", 0],
    prompt: p.instruction,
    negative_prompt: p.negPrompt || "",
    resolution: p.resolution,
    vae: ["vae", 0],
  };
  (p.images || []).forEach((img, i) => {
    const id = "ref" + (i + 1);
    add(id, CONFIG.LOAD_IMAGE_TYPE, { image: img.image });
    enc["images.image_" + (i + 1)] = [id, 0];
  });
  add("enc", CONFIG.TEXT_ENCODE_TYPE, enc);

  addSampler(add, m, p, ["enc", 2], CONFIG.EDIT_DENOISE);

  add("decode", CONFIG.VAE_DECODE_TYPE, { samples: ["ksampler", 0], vae: ["vae", 0] });
  add("save", CONFIG.SAVE_IMAGE_TYPE, { images: ["decode", 0], filename_prefix: CONFIG.EDIT_FILENAME_PREFIX });

  return g;
}

/** POST /upload/image as multipart/form-data. `serverName` is the randomized
 * on-disk name (the UI never reuses the user's filename, and overwrite is off,
 * so an upload can't clobber an existing input file). Resolves with the
 * server's `{name, subfolder, type}` and reports upload progress (0..1) when
 * the browser exposes it. Rejects with a message that includes the server body. */
export function uploadImage(file, serverName, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("image", file, serverName || file.name);
    form.append("type", CONFIG.UPLOAD.type);
    form.append("overwrite", "false");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", serverBase + "/upload/image", true);
    xhr.responseType = "text";
    xhr.timeout = 120000;
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON body */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error("HTTP " + xhr.status + " " + (xhr.statusText || "") +
          (data ? "\n" + JSON.stringify(data, null, 2) : (xhr.responseText ? "\n" + xhr.responseText : ""))));
      } else if (!data || !data.name) {
        reject(new Error("Upload response missing a filename:\n" + xhr.responseText));
      } else {
        resolve(data);
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed — is ComfyUI reachable at " + serverBase + "?"));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.send(form);
  });
}

/** `subfolder/name` reference accepted by LoadImage for an uploaded image. */
export function imageRef(data) {
  return data.subfolder ? data.subfolder + "/" + data.name : data.name;
}

/* ============================================================================
 * /prompt submission, /interrupt, /history, /view
 * ========================================================================== */

/** POST the graph to /prompt. Resolves with { promptId } or throws with a
 * message containing the verbatim ComfyUI error JSON. */
export async function submitPrompt(graph) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(serverBase + "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: conn.clientId }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body (proxy/HTML error) */ }

    if (!res.ok || !data || data.error) {
      // ComfyUI returns {error: {...}, node_errors: {...}} on rejection.
      const msg = (data && data.error)
        ? JSON.stringify(data, null, 2)
        : "HTTP " + res.status + " " + (res.statusText || "") + (text ? "\n" + text : "");
      throw new Error(msg);
    }
    if (!data.prompt_id) throw new Error("Server did not return a prompt_id:\n" + text);
    return { promptId: data.prompt_id };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the server to interrupt the currently running prompt. */
export async function interrupt(promptId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(serverBase + "/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
      signal: ctrl.signal,
    });
  } catch { /* best-effort */ } finally {
    clearTimeout(timer);
  }
}

/** Remove a queued (not-yet-running) job by prompt id. */
export async function cancelQueued(promptId) {
  if (!promptId) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(serverBase + "/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: ctrl.signal,
    });
  } catch { /* best-effort */ } finally {
    clearTimeout(timer);
  }
}

/** Fallback: pull the result images from /history/<promptId> if the WS
 * 'executed' event was missed. Returns an image array or null. */
export async function fetchHistoryImages(promptId) {
  if (!promptId) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(serverBase + "/history/" + encodeURIComponent(promptId), {
      signal: ctrl.signal,
    });
    const hist = await res.json();
    const entry = hist[promptId];
    if (entry && entry.outputs) {
      for (const nodeId of Object.keys(entry.outputs)) {
        const out = entry.outputs[nodeId];
        if (out.images && out.images.length) return out.images;
      }
    }
  } catch { /* keep waiting */ } finally {
    clearTimeout(timer);
  }
  return null;
}

/** Build a /view URL for an image descriptor {filename, subfolder, type}. */
export function viewUrl(img) {
  return serverBase + "/view?filename=" + encodeURIComponent(img.filename) +
    "&subfolder=" + encodeURIComponent(img.subfolder || "") +
    "&type=" + encodeURIComponent(img.type || "output");
}

/** Thumbnail URL for gallery tiles (ComfyUI renders a downscaled webp/jpeg). */
export function previewUrl(img, format = "webp", quality = 80) {
  return viewUrl(img) + "&preview=" + format + ";" + quality;
}

/** GET /system_stats — device + version info for the status panel. */
export async function fetchSystemStats() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(serverBase + "/system_stats", { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** GET /queue — { queue_running: [...], queue_pending: [...] }. */
export async function fetchQueue() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(serverBase + "/queue", { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Download an image by fetching it as a blob (works on file:// too, where
 * cross-origin download names are unreliable). */
export async function downloadImage(img) {
  const url = viewUrl(img);
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = img.filename || "image.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser time to start reading the blob before revoking it.
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch {
    window.open(url, "_blank");
  }
}
