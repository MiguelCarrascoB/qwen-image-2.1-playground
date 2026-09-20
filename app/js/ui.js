/* ============================================================================
 * ui.js — DOM construction, interaction wiring, gallery, progress, and
 * settings persistence.
 *
 * Sanitization rule: NO innerHTML / insertAdjacentHTML anywhere in this file
 * (or anywhere in the app). All server-derived or user-derived strings are
 * inserted via textContent or attribute values only.
 * ========================================================================== */

import { CONFIG, STORAGE_KEY } from "./config.js";
import {
  conn, onConnectionChange, checkConnection, reconnectNow, onWsMessage,
  buildGraph, submitPrompt, interrupt, cancelQueued, fetchHistoryImages,
  fetchSystemStats, fetchQueue, viewUrl, previewUrl,
  downloadImage, serverBase,
} from "./api.js";

const $ = (id) => document.getElementById(id);

const MAX_JOB_MS = 30 * 60 * 1000; // hard upper bound for a single job
const SETTINGS = loadSettings();

/* ============================================================================
 * Settings persistence (localStorage — non-sensitive UI settings only)
 * ========================================================================== */

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      prompt:     $("prompt").value,
      negPrompt:  $("negPrompt").value,
      width:      $("width").value,
      height:     $("height").value,
      steps:      $("steps").value,
      cfg:        $("cfg").value,
      seed:       $("seed").value,
      seedLocked: $("lockSeed").classList.contains("active"),
      sampler:    $("sampler").value,
      scheduler:  $("scheduler").value,
      denoise:    $("denoise").value,
      batch:      $("batch").value,
    }));
  } catch { /* private mode / quota — non-fatal */ }
}

/* ============================================================================
 * App state
 * ========================================================================== */

const state = {
  generating: false,
  currentPromptId: null,
  startTime: 0,
  elapsedTimer: null,
  maxSteps: 1,
  stepValue: 0,
  nodeEventCount: 0,
  historyFallbackTimer: null,
  historyFallbackTries: 0,
  watchdogTimer: null,
  queuePollTimer: null,
  statsPollTimer: null,
  lastParams: null, // parameters actually submitted for the in-flight job
  ownPromptIds: new Set(), // jobs this page submitted (never treated as foreign)
  recoveredIds: new Set(), // foreign jobs already pulled into the gallery
  busyPromptId: null, // foreign job currently running on the server
  gallery: [], // { filename, subfolder, type, prompt, seed, steps, width, height, elapsed, ts }
  selected: null,
};

/* ============================================================================
 * Tiny DOM helper — element(tag, props, ...children)
 * ========================================================================== */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v; // the ONLY text path
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

function fmtGiB(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  return (bytes / (1024 ** 3)).toFixed(1) + " GB";
}

function announce(text) { $("liveStatus").textContent = text; }

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/* ============================================================================
 * Status pill + setup-hint banner + server info
 * ========================================================================== */

function renderStatus(connected, extra) {
  const pill = $("statusPill");
  pill.classList.toggle("connected", connected);
  pill.classList.toggle("retrying", !connected);
  const where = serverBase.replace(/^https?:\/\//, "");
  $("statusText").textContent = connected ? "Connected" : "Disconnected";
  pill.title = (connected ? "Connected to ComfyUI at " : "ComfyUI unreachable at ") +
    where + (extra ? " · " + extra : "") + " — click to retry";
  $("setupBanner").classList.toggle("visible", !connected);
  $("generateBtn").disabled = state.generating || !connected;
  if (connected) {
    refreshServerInfo();
    startQueuePoll();
    refreshServerBusy();
  } else {
    stopQueuePoll();
    clearServerBusy();
    renderServerInfo(null);
  }
}

function renderServerInfo(stats) {
  const dev = stats && stats.devices && stats.devices[0];
  if (!dev) {
    $("serverBadge").textContent = conn.connected ? "connected" : "offline";
    $("deviceName").textContent = conn.connected ? "unknown" : "—";
    if (!conn.connected) {
      $("vramInfo").textContent = "—";
      $("comfyVersion").textContent = "—";
    }
    return;
  }
  const name = String(dev.name).replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*\w+$/, "").trim();
  $("serverBadge").textContent = String(dev.type || "device").toUpperCase();
  $("deviceName").textContent = name || "unknown";
  $("vramInfo").textContent = fmtGiB(dev.vram_free) + " free / " + fmtGiB(dev.vram_total);
  const sys = stats.system || {};
  const parts = [];
  if (sys.comfyui_version) parts.push("ComfyUI " + sys.comfyui_version);
  if (sys.pytorch_version) parts.push(sys.pytorch_version);
  $("comfyVersion").textContent = parts.join(" · ") || "—";
}

