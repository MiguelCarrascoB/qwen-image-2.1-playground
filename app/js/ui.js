/* ============================================================================
 * ui.js — DOM construction, interaction wiring, gallery, progress, and
 * settings persistence.
 *
 * Sanitization rule: NO innerHTML / insertAdjacentHTML anywhere in this file
 * (or anywhere in the app). All server-derived or user-derived strings are
 * inserted via textContent or attribute values only.
 * ========================================================================== */

import { CONFIG, STORAGE_KEY } from "./config.js?v=4";
import {
  conn, onConnectionChange, checkConnection, reconnectNow, onWsMessage,
  buildGraph, buildEditGraph, submitPrompt, uploadImage, imageRef,
  interrupt, cancelQueued, fetchHistoryImages,
  fetchSystemStats, fetchQueue, viewUrl, previewUrl,
  downloadImage, serverBase,
} from "./api.js?v=4";

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
      mode:            state.mode,
      prompt:          $("prompt").value,
      editInstruction: $("editInstruction").value,
      negPrompt:       $("negPrompt").value,
      width:           $("width").value,
      height:          $("height").value,
      steps:           $("steps").value,
      cfg:             $("cfg").value,
      seed:            $("seed").value,
      seedLocked:      $("lockSeed").classList.contains("active"),
      sampler:         $("sampler").value,
      scheduler:       $("scheduler").value,
      denoise:         $("denoise").value,
      batch:           $("batch").value,
    }));
  } catch { /* private mode / quota — non-fatal */ }
}

/* ============================================================================
 * App state
 * ========================================================================== */

