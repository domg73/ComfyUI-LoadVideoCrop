# Changelog

## v1.0.2 (2026-09-04)

- New **Free (Custom)** aspect ratio: a crop rectangle of any shape, not limited to the preset ratios. In Free mode the box keeps the shape you draw:
  - four small resize handles on the corners — drag one to resize the box freely (the opposite corner stays fixed; minimum size 2% of the frame);
  - the box still moves by dragging its middle, and the mouse wheel still zooms it (preserving the drawn ratio);
  - switching to Free keeps the current box (from Original it starts full-frame); switching back to a preset refits that ratio as before.
- The aspect-ratio selection is now persisted per file in the browser `localStorage` as well (alongside the crop box and the IN/OUT marks), so a Free crop survives a page reload.

## v1.0.1 (2026-09-04)

- Video-editor-style trim timeline below the preview (outside the crop area):
  - filmstrip of real frames sampled across the clip (1/s, min 4, max 48), rendered progressively;
  - audio waveform (decoded loudness envelope) under the filmstrip, skipped for very long clips;
  - mark-in / mark-out window: two thin (frame-precise) marker lines with a small grip on top; drag a marker to change the in or out point (minimum window 0.05 s); the middle of the window is not draggable;
  - playhead line following the native playback position in real time;
  - keyboard `I` / `O` set mark-in / mark-out at the playhead (standard editor convention);
  - a plain click anywhere on the timeline (including on the blue selection) seeks the native player;
  - playback is confined to the marks: starting from a time before the mark-in jumps to the mark-in, and reaching the mark-out loops back to the mark-in (unless the mark-out is the end of the clip, in which case it stops naturally); seeking while paused stays free anywhere on the clip;
  - dragging a marker (IN/OUT) pauses the preview and scrubs it to the marker position, so the frame being marked is visible (editor behavior).
- The timeline is display-only and reflows as the node is resized (thumbnails stretch, waveform re-samples, marks keep their exact times).
- The timeline survives aspect-ratio changes and preview re-renders (both designs); the captured assets (thumbnails, waveform) are kept across re-renders of the same file.
- New `start_time` / `duration` / `strict_duration` inputs (hidden widgets, same semantics as the core Trim Video node) — the trim is stored in the workflow and can be set via API.
- Changing the video file resets the trim window to the full clip.
- The trim works in combination with the crop rectangle (both at once, still static across all frames).
- Fixed: clicking/dragging the crop box no longer triggers the player's click-to-play/pause (the click synthesized at the end of the drag is now absorbed; clicking the video itself still toggles playback as usual).
- New **💾 Frame** button (top-left of the preview): one click saves the current frame as PNG file(s) **downloaded by the browser** — full frame plus cropped frame at the exact output dimensions (WYSIWYG with the node output); with the Original aspect ratio only the full frame is saved (the cropped copy would be identical); file names carry the source name and timecode; the button briefly shows the outcome (✓ Saved / ⚠ Failed).
- The node now also outputs the frame the preview is showing as two IMAGE sockets (full + cropped): the exact frame the player displays at `frame_time` (hidden input, kept in sync with the player by the frontend; settable manually to export an arbitrary moment) — the same frame the 💾 Frame button saves (in **Original** the two are identical).
- Per-file persistence: the crop box and the IN/OUT marks are cached in the browser `localStorage` and restored across multi-tab switches and page reloads, in both the classic and the 2.0 layouts (the frontend resets the hidden FLOAT widgets when it re-instantiates the nodes); a workflow that already carries crop/trim values always wins, and a new file always starts from its own memory (or clean).

## v1.0.0 (2026-09-02, initial release)

- Node based on the official Load Video: same file picker, drag & drop, and native `<video>` preview.
- Visual crop rectangle drawn on top of the native video preview: drag to move, mouse wheel to zoom, locked to a fixed aspect-ratio list (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9).
- WYSIWYG: the output VIDEO matches the framed area (dimensions are even-aligned for the x264/yuv420p encoder); the crop is static across all frames.
- Memory-efficient: the cropped video is saved frame-by-frame straight from the source file, so peak memory does not scale with video length or resolution; tensor consumers materialize only the cropped region.
- `Original` (default) passes the video through uncropped — the node behaves exactly like the official Load Video.
- The crop is stored in the workflow and exposed via the hidden `crop_x` / `crop_y` / `crop_w` / `crop_h` inputs (normalized 0..1), so it can be set from an API script.
- Works with classic nodes and ComfyUI 2.0 (Vue nodes).
