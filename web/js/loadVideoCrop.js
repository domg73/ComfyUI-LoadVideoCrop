/*
 * LoadVideoCrop - visual aspect-ratio-locked crop for the core Load Video player.
 *
 * How the core renders the player (verified against the installed frontend):
 *   - The `file` combo carries `video_upload:true`, so the frontend builds a
 *     DOM <video> element (playsInline, controls, loop) and, in classic mode,
 *     exposes it as a LiteGraph DOM widget "video-preview" (canvasOnly:true)
 *     inside a `div.comfy-img-preview` container held on `node.videoContainer`.
 *   - In 2.0 / Vue mode the same player is rendered by a Vue component: the
 *     <video> lives inside the node's [data-node-id] element.
 *   - In BOTH designs the element is a real DOM <video> with object-fit:contain,
 *     and its src is the INPUT file (uncropped). That is what makes the crop
 *     WYSIWYG: the preview shows the full video and the rectangle we draw on top
 *     of it is exactly the region that gets output.
 *
 * Because the player is DOM in both designs there is a SINGLE overlay path (no
 * canvas variant, unlike LoadImageCrop): a positioned <div> on top of the
 * video's container, re-synced by a light 250ms poller. The crop rectangle is
 * static across all frames, so the same normalized rect is valid for the whole
 * clip.
 *
 * Interaction:
 *   - drag: pointerdown INSIDE the crop box moves the rectangle (the box
 *     captures the pointer); events OUTSIDE the box are left to pass through so
 *     the native <video> controls (play/pause/seek) keep working.
 *   - wheel: a document capture-phase listener with a manual hit-test zooms the
 *     box while the cursor is over it, pre-empting the core canvas pan/zoom.
 *
 * The crop is stored as normalized floats in the (hidden) crop_x/y/w/h widgets
 * so it serializes into the workflow and is usable via API. "Original"
 * aspect ratio (default): no crop area, the video passes through uncropped.
 *
 * No static ES imports: /scripts/app.js is a shim read at evaluation time, so
 * it is imported dynamically (absolute path) with a retry loop.
 */
const LVRC = {
  NODE_NAME: "LoadVideoCrop",
  CROP_KEYS: ["crop_x", "crop_y", "crop_w", "crop_h"],
  POLL_MS: 250,
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
      crop: null,        // {x,y,w,h} normalized 0..1 in VIDEO CONTENT space
      cropFromWorkflow: false,
      lastKey: null,
      dom: null,         // {parent, overlay, box, label, video} for the current overlay
    };
  }
  return node.__lvrc;
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
 * Locate the visible <video> element for a node, in both designs.
 * The player can live in two places depending on the UI:
 *   - classic: a LiteGraph DOM widget held on node.videoContainer (div.comfy-img-preview)
 *   - 2.0/Vue: a <video> inside the node's [data-node-id] element (div.video-preview)
 * In 2.0 the LiteGraph container (if present) may be hidden while the Vue player is
 * the visible one, so we gather every candidate and prefer the visible element.
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
  let x = g("crop_x"), y = g("crop_y"), w = g("crop_w"), h = g("crop_h");
  if (x == null || y == null || w == null || h == null) {
    resetCrop(node, cw, ch);
  } else if (x === 0 && y === 0 && w === 1 && h === 1) {
    resetCrop(node, cw, ch);
  } else {
    st.crop = { x, y, w, h };
    st.cropFromWorkflow = true;
  }
}

function markDirty(node) {
  try {
    if (node.graph && typeof node.graph.setDirtyCanvas === "function") {
      node.graph.setDirtyCanvas(true);
    }
  } catch (_) { /* ignore */ }
}

/* --------------------------- overlay (DOM) --------------------------- */

function removeOverlay(node) {
  const st = node.__lvrc;
  if (st && st.dom && st.dom.overlay && st.dom.overlay.parentElement) {
    st.dom.overlay.parentElement.removeChild(st.dom.overlay);
  }
  if (st) st.dom = null;
}

