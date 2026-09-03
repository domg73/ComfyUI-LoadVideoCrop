/*
 * LoadVideoCrop - visual aspect-ratio-locked crop + visual trim timeline
 * for the core Load Video player.
 *
 * How the core renders the player (verified against the installed frontend):
 *   - The `file` combo carries `video_upload:true`, so the frontend builds a
 *     DOM <video> element (playsInline, controls, loop) and, in classic mode,
 *     exposes the `div.comfy-img-preview` container as a LiteGraph DOM widget
 *     (type "video", canvasOnly) held on `node.videoContainer`. The container
 *     is a flex box (overflow hidden) and the CSS makes the <video> fill it
 *     with object-fit:contain. The core also binds canvas interactions
 *     (wheel/pointer) to the element, so wheel/drag over the video drive the
 *     canvas.
 *   - In 2.0 / Vue mode the same player is rendered by a Vue component: the
 *     <video> lives inside the node's [data-node-id] element
 *     (div.video-preview) and may be re-created on re-render.
 *   - In BOTH designs the element is a real DOM <video> with object-fit:contain
 *     and its src is the INPUT file (uncropped): what you frame is what runs.
 *
 * Because the player is DOM in both designs there is a SINGLE overlay path
 * (no canvas variant, unlike LoadImageCrop): positioned <div>s managed by a
 * light 250ms poller. The crop rectangle is static across all frames, so one
 * normalized rect is valid for the whole clip.
 *
 * TRIM TIMELINE (v1.0.1): an editor-style strip BELOW the video (the video
 * box keeps its natural size; the container gets +TL_TOTAL_H px of height
 * in which the timeline lives, so the native <video> controls are never
 * covered). The node width is NOT pinned (the core's video widget pins it:
 * it reports the node's current width as minWidth, which would make the node
 * unshrinkable): the computeLayoutSize wrapper returns minWidth:0 instead,
 * so the node can be resized to any width (the video letterboxes):
 *
 *   - filmstrip of REAL thumbnails (a second hidden <video> seeked to N
 *     points: N = clamp(ceil(duration), 4, 48), ~1 per second, progressive);
 *   - audio waveform (WebAudio envelope, ~600 columns; skipped for files
 *     longer than 5 min to keep the decodeAudioData RAM bounded);
 *   - the trim window between the I (in) and O (out) markers: drag the two
 *     markers to change in/out (the middle is not draggable), click the track
 *     to seek, press I / O on the keyboard to mark in/out at the playhead; a
 *     white playhead follows the playback.
 * Values live in the (hidden) start_time / duration / strict_duration widgets
 * (0 = no trim / unlimited — core Trim Video semantics), so they serialize
 * into the workflow and can be set via API. The window resets to the full
 * clip when a different file is selected.
 *
 * Interaction (crop):
 *   - drag: a document capture-phase listener hit-tests the crop box and
 *     moves the rectangle; events outside the box pass through so the native
 *     <video> controls keep working.
 *   - wheel: a document capture-phase listener zooms the box while the cursor
 *     is over it (pre-empting the core canvas pan/zoom), and passes through
 *     everywhere else.
 *
 * The crop is stored as normalized floats in the (hidden) crop_x/y/w/h
 * widgets so it serializes into the workflow and is usable via API.
 * "Original" aspect ratio (default): no crop area, the video passes through
 * uncropped.
 *
 * No static ES imports: /scripts/app.js is a shim read at evaluation time, so
 * it is imported dynamically (absolute path) with a retry loop.
 */
const LVRC = {
  NODE_NAME: "LoadVideoCrop",
  CROP_KEYS: ["crop_x", "crop_y", "crop_w", "crop_h"],
  TRIM_KEYS: ["start_time", "duration", "strict_duration"],
  POLL_MS: 250,
  TL_FILM_H: 48,
  TL_WAVE_H: 20,
  TL_TOTAL_H: 68, // filmstrip + waveform
  TL_MIN_DUR: 0.05, // minimum trim window (seconds)
  TL_MIN_THUMBS: 4,
  TL_MAX_THUMBS: 48,
  TL_WAVE_MAX_SECONDS: 5 * 60, // decodeAudioData RAM: skip the waveform past 5 min
  TAG: "[LoadVideoCrop]",
};

let lvrcApp = null;

/* ------------------------------ helpers ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function widgetOf(node, name) {
  return node.widgets ? node.widgets.find((w) => w.name === name) : null;
}

function getState(node) {
  if (!node.__lvrc) {
    node.__lvrc = {
      inited: false,
      crop: null, // {x,y,w,h} normalized 0..1 in VIDEO CONTENT space
      cropFromWorkflow: false,
      trim: { start: 0, dur: 0 }, // seconds; dur 0 = unlimited (to the end)
      trimFromWorkflow: false,
      lastKey: null,
      lastSrc: null,
      dom: null, // {parent, overlay, box, label, tl, ...}
    };
  }
  return node.__lvrc;
}

/* ------------------ localStorage persistence (crop + trim) -------------
 * ComfyUI multi-tab (both the classic and the 2.0 layouts) re-instantiates
 * the nodes and resets the FLOAT
 * widgets to their defaults (losing crop + trim) while the aspect_ratio
 * combo keeps its value. The last user settings are therefore cached here,
 * per file (signature = name + native size + duration) and re-applied on
 * re-init. The workflow always wins: if the crop/trim widgets carry
 * non-default values (saved workflow / API) the cache is ignored. */
const LS_PREFIX = "lvrc1:";

function fileSigOf(v) {
  let name = "";
  try {
    name = decodeURIComponent(
      new URL(v.currentSrc || v.src, location.href).pathname.split("/").pop()
    );
  } catch (_) { /* fall back to the raw src below */ }
  const dur = videoDuration(v);
  const nat = videoNatural(v);
  return `${name || (v.currentSrc || v.src || "")}|${nat ? nat.w + "x" + nat.h : "?"}|${dur.toFixed(3)}`;
}

function lsKeyOfVideo(v) {
  return v ? LS_PREFIX + fileSigOf(v) : null;
}

function lsSave(node) {
  try {
    const st = node.__lvrc;
    const v = st && st.dom ? st.dom.video : null;
    const key = lsKeyOfVideo(v);
    if (!key) return;
    const crop = st.crop ? { x: st.crop.x, y: st.crop.y, w: st.crop.w, h: st.crop.h } : null;
    localStorage.setItem(key, JSON.stringify({
      crop,
      trim: { start: st.trim.start, dur: st.trim.dur },
      ts: Date.now(),
    }));
    // housekeeping: drop entries older than 7 days so the cache never grows
    const now = Date.now();
    const stale = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX) || k === key) continue;
      let old = null;
      try { old = JSON.parse(localStorage.getItem(k) || "null"); } catch (_) { /* ignore */ }
      if (!old || !old.ts || now - old.ts > 7 * 24 * 3600 * 1000) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch (_) { /* storage unavailable / quota: persistence is best-effort */ }
}

/** Restore reads the video element directly: at re-init time `st.dom` is
 * not built yet, so the node-based lookup would silently miss. */
function lsLoadForVideo(v) {
  try {
    const key = lsKeyOfVideo(v);
    if (!key) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.trim !== "object" || s.trim === null) return null;
    return s;
  } catch (_) {
    return null;
  }
}

function ratioOf(node) {
  const w = widgetOf(node, "aspect_ratio");
  const v = w ? String(w.value) : "Original";
  if (/^\s*original\b/i.test(v)) return null; // "Original" -> no crop at all
  const m = v.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const r = parseFloat(m[1]) / parseFloat(m[2]);
    if (isFinite(r) && r > 0) return r;
  }
  return 1;
}

function videoIsVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * Locate the visible <video> element for a node, in both designs:
 *   - classic: inside node.videoContainer (div.comfy-img-preview)
 *   - 2.0/Vue: inside the node's [data-node-id] element (div.video-preview)
 * In 2.0 the LiteGraph container may be hidden while the Vue player is the
 * visible one, so gather every candidate and prefer the visible element.
 */
function videoElOf(node) {
  const cands = [];
  if (node.videoContainer && node.videoContainer.querySelector) {
    const v = node.videoContainer.querySelector("video");
    if (v) cands.push(v);
  }
  try {
    const root = document.querySelector(`[data-node-id="${node.id}"]`);
    if (root) root.querySelectorAll("video").forEach((v) => cands.push(v));
  } catch (_) { /* ignore */ }
  for (const v of cands) if (videoIsVisible(v)) return v;
  return cands[0] || null;
}

/** Video content (decoded) size, or null until the first frame is known. */
function videoNatural(v) {
  if (!v) return null;
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return null;
  return { w, h };
}

/** Total playable duration in seconds, or 0 until metadata is loaded. */
function videoDuration(v) {
  if (!v) return 0;
  const d = v.duration;
  return isFinite(d) && d > 0 ? d : 0;
}

/** Largest rect (normalized) with the given aspect ratio fitting cw x ch. */
function maxFitRatio(ratio, cw, ch) {
  if (ratio <= cw / ch) return { w: (ratio * ch) / cw, h: 1 };
  return { w: 1, h: cw / (ratio * ch) };
}

function resetCrop(node, cw, ch) {
  const st = getState(node);
  const r = ratioOf(node);
  if (r == null) {
    st.crop = null;
  } else {
    const fr = maxFitRatio(r, cw, ch);
    st.crop = { x: (1 - fr.w) / 2, y: (1 - fr.h) / 2, w: fr.w, h: fr.h };
  }
  st.cropFromWorkflow = false;
  writeCrop(node);
}

/** Clamp crop to content bounds, keeping the ratio (height-driven). */
function fitCrop(node, c, cw, ch) {
  const r = ratioOf(node);
  if (r == null) return c;
  const k = r * (ch / cw);
  const fr = maxFitRatio(r, cw, ch);
  c.h = Math.min(Math.max(c.h, 0.02), fr.h);
  c.w = c.h * k;
  c.x = Math.min(Math.max(0, c.x), Math.max(0, 1 - c.w));
  c.y = Math.min(Math.max(0, c.y), Math.max(0, 1 - c.h));
  return c;
}

function writeCrop(node) {
  const st = getState(node);
  const c = st.crop || { x: 0, y: 0, w: 1, h: 1 };
  const map = { crop_x: "x", crop_y: "y", crop_w: "w", crop_h: "h" };
  for (const [key, prop] of Object.entries(map)) {
    const w = widgetOf(node, key);
    if (w) w.value = c[prop];
  }
}

function initCropFromWidgets(node, cw, ch) {
  const st = getState(node);
  if (ratioOf(node) == null) {
    st.crop = null;
    writeCrop(node);
    return;
  }
  if (st.crop) return;
  const g = (k) => {
    const w = widgetOf(node, k);
    return w && Number.isFinite(w.value) ? w.value : undefined;
  };
  const x = g("crop_x"), y = g("crop_y"), w = g("crop_w"), h = g("crop_h");
  if (x == null || y == null || w == null || h == null) {
    resetCrop(node, cw, ch);
  } else if (x === 0 && y === 0 && w === 1 && h === 1) {
    resetCrop(node, cw, ch);
  } else {
    st.crop = { x, y, w, h };
    st.cropFromWorkflow = true;
  }
}

/* --------------------------- trim state ------------------------------ */

/** Push the trim window into the (hidden) widgets so it serializes. */
function writeTrim(node) {
  const st = getState(node);
  const t = st.trim;
  const wStart = widgetOf(node, "start_time");
  const wDur = widgetOf(node, "duration");
  if (wStart) wStart.value = t.start;
  if (wDur) wDur.value = t.dur;
}

function initTrimFromWidgets(node) {
  const st = getState(node);
  const g = (k) => {
    const w = widgetOf(node, k);
    return w && Number.isFinite(w.value) ? w.value : undefined;
  };
  const start = g("start_time");
  const dur = g("duration");
  if (start != null && dur != null && (start > 0 || dur > 0)) {
    st.trim = { start: Math.max(0, start), dur: Math.max(0, dur) };
    st.trimFromWorkflow = true;
    return;
  }
  st.trim = { start: 0, dur: 0 };
  st.trimFromWorkflow = false;
}

/** The window in ABSOLUTE seconds on the (uncropped) preview video.
 * A negative start (API-set) means "from the end" and is resolved here. */
function trimWindowOf(node, durTotal) {
  const t = getState(node).trim;
  const start = t.start < 0 ? Math.max(0, durTotal + t.start) : Math.min(Math.max(0, t.start), durTotal);
  const end = t.dur > 0 ? Math.min(start + t.dur, durTotal) : durTotal;
  return { start, end };
}

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

/* ------------------------------ misc ------------------------------ */

function markDirty(node) {
  try {
    if (node.graph && typeof node.graph.setDirtyCanvas === "function") {
      node.graph.setDirtyCanvas(true);
    }
  } catch (_) { /* ignore */ }
}

/* --------------------------- overlay (DOM) --------------------------- */

/**
 * Detach our DOM (crop overlay + timeline + hidden thumb video). NEVER
 * removes the <video> itself. Safe to call repeatedly.
 */
function removeOverlay(node) {
  const st = node.__lvrc;
  if (st && st.dom) {
    // stop any in-flight thumbnail capture
    if (st.dom.thumbs) st.dom.thumbs.cancelled = true;
    // the hidden thumb <video> is a child of the timeline, so removing the
    // timeline removes it too; clear the references either way
    for (const el of [st.dom.overlay, st.dom.tl, st.dom.saveBtn]) {
      if (el && el.parentElement) el.parentElement.removeChild(el);
    }
  }
  if (st) st.dom = null;
}

/* Mirror of LoadVideoCrop._crop.even_box: the exact pixel box the backend
 * writes to disk (even-snapped + clamped). pyRound reproduces Python's
 * round-half-to-even so the JS math matches the backend bit-for-bit. */
function pyRound(x) {
  const f = Math.floor(x);
  const frac = x - f;
  if (frac > 0.5) return f + 1;
  if (frac < 0.5) return f;
  return f % 2 === 0 ? f : f + 1; // exactly 0.5 -> even neighbor
}
function evenBox(fx0, fy0, fx1, fy1, W, H) {
  const clampi = (v, lo, hi) => Math.max(lo, Math.min(hi, pyRound(v)));
  let x0 = clampi(fx0 * W, 0, W - 2);
  let y0 = clampi(fy0 * H, 0, H - 2);
  let x1 = clampi(fx1 * W, x0 + 2, W);
  let y1 = clampi(fy1 * H, y0 + 2, H);
  x0 -= x0 % 2;
  y0 -= y0 % 2;
  let w = x1 - x0;
  let h = y1 - y0;
  w -= w % 2;
  h -= h % 2;
  if (w < 2) w = 2;
  if (h < 2) h = 2;
  if (x0 + w > W) { w = W - x0; w -= w % 2; }
  if (y0 + h > H) { h = H - y0; h -= h % 2; }
  return { x0, y0, w, h };
}

/**
 * (Re)sync the DOM for a node. Reconnects (never destroys) when the video or
 * its container changed under us (Vue re-render on aspect-ratio change, file
 * change); re-inits crop/trim only when the content or ratio changed.
 */