const state = {
  mode: "t2i", // "t2i" | "edit"
  generating: false,
  currentPromptId: null,
  startTime: 0,
  elapsedTimer: null,
  cancelTimer: null, // cancel watchdog; cleared so it can't hit the next job
  maxSteps: 1,
  stepValue: 0,
  nodeEventCount: 0,
  historyFallbackTimer: null,
  historyFallbackTries: 0,
  watchdogTimer: null,
  queuePollTimer: null,
  statsPollTimer: null,
  queueFetchInFlight: false,
  firstProbeDone: false, // suppress the "not reachable" banner before the first probe
  lastParams: null, // parameters actually submitted for the in-flight job
  ownPromptIds: new Set(), // jobs this page submitted (never treated as foreign)
  recoveredIds: new Set(), // foreign jobs already pulled into the gallery
  busyPromptId: null, // foreign job currently running on the server
  gallery: [], // { filename, subfolder, type, mode, prompt, instruction, seed, steps, width, height, elapsed, ts }
  selected: null,
  editImages: [], // { id, name, previewUrl, status, server, image, progress }
  editSeq: 0,
  focusOnCancel: false, // focus was parked on Cancel when the controls were disabled
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
  announce(connected
    ? "Connected to ComfyUI"
    : "ComfyUI unreachable" + (extra ? ": " + extra : ""));
  updateGenerateButton();
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

/** Generate is blocked while disconnected, mid-run, or (in edit mode) until at
 * least one reference image is uploaded and an instruction is present. */
function updateGenerateButton() {
  const edit = state.mode === "edit";
  const hasRef = state.editImages.some((it) => it.status === "ready");
  const missing = edit && (!hasRef || !$("editInstruction").value.trim());
  $("generateBtn").disabled = state.generating || !conn.connected || missing;
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

let errorReturnFocus = null;

function showError(msg) {
  // Reveal first: a live region whose content changes while display:none is
  // not reliably announced.
  $("errorBox").classList.add("active");
  $("errorBody").textContent = msg;
  errorReturnFocus = document.activeElement;
  $("errorBox").scrollIntoView({ block: "nearest" });
  $("errorBox").focus({ preventScroll: true });
}
function hideError() {
  if (!$("errorBox").classList.contains("active")) return;
  $("errorBox").classList.remove("active");
  if (errorReturnFocus && document.contains(errorReturnFocus)) {
    errorReturnFocus.focus({ preventScroll: true });
  }
  errorReturnFocus = null;
}

/* ============================================================================
 * Generation controls + progress
 * ========================================================================== */

const CONTROL_IDS = [
  "prompt", "editInstruction", "negPrompt", "width", "height", "steps", "cfg", "seed",
  "randomizeBtn", "lockSeed", "sampler", "scheduler", "denoise", "batch",
  "dropZone", "modeT2i", "modeEdit",
];

function setControlsDisabled(disabled) {
  for (const id of CONTROL_IDS) {
    const node = $(id);
    if (node) node.disabled = disabled;
  }
  // Batch has no effect on an edit: the sampler latent is derived from one
  // reference image, so keep the control disabled in that mode.
  $("batch").disabled = disabled || state.mode === "edit";
  for (const chip of $("sizePresets").children) chip.disabled = disabled;
}

function setGenerating(on) {
  state.generating = on;
  if (on) clearServerBusy();
  $("cancelBtn").classList.toggle("visible", on);
  $("cancelBtn").disabled = false;
  $("cancelBtn").textContent = "Cancel";
  $("progressBox").classList.toggle("active", on);
  $("progressBox").setAttribute("aria-busy", String(on));
  $("viewerOverlay").hidden = !on;
  // Keep stale result actions out of the tab order while the overlay covers them.
  $("viewer").toggleAttribute("inert", on);
  // Screen-reader/keyboard focus must land somewhere real when the focused
  // control is disabled; park it on Cancel and give it back afterwards.
  if (on && $("controls").contains(document.activeElement)) {
    state.focusOnCancel = true;
    $("cancelBtn").focus({ preventScroll: true });
  } else if (!on && state.focusOnCancel) {
    state.focusOnCancel = false;
    $("generateBtn").focus({ preventScroll: true });
  }
  setControlsDisabled(on);
  updateGenerateButton();
  if (!on) {
    $("queueStatus").textContent = "";
    $("queuePosition").textContent = "";
    $("stepCounter").textContent = "";
    $("eta").textContent = "";
    setPhase("");
    if (state.historyFallbackTimer) { clearTimeout(state.historyFallbackTimer); state.historyFallbackTimer = null; }
    if (state.watchdogTimer) { clearTimeout(state.watchdogTimer); state.watchdogTimer = null; }
    if (state.cancelTimer) { clearTimeout(state.cancelTimer); state.cancelTimer = null; }
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
  if (!conn.connected || state.queueFetchInFlight) return;
  state.queueFetchInFlight = true;
  try {
    const q = await fetchQueue();
    const running = q.queue_running || [];
    const pending = q.queue_pending || [];
    const total = running.length + pending.length;
    if (state.generating) {
      $("queuePosition").textContent = total
        ? "queue: " + pending.length + " pending, " + running.length + " running"
        : "";
      // If our job already left the queue but the 'executed' / sentinel message
      // was lost (WS blip), recover via /history instead of waiting 30 minutes.
      if (state.currentPromptId &&
          !running.concat(pending).some((e) => e[1] === state.currentPromptId)) {
        checkHistoryFallback();
      }
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
  } catch { /* transient — ignore */ } finally {
    state.queueFetchInFlight = false;
  }
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
  $("busyNotice").hidden = false;
}
function clearServerBusy() {
  state.busyPromptId = null;
  $("busyNotice").hidden = true;
}

/** Pull a foreign job's result into the gallery once it finishes. The id is
 * only marked recovered after a successful fetch, so a transient /history
 * failure can be retried by the next event or queue poll. */
async function recoverForeign(promptId, images) {
  if (!promptId || state.recoveredIds.has(promptId) || state.generating) return;
  clearServerBusy();
  const imgs = (images && images.length) ? images : await fetchHistoryImages(promptId);
  if (imgs && imgs.length && !state.generating) {
    state.recoveredIds.add(promptId);
    // Unknown parameters: don't label a foreign result with our last prompt.
    addGalleryItems(imgs, undefined, {});
    announce("Recovered a result from a job that finished after the page reloaded");
  }
}

/** Reset all run-related UI. Called on load and on bfcache restore so a
 * reloaded page never shows a stale "generating" state, and so a job that
 * outlives the restore is treated as foreign and recovered. */
function resetRunUI() {
  setGenerating(false);
  stopElapsedTimer();
  state.currentPromptId = null;
  state.ownPromptIds.clear();
  state.lastParams = null;
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
  // "mine" also covers ids this page submitted before currentPromptId is
  // assigned, so an early execution_error isn't misread as foreign and dropped.
  const mine = (id) => !id || id === state.currentPromptId || state.ownPromptIds.has(id);

  // A job this page did not submit (kept running across a reload, or another
  // tab) — surface it instead of silently ignoring the events.
  const fid = d.prompt_id;
  const foreign = !!(fid && !mine(fid));
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
      if (state.generating && mine(d.prompt_id)) {
        setPhase("executing…");
        announce("Executing");
        appendQueue("execution_start");
      }
      break;
    case "execution_cached":
      if (state.generating && mine(d.prompt_id)) appendQueue("execution_cached");
      break;
    case "executing": {
      if (d.node === null) {
        // Sentinel: this prompt finished (or errored). Wait for 'executed',
        // with a /history fallback if nothing arrives shortly.
        if (state.generating && mine(d.prompt_id)) {
          setPhase("finalizing…");
          state.historyFallbackTries = 0;
          state.historyFallbackTimer = setTimeout(checkHistoryFallback, 1500);
        }
      } else if (state.generating && mine(d.prompt_id)) {
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
      if (state.generating && mine(d.prompt_id) && d.output && d.output.images) {
        addGalleryItems(d.output.images, performance.now() - state.startTime, state.lastParams);
        announce("Generation complete");
        finishGeneration();
      } else if (foreign && d.output && d.output.images) {
        recoverForeign(fid, d.output.images);
      }
      break;
    }
    case "execution_error": {
      if (state.generating && mine(d.prompt_id)) {
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
  const edit = item.mode === "edit";
  setMode(edit ? "edit" : "t2i");
  if (edit) {
    $("editInstruction").value = item.instruction || "";
    // Re-attach the original reference files (still on the server as type=input).
    restoreEditImages(item.references || []);
  } else {
    $("prompt").value = item.prompt || "";
  }
  $("negPrompt").value = item.negPrompt || "";
  if (item.width !== undefined) {
    $("width").value = item.width;
    $("height").value = item.height;
    syncPresetFromInputs();
  }
  if (item.steps !== undefined) { $("steps").value = item.steps; $("stepsVal").textContent = item.steps; }
  if (item.cfg !== undefined) $("cfg").value = item.cfg;
  if (item.seed !== undefined) $("seed").value = item.seed;
  $("lockSeed").classList.add("active");
  syncLockButton();
  updateGenerateButton();
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

  const isEdit = item.mode === "edit";
  const desc = isEdit ? (item.instruction || "") : (item.prompt || "");
  const img = el("img", { src: item.url, alt: desc || "Generated image" });
  viewer.append(el("div", { class: "result-img-wrap" }, img));

  const meta = el("div", { class: "result-meta" });
  const facts = el("div", { class: "meta-facts" });
  const grid = el("div", { class: "meta-grid" },
    el("span", { class: "meta-k", text: "Mode" }),  el("span", { text: isEdit ? "Edit" : "Text → Image" }),
    el("span", { class: "meta-k", text: "Seed" }),  el("span", { text: String(item.seed) }),
    el("span", { class: "meta-k", text: "Steps" }), el("span", { text: String(item.steps) }),
    el("span", { class: "meta-k", text: "CFG" }),   el("span", { text: String(item.cfg) }),
    el("span", { class: "meta-k", text: "Size" }),  el("span", { text: item.width + "×" + item.height }),
    el("span", { class: "meta-k", text: "Time" }),  el("span", { text: Number.isFinite(item.elapsed) ? (item.elapsed / 1000).toFixed(1) + "s" : "— (recovered)" }),
    el("span", { class: "meta-k", text: "File" }),  el("span", { class: "mono", text: item.filename }),
  );
  if (isEdit && item.references && item.references.length) {
    grid.append(
      el("span", { class: "meta-k", text: "Refs" }),
      el("span", { class: "mono", text: item.references.map((r) => r.name).join(", ") }),
    );
  }
  facts.append(
    el("div", { class: "meta-prompt", text: desc || "(no description)" }),
    grid,
  );
  meta.append(facts);

  const actions = el("div", { class: "meta-actions", id: "metaActions" });
  actions.append(
    makeActionBtn("Open", "open", () => window.open(item.url, "_blank", "noopener")),
    makeActionBtn(isEdit ? "Copy instruction" : "Copy prompt", "copy", async (e) => {
      const ok = await copyText(desc);
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

function addGalleryItems(images, elapsedMs, params, focusViewer = true) {
  if (!images || !images.length) return;
  const p = (params === undefined ? (state.lastParams || {}) : params);
  const isEdit = p.mode === "edit";
  const items = images.map((img) => ({
    filename: img.filename,
    subfolder: img.subfolder || "",
    type: img.type || "output",
    url: viewUrl(img),
    mode: p.mode || "t2i",
    instruction: p.instruction,
    references: p.images
      ? p.images.map((r) => ({ name: r.name, subfolder: r.subfolder, type: r.type }))
      : null,
    // Snapshot the parameters actually submitted, not the live inputs (the
    // user may have edited them while the job was running).
    prompt: isEdit ? (p.instruction || "") : (p.prompt !== undefined ? p.prompt : $("prompt").value.trim()),
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
  showInViewer(items[0], focusViewer);
  $("galleryPanel").hidden = false;
}

/** Re-focus a gallery thumbnail after a re-render destroys the old node. */
function focusGalleryIndex(i) {
  const thumbs = $("gallery").querySelectorAll(".thumb");
  const target = (i >= 0 && thumbs[i]) ? thumbs[i] : $("generateBtn");
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

/** Focus the first usable control of the active mode (used after a clear). */
function focusInputArea() {
  const target = state.mode === "edit" ? $("dropZone") : $("prompt");
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

function removeGalleryItem(item) {
  const idx = state.gallery.indexOf(item);
  if (idx < 0) return;
  state.gallery.splice(idx, 1);
  if (state.selected === item) {
    state.selected = null;
    if (state.gallery.length) showInViewer(state.gallery[0]);
    else showPlaceholder();
  }
  renderGallery();
  focusGalleryIndex(Math.min(idx, state.gallery.length - 1));
}

function clearGallery() {
  state.gallery = [];
  state.selected = null;
  renderGallery();
  $("galleryPanel").hidden = true;
  showPlaceholder();
  focusInputArea();
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
    const desc = item.mode === "edit" ? (item.instruction || "") : (item.prompt || "");
    const label = desc || item.filename;
    const wrap = el("div", { class: "thumb-wrap" });
    const thumb = el("button", {
      class: "thumb" + (selected ? " selected" : ""),
      type: "button",
      dataset: { filename: item.filename, ts: String(item.ts), mode: item.mode || "t2i" },
      title: label,
      "aria-label": "View result: " + label,
      "aria-pressed": String(selected),
      onclick: () => showInViewer(item),
    });
    thumb.append(el("img", { src: previewUrl(item), alt: label, loading: "lazy" }));
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
  $("galleryEmpty").hidden = n > 0;
  announce(n + (n === 1 ? " image" : " images") + " in session");
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

  const edit = state.mode === "edit";
  if (edit) {
    if (state.editImages.some((it) => it.status === "uploading")) {
      showError("A reference image is still uploading — try again in a moment.");
      return;
    }
    if (!state.editImages.some((it) => it.status === "ready")) {
      showError("Add at least one reference image before editing.");
      return;
    }
    if (!$("editInstruction").value.trim()) {
      showError("Enter an edit instruction first.");
      return;
    }
  } else if (!$("prompt").value.trim()) {
    showError("Enter a prompt first.");
    return;
  }

  // Auto-randomize seed only when unlocked AND the user hasn't typed one.
  if (!$("lockSeed").classList.contains("active") && !seedTouched) {
    $("seed").value = Math.floor(Math.random() * 1e15);
  }
  seedTouched = false;
  saveSettings();

  const common = {
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
    denoise:   clampNum($("denoise").value, 0, 1, edit ? CONFIG.EDIT_DENOISE : CONFIG.DENOISE),
  };

  let p;
  let graph;
  if (edit) {
    const refs = state.editImages.filter((it) => it.status === "ready");
    p = {
      mode: "edit",
      instruction: $("editInstruction").value.trim(),
      // The encoder resizes references to this pixel budget; output follows the
      // first reference's aspect ratio. The Size control drives that budget.
      resolution: Math.max(0, Math.min(4096, Math.round(common.width / 32) * 32)),
      images: refs.map((it) => ({
        image: it.image,
        name: it.server.name,
        subfolder: it.server.subfolder,
        type: it.server.type,
      })),
      ...common,
    };
    graph = buildEditGraph(p);
  } else {
    p = {
      mode: "t2i",
      prompt: $("prompt").value.trim(),
      batch:  clampInt($("batch").value, 1, 16, 1),
      ...common,
    };
    graph = buildGraph(p);
  }
  state.lastParams = p;

  if (state.cancelTimer) { clearTimeout(state.cancelTimer); state.cancelTimer = null; }
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
  // Cancel may be pressed during the brief submit window before the prompt_id
  // is known; wait for it so we can cancel the right job instead of a no-op.
  let id = state.currentPromptId;
  for (let i = 0; !id && i < 10 && state.generating; i++) {
    await new Promise((r) => setTimeout(r, 200));
    id = state.currentPromptId;
  }
  if (id) {
    // ComfyUI's /interrupt stops whichever prompt is executing, so only call
    // it when our own prompt is the running one — otherwise a queued job's
    // Cancel would kill an unrelated GPU job.
    const q = await fetchQueue().catch(() => null);
    const running = q && (q.queue_running || []).some((e) => e[1] === id);
    if (running) await interrupt(id);
    await cancelQueued(id);
  }
  appendQueue("interrupt requested…");
  // Watchdog: if no execution_interrupted event arrives, don't stay stuck.
  state.cancelTimer = setTimeout(() => {
    state.cancelTimer = null;
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

function setChipActive(size) {
  for (const chip of $("sizePresets").children) {
    const on = chip.dataset.size === String(size);
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}

function applyPreset(size) {
  $("width").value = size;
  $("height").value = size;
  setChipActive(size);
  $("customSizeRow").classList.remove("visible");
  const cc = $("customChip");
  cc.classList.remove("active");
  cc.setAttribute("aria-pressed", "false");
  saveSettings();
}

function markCustom() {
  setChipActive(null);
  $("customSizeRow").classList.add("visible");
  const cc = $("customChip");
  cc.classList.add("active");
  cc.setAttribute("aria-pressed", "true");
  saveSettings();
}

function syncPresetFromInputs() {
  const w = $("width").value, h = $("height").value;
  const match = CONFIG.SIZE_PRESETS.find((s) => String(s) === w && String(s) === h);
  if (match) {
    applyPreset(match);
  } else {
    setChipActive(null);
    const cc = $("customChip");
    cc.classList.add("active");
    cc.setAttribute("aria-pressed", "true");
    $("customSizeRow").classList.add("visible");
  }
  saveSettings();
}

/* ============================================================================
 * Image edit — mode switch, reference uploads, drag & drop / paste
 * ========================================================================== */

function setMode(mode) {
  state.mode = mode === "edit" ? "edit" : "t2i";
  const edit = state.mode === "edit";
  $("t2iFields").hidden = edit;
  $("editFields").hidden = !edit;
  for (const [id, on] of [["modeT2i", !edit], ["modeEdit", edit]]) {
    const btn = $(id);
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  // Batch only applies to the T2I latent; re-apply the mode-dependent disable.
  if ($("batch")) $("batch").disabled = state.generating || edit;
  updateGenerateButton();
  saveSettings();
}

/** Allowed raster extension derived from the filename or MIME type. */
function safeExt(file) {
  const m = /\.([a-z0-9]+)$/i.exec(file.name || "");
  const ext = m ? m[1].toLowerCase() : "";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return ext;
  const byType = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/gif": "gif", "image/bmp": "bmp",
  };
  return byType[(file.type || "").toLowerCase()] || "";
}

function fileError(file) {
  if (!file || file.size === 0) return "the file is empty";
  if (file.size > CONFIG.UPLOAD.maxBytes) {
    return "larger than " + Math.round(CONFIG.UPLOAD.maxBytes / (1024 * 1024)) + " MB";
  }
  const type = (file.type || "").toLowerCase();
  if (type && !CONFIG.UPLOAD.accept.includes(type)) return "unsupported type " + type;
  if (!safeExt(file)) return "unsupported file type";
  return null;
}

function revokeEditPreview(item) {
  if (item.previewUrl && item.previewUrl.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
}

function addEditFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  hideError();
  let added = 0;
  for (const file of files) {
    if (state.editImages.length >= CONFIG.EDIT_MAX_IMAGES) {
      showError("At most " + CONFIG.EDIT_MAX_IMAGES + " reference images are supported.");
      break;
    }
    const err = fileError(file);
    if (err) { showError("Could not add \"" + file.name + "\": " + err + "."); continue; }
    const item = {
      id: "ref" + (++state.editSeq),
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      status: "uploading",
      progress: 0,
      statusEl: null,
      file,
      server: null,
      image: null,
    };
    state.editImages.push(item);
    added++;
    uploadEditImage(item);
  }
  if (added) announce(added + (added === 1 ? " reference image added" : " reference images added"));
  renderEditImages();
  updateGenerateButton();
}

async function uploadEditImage(item) {
  const ext = safeExt(item.file);
  const serverName = CONFIG.UPLOAD.prefix + item.id + "_" +
    Math.random().toString(36).slice(2, 8) + (ext ? "." + ext : "");
  try {
    const data = await uploadImage(item.file, serverName, (p) => {
      item.progress = p;
      if (item.statusEl) item.statusEl.textContent = Math.round(p * 100) + "%";
    });
    item.server = { name: data.name, subfolder: data.subfolder || "", type: data.type || "input" };
    item.image = imageRef(item.server);
    item.status = "ready";
    item.file = null; // release the File handle
  } catch (e) {
    item.status = "error";
    item.error = e.message || String(e);
    showError("Upload failed for \"" + item.name + "\":\n" + item.error);
  }
  renderEditImages();
  updateGenerateButton();
}

function renderEditImages() {
  const wrap = $("editThumbs");
  wrap.textContent = "";
  state.editImages.forEach((item) => {
    const t = el("div", { class: "ref-thumb " + item.status, title: item.name });
    t.append(el("img", { src: item.previewUrl, alt: item.name }));
    const status = el("span", { class: "ref-status" });
    item.statusEl = status;
    if (item.status === "uploading") status.textContent = Math.round((item.progress || 0) * 100) + "%";
    else if (item.status === "error") status.textContent = "!";
    t.append(status);
    t.append(el("button", {
      class: "ref-del", type: "button", text: "✕",
      "aria-label": "Remove reference image " + item.name,
      title: "Remove reference image",
      onclick: () => removeEditImage(item),
    }));
    wrap.append(t);
  });
  $("editThumbsEmpty").hidden = state.editImages.length > 0;
}

function removeEditImage(item) {
  const idx = state.editImages.indexOf(item);
  if (idx < 0) return;
  revokeEditPreview(item);
  state.editImages.splice(idx, 1);
  renderEditImages();
  updateGenerateButton();
  const nodes = $("editThumbs").querySelectorAll(".ref-thumb");
  const next = nodes[Math.min(idx, state.editImages.length - 1)];
  if (next) next.querySelector(".ref-del").focus({ preventScroll: true });
  else $("dropZone").focus({ preventScroll: true });
  announce("Reference image removed");
}

/** Rebuild the reference list from a gallery item's stored descriptors (the
 * files are still on the server as type=input, so nothing is re-uploaded). */
function restoreEditImages(references) {
  for (const it of state.editImages) revokeEditPreview(it);
  state.editImages = references.map((r, i) => {
    const server = { name: r.name, subfolder: r.subfolder || "", type: r.type || "input" };
    return {
      id: "restored" + (++state.editSeq) + "_" + i,
      name: server.name,
      previewUrl: viewUrl(server),
      status: "ready",
      progress: 1,
      statusEl: null,
      server,
      image: imageRef(server),
    };
  });
  renderEditImages();
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
      "aria-pressed": "false",
      onclick: () => applyPreset(size),
    }));
  }
  wrap.append(el("button", {
    class: "chip", type: "button", id: "customChip", text: "Custom",
    "aria-pressed": "false", onclick: markCustom,
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

  // Mode switch (tablist) — click or Left/Right arrow.
  for (const [id, mode] of [["modeT2i", "t2i"], ["modeEdit", "edit"]]) {
    const btn = $(id);
    btn.addEventListener("click", () => setMode(mode));
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = mode === "t2i" ? "edit" : "t2i";
      setMode(next);
      $(next === "t2i" ? "modeT2i" : "modeEdit").focus();
    });
  }

  // Reference images: click-to-browse, drag & drop, and Ctrl/Cmd+V paste.
  const dz = $("dropZone");
  dz.addEventListener("click", () => { if (!dz.disabled) $("fileInput").click(); });
  for (const ev of ["dragenter", "dragover"]) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); if (!dz.disabled) dz.classList.add("drag"); });
  }
  for (const ev of ["dragleave", "dragend"]) {
    dz.addEventListener(ev, () => dz.classList.remove("drag"));
  }
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (!dz.disabled) addEditFiles(e.dataTransfer && e.dataTransfer.files);
  });
  $("fileInput").addEventListener("change", (e) => {
    addEditFiles(e.target.files);
    e.target.value = "";
  });
  // Never let a stray drop navigate the page away from the app.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());
  document.addEventListener("paste", (e) => {
    if (state.mode !== "edit" || state.generating) return;
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return;
    const items = e.clipboardData ? e.clipboardData.items : null;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); addEditFiles(files); }
  });

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
  for (const id of ["prompt", "editInstruction", "negPrompt", "steps", "cfg", "seed", "sampler", "scheduler", "denoise", "batch"]) {
    $(id).addEventListener("change", saveSettings);
  }
  $("seed").addEventListener("input", () => { seedTouched = true; });

  // Prompt / instruction autosave (debounced) so a closed tab doesn't lose text.
  let saveTimer = null;
  for (const id of ["prompt", "editInstruction", "negPrompt"]) {
    $(id).addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveSettings, 500);
    });
  }
  // An instruction is required to generate an edit.
  $("editInstruction").addEventListener("input", updateGenerateButton);

  // Steps slider live value
  $("steps").addEventListener("input", () => {
    $("stepsVal").textContent = $("steps").value;
  });

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    } else if (e.key === "Escape") {
      if (state.generating) { e.preventDefault(); cancelGeneration(); }
      else if ($("errorBox").classList.contains("active")) { e.preventDefault(); hideError(); }
    }
  });
}

/* ============================================================================
 * Init: restore settings, build UI, connect
 * ========================================================================== */

function initInputs() {
  const s = SETTINGS;
  $("prompt").value = s.prompt !== undefined ? s.prompt : CONFIG.DEFAULTS.prompt;
  $("editInstruction").value = s.editInstruction !== undefined ? s.editInstruction : CONFIG.DEFAULTS.editInstruction;
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

  renderEditImages();
  // Reference files can't survive a reload, so restore the mode but leave the
  // drop zone empty (Generate stays disabled until an image is added).
  setMode(s.mode === "edit" ? "edit" : "t2i");
}

export function initUI() {
  buildSizePresets();
  initInputs();
  wireEvents();
  resetRunUI(); // never start in a stale "generating" state
  // Stay in the neutral "Connecting…" state until the first probe reports —
  // don't flash the unreachable banner / alert on every load.
  $("statusPill").classList.add("retrying");
  $("viewer").setAttribute("tabindex", "-1");
  startStatsPolling();
  // Pause the queue poll while the tab is hidden; resume when visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopQueuePoll();
    else if (conn.connected) startQueuePoll();
  });
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