async function refreshServerInfo() {
  if (!conn.connected) { renderServerInfo(null); return; }
  try { renderServerInfo(await fetchSystemStats()); }
  catch { /* keep the previous snapshot */ }
}

function startStatsPolling() {
  if (state.statsPollTimer) return;
  state.statsPollTimer = setInterval(refreshServerInfo, 10000);
}

function renderModelInfo() {
  const info = conn.objectInfo || {};
  const reqOf = (node) => (info[node] && info[node].input && info[node].input.required) || {};
  const unetList = reqOf(CONFIG.UNET_LOADER_TYPE).unet_name ? reqOf(CONFIG.UNET_LOADER_TYPE).unet_name[0] : [];
  const clipList = reqOf(CONFIG.CLIP_LOADER_TYPE).clip_name ? reqOf(CONFIG.CLIP_LOADER_TYPE).clip_name[0] : [];
  const vaeList = reqOf(CONFIG.VAE_LOADER_TYPE).vae_name ? reqOf(CONFIG.VAE_LOADER_TYPE).vae_name[0] : [];
  const quant = (CONFIG.UNET_GGUF.match(/(Q\d[_A-Z0-9]*)/i) || [])[1] || "GGUF";
  $("modelName").textContent = "Qwen-Image-2.1 · " + quant;
  $("modelName").title = CONFIG.UNET_GGUF;

  const missing = [];
  if (unetList.length && !unetList.includes(CONFIG.UNET_GGUF)) missing.push(CONFIG.UNET_GGUF);
  if (clipList.length && !clipList.includes(CONFIG.CLIP_NAME)) missing.push(CONFIG.CLIP_NAME);
  if (vaeList.length && !vaeList.includes(CONFIG.VAE_NAME)) missing.push(CONFIG.VAE_NAME);
  return missing;
}

/* ============================================================================
 * Error box (verbatim ComfyUI errors, monospace, textContent only)
 * ========================================================================== */

function showError(msg) {
  $("errorBody").textContent = msg;
  $("errorBox").classList.add("active");
  $("errorBox").focus({ preventScroll: true });
}
function hideError() {
  $("errorBox").classList.remove("active");
}

/* ============================================================================
 * Generation controls + progress
 * ========================================================================== */

const CONTROL_IDS = [
  "prompt", "negPrompt", "width", "height", "steps", "cfg", "seed",
  "randomizeBtn", "lockSeed", "sampler", "scheduler", "denoise", "batch",
];

function setControlsDisabled(disabled) {
  for (const id of CONTROL_IDS) {
    const node = $(id);
    if (node) node.disabled = disabled;
  }
  for (const chip of $("sizePresets").children) chip.disabled = disabled;
  $("controls").setAttribute("aria-busy", String(disabled));
}

function setGenerating(on) {
  state.generating = on;
  if (on) clearServerBusy();
  $("generateBtn").disabled = on || !conn.connected;
  $("cancelBtn").classList.toggle("visible", on);
  $("cancelBtn").disabled = false;
  $("cancelBtn").textContent = "Cancel";
  $("progressBox").classList.toggle("active", on);
  $("progressBox").setAttribute("aria-busy", String(on));
  $("viewerOverlay").classList.toggle("hidden", !on);
  setControlsDisabled(on);
  if (!on) {
    $("queueStatus").textContent = "";
    $("queuePosition").textContent = "";
    $("stepCounter").textContent = "";
    $("eta").textContent = "";
    setPhase("");
    if (state.historyFallbackTimer) { clearTimeout(state.historyFallbackTimer); state.historyFallbackTimer = null; }
    if (state.watchdogTimer) { clearTimeout(state.watchdogTimer); state.watchdogTimer = null; }
  }
}

function startElapsedTimer() {
  state.startTime = performance.now();
  stopElapsedTimer();
  state.elapsedTimer = setInterval(() => {
    $("elapsed").textContent = ((performance.now() - state.startTime) / 1000).toFixed(1) + "s";
    updateEta();
  }, 100);
}
function stopElapsedTimer() {
  if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
}

function setPhase(text) { $("phase").textContent = text; }

/** Monotonic progress bar (never moves backwards) + ARIA value. */
function setProgress(pct, reset) {
  const bar = $("progressFill");
  const cur = reset ? 0 : (parseFloat(bar.style.width) || 0);
  const v = Math.max(0, Math.min(100, Math.max(cur, pct)));
  bar.style.width = v + "%";
  $("progressBar").setAttribute("aria-valuenow", String(Math.round(v)));
}

