# Changelog

## v1.0.0 (2026-09-02, initial release)

- Node based on the official Load Video: same file picker, drag & drop, and native `<video>` preview.
- Visual crop rectangle drawn on top of the native video preview: drag to move, mouse wheel to zoom, locked to a fixed aspect-ratio list (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9).
- WYSIWYG: the output VIDEO matches the framed area (dimensions are even-aligned for the x264/yuv420p encoder); the crop is static across all frames.
- Memory-efficient: the cropped video is saved frame-by-frame straight from the source file, so peak memory does not scale with video length or resolution; tensor consumers materialize only the cropped region.
- `Original` (default) passes the video through uncropped — the node behaves exactly like the official Load Video.
- The crop is stored in the workflow and exposed via the hidden `crop_x` / `crop_y` / `crop_w` / `crop_h` inputs (normalized 0..1), so it can be set from an API script.
- Works with classic nodes and ComfyUI 2.0 (Vue nodes).