/* Mirror of LoadVideoCrop._crop.even_box: the exact pixel box the backend
 * writes to disk (even-snapped + clamped). Lets the marker show the real
 * output dimensions instead of a rounded approximation. pyRound reproduces
 * Python's round-half-to-even so the JS math matches the backend bit-for-bit. */
function pyRound(x) {
  const f = Math.floor(x);
  const frac = x - f;
  if (frac > 0.5) return f + 1;
  if (frac < 0.5) return f;
  // exactly 0.5 -> to the even neighbor
  return f % 2 === 0 ? f : f + 1;
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
 * (Re)sync the DOM overlay for a node: rebuild it when the video/container
 * changed under us (Vue re-render, file change), (re)init the crop when the
 * content size or ratio changed, and position the box over the object-contain
 * area. Called by the poller, on drag and on wheel.
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

  // (Re)initialize the crop when the displayed content or ratio changes.
  const key = `${v.src}|${ratioOf(node)}|${cw}x${ch}`;
  if (st.lastKey !== key) {
    st.lastKey = key;
    let chosen = "?";
    if (node.videoContainer && node.videoContainer.contains(v)) chosen = "videoContainer";
    else if (document.querySelector(`[data-node-id="${node.id}"]`)) chosen = "data-node-id";
    console.log(
      LVRC.TAG, "node", node.id, "file", (v.currentSrc || v.src || "").split("/").pop(),
      "content", cw + "x" + ch, "ratio", ratioOf(node), "chosen", chosen,
      "parentClass", ((v.parentElement && v.parentElement.className) || "").toString().slice(0, 60)
    );
    if (!st.cropFromWorkflow) {
      resetCrop(node, cw, ch);
    } else {
      st.crop = fitCrop(node, st.crop, cw, ch);
      writeCrop(node);
    }
  } else if (!st.crop && ratioOf(node) != null) {
    initCropFromWidgets(node, cw, ch);
  }

  const parent = v.parentElement;
  if (!parent) return;

  const same = st.dom && st.dom.video === v && st.dom.parent === parent;
  if (!same) buildOverlay(node, v, parent);
  if (!st.dom) return;

  const { overlay, box, label } = st.dom;
  const c = st.crop;
  if (!c) {
    overlay.style.display = "none";
    return;
  }
  overlay.style.display = "";

  // displayed content area inside the (video-sized) container: object-contain
  const pw = parent.clientWidth || 1;
  const ph = parent.clientHeight || 1;
  const s = Math.min(pw / cw, ph / ch);
  const dw = cw * s;
  const dh = ch * s;
  const ox = (pw - dw) / 2;
  const oy = (ph - dh) / 2;
  box.style.left = ((ox + c.x * dw) / pw) * 100 + "%";
  box.style.top = ((oy + c.y * dh) / ph) * 100 + "%";
  box.style.width = (c.w * dw / pw) * 100 + "%";
  box.style.height = (c.h * dh / ph) * 100 + "%";
  const out = evenBox(c.x, c.y, c.x + c.w, c.y + c.h, cw, ch);
  label.textContent = `${out.w} × ${out.h}`;
  label.style.display = box.offsetHeight > 18 ? "" : "none";
}

function buildOverlay(node, v, parent) {
  const st = getState(node);
  removeOverlay(node);

  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

  // The overlay is PURELY VISUAL: it has no pointer events of its own, so the
  // native <video> controls always work, and all interaction (drag/wheel) is
  // driven from document capture-phase listeners with a manual hit-test against
  // this box (robust against LiteGraph stealing the pointer / resetting the
  // viewport). See installDomInterceptors.
  const overlay = document.createElement("div");
  overlay.dataset.lvrcOverlay = "1";
  overlay.style.cssText =
    "position:absolute;inset:0;z-index:1;pointer-events:none;";
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
  layoutOverlay(node);
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
      }
    } catch (_) { /* ignore */ }
  }, LVRC.POLL_MS);
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