function layoutOverlay(node) {
  const st = getState(node);
  const v = videoElOf(node);
  const nat = videoNatural(v);
  if (!v || !nat) {
    removeOverlay(node);
    return;
  }
  const cw = nat.w, ch = nat.h;

  // the duration is part of the file signature (localStorage key); the
  // block below re-runs once it becomes known
  const dur = videoDuration(v);
  const key = `${v.src}|${ratioOf(node)}|${cw}x${ch}|${dur.toFixed(3)}`;
  if (st.lastKey !== key) {
    st.lastKey = key;
    // file changed -> the captured assets (thumbnails, waveform) belong to
    // the previous file: drop them so they get re-captured. The very first
    // sighting only records the src (a workflow-loaded trim must survive).
    // (captured before the block below consumes st.lastSrc)
    const fileChanged = st.lastSrc !== v.src;
    if (fileChanged) {
      const first = st.lastSrc == null;
      if (dur > 0) st.lastSrc = v.src; // only once the metadata is complete
      if (!first && dur > 0 && st.dom) {
        clearThumbs(node);
        st.dom.waveData = null;
        st.dom.waveKey = undefined;
        if (st.dom.wave) {
          try {
            const wctx = st.dom.wave.getContext("2d");
            wctx.clearRect(0, 0, st.dom.wave.width, st.dom.wave.height);
          } catch (_) { /* ignore */ }
        }
      }
      if (dur > 0) {
        // Trim window for this file: the workflow wins (initTrimFromWidgets
        // already loaded it); otherwise restore the per-file memory, or
        // reset to the full clip (spec: a new file resets the window). This
        // also covers the multi-tab re-instantiation (both layouts), where the node is
        // brand new (first sighting) and the widgets carry defaults.
        if (!first || !st.trimFromWorkflow) {
          const ld = lsLoadForVideo(v);
          const tm = ld && ld.trim;
          if (tm && (tm.start > 0 || tm.dur > 0)) {
            st.trim = { start: Math.max(0, tm.start), dur: Math.max(0, tm.dur) };
          } else {
            st.trim = { start: 0, dur: 0 };
          }
          writeTrim(node);
        }
      }
    }
    let chosen = "?";
    if (node.videoContainer && node.videoContainer.contains(v)) chosen = "videoContainer";
    else if (document.querySelector(`[data-node-id="${node.id}"]`)) chosen = "data-node-id";
    console.log(
      LVRC.TAG, "node", node.id, "file", (v.currentSrc || v.src || "").split("/").pop(),
      "content", cw + "x" + ch, "ratio", ratioOf(node), "chosen", chosen,
      "parentClass", ((v.parentElement && v.parentElement.className) || "").toString().slice(0, 60)
    );
    if (!st.cropFromWorkflow) {
      // the widgets carried no crop (fresh node, or the frontend reset the
      // FLOAT widgets on a tab switch): prefer the localStorage memory for
      // this exact file over the default max-fit crop. Only on (re)init or
      // file change - an ASPECT RATIO change is not a file change and must
      // reset the box to the new max fit (spec).
      const ld = fileChanged && ratioOf(node) != null && dur > 0 ? lsLoadForVideo(v) : null;
      const lc = ld && ld.crop;
      if (lc && lc.w > 0.01 && lc.h > 0.01) {
        st.crop = { x: lc.x, y: lc.y, w: lc.w, h: lc.h };
        fitCrop(node, st.crop, cw, ch);
        writeCrop(node);
      } else {
        resetCrop(node, cw, ch);
      }
    } else {
      st.crop = fitCrop(node, st.crop, cw, ch);
      writeCrop(node);
    }
    // Note: the trim window is deliberately NOT reset here. A key change
    // also happens when the user only changes the ASPECT RATIO, and the
    // IN/OUT marks must survive that. A changed FILE already resets the
    // trim (see the lastSrc block above).
  } else if (!st.crop && ratioOf(node) != null) {
    initCropFromWidgets(node, cw, ch);
  }

  const parent = v.parentElement;
  if (!parent) return;

  const same = st.dom && st.dom.video === v && st.dom.parent === parent;
  if (!same) buildOverlay(node, v, parent);
  if (!st.dom) return;

  sizeVideoBox(node);

  const { overlay, box, label } = st.dom;
  const c = st.crop;
  if (!c) {
    overlay.style.display = "none";
  } else {
    // re-measure AFTER sizeVideoBox (the video box height is set above)
    const vw = v.clientWidth || 1;
    const vh = v.clientHeight || 1;
    if (vw < 2 || vh < 2) { layoutTimeline(node); return; }
    overlay.style.display = "";
    // content area inside the VIDEO box: object-contain
    const s = Math.min(vw / cw, vh / ch);
    const dw = cw * s;
    const dh = ch * s;
    const vr = v.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    // video box offset inside the parent (normally 0,0: the video is
    // absolute-top in the parent; kept for robustness)
    const vx = vr.left - pr.left;
    const vy = vr.top - pr.top;
    // box coords in VIDEO-CONTENT space, in px from the overlay origin
    // (the overlay spans the video box exactly)
    const bx = vx + (vw - dw) / 2 + c.x * dw;
    const by = vy + (vh - dh) / 2 + c.y * dh;
    box.style.left = (bx / vw) * 100 + "%";
    box.style.top = (by / vh) * 100 + "%";
    box.style.width = (c.w * dw / vw) * 100 + "%";
    box.style.height = (c.h * dh / vh) * 100 + "%";
    const out = evenBox(c.x, c.y, c.x + c.w, c.y + c.h, cw, ch);
    label.textContent = `${out.w} × ${out.h}`;
    label.style.display = box.offsetHeight > 18 ? "" : "none";
  }

  layoutTimeline(node);
  // kick off the asynchronous bits (self-cancelling, re-run safely)
  startThumbs(node);
  startWave(node);
}

/** Keep the <video> filling the TOP of its container and the container
 * (H_video + timeline) tall, so the timeline lives BELOW the video. */
function sizeVideoBox(node) {
  const st = node.__lvrc;
  if (!st || !st.dom) return;
  const v = st.dom.video;
  const parent = st.dom.parent;
  const nat = videoNatural(v);
  if (!nat) return;
  const isClassic = node.videoContainer === parent;

  if (isClassic) {
    // classic: the LiteGraph DOM widget (type "video") drives the container
    // size via computeLayoutSize -> add the timeline height to its minHeight.
    const wdg = (node.widgets || []).find((w) => w && w.type === "video");
    if (wdg && !wdg.__lvrcSized) {
      wdg.__lvrcSized = true;
      const orig = wdg.computeLayoutSize;
      wdg.computeLayoutSize = () => {
        const r = orig && typeof orig === "function" ? orig() : {};
        // minWidth is DELIBERATELY 0: the core returns the node's current
        // width as minWidth, which pins the node so it can never be resized
        // narrower; returning 0 frees the node to any width (the video
        // letterboxes via object-fit:contain)
        return {
          minHeight: (Number.isFinite(r.minHeight) ? r.minHeight : 0) + LVRC.TL_TOTAL_H,
          minWidth: 0,
        };
      };
    }
  } else {
    // 2.0/Vue: size the container ourselves (the poller re-applies after
    // re-renders). Target = the video aspect height at the current width
    // plus the timeline.
    const baseH = (parent.clientWidth / nat.w) * nat.h;
    const target = Math.round(baseH + LVRC.TL_TOTAL_H);
    if (Math.abs(parent.clientHeight - target) > 1) {
      parent.style.height = target + "px";
    }
  }

  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  v.style.position = "absolute";
  v.style.left = "0";
  v.style.top = "0";
  v.style.width = "100%";
  v.style.height = `calc(100% - ${LVRC.TL_TOTAL_H}px)`;
  v.style.objectFit = "contain";
}