function bumpProgress() {
  state.nodeEventCount++;
  // Pre-sampler nodes fill the first 15% of the bar; real step events take over.
  setProgress(Math.min(15, state.nodeEventCount * 3));
}

function updateEta() {
  const el2 = $("eta");
  if (!state.generating || !state.stepValue || state.maxSteps <= state.stepValue) {
    if (state.stepValue && state.stepValue === state.maxSteps) el2.textContent = "";
    return;
  }
  const elapsed = (performance.now() - state.startTime) / 1000;
  const remain = elapsed * (state.maxSteps - state.stepValue) / state.stepValue;
  el2.textContent = "~" + Math.max(0, Math.round(remain)) + "s left";
}

function appendQueue(text) {
  const box = $("queueStatus");
  const lines = box.textContent ? box.textContent.split("\n") : [];
  lines.push(text);
  while (lines.length > 6) lines.shift();
  box.textContent = lines.join("\n");
}

function startQueuePoll() {
  if (state.queuePollTimer) return;
  updateQueue();
  state.queuePollTimer = setInterval(updateQueue, 3000);
}
function stopQueuePoll() {
  if (state.queuePollTimer) { clearInterval(state.queuePollTimer); state.queuePollTimer = null; }
}

async function updateQueue() {
  if (!conn.connected) return;
  try {
    const q = await fetchQueue();
    const running = q.queue_running || [];
    const pending = q.queue_pending || [];
    const total = running.length + pending.length;
    if (state.generating) {
      $("queuePosition").textContent = total
        ? "queue: " + pending.length + " pending, " + running.length + " running"
        : "";
      return;
    }
    // Idle: surface a job this page did not start (e.g. a run that kept going
    // after a reload, or another tab) so the user knows the GPU is active.
    const first = running[0] || pending[0];
    const pid = first && first[1];
    if (total && pid && !state.ownPromptIds.has(pid)) {
      setServerBusy(pid, running.length, pending.length);
    } else if (total === 0 && state.busyPromptId) {
      // The job we were tracking just left the queue — pull in its result.
      recoverForeign(state.busyPromptId);
    } else {
      clearServerBusy();
    }
  } catch { /* transient — ignore */ }
}

async function refreshServerBusy() { await updateQueue(); }

function setServerBusy(promptId, running, pending) {
  if (promptId) state.busyPromptId = promptId;
  const bits = [];
  if (running) bits.push(running + " running");
  if (pending) bits.push(pending + " pending");
  $("busyText").textContent = "ComfyUI is working on another job" +
    (bits.length ? " (" + bits.join(", ") + ")" : "") +
    " — the GPU may be active.";
  $("busyNotice").classList.remove("hidden");
}
function clearServerBusy() {
  state.busyPromptId = null;
  $("busyNotice").classList.add("hidden");
}

/** Pull a foreign job's result into the gallery once it finishes. */
async function recoverForeign(promptId, images) {
  if (!promptId || state.recoveredIds.has(promptId) || state.generating) return;
  state.recoveredIds.add(promptId);
  clearServerBusy();
  const imgs = (images && images.length) ? images : await fetchHistoryImages(promptId);
  if (imgs && imgs.length && !state.generating) {
    addGalleryItems(imgs, undefined);
    announce("Recovered a result from a job that finished after the page reloaded");
  }
}

/** Reset all run-related UI. Called on load and on bfcache restore so a
 * reloaded page never shows a stale "generating" state. */
function resetRunUI() {
  setGenerating(false);
  stopElapsedTimer();
  state.currentPromptId = null;
  state.stepValue = 0;
  setProgress(0, true);
  $("stepCounter").textContent = "";
  $("eta").textContent = "";
}

function finishGeneration() {
  stopElapsedTimer();
  setProgress(100);
  setGenerating(false);
  state.currentPromptId = null;
}

/* ============================================================================
 * WebSocket message handling
 * ========================================================================== */