/* --------------------------- wheel + drag ----------------------------- */
/*
 * All interaction is driven here, at the document level in capture phase, with
 * a manual hit-test against the crop box. The overlay itself is purely visual
 * (pointer-events:none) so the native <video> controls always work; we only
 * intercept when the pointer is ON the box. This is robust against LiteGraph
 * stealing the pointer capture or resetting the canvas viewport, because we
 * recompute the pointer's content-space position live and move by content-space
 * deltas.
 */
let domInterceptorsInstalled = false;
let activeDrag = null; // { node, nx, ny, cx, cy, pid }

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
          if (!nodeOverBox(n, e.clientX, e.clientY)) continue; // outside: core canvas behavior
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
          break; // first hit node wins (consistent with pointerdown)
        }
      } catch (err) {
        console.warn(LVRC.TAG, "wheel", err);
      }
    },
    { passive: false, capture: true }
  );

  // pointerdown over the box -> start drag
  document.addEventListener(
    "pointerdown",
    (e) => {
      try {
        if (!lvrcApp || !lvrcApp.graph || activeDrag) return;
        for (const n of lvrcApp.graph.nodes || []) {
          if (n.type !== LVRC.NODE_NAME || !n.__lvrc) continue;
          if (!nodeOverBox(n, e.clientX, e.clientY)) continue;
          const st = n.__lvrc;
          const v = st.dom.video;
          const nat = videoNatural(v);
          const p = contentPosOf(v, e);
          if (!nat || !p) return;
          e.preventDefault();
          e.stopPropagation();
          activeDrag = { node: n, nx: p.nx, ny: p.ny, cx: st.crop.x, cy: st.crop.y, pid: e.pointerId };
          if (st.dom.overlay) st.dom.overlay.style.cursor = "move";
          break;
        }
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

  const endDrag = () => {
    try {
      if (!activeDrag) return;
      const n = activeDrag.node;
      const st = n.__lvrc;
      const v = st && st.dom ? st.dom.video : null;
      if (st && st.crop && v) {
        const nat = videoNatural(v);
        if (nat) fitCrop(n, st.crop, nat.w, nat.h);
        writeCrop(n);
      }
      if (st) {
        if (st.dom && st.dom.overlay) st.dom.overlay.style.cursor = "default";
      }
      activeDrag = null;
    } catch (err) {
      console.warn(LVRC.TAG, "pointerup", err);
    }
  };
  document.addEventListener("pointerup", endDrag, { capture: true });
  document.addEventListener("pointercancel", endDrag, { capture: true });
}

/* --------------------------- node init/hooking ----------------------- */

function initNode(node) {
  try {
    if (!node || node.type !== LVRC.NODE_NAME) return;
    const st = getState(node);

    // drop the unlinked FLOAT slots (crop_*): this node has no linkable inputs
    const inputs = node.inputs;
    if (Array.isArray(inputs)) {
      for (let i = inputs.length - 1; i >= 0; i--) {
        const slot = inputs[i];
        if (slot && slot.type === "FLOAT" && slot.link == null) {
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
      // hide the crop_* widgets (they still serialize); the 2.0 renderer
      // filters on options.hidden, classic litegraph on hidden
      for (const key of LVRC.CROP_KEYS) {
        const w = widgetOf(node, key);
        if (!w) continue;
        w.hidden = true;
        if (!w.options || typeof w.options !== "object") w.options = {};
        w.options.hidden = true;
      }
      // keep the aspect_ratio widget's change in sync with the crop
      const ar = widgetOf(node, "aspect_ratio");
      if (ar && !ar.__lvrcBound) {
        ar.__lvrcBound = true;
        const prev = ar.callback;
        ar.callback = (val) => {
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
        };
      }
      initCropFromWidgets(node, 16, 9);
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
  startPoller();
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