function buildOverlay(node, v, parent) {
  const st = getState(node);
  const old = st.dom;
  removeOverlay(node);
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

  // The crop overlay is PURELY VISUAL (pointer-events:none): the native
  // <video> controls always work; all crop interaction is driven from
  // document capture-phase listeners with a manual hit-test against this box.
  const overlay = document.createElement("div");
  overlay.dataset.lvrcOverlay = "1";
  // covers ONLY the video box (the bottom TL_TOTAL_H px is the timeline):
  // the dimming box-shadow must not darken the timeline strip
  overlay.style.cssText =
    `position:absolute;left:0;top:0;width:100%;height:calc(100% - ${LVRC.TL_TOTAL_H}px);z-index:2;pointer-events:none;overflow:hidden;`;
  const box = document.createElement("div");
  box.style.cssText =
    "position:absolute;box-sizing:border-box;border:2px solid #ff4040;box-shadow:0 0 0 4000px rgba(0,0,0,0.55);cursor:move;";
  const label = document.createElement("div");
  label.style.cssText =
    "position:absolute;left:4px;top:2px;font:11px monospace;color:#fff;background:rgba(0,0,0,0.8);padding:0 4px;white-space:nowrap;";
  box.appendChild(label);
  overlay.appendChild(box);

  parent.appendChild(overlay);

  st.dom = { parent, overlay, box, label, video: v };
  buildTimeline(node, parent); // stores tl/film/wave/... on st.dom

  // "Save frame" button: top-left of the video box (the right side is taken
  // by the 2.0 layout controls). One click downloads the current frame as
  // PNG: the full frame, plus the cropped frame at the exact output
  // dimensions (identical in Original mode, so only the full one is saved).
  // Created here so it is rebuilt with the overlay on every (re)render.
  const saveBtn = document.createElement("button");
  saveBtn.dataset.lvrcSaveFrame = "1";
  saveBtn.type = "button";
  saveBtn.textContent = "\uD83D\uDCBE Frame";
  saveBtn.title = "Save the current frame as PNG (full, plus cropped at the exact output dimensions)";
  saveBtn.style.cssText =
    "position:absolute;top:8px;left:8px;z-index:3;pointer-events:auto;" +
    "background:rgba(0,0,0,0.6);color:#fff;border:1px solid rgba(255,255,255,0.35);" +
    "border-radius:4px;padding:2px 8px;font:12px sans-serif;cursor:pointer;";
  // keep the core's container handlers (canvas pan/zoom) out of it
  saveBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    saveFrames(node);
  });
  parent.appendChild(saveBtn);
  st.dom.saveBtn = saveBtn;

  // Reuse the already-captured assets (same file only): move the finished
  // thumbnail <img>s into the new filmstrip and redraw the waveform, so a
  // Vue re-render (e.g. on aspect-ratio change) does not re-seek the file.
  const oldSrc = old && old.video ? (old.video.currentSrc || old.video.src || "") : "";
  const newSrc = v.currentSrc || v.src || "";
  if (old && oldSrc === newSrc) {
    if (old.thumbs) old.thumbs.cancelled = true;
    if (old.film && st.dom.film) {
      for (const img of old.film.querySelectorAll("img")) st.dom.film.appendChild(img);
      st.dom.thumbs.els = Array.from(st.dom.film.querySelectorAll("img"));
      // carry the finished state: a completed capture is NOT re-seeked; an
      // interrupted one is captured from scratch on the new DOM
      st.dom.thumbs.key = old.thumbs ? old.thumbs.key : "";
      st.dom.thumbs.done = old.thumbs ? old.thumbs.done : false;
    }
    if (old.waveData && st.dom.wave) {
      st.dom.waveData = old.waveData;
      st.dom.waveKey = old.waveKey;
      drawWave(st.dom.wave, old.waveData);
    }
  }
  layoutOverlay(node);
}

/* --------------------------- trim timeline --------------------------- */

function buildTimeline(node, parent) {
  const st = getState(node);
  const tl = document.createElement("div");
  tl.dataset.lvrcTimeline = "1";
  tl.style.cssText =
    `position:absolute;left:0;right:0;bottom:0;height:${LVRC.TL_TOTAL_H}px;z-index:1;` +
    "background:#0a0a0a;pointer-events:auto;";

  const film = document.createElement("div");
  film.dataset.lvrcFilm = "1";
  film.style.cssText = `position:absolute;left:0;right:0;top:0;height:${LVRC.TL_FILM_H}px;background:#141414;overflow:hidden;`;

  const wave = document.createElement("canvas");
  wave.dataset.lvrcWave = "1";
  wave.style.cssText = `position:absolute;left:0;right:0;top:${LVRC.TL_FILM_H}px;height:${LVRC.TL_WAVE_H}px;width:100%;background:#0d0d0d;`;

  const dim = document.createElement("div");
  dim.dataset.lvrcDim = "1";
  dim.style.cssText = "position:absolute;left:0;right:0;top:0;bottom:0;background:rgba(0,0,0,0.55);";

  const sel = document.createElement("div");
  sel.dataset.lvrcSel = "1";
  sel.style.cssText =
    "position:absolute;left:0%;width:100%;top:0;bottom:0;" +
    "background:rgba(64,192,255,0.10);cursor:default;";

  // Thin 2px marker lines (frame-precise) with a small grip on top as the
  // drag affordance. The pointer handler keeps a +/-7px grab tolerance, so
  // the thin lines remain easy to grab.
  const hL = document.createElement("div");
  hL.dataset.lvrcHL = "1";
  hL.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:2px;cursor:ew-resize;background:#40c0ff;";
  const gL = document.createElement("div");
  gL.style.cssText =
    "position:absolute;left:-4px;top:0;width:10px;height:12px;border-radius:2px;cursor:ew-resize;" +
    "background:#40c0ff;box-shadow:0 0 3px rgba(0,0,0,0.8);";
  hL.appendChild(gL);
  const hR = document.createElement("div");
  hR.dataset.lvrcHR = "1";
  hR.style.cssText = "position:absolute;right:0;top:0;bottom:0;width:2px;cursor:ew-resize;background:#40c0ff;";
  const gR = document.createElement("div");
  gR.style.cssText =
    "position:absolute;right:-4px;top:0;width:10px;height:12px;border-radius:2px;cursor:ew-resize;" +
    "background:#40c0ff;box-shadow:0 0 3px rgba(0,0,0,0.8);";
  hR.appendChild(gR);
  const lbl = document.createElement("div");
  lbl.dataset.lvrcLbl = "1";
  lbl.style.cssText =
    "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);" +
    "font:10px monospace;color:#fff;white-space:nowrap;pointer-events:none;text-shadow:0 0 3px #000;";
  sel.appendChild(hL);
  sel.appendChild(hR);
  sel.appendChild(lbl);

  const ph = document.createElement("div");
  ph.dataset.lvrcPH = "1";
  ph.style.cssText = "position:absolute;top:0;bottom:0;width:2px;left:0%;background:#fff;pointer-events:none;";

  tl.appendChild(film);
  tl.appendChild(wave);
  tl.appendChild(dim);
  tl.appendChild(sel);
  tl.appendChild(ph);
  parent.appendChild(tl);
  installTimelineEvents(node, tl);

  // attach into st.dom (created by buildOverlay)
  const d = getState(node).dom;
  d.tl = tl;
  d.film = film;
  d.wave = wave;
  d.sel = sel;
  d.lbl = lbl;
  d.ph = ph;
  d.thumbs = { key: "", els: [], src: "", cancelled: false, video: null, done: false };
  d.waveData = null;
}

/** Position selection/handles/label for the current trim window. The
 * playhead is driven by the rAF loop (startPlayheadLoop). */