function onServerMessage(msg) {
  const d = msg.data || {};
  const mine = (id) => !id || id === state.currentPromptId;

  // A job this page did not submit (kept running across a reload, or another
  // tab) — surface it instead of silently ignoring the events.
  const fid = d.prompt_id;
  const foreign = !!(fid && fid !== state.currentPromptId && !state.ownPromptIds.has(fid));
  if (foreign && !state.generating &&
      (msg.type === "execution_start" ||
       (msg.type === "executing" && d.node !== null) ||
       msg.type === "progress")) {
    setServerBusy(fid, null, null);
  }

  switch (msg.type) {
    case "status": {
      const q = d.status && d.status.exec_info ? d.status.exec_info.queue_remaining : null;
      if (q !== null && state.generating) appendQueue("status: queue_remaining=" + q);
      break;
    }
    case "execution_start":
      if (d.prompt_id === state.currentPromptId) {
        setPhase("executing…");
        announce("Executing");
        appendQueue("execution_start");
      }
      break;
    case "execution_cached":
      if (d.prompt_id === state.currentPromptId) appendQueue("execution_cached");
      break;
    case "executing": {
      if (d.node === null) {
        // Sentinel: this prompt finished (or errored). Wait for 'executed',
        // with a /history fallback if nothing arrives shortly.
        if (d.prompt_id === state.currentPromptId && state.generating) {
          setPhase("finalizing…");
          state.historyFallbackTries = 0;
          state.historyFallbackTimer = setTimeout(checkHistoryFallback, 1500);
        }
      } else if (d.prompt_id === state.currentPromptId) {
        setPhase("running node " + d.node);
        appendQueue("executing node: " + d.node + (d.display_node ? " (" + d.display_node + ")" : ""));
        bumpProgress();
      }
      break;
    }
    case "progress": {
      if (state.generating && d.max && mine(d.prompt_id)) {
        state.stepValue = d.value;
        state.maxSteps = d.max;
        setProgress(15 + (d.value / d.max) * 84);
        $("stepCounter").textContent = d.value + "/" + d.max;
        updateEta();
        setPhase("sampling step " + d.value + "/" + d.max);
      }
      break;
    }
    case "executed": {
      if (d.prompt_id === state.currentPromptId && d.output && d.output.images) {
        addGalleryItems(d.output.images, performance.now() - state.startTime);
        announce("Generation complete");
        finishGeneration();
      } else if (foreign && d.output && d.output.images) {
        recoverForeign(fid, d.output.images);
      }
      break;
    }
    case "execution_error": {
      if (d.prompt_id === state.currentPromptId) {
        showError("ComfyUI execution error:\n" + JSON.stringify(d, null, 2));
        announce("Generation failed");
        finishGeneration();
      } else if (foreign) {
        clearServerBusy();
      }
      break;
    }
    case "execution_interrupted":
      if (state.generating && mine(d.prompt_id)) {
        showError("Execution was interrupted.");
        announce("Generation cancelled");
        finishGeneration();
      } else if (foreign) {
        clearServerBusy();
      }
      break;
    case "execution_success":
      if (foreign) recoverForeign(fid);
      break;
  }
}

const HISTORY_FALLBACK_MAX_TRIES = 15; // ~30 s at 2 s intervals

async function checkHistoryFallback() {
  if (!state.generating || !state.currentPromptId) return;
  const images = await fetchHistoryImages(state.currentPromptId);
  if (images && state.generating) {
    addGalleryItems(images, performance.now() - state.startTime);
    announce("Generation complete");
    finishGeneration();
    return;
  }
  if (!state.generating) return;
  if (state.historyFallbackTries < HISTORY_FALLBACK_MAX_TRIES) {
    state.historyFallbackTries++;
    state.historyFallbackTimer = setTimeout(checkHistoryFallback, 2000);
  } else {
    // Terminal state: never leave the UI stuck "generating" forever.
    showError("No result received from ComfyUI for this job. It may have failed silently.");
    announce("Generation failed");
    finishGeneration();
  }
}

/* ============================================================================
 * Result viewer + metadata + gallery
 * ========================================================================== */

function applyItemParams(item) {
  $("prompt").value = item.prompt || "";
  $("negPrompt").value = item.negPrompt || "";
  $("width").value = item.width;
  $("height").value = item.height;
  syncPresetFromInputs();
  $("steps").value = item.steps;
  $("stepsVal").textContent = item.steps;
  $("cfg").value = item.cfg;
  $("seed").value = item.seed;
  $("lockSeed").classList.add("active");
  syncLockButton();
  saveSettings();
}

function makeActionBtn(label, action, handler) {
  return el("button", {
    class: "mini-btn", type: "button",
    dataset: { action },
    text: label,
    onclick: handler,
  });
}

