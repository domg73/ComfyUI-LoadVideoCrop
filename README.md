# ComfyUI-LoadVideoCrop

A native ComfyUI node: the official **Load Video**, extended with an aspect-ratio-locked, WYSIWYG crop rectangle drawn directly on the preview. What you frame is exactly what gets executed — the node outputs the cropped **VIDEO**.

Works with **classic nodes** and **ComfyUI 2.0 (Vue nodes)**.

## Install

Drop the folder into `ComfyUI/custom_nodes/` and restart ComfyUI. No extra dependencies.

## Usage

The node looks and behaves like the official Load Video: same file picker, drag & drop and native `<video>` preview.

- **Aspect Ratio** — default **Original**: the video passes through **uncropped**, no crop area is shown and the node behaves exactly like the official Load Video. The other ratios are locked: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9`.
- With any locked ratio, a crop rectangle appears on the preview:
  - **Move it**: click and drag the rectangle.
  - **Zoom it**: keep the mouse pointer over the crop area and turn the mouse wheel — wheel up enlarges, wheel down shrinks, always around the pointer. While the pointer is over the crop area the wheel is captured by the crop, so the canvas behind does not pan/zoom; outside it the wheel works normally.
  - The rectangle is locked to the selected ratio and the output size is shown on the frame.
  - Clicking or dragging the box does **not** trigger the player's click-to-play/pause (the synthesized click is absorbed), so you can adjust the crop without the video starting/stopping.
- The crop is **static across all frames**: every frame is cropped to the same rectangle.
- The crop is stored in the workflow and is also exposed via the hidden `crop_x` / `crop_y` / `crop_w` / `crop_h` inputs (normalized 0..1), so it can be set from an API script.
- **Frame IMAGE outputs**: the node also outputs the frame the preview is showing as two standard IMAGE sockets — the **full frame** and the **cropped frame** (identical in **Original** mode). It is the last frame at or before `frame_time` seconds, i.e. exactly the frame the player displays (the same pixels the 💾 Frame button saves). The frontend keeps the hidden `frame_time` input in sync with the player, so the outputs are the frame that was on screen when the prompt was queued (a paused player outputs a stable frame). `frame_time` can also be set (from a workflow or an API script) to export an arbitrary moment.

### Trim

A video-editor-style timeline sits **below the preview** (outside the crop area): a filmstrip of real frames from the video, the audio waveform underneath, a playhead, and a mark-in / mark-out window.

- **Filmstrip**: real frames sampled across the whole clip (1 per second, min 4, max 48), rendered progressively as they are captured. The strip always spans the full clip width.
- **Audio waveform**: the decoded loudness envelope, drawn under the filmstrip (skipped for very long clips to keep memory bounded).
- **Mark in / mark out**: drag the left or right marker (thin line, small grip on top) to change the start time or the length (minimum 0.05 s). While dragging a marker the preview pauses and scrubs to the marker position, so you see exactly the frame you are marking (editor behavior). Only the two markers are draggable; the middle of the window is not.
- **Playhead**: the white line follows the native player. A click anywhere on the timeline seeks the preview to that time. While the preview plays, the playhead moves in real time and playback is confined to the marks: starting (or seeking) from a time before the mark-in jumps to the mark-in, and when the mark-out is reached the video loops back to the mark-in (unless the mark-out is the end of the clip, in which case it simply stops). Seeking while paused stays free anywhere on the clip.
- **Keyboard**: with the preview in view, `I` sets the mark-in and `O` sets the mark-out at the current playhead position (standard editor convention).
- **Reset**: the window resets to the full clip when a different video file is selected.
- **Persistence**: the crop box and the IN/OUT marks are remembered per file (browser `localStorage`) and are restored across multi-tab switches and page reloads (both the classic and the 2.0 layouts re-instantiate the nodes and reset the hidden widgets). A workflow that already carries crop/trim values always wins, and a new file always starts from its own memory (or clean).

### Frame saving

The **💾 Frame** button (top-left of the preview) saves the current frame as PNG file(s) **downloaded by the browser**: the **full frame** plus the **cropped frame** at the exact output dimensions (the same box the node writes to disk, so it matches the rendered output WYSIWYG). With the **Original** aspect ratio only the full frame is saved (a cropped copy would be identical). File names include the source name and the timecode (e.g. `gag_t01-07.50_crop.png`). The button briefly shows the outcome (✓ Saved / ⚠ Failed).

The same frame is also available in the graph as the two IMAGE outputs (see above), so it can be fed to other nodes instead of the browser download.

The timeline is display-only: it is sized to the node width and reflows as you resize the node (thumbnails stretch, the waveform re-samples, the marks stay at their exact times). It never changes what the backend does — it just edits the same `start_time` / `duration` values.

Semantics match the core **Trim Video** node: `start_time` in seconds (a negative value counts from the end), `duration` in seconds (`0` = until the end of the clip), `strict_duration` (`false`: if the remaining clip is shorter, the trim is clamped to the end; `true`: the node fails instead). The three values are stored in the workflow via the hidden `start_time` / `duration` / `strict_duration` inputs, so they can be set from an API script. The trim works in combination with the crop: the output contains only the selected window, with every frame cropped.

## Notes

- WYSIWYG: the output matches the framed area (dimensions are even-aligned to what the x264/yuv420p encoder requires).
- Memory-efficient: the crop is applied frame-by-frame while saving, straight from the source file, so peak memory does not scale with video length or resolution. Only tensor consumers (e.g. Get Video Components) materialize the video in RAM, and then only the cropped region.
- v1 streaming save supports 8-bit SDR sources; rotated, 10-bit and HDR sources are rejected with a clear error (save without a crop — aspect ratio **Original** — to use the core path for those).
- In 2.0 the overlay follows the frontend's DOM structure; if a future frontend release changes the preview markup, the overlay layer may need a selector update.

## License & Copyright

Copyright (c) 2026 domg73 (aka MayaProphecy).

This project is licensed under the MIT License. You are free to use, modify, and distribute this software under the terms specified in the license.