function layoutTimeline(node) {
  const st = node.__lvrc;
  if (!st || !st.dom) return;
  const { tl, sel, lbl, ph, video } = st.dom;
  const durTotal = videoDuration(video);
  if (!durTotal || !tl) {
    if (tl) tl.style.display = "none";
    return;
  }
  tl.style.display = "";
  const { start, end } = trimWindowOf(node, durTotal);
  sel.style.left = (start / durTotal) * 100 + "%";
  sel.style.width = Math.max(0, ((end - start) / durTotal) * 100) + "%";
  lbl.textContent = `${fmtTime(start)} – ${fmtTime(end)}  (${(end - start).toFixed(2)}s)`;
  if (ph) {
    const p = Math.min(1, Math.max(0, (video.currentTime || 0) / durTotal));
    ph.style.left = p * 100 + "%";
  }
}

/* --------------------- filmstrip thumbnails -------------------------- */

function thumbCountOf(durTotal) {
  return Math.min(LVRC.TL_MAX_THUMBS, Math.max(LVRC.TL_MIN_THUMBS, Math.ceil(durTotal)));
}

function clearThumbs(st) {
  const d = st.dom;
  if (!d) return;
  d.thumbs.cancelled = true;
  if (d.thumbs.els) {
    for (const el of d.thumbs.els) {
      if (el.parentElement) el.parentElement.removeChild(el);
    }
  }
  d.thumbs.els = [];
  if (d.thumbs.video && d.thumbs.video.parentElement) {
    d.thumbs.video.parentElement.removeChild(d.thumbs.video);
  }
  d.thumbs.video = null;
}

function seekTo(v, t) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("seek timeout")), 2000);
    v.onseeked = () => { clearTimeout(to); res(); };
    v.onerror = () => { clearTimeout(to); rej(new Error("seek error")); };
    try {
      v.currentTime = Math.min(Math.max(0, t), Math.max(0, videoDuration(v) - 0.05));
    } catch (e) {
      clearTimeout(to);
      rej(e);
    }
  });
}

/** Fill the filmstrip with real frames: a second hidden <video> is seeked to
 * N equidistant points (N = clamp(ceil(dur), 4, 48)) and each frame is drawn
 * to a small JPEG. Progressive: thumbnails appear as they are captured. */
function startThumbs(node) {
  const st = node.__lvrc;
  const d = st.dom;
  const v = d.video;
  const durTotal = videoDuration(v);
  if (!durTotal || !d.film) return;
  const count = thumbCountOf(durTotal);
  const src = v.currentSrc || v.src || "";
  const key = `${src}|${durTotal.toFixed(3)}|${count}`;
  // skip if this exact capture already finished, or is still in flight
  // (the hidden <video> exists until the loop cleans up)
  if (d.thumbs.key === key && (d.thumbs.done || d.thumbs.video)) return;
  clearThumbs(st);
  d.thumbs = { key, els: [], src, cancelled: false, video: null, done: false };

  const cv = document.createElement("video");
  cv.muted = true;
  cv.playsInline = true;
  cv.preload = "auto";
  cv.src = src;
  cv.style.cssText = "position:absolute;width:2px;height:2px;left:-9999px;opacity:0;pointer-events:none;";
  d.thumbs.video = cv;
  parentAppendKeepHidden(node, cv);

  const nat = videoNatural(v);
  const tw = nat ? Math.max(32, Math.round(LVRC.TL_FILM_H * (nat.w / nat.h))) : 50;
  const c = document.createElement("canvas");
  c.width = tw;
  c.height = LVRC.TL_FILM_H;
  const ctx = c.getContext("2d");

  (async () => {
    try {
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error("thumb video timeout")), 8000);
        cv.onloadeddata = () => { clearTimeout(to); res(); };
        cv.onerror = () => { clearTimeout(to); rej(new Error("thumb video error")); };
      });
    } catch (_) {
      cleanup();
      return;
    }
    for (let i = 0; i < count; i++) {
      if (d.thumbs.cancelled) { cleanup(); return; }
      const t = Math.min(Math.max(0, durTotal - 0.05), ((i + 0.5) / count) * durTotal);
      try {
        await seekTo(cv, t);
      } catch (_) {
        continue; // skip a bad seek point
      }
      if (d.thumbs.cancelled) { cleanup(); return; }
      try {
        ctx.drawImage(cv, 0, 0, tw, LVRC.TL_FILM_H);
        const img = document.createElement("img");
        img.src = c.toDataURL("image/jpeg", 0.6);
        img.style.cssText =
          `position:absolute;top:0;height:100%;` +
          `width:${100 / count + 0.8}%;left:${(i * 100) / count}%;` +
          "object-fit:cover;pointer-events:none;";
        d.film.appendChild(img);
        d.thumbs.els.push(img);
      } catch (_) { /* skip frame */ }
      await sleep(0); // yield to the UI
    }
    d.thumbs.done = true; // full set captured (lets a DOM rebuild skip the re-seek)
    cleanup();
  })();

  function cleanup() {
    if (d.thumbs.video && d.thumbs.video.parentElement) {
      d.thumbs.video.parentElement.removeChild(d.thumbs.video);
    }
    d.thumbs.video = null;
  }
}

/** The hidden thumb <video> lives in the timeline track (hidden off-canvas). */
function parentAppendKeepHidden(node, cv) {
  const st = node.__lvrc;
  if (!st || !st.dom || !st.dom.tl) return;
  cv.style.position = "absolute";
  cv.style.left = "-100px";
  cv.style.width = "2px";
  cv.style.height = "2px";
  cv.style.opacity = "0";
  st.dom.tl.appendChild(cv);
}

/* --------------------- audio waveform ------------------------------- */

let lrcAudioCtx = null;

function audioCtx() {
  try {
    if (!lrcAudioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      lrcAudioCtx = new AC();
    }
    if (lrcAudioCtx.state === "suspended") lrcAudioCtx.resume();
    return lrcAudioCtx;
  } catch (_) {
    return null;
  }
}

function drawWave(canvas, data) {
  if (!data || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round((canvas.clientWidth || 300) * dpr));
  const H = Math.round(LVRC.TL_WAVE_H * dpr);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(64,192,255,0.85)";
  const mid = H / 2;
  for (let x = 0; x < W; x++) {
    // sample the envelope with linear interpolation; data holds 600 bins x 2
    // (min,max), so the bin count is data.length / 2
    const bins = data.length / 2;
    const f = (x / W) * bins;
    const i0 = Math.min(bins - 1, Math.floor(f));
    const i1 = Math.min(bins - 1, i0 + 1);
    const fr = f - i0;
    const mn = data[i0 * 2] * (1 - fr) + data[i1 * 2] * fr;
    const mx = data[i0 * 2 + 1] * (1 - fr) + data[i1 * 2 + 1] * fr;
    const y0 = mid + mn * mid; // mn is -1..0
    const h = Math.max(1, (mx - mn) * mid);
    ctx.fillRect(x, y0, 1, h);
  }
}

/** Fetch + decode the audio once and store a min/max envelope. Skipped for
 * very long files (large decode) - the filmstrip still works. */
