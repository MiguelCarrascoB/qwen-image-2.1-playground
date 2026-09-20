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
  buildGraph, submitPrompt, interrupt, fetchHistoryImages,
  viewUrl, downloadImage,
} from "./api.js";

const $ = (id) => document.getElementById(id);

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
      seedLocked: $("lockSeed").classList.contains("active"),
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
  nodeEventCount: 0,
  historyFallbackTimer: null,
  gallery: [], // { filename, subfolder, type, prompt, seed, steps, width, height, elapsed, ts }
  selected: null,
  historyOffset: 0, // to disambiguate duplicate filenames in session gallery
  wsUnsub: null,
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

/* ============================================================================
 * Status pill + setup-hint banner
 * ========================================================================== */

function renderStatus(connected, extra) {
  const pill = $("statusPill");
  const text = $("statusText");
  pill.classList.toggle("connected", connected);
  pill.classList.toggle("retrying", !connected);
  text.textContent = (connected ? "Connected" : "Disconnected") +
    " — ComfyUI at 127.0.0.1:8188" + (extra ? " · " + extra : "");
  $("setupBanner").classList.toggle("visible", !connected);
  $("generateBtn").disabled = state.generating || !connected;
}

/* ============================================================================
 * Error box (verbatim ComfyUI errors, monospace, textContent only)
 * ========================================================================== */

function showError(msg) {
  const box = $("errorBox");
  box.textContent = msg;
  box.classList.add("active");
}
function hideError() {
  $("errorBox").classList.remove("active");
}

/* ============================================================================
 * Progress UI
 * ========================================================================== */

function setGenerating(on) {
  state.generating = on;
  $("generateBtn").disabled = on || !conn.connected;
  $("cancelBtn").classList.toggle("visible", on);
  $("progressBox").classList.toggle("active", on);
  if (!on) {
    $("queueStatus").textContent = "";
    setPhase("");
    if (state.historyFallbackTimer) { clearTimeout(state.historyFallbackTimer); state.historyFallbackTimer = null; }

  }
}

function startElapsedTimer() {
  state.startTime = performance.now();
  stopElapsedTimer();
  state.elapsedTimer = setInterval(() => {
    $("elapsed").textContent = ((performance.now() - state.startTime) / 1000).toFixed(1) + "s";
  }, 100);
}
function stopElapsedTimer() {
  if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
}

function setPhase(text) { $("phase").textContent = text; }
function setProgress(pct) { $("progressFill").style.width = pct + "%"; }

function bumpProgress() {
  state.nodeEventCount++;
  // Heuristic: pre-sampler nodes take ~30% of the bar; WS 'progress' events
  // then take over with real step counts.
  const est = Math.min(25, state.nodeEventCount * 6);
  const cur = parseFloat($("progressFill").style.width) || 0;
  if (cur < est) setProgress(est);
}

function appendQueue(text) {
  const box = $("queueStatus");
  const lines = box.textContent ? box.textContent.split("\n") : [];
  lines.push(text);
  while (lines.length > 6) lines.shift();
  box.textContent = lines.join("\n");
}

function finishGeneration() {
  setGenerating(false);
  stopElapsedTimer();
  setProgress(100);
  state.currentPromptId = null;
}

/* ============================================================================
 * WebSocket message handling (same event semantics as the verified version)
 * ========================================================================== */