/** Render the viewer with a gallery item; attaches the metadata panel. */
function showInViewer(item, focusViewer = false) {
  state.selected = item;
  const viewer = $("viewer");
  viewer.textContent = ""; // clears all children

  const img = el("img", { src: item.url, alt: item.prompt || "Generated image" });
  viewer.append(el("div", { class: "result-img-wrap" }, img));

  const meta = el("div", { class: "result-meta" });
  const facts = el("div", { class: "meta-facts" });
  facts.append(
    el("div", { class: "meta-prompt", text: item.prompt || "(no prompt)" }),
    el("div", { class: "meta-grid" },
      el("span", { class: "meta-k", text: "Seed" }),   el("span", { text: String(item.seed) }),
      el("span", { class: "meta-k", text: "Steps" }),  el("span", { text: String(item.steps) }),
      el("span", { class: "meta-k", text: "CFG" }),    el("span", { text: String(item.cfg) }),
      el("span", { class: "meta-k", text: "Size" }),   el("span", { text: item.width + "×" + item.height }),
      el("span", { class: "meta-k", text: "Time" }),   el("span", { text: Number.isFinite(item.elapsed) ? (item.elapsed / 1000).toFixed(1) + "s" : "— (recovered)" }),
      el("span", { class: "meta-k", text: "File" }),   el("span", { class: "mono", text: item.filename }),
    ),
  );
  meta.append(facts);

  const actions = el("div", { class: "meta-actions", id: "metaActions" });
  actions.append(
    makeActionBtn("Open", "open", () => window.open(item.url, "_blank", "noopener")),
    makeActionBtn("Copy prompt", "copy", async (e) => {
      const ok = await copyText(item.prompt || "");
      const btn = e.currentTarget;
      const old = btn.textContent;
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(() => { btn.textContent = old; }, 1500);
    }),
    makeActionBtn("Apply", "apply", () => applyItemParams(item)),
    makeActionBtn("Re-run", "rerun", () => { applyItemParams(item); generate(); }),
    makeActionBtn("Download", "download", () => downloadImage(item)),
  );
  meta.append(actions);
  viewer.append(meta);

  $("viewerBadge").textContent = item.width + "×" + item.height + " · " +
    (Number.isFinite(item.elapsed) ? (item.elapsed / 1000).toFixed(1) + "s" : "recovered");

  for (const t of $("gallery").querySelectorAll(".thumb")) {
    const on = t.dataset.filename === item.filename && t.dataset.ts === String(item.ts);
    t.classList.toggle("selected", on);
    t.setAttribute("aria-pressed", String(on));
  }

  if (focusViewer) viewer.focus({ preventScroll: true });
}

function addGalleryItems(images, elapsedMs) {
  if (!images || !images.length) return;
  const p = state.lastParams || {};
  const items = images.map((img) => ({
    filename: img.filename,
    subfolder: img.subfolder || "",
    type: img.type || "output",
    url: viewUrl(img),
    // Snapshot the parameters actually submitted, not the live inputs (the
    // user may have edited them while the job was running).
    prompt: p.prompt !== undefined ? p.prompt : $("prompt").value.trim(),
    negPrompt: p.negPrompt !== undefined ? p.negPrompt : $("negPrompt").value.trim(),
    seed: p.seed !== undefined ? p.seed : $("seed").value,
    steps: p.steps !== undefined ? p.steps : $("steps").value,
    cfg: p.cfg !== undefined ? p.cfg : $("cfg").value,
    width: p.width !== undefined ? p.width : $("width").value,
    height: p.height !== undefined ? p.height : $("height").value,
    elapsed: (elapsedMs === undefined ? null : elapsedMs),
    ts: Date.now() + Math.random(),
  }));
  for (const item of items) state.gallery.unshift(item);
  renderGallery();
  showInViewer(items[0], true);
  $("galleryPanel").classList.remove("hidden");
}

function removeGalleryItem(item) {
  const idx = state.gallery.indexOf(item);
  if (idx >= 0) state.gallery.splice(idx, 1);
  if (state.selected === item) {
    state.selected = null;
    if (state.gallery.length) showInViewer(state.gallery[0]);
    else showPlaceholder();
  }
  renderGallery();
}

function clearGallery() {
  state.gallery = [];
  state.selected = null;
  renderGallery();
  $("galleryPanel").classList.add("hidden");
  showPlaceholder();
}

function showPlaceholder() {
  const viewer = $("viewer");
  viewer.textContent = "";
  const ph = el("div", { class: "placeholder", id: "placeholder" });
  ph.append(
    el("div", { class: "placeholder-title", text: "Configure your prompt and hit Generate." }),
    el("div", { class: "placeholder-sub", text: "Images appear here." }),
    el("div", { class: "placeholder-tip" },
      el("kbd", { text: "Ctrl" }), el("span", { text: "/" }),
      el("kbd", { text: "⌘" }), el("span", { text: "+" }),
      el("kbd", { text: "Enter" }), el("span", { text: "to generate" })),
  );
  viewer.append(ph);
  $("viewerBadge").textContent = "";
}

