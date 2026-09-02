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
- The crop is **static across all frames**: every frame is cropped to the same rectangle.
- The crop is stored in the workflow and is also exposed via the hidden `crop_x` / `crop_y` / `crop_w` / `crop_h` inputs (normalized 0..1), so it can be set from an API script.

## Notes

- WYSIWYG: the output matches the framed area (dimensions are even-aligned to what the x264/yuv420p encoder requires).
- Memory-efficient: the crop is applied frame-by-frame while saving, straight from the source file, so peak memory does not scale with video length or resolution. Only tensor consumers (e.g. Get Video Components) materialize the video in RAM, and then only the cropped region.
- v1 streaming save supports 8-bit SDR sources; rotated, 10-bit and HDR sources are rejected with a clear error (save without a crop — aspect ratio **Original** — to use the core path for those).
- In 2.0 the overlay follows the frontend's DOM structure; if a future frontend release changes the preview markup, the overlay layer may need a selector update.

## License & Copyright

Copyright (c) 2026 domg73 (aka MayaProphecy).

This project is licensed under the MIT License. You are free to use, modify, and distribute this software under the terms specified in the license.