function onServerMessage(msg) {
  const d = msg.data || {};

  switch (msg.type) {
    case "status": {
      const q = d.status && d.status.exec_info ? d.status.exec_info.queue_remaining : null;
      if (q !== null && state.generating) appendQueue("status: queue_remaining=" + q);
      break;
    }
    case "execution_start":
      if (d.prompt_id === state.currentPromptId) {
        setPhase("executing…");
        appendQueue("execution_start");
      }
      break;
    case "executing": {
      if (d.node === null) {
        // Sentinel: this prompt finished (or errored). Wait for 'executed',
        // with a /history fallback if nothing arrives shortly.
        if (d.prompt_id === state.currentPromptId && state.generating) {
          setPhase("finalizing…");
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
      if (state.generating && d.max) {
        setProgress(Math.round((d.value / d.max) * 100));
        setPhase("sampling step " + d.value + "/" + d.max);
      }
      break;
    }
    case "executed": {
      if (d.prompt_id === state.currentPromptId && d.output && d.output.images) {
        addGalleryItem(d.output.images, performance.now() - state.startTime);
        finishGeneration();
      }
      break;
    }
    case "execution_error": {
      if (d.prompt_id === state.currentPromptId) {
        showError("ComfyUI execution error:\n" + JSON.stringify(d, null, 2));
        finishGeneration();
      }
      break;
    }
    case "execution_interrupted":
      if (state.generating) {
        showError("Execution was interrupted.");
        finishGeneration();
      }
      break;
    case "execution_success":
      break;
  }
}

async function checkHistoryFallback() {
  if (!state.generating || !state.currentPromptId) return;
  const images = await fetchHistoryImages(state.currentPromptId);
  if (images && state.generating) {
    addGalleryItem(images, performance.now() - state.startTime);
    finishGeneration();
  }
  // else: keep waiting — another fallback cycle can be triggered by the
  // next WS event or the user clicking the status pill.
}

/* ============================================================================
 * Viewer + metadata panel + gallery
 * ========================================================================== */

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}

/** Render the viewer with a gallery item; attaches the metadata panel. */
function showInViewer(item) {
  state.selected = item;
  const viewer = $("viewer");
  viewer.textContent = ""; // clears all children

  const img = el("img", { src: item.url, alt: "Generated image" });
  viewer.append(el("div", { class: "result-img-wrap" }, img));

  // Metadata panel
  const meta = el("div", { class: "result-meta" });
  const facts = el("div", { class: "meta-facts" });
  facts.append(
    el("div", { class: "meta-prompt", text: item.prompt || "(no prompt)" }),
    el("div", { class: "meta-grid" },
      el("span", { class: "meta-k", text: "Seed" }),   el("span", { text: String(item.seed) }),
      el("span", { class: "meta-k", text: "Steps" }),  el("span", { text: String(item.steps) }),
      el("span", { class: "meta-k", text: "CFG" }),    el("span", { text: String(item.cfg) }),
      el("span", { class: "meta-k", text: "Size" }),   el("span", { text: item.width + "×" + item.height }),
      el("span", { class: "meta-k", text: "Time" }),   el("span", { text: (item.elapsed / 1000).toFixed(1) + "s" }),
      el("span", { class: "meta-k", text: "File" }),   el("span", { class: "mono", text: item.filename }),
    ),
  );
  meta.append(facts);
  meta.append(el("button", {
    class: "dl-btn",
    type: "button",
    text: "⬇ Download",
    onclick: () => downloadImage(item),
  }));
  viewer.append(meta);

  // Mark selected thumb
  for (const t of $("gallery").children) {
    t.classList.toggle("selected", t.dataset.filename === item.filename && t.dataset.ts === String(item.ts));
  }
}

function addGalleryItem(images, elapsedMs) {
  const img = images[0];
  if (!img) return;
  const item = {
    filename: img.filename,
    subfolder: img.subfolder || "",
    type: img.type || "output",
    url: viewUrl(img),
    prompt: $("prompt").value.trim(),
    negPrompt: $("negPrompt").value.trim(),
    seed: $("seed").value,
    steps: $("steps").value,
    cfg: $("cfg").value,
    width: $("width").value,
    height: $("height").value,
    elapsed: elapsedMs,
    ts: Date.now(),
  };
  state.gallery.unshift(item);
  renderGallery();
  showInViewer(item);
  $("galleryPanel").classList.remove("hidden");
}

function renderGallery() {
  const gal = $("gallery");
  gal.textContent = "";
  state.gallery.forEach((item) => {
    const thumb = el("div", {
      class: "thumb" + (state.selected && state.selected.ts === item.ts ? " selected" : ""),
      dataset: { filename: item.filename, ts: String(item.ts) },
      title: item.prompt || item.filename,
      onclick: () => showInViewer(item),
    });
    thumb.append(el("img", { src: item.url, alt: item.prompt || "Gallery image", loading: "lazy" }));
    gal.append(thumb);
  });
}

/* ============================================================================
 * Generate
 * ========================================================================== */

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

async function generate() {
  if (state.generating || !conn.connected) return;
  hideError();

  // Auto-randomize seed if locked OFF and untouched since last generation.
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
    cfg:       parseFloat($("cfg").value) || 1,
    seed:      BigInt($("seed").value || 0) < 0n ? 0n : BigInt($("seed").value || 0),
  };

  const graph = buildGraph(p);

  setGenerating(true);
  state.maxSteps = p.steps;
  state.nodeEventCount = 0;
  startElapsedTimer();
  setPhase("submitting…");
  setProgress(0);

  try {
    const { promptId } = await submitPrompt(graph);
    state.currentPromptId = promptId;
    setPhase("queued (prompt_id " + promptId.slice(0, 8) + "…)");
  } catch (e) {
    showError("Failed to submit workflow:\n" + (e.message || e));
    setGenerating(false);
    stopElapsedTimer();
  }
}