function renderGallery() {
  const gal = $("gallery");
  gal.textContent = "";
  state.gallery.forEach((item) => {
    const selected = !!(state.selected && state.selected.ts === item.ts);
    const wrap = el("div", { class: "thumb-wrap" });
    const thumb = el("button", {
      class: "thumb" + (selected ? " selected" : ""),
      type: "button",
      dataset: { filename: item.filename, ts: String(item.ts) },
      title: item.prompt || item.filename,
      "aria-label": "View result: " + (item.prompt || item.filename),
      "aria-pressed": String(selected),
      onclick: () => showInViewer(item),
    });
    thumb.append(el("img", { src: previewUrl(item), alt: item.prompt || "Gallery image", loading: "lazy" }));
    const del = el("button", {
      class: "thumb-del", type: "button", text: "✕",
      "aria-label": "Remove image",
      title: "Remove image",
      onclick: (e) => { e.stopPropagation(); removeGalleryItem(item); },
    });
    wrap.append(thumb, del);
    gal.append(wrap);
  });
  const n = state.gallery.length;
  $("galleryCount").textContent = n + (n === 1 ? " image" : " images");
  $("galleryEmpty").classList.toggle("hidden", n > 0);
}

/* ============================================================================
 * Generate
 * ========================================================================== */

function clampNum(v, min, max, dflt) {
  const n = parseFloat(v);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

async function generate() {
  if (state.generating || !conn.connected) return;
  hideError();

  // Auto-randomize seed only when unlocked AND the user hasn't typed one.
  if (!$("lockSeed").classList.contains("active") && !seedTouched) {
    $("seed").value = Math.floor(Math.random() * 1e15);
  }
  seedTouched = false;
  saveSettings();

  const p = {
    prompt:    $("prompt").value.trim(),
    negPrompt: $("negPrompt").value.trim(),
    width:     clampInt($("width").value, CONFIG.MIN_SIZE, CONFIG.MAX_SIZE, 1024),
    height:    clampInt($("height").value, CONFIG.MIN_SIZE, CONFIG.MAX_SIZE, 1024),
    steps:     clampInt($("steps").value, CONFIG.MIN_STEPS, CONFIG.MAX_STEPS, 40),
    cfg:       clampNum($("cfg").value, 1, 20, 1),
    // ComfyUI expects a JSON number for `seed`. BigInt cannot be passed
    // through JSON.stringify (throws "Do not know how to serialize a BigInt"),
    // and JSON numbers are exact only up to 2^53-1, so clamp to that range.
    seed:      clampInt($("seed").value, 0, Number.MAX_SAFE_INTEGER, CONFIG.DEFAULTS.seed),
    sampler:   $("sampler").value || CONFIG.SAMPLER_NAME,
    scheduler: $("scheduler").value || CONFIG.SCHEDULER,
    denoise:   clampNum($("denoise").value, 0, 1, CONFIG.DENOISE),
    batch:     clampInt($("batch").value, 1, 16, 1),
  };

  const graph = buildGraph(p);
  state.lastParams = p;

  setGenerating(true);
  state.maxSteps = p.steps;
  state.stepValue = 0;
  state.nodeEventCount = 0;
  startElapsedTimer();
  setPhase("submitting…");
  setProgress(0, true);
  announce("Submitting to ComfyUI");
  startQueuePoll();

  // Hard watchdog: never stay "generating" forever even if every event is lost.
  state.watchdogTimer = setTimeout(() => {
    if (state.generating) {
      showError("Timed out waiting for ComfyUI after " + Math.round(MAX_JOB_MS / 60000) + " minutes.");
      finishGeneration();
    }
  }, MAX_JOB_MS);

  try {
    const { promptId } = await submitPrompt(graph);
    state.currentPromptId = promptId;
    state.ownPromptIds.add(promptId);
    setPhase("queued (prompt_id " + promptId.slice(0, 8) + "…)");
  } catch (e) {
    showError("Failed to submit workflow:\n" + (e.message || e));
    setGenerating(false);
    stopElapsedTimer();
  }
}

async function cancelGeneration() {
  const btn = $("cancelBtn");
  btn.textContent = "Cancelling…";
  btn.disabled = true;
  const id = state.currentPromptId;
  await interrupt(id);
  await cancelQueued(id);
  appendQueue("interrupt requested…");
  // Watchdog: if no execution_interrupted event arrives, don't stay stuck.
  setTimeout(() => {
    if (state.generating) {
      showError("Interrupt requested — no response from ComfyUI; resetting.");
      finishGeneration();
    }
  }, 6000);
}

/* ============================================================================
 * Seed handling
 * ========================================================================== */

let seedTouched = false;
function randomizeSeed() {
  $("seed").value = Math.floor(Math.random() * 1e15);
  seedTouched = true;
  saveSettings();
}
function syncLockButton() {
  const btn = $("lockSeed");
  const locked = btn.classList.contains("active");
  btn.textContent = locked ? "🔒" : "🔓";
  btn.setAttribute("aria-pressed", String(locked));
  btn.title = locked
    ? "Seed locked — same seed reused"
    : "Seed unlocked — new random seed per generation";
}
function toggleLock() {
  $("lockSeed").classList.toggle("active");
  syncLockButton();
  saveSettings();
}

/* ============================================================================
 * Size presets
 * ========================================================================== */

function applyPreset(size) {
  $("width").value = size;
  $("height").value = size;
  for (const chip of $("sizePresets").children) {
    chip.classList.toggle("active", chip.dataset.size === String(size));
  }
  $("customSizeRow").classList.remove("visible");
  $("customChip").classList.remove("active");
  saveSettings();
}

function markCustom() {
  for (const chip of $("sizePresets").children) chip.classList.remove("active");
  $("customSizeRow").classList.add("visible");
  $("customChip").classList.add("active");
  saveSettings();
}

function syncPresetFromInputs() {
  const w = $("width").value, h = $("height").value;
  const match = CONFIG.SIZE_PRESETS.find((s) => String(s) === w && String(s) === h);
  if (match) {
    applyPreset(match);
  } else {
    for (const chip of $("sizePresets").children) chip.classList.remove("active");
    $("customChip").classList.add("active");
    $("customSizeRow").classList.add("visible");
  }
  saveSettings();
}

/* ============================================================================
 * Static DOM construction + event wiring
 * ========================================================================== */

function buildSizePresets() {
  const wrap = $("sizePresets");
  for (const size of CONFIG.SIZE_PRESETS) {
    wrap.append(el("button", {
      class: "chip", type: "button",
      dataset: { size: String(size) },
      text: String(size),
      onclick: () => applyPreset(size),
    }));
  }
  wrap.append(el("button", {
    class: "chip", type: "button", id: "customChip", text: "Custom", onclick: markCustom,
  }));
}

/** Populate the advanced selects from the server's /object_info enums. */
function buildAdvancedOptions() {
  const ks = (conn.objectInfo && conn.objectInfo[CONFIG.KSAMPLER_TYPE]) || null;
  const req = (ks && ks.input && ks.input.required) || {};
  const samplers = req.sampler_name ? req.sampler_name[0] : null;
  const schedulers = req.scheduler ? req.scheduler[0] : null;
  fillSelect($("sampler"), samplers, SETTINGS.sampler || CONFIG.DEFAULTS.sampler);
  fillSelect($("scheduler"), schedulers, SETTINGS.scheduler || CONFIG.DEFAULTS.scheduler);
}

function fillSelect(select, options, wanted) {
  select.textContent = "";
  const list = (options && options.length) ? options : (wanted ? [wanted] : []);
  for (const opt of list) select.append(el("option", { value: opt, text: opt }));
  if (wanted && list.includes(wanted)) select.value = wanted;
  else if (list.length) select.value = list[0];
}

function wireCollapsible(toggleId, bodyId) {
  const body = $(bodyId);
  const toggle = $(toggleId);
  body.inert = true;
  body.setAttribute("aria-hidden", "true");
  toggle.addEventListener("click", () => {
    const open = body.classList.toggle("open");
    body.inert = !open;
    body.setAttribute("aria-hidden", String(!open));
    toggle.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
}

function wireEvents() {
  // Connection listeners
  onWsMessage(onServerMessage);
  onConnectionChange(renderStatus);
  $("statusPill").addEventListener("click", () => reconnectNow());
  $("bannerRetry").addEventListener("click", () => reconnectNow());

  // Controls
  $("randomizeBtn").addEventListener("click", randomizeSeed);
  $("lockSeed").addEventListener("click", toggleLock);
  $("generateBtn").addEventListener("click", generate);
  $("cancelBtn").addEventListener("click", cancelGeneration);

  // Collapsibles
  wireCollapsible("negToggle", "negBody");
  wireCollapsible("advToggle", "advBody");

  // Error box actions
  $("errorDismiss").addEventListener("click", hideError);
  $("errorCopy").addEventListener("click", async (e) => {
    const ok = await copyText($("errorBody").textContent);
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { btn.textContent = old; }, 1500);
  });

  // Gallery actions
  $("galleryClearBtn").addEventListener("click", clearGallery);

  // Server-busy notice: stop a job this page did not start.
  $("busyCancel").addEventListener("click", async () => {
    const id = state.busyPromptId;
    $("busyText").textContent = "Stopping server job…";
    await interrupt(id);
    await cancelQueued(id);
    clearServerBusy();
    updateQueue();
  });

  // Size inputs
  $("width").addEventListener("input", syncPresetFromInputs);
  $("height").addEventListener("input", syncPresetFromInputs);

  // Persist on change; mark the seed as user-edited on any manual input.
  for (const id of ["prompt", "negPrompt", "steps", "cfg", "seed", "sampler", "scheduler", "denoise", "batch"]) {
    $(id).addEventListener("change", saveSettings);
  }
  $("seed").addEventListener("input", () => { seedTouched = true; });

  // Prompt autosave (debounced) so a closed tab doesn't lose the text.
  let saveTimer = null;
  for (const id of ["prompt", "negPrompt"]) {
    $(id).addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveSettings, 500);
    });
  }

  // Steps slider live value
  $("steps").addEventListener("input", () => {
    $("stepsVal").textContent = $("steps").value;
  });

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    } else if (e.key === "Escape" && state.generating) {
      e.preventDefault();
      cancelGeneration();
    }
  });
}

