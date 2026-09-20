# Deep analysis — Qwen-Image-2.1 playground

A prioritised review of the whole system (frontend + local ComfyUI integration),
produced from four read-only analysis passes (performance, reliability,
security/privacy, UX/a11y + architecture) against the code as of the
image-edit release. Each item lists priority, location, impact and the minimal
fix. **Status** marks what shipped in this change versus what is deliberately
deferred.

Priorities: **P0** = breaks or strands users / real security exposure;
**P1** = significant user-visible or security issue; **P2** = polish/hardening.

## Implemented in this change

| # | Pri | Area | Location | Issue | Fix shipped |
|---|---|---|---|---|---|
| 1 | P1 | Editing | `app/js/api.js` | No image-edit path existed. | Added `buildEditGraph()` using `TextEncodeQwenImage21`'s autogrow `images.image_N` inputs + optional `vae`, seeded from the node's own `latent` output. Verified on the RX 7900 XTX. |
| 2 | P1 | Editing | `app/js/ui.js`, `app/index.html` | No upload UI. | Mode switch, drop zone (drag & drop / click / Ctrl·⌘+V), validated reference thumbnails with remove, instruction field; reuses size/steps/CFG/seed/advanced; gallery metadata keeps mode + references for Apply/Re-run. |
| 3 | P1 | Security | `app/js/api.js` | `/upload/image` was reachable with client-controlled filename and `overwrite=true` → clobbering/DoS. | Random server filename (`qwen21_ref_<id>_<rand>.<ext>`), `overwrite=false`, raster-only MIME + extension + size (≤20 MB) validation. |
| 4 | P1 | Security | `app/index.html`, docs/scripts | Bare `--enable-cors-header` answers `Access-Control-Allow-Origin: *`, letting any site read ComfyUI files (incl. uploads) and queue jobs. | CSP hardened (`object-src 'none'`, `base-uri 'self'`, `form-action 'none'`, `worker-src`); all launch commands/doc scripts now pass an explicit UI origin. |
| 5 | P1 | Reliability | `app/js/ui.js` | If the WS `executing(null)` sentinel was missed, the UI hung until the 30-min watchdog. | `updateQueue()` now detects that our prompt left the queue and calls the `/history` fallback immediately. |
| 6 | P1 | Reliability | `app/js/ui.js` | Cancel could `/interrupt` an unrelated running job. | Interrupt is only sent when our own prompt is actually in `queue_running`; otherwise just `cancelQueued`. |
| 7 | P1 | Reliability | `app/js/ui.js` | Cancel's 6 s watchdog was not stored, so it could reset the *next* job. | Stored on `state.cancelTimer`, cleared in `setGenerating(false)` and at the start of `generate()`. |
| 8 | P1 | Reliability | `app/js/ui.js` | bfcache restore kept `ownPromptIds`, silently dropping our own in-flight result. | `resetRunUI()` clears `ownPromptIds` + `lastParams`, so the job is treated as foreign and recovered. |
| 9 | P1 | Reliability | `app/js/ui.js` | Errors arriving before `currentPromptId` was assigned were classified foreign and swallowed. | Ownership now uses `ownPromptIds.has(id)`; `execution_error`/`interrupted`/`executed` are gated on `state.generating && mine(id)`. |
| 10 | P1 | Reliability | `app/js/ui.js` | Recovered foreign results inherited our last job's prompt (stale `lastParams`). | `addGalleryItems(..., params)` takes explicit params; `recoverForeign` passes `{}`. |
| 11 | P2 | Reliability | `app/js/ui.js` | `recoveredIds` marked before the `/history` fetch, so a transient failure lost the result forever. | Marked only after a successful fetch; `queueFetchInFlight` guard stops overlapping polls. |
| 12 | P1 | UX/a11y | `app/js/ui.js` | Disabling the focused control dropped focus to `<body>` on every run. | Focus is parked on Cancel while controls are disabled and returned to Generate on completion; the viewer is made `inert` behind the overlay. |
| 13 | P1 | UX/a11y | `app/js/ui.js` | `aria-busy` on `#controls` suppressed progress/error announcements; progressbar had no name. | Removed `aria-busy` from `#controls`; progressbar has `aria-label`. |
| 14 | P1 | UX/a11y | `app/js/ui.js` | `showError` wrote text while `display:none` (unreliable announcement) and never restored focus. | Reveal first, then set text; focus returns to the prior element on dismiss; Escape dismisses the error box. |
| 15 | P1 | UX/a11y | `app/js/ui.js` | Every page load flashed the `role="alert"` "unreachable" banner before the first probe. | Stay in "Connecting…" until a probe actually fails. |
| 16 | P1 | UX/a11y | `app/js/ui.js` | Recovered results stole focus into the viewer. | `focusViewer` is explicit; recovery no longer focuses. |
| 17 | P1 | UX/a11y | `app/styles.css` | Generate button failed contrast (2.6–4.0:1). | Darkened gradient to clear 4.5:1. |
| 18 | P1 | UX/a11y | `app/styles.css` | Collapsed/`Advanced` could clip unreachably; delete buttons invisible on touch. | `overflow-y:auto` + `max-height:min(60vh,480px)`; `@media (hover:none)` reveals delete buttons; ≥24px targets. |
| 19 | P2 | UX/a11y | `app/js/ui.js`, `app/index.html` | Size chips had no `aria-pressed`; icon buttons had no accessible name; gallery changes were silent. | Chips expose `aria-pressed` + labelled group; `aria-label`s added; `renderGallery` announces the count; connection transitions announced. |
| 20 | P1 | Perf | `app/js/api.js` | `emitStatus` fired twice per connect, duplicating `/system_stats` + `/queue`. | Notify listeners only on a real state transition (or with detail). |
| 21 | P2 | Perf | `app/js/ui.js` | Queue poll ran even while the tab was hidden. | Paused on `visibilitychange`, resumed when visible. |
| 22 | P2 | Code health | `app/js/api.js` | `clearQueue` was dead code. | Removed. |
| 23 | P2 | Docs | `README.md`, `app/README.md`, `docs/*`, `scripts/*` | Stale/incorrect docs (file:// CSP claim, persisted-settings list, "open app/index.html", bare CORS). | Corrected all of the above; documented the edit flow and upload hardening. |

## Performance measurements (RX 7900 XTX, ROCm 7.2.1, euler/simple, cfg 1)

Measured with `POST /prompt` + `/history` polling, warm model unless noted.
ComfyUI's execution cache serves a byte-identical second graph in ~0.5 s, so
every configuration used a unique seed.

| Resolution | Steps | Warm total | s/step |
|---|---|---|---|
| 512 | 8 | 5.96 s | 0.75 |
| 512 | 25 | 17.5 s | 0.70 |
| 512 | 40 | 27.9 s | 0.70 |
| 1024 | 8 | 15.5 s | 1.94 |
| 1024 | 25 | 44.2 s | 1.77 |
| 1024 | 40 | 70.7 s | 1.77 |

- **Cold vs warm:** after `POST /free` (unload models), 512/8 takes **16.8 s** —
  ~**10.8 s** of one-time model loading (text encoder + GGUF DiT + VAE) plus the
  ~6 s of sampling. Warm steady state is ~0.70 s/step at 512.
- **Resolution:** 1024 is ~2.5× the total and ~2.4× the per-step cost of 512
  (≈4× the pixels; the DiT scales close to linearly).
- **Steps:** linear once warm (~0.70 s/step at 512, ~1.77 s/step at 1024). The
  UI default of 40 makes a first 1024 render ~71 s warm / ~82 s cold, while the
  official template starts at 25 — a 40-step default is a deliberate quality
  choice, not a free one.
- **Sampler:** at 512/25, `euler` ≈ `dpmpp_2m` ≈ `euler_ancestral` within noise
  (18.9 / 18.4 / 18.1 s). Sampler choice is not a meaningful lever here; steps
  and resolution are.
- **Batch:** time and latent memory scale linearly; a batch of 16 at 1024² adds
  ~1 GB of latents on a 24 GB card with no guard (deferred item).
- **Edit mode** adds a local upload and reference VAE encoding; end-to-end edit
  512/8 measured **16.2 s** vs ~6 s for T2I 512/8, because the reference latents
  lengthen the sequence the DiT attends to.

## Deferred (with rationale)

- **Split `api.js` into transport + a pure `workflow.js`** (architecture P1).
  Sound long-term, but a broad multi-file reshuffle with no user-visible gain;
  kept out to protect the "T2I must not regress / focused diff" constraints.
- **Incremental gallery rendering** (perf P1). Full re-render is O(N²) across a
  session, but N is small in practice (a session is `localStorage`-less and
  clearable). Revisit if sessions grow.
- **Incremental `util.js` / `CONFIG.TIMEOUTS` centralisation** (P2). Cosmetic;
  the magic numbers are stable and documented by comments.
- **Server-side same-origin drive-by guard.** CORS scoping stops *reads*, but a
  cross-site `POST /prompt` still reaches the server. Fully closing this needs
  serving the UI same-origin as ComfyUI or patching `server.py` — out of scope
  for this app, and ComfyUI stays bound to `127.0.0.1`.
- **Dimension/decompression-bomb pre-check on upload** (P2). Pillow's
  `MAX_IMAGE_PIXELS` gives partial protection; a client-side decode check is a
  nice follow-up.

## What is already solid

- No `innerHTML`/`eval`/`insertAdjacentHTML` anywhere; server/user strings go
  through `textContent`/`setAttribute` (`ui.js` `el()` helper).
- Every `fetch`/upload is `AbortController`-wrapped with an explicit timeout;
  WS reconnect uses capped exponential backoff.
- A hard watchdog plus a `/history` fallback with a terminal state, so the UI
  never stays "generating" forever.
- Strict CSP, no CDNs/fonts/external assets, ComfyUI bound to `127.0.0.1`,
  `serve_app.py` sends `no-store` and explicit MIME types.
- Correct collapsible wiring (`aria-expanded`/`controls` + `inert`) and
  `prefers-reduced-motion` handling.
