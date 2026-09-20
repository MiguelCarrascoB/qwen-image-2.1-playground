/* ============================================================================
 * api.js — all communication with the local ComfyUI server.
 *
 * The workflow-graph construction below is copied VERBATIM from the verified
 * single-file version (pruebaImage/index.html) — do not change node types,
 * input names or wiring without re-testing against the live server.
 * ========================================================================== */

import { CONFIG } from "./config.js";

export const serverBase = CONFIG.SERVER.replace(/\/$/, "");

/* ============================================================================
 * Connection state + status listeners
 * ========================================================================== */

export const conn = {
  ws: null,
  clientId: crypto.randomUUID(),
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
  conn.connected = connected;
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
    connectWs();
  }, wsBackoffMs);
  wsBackoffMs = Math.min(WS_BACKOFF_MAX_MS, wsBackoffMs * 2);
}

function connectWs() {
  if (wsIntentionalClose) return;
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
  if (conn.ws) { try { conn.ws.close(); } catch { /* already closed */ } }
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

/** Returns a human-readable list of missing node classes (empty if all good). */
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
  ];
  if (CONFIG.CFG_NORM_TYPE) required.push(CONFIG.CFG_NORM_TYPE);
  return required.filter((t) => !(t in info));
}

/* ============================================================================
 * Graph construction — ComfyUI API-format graph (flat node map). VERBATIM
 * from the verified single-file version.
 * ========================================================================== */

export function buildGraph(p) {
  const g = {};
  const add = (id, classType, inputs) => { g[id] = { class_type: classType, inputs }; };

  // Loaders
  add("unet",  CONFIG.UNET_LOADER_TYPE, { unet_name: CONFIG.UNET_GGUF });
  add("clip",  CONFIG.CLIP_LOADER_TYPE, { clip_name: CONFIG.CLIP_NAME, type: CONFIG.CLIP_TYPE });
  add("vae",   CONFIG.VAE_LOADER_TYPE,  { vae_name: CONFIG.VAE_NAME });

  // Text encoding — single node, outputs [0]=positive, [1]=negative
  add("enc", CONFIG.TEXT_ENCODE_TYPE, {
    clip: ["clip", 0],
    prompt: p.prompt,
    negative_prompt: p.negPrompt,
    resolution: 1024,
  });

  // Latent — see CONFIG.EMPTY_LATENT_TYPE note re: 16ch vs 64ch variants.
  add("latent", CONFIG.EMPTY_LATENT_TYPE, { width: p.width, height: p.height, batch_size: 1 });

  // Optional CFGNorm between model and sampler
  let modelRef = ["unet", 0];
  if (CONFIG.CFG_NORM_TYPE) {
    add("cfgnorm", CONFIG.CFG_NORM_TYPE, { model: ["unet", 0] });
    modelRef = ["cfgnorm", 0];
  }

  // Sampler
  add("ksampler", CONFIG.KSAMPLER_TYPE, {
    seed: p.seed,
    steps: p.steps,
    cfg: p.cfg,
    sampler_name: CONFIG.SAMPLER_NAME,
    scheduler: CONFIG.SCHEDULER,
    denoise: CONFIG.DENOISE,
    model: modelRef,
    positive: ["enc", 0],
    negative: ["enc", 1],
    latent_image: ["latent", 0],
  });

  add("decode", CONFIG.VAE_DECODE_TYPE, { samples: ["ksampler", 0], vae: ["vae", 0] });
  add("save", CONFIG.SAVE_IMAGE_TYPE, { images: ["decode", 0], filename_prefix: CONFIG.FILENAME_PREFIX });

  return g;
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
    const data = await res.json();

    if (!res.ok || data.error) {
      // ComfyUI returns {error: {...}, node_errors: {...}} on rejection.
      const msg = data.error
        ? JSON.stringify(data, null, 2)
        : "HTTP " + res.status + " " + (res.statusText || "");
      throw new Error(msg);
    }
    return { promptId: data.prompt_id };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the server to interrupt the currently running prompt. */
export async function interrupt() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(serverBase + "/interrupt", { method: "POST", signal: ctrl.signal });
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
    URL.revokeObjectURL(a.href);
  } catch {
    window.open(url, "_blank");
  }
}