/* ============================================================================
 * Init: restore settings, build UI, connect
 * ========================================================================== */

function initInputs() {
  const s = SETTINGS;
  $("prompt").value = s.prompt !== undefined ? s.prompt : CONFIG.DEFAULTS.prompt;
  $("negPrompt").value = s.negPrompt !== undefined ? s.negPrompt : CONFIG.DEFAULTS.negPrompt;
  $("steps").value = s.steps !== undefined ? s.steps : CONFIG.DEFAULTS.steps;
  $("cfg").value = s.cfg !== undefined ? s.cfg : CONFIG.DEFAULTS.cfg;
  $("seed").value = s.seed !== undefined ? s.seed : CONFIG.DEFAULTS.seed;
  $("denoise").value = s.denoise !== undefined ? s.denoise : CONFIG.DEFAULTS.denoise;
  $("batch").value = s.batch !== undefined ? s.batch : CONFIG.DEFAULTS.batch;
  $("stepsVal").textContent = $("steps").value;

  if (s.seedLocked) $("lockSeed").classList.add("active");
  syncLockButton();

  const w = s.width !== undefined ? parseInt(s.width, 10) : CONFIG.DEFAULTS.width;
  const h = s.height !== undefined ? parseInt(s.height, 10) : CONFIG.DEFAULTS.height;
  const preset = CONFIG.SIZE_PRESETS.find((sz) => sz === w && sz === h);
  if (preset) {
    applyPreset(preset);
    $("width").value = w;
    $("height").value = h;
  } else if (Number.isFinite(w) && Number.isFinite(h)) {
    $("width").value = w;
    $("height").value = h;
    $("customSizeRow").classList.add("visible");
    $("customChip").classList.add("active");
  } else {
    applyPreset(CONFIG.DEFAULTS.width);
  }
}

export function initUI() {
  buildSizePresets();
  initInputs();
  wireEvents();
  resetRunUI(); // never start in a stale "generating" state
  renderStatus(false);
  $("viewer").setAttribute("tabindex", "-1");
  startStatsPolling();
  // A back/forward-cache restore can bring back a DOM that still shows the
  // previous run; reset it and re-sync with the server.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      resetRunUI();
      checkConnection();
    }
  });
  checkConnection().then((res) => {
    if (!res) return;
    const notes = [];
    if (res.ok && res.warnings && res.warnings.length) {
      notes.push("Missing ComfyUI node types: " + res.warnings.join(", ") +
        "\nInstall / enable the matching custom nodes, then reload.");
    }
    if (res.ok) {
      buildAdvancedOptions();
      const missing = renderModelInfo();
      if (missing.length) {
        notes.push("Configured model file(s) not present on the server:\n" + missing.join("\n"));
      }
    }
    if (notes.length) showError(notes.join("\n\n"));
  });
}