function startWave(node) {
  const st = node.__lvrc;
  const d = st.dom;
  const v = d.video;
  const durTotal = videoDuration(v);
  if (!durTotal || !d.wave) return;
  const src = v.currentSrc || v.src || "";
  if (d.waveData || d.waveKey === src) return;
  d.waveKey = src;
  if (durTotal > LVRC.TL_WAVE_MAX_SECONDS) {
    d.waveData = null;
    return;
  }
  (async () => {
    let buf = null;
    try {
      const resp = await fetch(src);
      buf = await resp.arrayBuffer();
    } catch (_) {
      return;
    }
    const actx = audioCtx();
    if (!actx || !buf) return;
    let audio = null;
    try {
      audio = await actx.decodeAudioData(buf);
    } catch (_) {
      return; // no decodable audio
    }
    // mono envelope over 600 bins (channel 0; enough for a visual cue)
    const nBins = 600;
    const data = new Float32Array(nBins * 2).fill(0);
    const ch = audio.getChannelData(0);
    const n = ch.length;
    const step = n / nBins;
    for (let b = 0; b < nBins; b++) {
      const s0 = Math.floor(b * step);
      const s1 = Math.min(n, Math.floor((b + 1) * step));
      let mn = 0, mx = 0;
      // sample at most every 8th point (fast, accurate enough)
      const inc = Math.max(1, Math.floor((s1 - s0) / 512));
      for (let i = s0; i < s1; i += inc) {
        const x = ch[i];
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
      data[b * 2] = mn;
      data[b * 2 + 1] = mx;
    }
    if (d.waveKey !== src) return; // file changed meanwhile
    d.waveData = data;
    drawWave(d.wave, data);
  })();
}

/** Redraw the waveform whenever the timeline width changed. */
function resyncWave(node) {
  const st = node.__lvrc;
  if (!st || !st.dom) return;
  const d = st.dom;
  if (!d.wave || !d.waveData) return;
  drawWave(d.wave, d.waveData);
}

/* --------------------- frame saving ---------------------------------- */

/** Best-effort file stem from the video src (for the PNG file name). */
function frameBaseName(v) {
  try {
    const p = new URL(v.currentSrc || v.src, location.href).pathname.split("/").pop() || "";
    let n = decodeURIComponent(p).replace(/\.[a-z0-9]{2,5}$/i, "");
    n = n.replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "");
    return n || "video";
  } catch (_) {
    return "video";
  }
}