async function cancelGeneration() {
  await interrupt();
  appendQueue("interrupt requested…");
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
function toggleLock() {
  const btn = $("lockSeed");
  btn.classList.toggle("active");
  btn.title = btn.classList.contains("active")
    ? "Seed locked — same seed reused"
    : "Seed unlocked — new random seed per generation";
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
 * Build static DOM sections that are easier to generate than hand-write
 * (presets chips), then wire all events.
 * ========================================================================== */

function buildSizePresets() {
  const wrap = $("sizePresets");
  for (const size of CONFIG.SIZE_PRESETS) {
    wrap.append(el("button", {
      class: "chip",
      type: "button",
      dataset: { size: String(size) },
      text: String(size),
      onclick: () => applyPreset(size),
    }));
  }
  wrap.append(el("button", {
    class: "chip",
    type: "button",
    id: "customChip",
    text: "Custom",
    onclick: () => { $("customSizeRow").classList.add("visible"); $("customChip").classList.add("active"); },
  }));
}

function wireEvents() {
  // Connection listeners
  state.wsUnsub = onWsMessage(onServerMessage);
  onConnectionChange(renderStatus);
  $("statusPill").addEventListener("click", () => reconnectNow());
  $("bannerRetry").addEventListener("click", () => reconnectNow());

  // Controls
  $("randomizeBtn").addEventListener("click", randomizeSeed);
  $("lockSeed").addEventListener("click", toggleLock);
  $("generateBtn").addEventListener("click", generate);
  $("cancelBtn").addEventListener("click", cancelGeneration);

  // Collapsible negative prompt
  $("negToggle").addEventListener("click", () => {
    const body = $("negBody");
    const open = body.classList.toggle("open");
    $("negToggle").classList.toggle("open", open);
    $("negToggle").setAttribute("aria-expanded", String(open));
  });

  // Size inputs
  $("width").addEventListener("input", () => { syncPresetFromInputs(); });
  $("height").addEventListener("input", () => { syncPresetFromInputs(); });

  // Persist on any setting change
  for (const id of ["prompt", "negPrompt", "steps", "cfg", "seed"]) {
    $(id).addEventListener("change", saveSettings);
  }

  // Cmd/Ctrl+Enter in prompt triggers generate
  $("prompt").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate();
  });

  // Steps slider live value
  $("steps").addEventListener("input", () => {
    $("stepsVal").textContent = $("steps").value;
  });
}

/* ============================================================================
 * Init: restore settings, build UI, connect
 * ========================================================================== */

function initInputs() {
  const s = loadSettings();
  $("prompt").value = s.prompt !== undefined ? s.prompt : CONFIG.DEFAULTS.prompt;
  $("negPrompt").value = s.negPrompt !== undefined ? s.negPrompt : CONFIG.DEFAULTS.negPrompt;
  $("steps").value = s.steps !== undefined ? s.steps : CONFIG.DEFAULTS.steps;
  $("cfg").value = s.cfg !== undefined ? s.cfg : CONFIG.DEFAULTS.cfg;
  $("stepsVal").textContent = $("steps").value;

  if (s.seedLocked) $("lockSeed").classList.add("active");

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
  renderStatus(false);
  checkConnection();
}