/** mm-ss.cc timecode for the file name. */
function frameTimecode(t) {
  const m = Math.floor(t / 60);
  const cs = Math.min(5999, Math.floor((t % 60) * 100));
  return String(m).padStart(2, "0") + "-" + String(cs).padStart(4, "0");
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function saveFrameTo(v, sx, sy, sw, sh, name) {
  return new Promise((resolve) => {
    const cv = document.createElement("canvas");
    cv.width = sw;
    cv.height = sh;
    const ctx = cv.getContext("2d");
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    cv.toBlob((blob) => {
      if (!blob) { resolve(false); return; }
      downloadBlob(blob, name);
      resolve(true);
    }, "image/png");
  });
}

const SAVE_BTN_IDLE = "\uD83D\uDCBE Frame";

/** One click downloads the current frame as PNG via the browser: the full
 * frame plus the cropped frame at the exact output dimensions (only the
 * full one in Original mode); the outcome is reported on the button. */
async function saveFrames(node) {
  const st = node.__lvrc;
  const d = st && st.dom;
  const v = d && d.video;
  if (!v || !v.videoWidth) return;
  const btn = d.saveBtn;
  if (btn) { btn.disabled = true; btn.textContent = "\u2026"; }
  let ok = true;
  let state = "saved";
  try {
    const W = v.videoWidth;
    const H = v.videoHeight;
    const c = st.crop;
    const base = frameBaseName(v) + "_t" + frameTimecode(v.currentTime || 0);
    // Original aspect ratio has no crop, so a cropped PNG would be a
    // duplicate of the full one: save only the full frame in that case.
    const results = [saveFrameTo(v, 0, 0, W, H, base + "_full.png")];
    if (c) {
      const box = evenBox(c.x, c.y, c.x + c.w, c.y + c.h, W, H);
      results.push(saveFrameTo(v, box.x0, box.y0, box.w, box.h, base + "_crop.png"));
    }
    ok = (await Promise.all(results)).every(Boolean);
  } catch (err) {
    console.warn(LVRC.TAG, "saveFrames", err);
    state = "failed";
  }
  if (btn) {
    btn.textContent = state === "failed" || !ok
      ? "\u26A0 Failed"
      : "\u2713 Saved";
  }
  setTimeout(() => {
    if (btn) { btn.textContent = SAVE_BTN_IDLE; btn.disabled = false; }
  }, 1600);
}

/* --------------------- timeline interaction -------------------------- */

let tlActive = null; // { node, mode, grabT, start, dur, pid }

function tlFracOf(tl, e) {
  const r = tl.getBoundingClientRect();
  if (!r || r.width <= 0) return 0;
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}

function installTimelineEvents(node, tl) {
  tl.addEventListener("pointerdown", (e) => {
    try {
      if (e.button !== 0 || tlActive) return;
      const st = node.__lvrc;
      const v = st && st.dom ? st.dom.video : null;
      const durTotal = videoDuration(v);
      if (!st || !v || !durTotal) return;
      const r = tl.getBoundingClientRect();
      if (!r || r.width <= 0) return;
      const px = e.clientX - r.left;
      const t = (px / r.width) * durTotal;
      const { start, end } = trimWindowOf(node, durTotal);
      const selLeftPx = (start / durTotal) * r.width;
      const selRightPx = (end / durTotal) * r.width;
      let mode = "seek";
      if (Math.abs(px - selLeftPx) <= 7) mode = "resize-l";
      else if (Math.abs(px - selRightPx) <= 7) mode = "resize-r";
      // the middle of the selection is NOT draggable: only IN/OUT move;
      // pressing anywhere else (including the middle) just seeks
      if (mode === "seek") {
        try { v.currentTime = Math.min(Math.max(0, t), durTotal); } catch (_) { /* not seekable yet */ }
        // keep the core's container handlers (canvas pan/zoom) out of it
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      tlActive = {
        node, mode, grabT: t - start, start, dur: st.trim.dur, pid: e.pointerId,
        downX: e.clientX, downY: e.clientY, moved: false,
      };
      try { tl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      tl.style.cursor = "ew-resize";
      // editor behavior: pause the preview so the marker drag below can scrub it
      if (mode === "resize-l" || mode === "resize-r") {
        try { v.pause(); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.warn(LVRC.TAG, "tl pointerdown", err);
    }
  });

  tl.addEventListener("pointermove", (e) => {
    if (!tlActive || tlActive.node !== node) return;
    try {
      const st = node.__lvrc;
      const v = st && st.dom ? st.dom.video : null;
      const durTotal = videoDuration(v);
      if (!st || !v || !durTotal) return;
      const t = tlFracOf(tl, e) * durTotal;
      const a = tlActive;
      // click-vs-drag: a pointer that barely moved is a click, not a drag
      if (!a.moved) {
        if (Math.abs(e.clientX - a.downX) <= 4 && Math.abs(e.clientY - a.downY) <= 4) return;
        a.moved = true;
      }
      const MIN = LVRC.TL_MIN_DUR;
      let start;
      let dur;
      if (a.mode === "resize-l") {
        // only the IN moves: the OUT (end) stays fixed
        const end = a.dur > 0 ? Math.min(a.start + a.dur, durTotal) : durTotal;
        start = Math.min(Math.max(0, t), Math.max(0, end - MIN));
        dur = a.dur > 0 ? end - start : 0;
      } else {
        start = a.start;
        const end = Math.min(Math.max(t, a.start + MIN), durTotal);
        dur = end - a.start;
      }
      st.trim = { start, dur };
      writeTrim(node);
      layoutTimeline(node);
      // while dragging IN/OUT, the preview scrubs to the marker position
      if (a.mode === "resize-l" || a.mode === "resize-r") {
        const mt = (a.mode === "resize-l" ? start : start + dur);
        try { v.currentTime = Math.min(Math.max(0, mt), durTotal); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.warn(LVRC.TAG, "tl pointermove", err);
    }
  });

  const tlEnd = (e) => {
    if (!tlActive || tlActive.node !== node) return;
    const a = tlActive;
    tlActive = null;
    tl.style.cursor = "default";
    if (a.moved) lsSave(node); // remember the marks (drag only; a click is a seek)
    // a click (no drag) on the selection/handles = seek to that position,
    // same as clicking the rest of the timeline
    if (!a.moved && e && e.clientX !== undefined) {
      try {
        const st = node.__lvrc;
        const v = st && st.dom ? st.dom.video : null;
        const durTotal = videoDuration(v);
        if (!v || !durTotal) return;
        const r = tl.getBoundingClientRect();
        if (!r || r.width <= 0) return;
        const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * durTotal;
        v.currentTime = Math.min(Math.max(0, t), durTotal);
      } catch (_) { /* ignore */ }
    }
  };
  tl.addEventListener("pointerup", tlEnd);
  tl.addEventListener("pointercancel", tlEnd);

  // the core binds wheel/pointer to the container for canvas pan/zoom:
  // eat wheel over the timeline so the graph does not jump while adjusting
  // the trim
  tl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    { passive: false }
  );
}

/* Keyboard I/O marking (editor style): I = mark in, O = mark out at the
 * playhead. Only when not typing in an input. */
let keyHandlerInstalled = false;

function installKeyHandler() {
  if (keyHandlerInstalled) return;
  keyHandlerInstalled = true;
  document.addEventListener("keydown", (e) => {
    try {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
      const k = (e.key || "").toLowerCase();
      if (k !== "i" && k !== "o") return;
      if (!lvrcApp || !lvrcApp.graph) return;
      // the LAST LoadVideoCrop node with a visible player (or the first)
      let target = null;
      for (const n of lvrcApp.graph.nodes || []) {
        if (n.type !== LVRC.NODE_NAME || !n.__lvrc || !n.__lvrc.dom) continue;
        const v = n.__lvrc.dom.video;
        if (v && videoIsVisible(v)) target = n;
      }
      if (!target) return;
      const st = target.__lvrc;
      const v = st.dom.video;
      const durTotal = videoDuration(v);
      if (!durTotal) return;
      const ct = Math.min(Math.max(0, v.currentTime || 0), durTotal);
      const { start, end } = trimWindowOf(target, durTotal);
      const MIN = LVRC.TL_MIN_DUR;
      let s = start;
      let d = st.trim.dur;
      if (k === "i") {
        s = Math.min(ct, Math.max(0, end - MIN));
        d = end - s; // only the IN moves; OUT (end) stays fixed
      } else {
        const ne = Math.max(ct, start + MIN);
        d = ne - start;
      }
      st.trim = { start: s, dur: d };
      writeTrim(target);
      lsSave(target);
      layoutTimeline(target);
    } catch (err) {
      console.warn(LVRC.TAG, "keydown", err);
    }
  }, true);
}

/* --------------------------- poller ---------------------------------- */

let pollerStarted = false;

function startPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  setInterval(() => {
    try {
      if (!lvrcApp || !lvrcApp.graph) return;
      for (const n of lvrcApp.graph.nodes || []) {
        if (!n || n.type !== LVRC.NODE_NAME || !n.__lvrc || !n.__lvrc.inited) continue;
        layoutOverlay(n);
        // redraw the waveform when the node width changed
        if (n.__lvrc.dom && n.__lvrc.dom.wave && n.__lvrc.dom.waveData) {
          const w = n.__lvrc.dom.wave;
          const dpr = window.devicePixelRatio || 1;
          const wantW = Math.round((w.clientWidth || 300) * dpr);
          if (Math.abs(w.width - wantW) > 1) resyncWave(n);
        }
      }
    } catch (err) {
      console.warn(LVRC.TAG, "poller", err);
    }
  }, LVRC.POLL_MS);
}

/* Playhead follows the playback position at display refresh rate. */
let playheadStarted = false;

function startPlayheadLoop() {
  if (playheadStarted) return;
  playheadStarted = true;
  const tick = () => {
    try {
      if (lvrcApp && lvrcApp.graph) {
        for (const n of lvrcApp.graph.nodes || []) {
          if (!n || n.type !== LVRC.NODE_NAME || !n.__lvrc || !n.__lvrc.dom) continue;
          const st = n.__lvrc;
          const d = st.dom;
          const v = d.video;
          const dur = videoDuration(v);
          if (!dur || !d.ph) continue;
          // playback is confined to the trim window: starting (or seeking)
          // before the IN mark jumps to IN, and when the OUT mark is reached
          // the playhead loops back to IN (only while the window is strictly
          // inside the clip, so OUT == end of video still stops naturally)
          const t = st.trim;
          if (t && t.dur > LVRC.TL_MIN_DUR && !v.paused) {
            const ct = v.currentTime || 0;
            if (
              ct < t.start - 0.03 ||
              (ct >= t.start + t.dur - 0.03 && t.start + t.dur < dur - 0.01)
            ) {
              try { v.currentTime = t.start; } catch (_) { /* ignore */ }
            }
          }
          d.ph.style.left = Math.min(1, Math.max(0, (v.currentTime || 0) / dur)) * 100 + "%";
          // keep the hidden frame_time widget in sync with the player so the
          // IMAGE outputs carry the frame the preview is showing (60Hz tick
          // -> at most half a frame of lag)
          const wt = widgetOf(n, "frame_time");
          if (wt) wt.value = v.currentTime || 0;
        }
      }
    } catch (_) { /* ignore */ }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* --------------------- shared interaction helpers --------------------- */

/** Pointer position normalized to the CONTENT area of a <video> (letterbox aware). */
function contentPosOf(v, e) {
  const r = v.getBoundingClientRect();
  const pw = r.width || 1, ph = r.height || 1;
  const nat = videoNatural(v);
  if (!nat) return null;
  const s = Math.min(pw / nat.w, ph / nat.h);
  const dw = nat.w * s, dh = nat.h * s;
  const ox = (pw - dw) / 2, oy = (ph - dh) / 2;
  return { nx: (e.clientX - r.left - ox) / dw, ny: (e.clientY - r.top - oy) / dh };
}
function inRect(x, y, r) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function nodeOverBox(n, x, y) {
  const st = n.__lvrc;
  if (!st || !st.dom || !st.dom.box || !st.dom.video || !st.crop) return false;
  return inRect(x, y, st.dom.box.getBoundingClientRect());
}

/** First node (in graph order) whose crop box contains the point. */
function nodeBoxAt(x, y) {
  try {
    if (!lvrcApp || !lvrcApp.graph) return null;
    for (const n of lvrcApp.graph.nodes || []) {
      if (n.type !== LVRC.NODE_NAME || !n.__lvrc) continue;
      if (nodeOverBox(n, x, y)) return n;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/* --------------------------- wheel + drag ----------------------------- */

let domInterceptorsInstalled = false;
let activeDrag = null; // { node, nx, ny, cx, cy, pid }
let suppressNextClick = false; // next click belongs to our drag, not the player

function installDomInterceptors() {
  if (domInterceptorsInstalled) return;
  domInterceptorsInstalled = true;

  // wheel over the box -> zoom (ratio locked)
  document.addEventListener(
    "wheel",
    (e) => {
      try {
        if (!lvrcApp || !lvrcApp.graph) return;
        for (const n of lvrcApp.graph.nodes || []) {
          if (n.type !== LVRC.NODE_NAME || !n.__lvrc) continue;
          if (!nodeOverBox(n, e.clientX, e.clientY)) continue;
          e.preventDefault();
          e.stopPropagation();
          const st = n.__lvrc;
          const v = st.dom.video;
          const nat = videoNatural(v);
          if (!nat) return;
          const r = ratioOf(n);
          const fr = maxFitRatio(r, nat.w, nat.h);
          const c = st.crop;
          const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
          let newH = c.h * factor;
          if (newH > fr.h) newH = fr.h;
          if (newH < 0.02) newH = 0.02;
          if (Math.abs(newH - c.h) <= 1e-6) return;
          const k = r * (nat.h / nat.w);
          const newW = newH * k;
          const p = contentPosOf(v, e);
          if (!p) return;
          c.x = c.x + (c.w - newW) * p.nx;
          c.y = c.y + (c.h - newH) * p.ny;
          c.w = newW;
          c.h = newH;
          fitCrop(n, c, nat.w, nat.h);
          writeCrop(n);
          layoutOverlay(n);
          break;
        }
      } catch (err) {
        console.warn(LVRC.TAG, "wheel", err);
      }
    },
    { passive: false, capture: true }
  );

  // pointerdown over the box -> start drag (dedicated capture listener: the
  // box is draggable even where it overlaps the timeline)
  document.addEventListener(
    "pointerdown",
    (e) => {
      try {
        suppressNextClick = false; // a fresh pointerdown invalidates any stale flag
        if (activeDrag || tlActive) return;
        const n = nodeBoxAt(e.clientX, e.clientY);
        if (!n) return;
        const st = n.__lvrc;
        const v = st.dom.video;
        const nat = videoNatural(v);
        const p = contentPosOf(v, e);
        if (!nat || !p) return;
        e.preventDefault();
        e.stopPropagation();
        activeDrag = { node: n, nx: p.nx, ny: p.ny, cx: st.crop.x, cy: st.crop.y, pid: e.pointerId };
        if (st.dom.overlay) st.dom.overlay.style.cursor = "move";
      } catch (err) {
        console.warn(LVRC.TAG, "pointerdown", err);
      }
    },
    { passive: false, capture: true }
  );

  // pointermove -> move the box while dragging, else update the hover cursor
  document.addEventListener(
    "pointermove",
    (e) => {
      try {
        if (!lvrcApp || !lvrcApp.graph) return;
        if (activeDrag) {
          const n = activeDrag.node;
          const st = n.__lvrc;
          const v = st && st.dom ? st.dom.video : null;
          const nat = videoNatural(v);
          const p = contentPosOf(v, e);
          if (!st || !st.crop || !nat || !p) return;
          st.crop.x = activeDrag.cx + (p.nx - activeDrag.nx);
          st.crop.y = activeDrag.cy + (p.ny - activeDrag.ny);
          fitCrop(n, st.crop, nat.w, nat.h);
          writeCrop(n);
          layoutOverlay(n);
          return;
        }
        for (const n of lvrcApp.graph.nodes || []) {
          if (n.type !== LVRC.NODE_NAME || !n.__lvrc || !n.__lvrc.dom || !n.__lvrc.dom.overlay) continue;
          n.__lvrc.dom.overlay.style.cursor = nodeOverBox(n, e.clientX, e.clientY) ? "move" : "default";
        }
      } catch (err) {
        console.warn(LVRC.TAG, "pointermove", err);
      }
    },
    { passive: false, capture: true }
  );

  const endDrag = (e) => {
    try {
      if (!activeDrag) return;
      // the drag is ours, not the player's: stop the pointerup from reaching
      // the <video> (the player can toggle play/pause on pointerup), and
      // swallow the click the browser still synthesizes for this down/up pair
      try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
      suppressNextClick = true;
      const n = activeDrag.node;
      const st = n.__lvrc;
      const v = st && st.dom ? st.dom.video : null;
      if (st && st.crop && v) {
        const nat = videoNatural(v);
        if (nat) fitCrop(n, st.crop, nat.w, nat.h);
        writeCrop(n);
        lsSave(n); // remember for tab switches / reloads
      }
      if (st && st.dom && st.dom.overlay) st.dom.overlay.style.cursor = "default";
      activeDrag = null;
    } catch (err) {
      console.warn(LVRC.TAG, "pointerup", err);
    }
  };
  document.addEventListener("pointerup", endDrag, { capture: true });
  document.addEventListener("pointercancel", endDrag, { capture: true });

  // eat the events that follow one of our drag interactions (see above):
  // the browser still synthesizes mouseup + click for the captured pair
  const swallowTrailing = (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener("mouseup", swallowTrailing, { capture: true });
  document.addEventListener("click", swallowTrailing, { capture: true });
}

/* --------------------------- node init/hooking ----------------------- */

function initNode(node) {
  try {
    if (!node || node.type !== LVRC.NODE_NAME) return;
    const st = getState(node);

    // drop the unlinked FLOAT/BOOLEAN slots (crop_*, start_time, duration,
    // strict_duration): this node has no linkable inputs
    const inputs = node.inputs;
    if (Array.isArray(inputs)) {
      for (let i = inputs.length - 1; i >= 0; i--) {
        const slot = inputs[i];
        if (slot && (slot.type === "FLOAT" || slot.type === "BOOLEAN") && slot.link == null) {
          try {
            if (typeof node.removeInput === "function") node.removeInput(slot);
          } catch (_) { /* ignore */ }
          const j = node.inputs.indexOf(slot);
          if (j !== -1) node.inputs.splice(j, 1);
        }
      }
    }

    if (!st.inited) {
      st.inited = true;
      // hide the crop_*/trim/frame_time widgets (they still serialize)
      for (const key of LVRC.CROP_KEYS.concat(LVRC.TRIM_KEYS, "frame_time")) {
        const w = widgetOf(node, key);
        if (!w) continue;
        w.hidden = true;
        if (!w.options || typeof w.options !== "object") w.options = {};
        w.options.hidden = true;
      }
      // keep the aspect_ratio widget in sync with the crop
      const ar = widgetOf(node, "aspect_ratio");
      if (ar && !ar.__lvrcBound) {
        ar.__lvrcBound = true;
        const prev = ar.callback;
        ar.callback = (val) => {
          try {
            const v = videoElOf(node);
            const nat = videoNatural(v);
            if (nat) resetCrop(node, nat.w, nat.h);
            else {
              const s = getState(node);
              s.crop = null;
              writeCrop(node);
            }
            if (typeof prev === "function") prev(val);
            layoutOverlay(node);
            markDirty(node);
          } catch (err) {
            console.warn(LVRC.TAG, "aspect_ratio callback", err);
          }
        };
      }
      initCropFromWidgets(node, 16, 9);
      initTrimFromWidgets(node);
    }
    layoutOverlay(node);
  } catch (e) {
    console.warn(LVRC.TAG, "initNode", e);
  }
}

/* --------------------------- registration ---------------------------- */

function register(a) {
  lvrcApp = a;
  a.registerExtension({
    name: "LoadVideoCrop",
    nodeCreated: (node) => initNode(node),
    loadedGraphNode: (node) => initNode(node),
    beforeRegisterNodeDef: (nodeType, nodeData) => {
      if (nodeData && nodeData.name !== LVRC.NODE_NAME) return;
      const proto = nodeType.prototype;
      const prevConfigure = proto.onConfigure;
      proto.onConfigure = function (data) {
        const r = prevConfigure ? prevConfigure.call(this, data) : undefined;
        initNode(this);
        return r;
      };
      const prevAdded = proto.onAdded;
      proto.onAdded = function (graph) {
        const r = prevAdded ? prevAdded.call(this, graph) : undefined;
        initNode(this);
        return r;
      };
    },
  });
  installDomInterceptors();
  installKeyHandler();
  startPoller();
  startPlayheadLoop();
  console.log(LVRC.TAG, "extension registered");
}

(async function boot() {
  let mod = null;
  for (let i = 0; i < 100; i++) {
    try {
      mod = await import("/scripts/app.js");
      if (mod && mod.app) break;
      mod = null;
    } catch (_) { /* retry */ }
    await sleep(50);
  }
  if (!mod || !mod.app) {
    console.error(LVRC.TAG, "could not load /scripts/app.js - extension not started");
    return;
  }
  try {
    register(mod.app);
  } catch (e) {
    console.error(LVRC.TAG, "register failed", e);
  }
})();
