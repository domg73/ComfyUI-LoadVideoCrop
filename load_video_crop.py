import itertools
import math
import os
from fractions import Fraction

import av
from av.video.reformatter import ColorRange
import folder_paths
import numpy as np
import torch

try:  # current import location
    from comfy_api.latest import io, InputImpl, Types
    from comfy_api.latest import _input as _core_in
except Exception:  # older import location
    from comfy.api.latest import io, InputImpl, Types
    from comfy.api.latest import _input as _core_in

# Reuse the core video-impl's private save/encode helpers so the streaming
# encoder below matches core behavior (container config, encoder options,
# color properties, metadata writing). If a future core release moves them,
# the node degrades to the legacy eager path (still correct, just RAM-hungry)
# instead of breaking.
try:
    from comfy_api.latest._input_impl import video_types as _core_vt
except Exception:
    try:
        from comfy.api.latest._input_impl import video_types as _core_vt
    except Exception:
        _core_vt = None

ASPECT_RATIOS = [
    "Original",
    "1:1 (Square)",
    "2:3 (Portrait Photo)",
    "3:2 (Photo)",
    "3:4 (Portrait Standard)",
    "4:3 (Standard)",
    "9:16 (Portrait Widescreen)",
    "16:9 (Widescreen)",
    "21:9 (Ultrawide)",
]


def _even_crop_box(fx0, fy0, fx1, fy1, W, H):
    """Even pixel box for a normalized rect over a WxH frame.
    x264 (yuv420p) requires even width AND height, so the box is snapped to
    even dimensions (<=1px shift, invisible). Bit-identical to the frontend
    evenBox() and to LoadImageCrop._crop's box math."""
    def clampi(v, lo, hi):
        return max(lo, min(hi, int(round(v))))

    x0 = clampi(fx0 * W, 0, W - 2)
    y0 = clampi(fy0 * H, 0, H - 2)
    x1 = clampi(fx1 * W, x0 + 2, W)
    y1 = clampi(fy1 * H, y0 + 2, H)
    x0 -= x0 % 2
    y0 -= y0 % 2
    w = x1 - x0
    h = y1 - y0
    w -= w % 2
    h -= h % 2
    if w < 2: w = 2
    if h < 2: h = 2
    if x0 + w > W:
        w = W - x0
        w -= w % 2
    if y0 + h > H:
        h = H - y0
        h -= h % 2
    return x0, y0, x0 + w, y0 + h


class LoadVideoCropVideo(_core_in.VideoInput):
    """Lazy video: a static crop rectangle applied to a source file.

    Holds only the source path and the normalized crop box. ``save_to()``
    streams frame-by-frame from the file (decode -> crop -> encode -> mux),
    so peak memory does not scale with video length or resolution. The whole
    video is materialized only by ``get_components()``, for consumers that
    actually need tensors (Get Video Components, ...), and even then only
    the cropped region is accumulated (single pre-allocated tensor).

    v1 streaming save supports 8-bit SDR sources, mp4/webm output, h264/av1
    encoding; rotated sources are rejected with a clear error.
    """

    def __init__(self, path, crop_x, crop_y, crop_w, crop_h,
                 start_time=0.0, duration=0.0):
        self.__path = path
        self.__crop = (crop_x, crop_y, crop_w, crop_h)
        self.__start_time = float(start_time)
        self.__duration = float(duration)

    # ------------------------------------------------------------------ #
    # lightweight metadata (container header only, never decode frames)  #
    # ------------------------------------------------------------------ #

    def _first_video_stream(self, container):
        if len(container.streams.video):
            return container.streams.video[0]
        raise ValueError(f"No video stream found in file '{self.__path}'")

    def _crop_box(self, W, H):
        cx, cy, cw, ch = self.__crop
        if (cx, cy, cw, ch) == (0, 0, 1, 1) or not (
            cw > 0.001 and ch > 0.001 and cx < 0.999 and cy < 0.999
        ):
            return 0, 0, W, H
        return _even_crop_box(cx, cy, cx + cw, cy + ch, W, H)

    def get_dimensions(self):
        with av.open(self.__path, mode="r") as container:
            stream = self._first_video_stream(container)
            W, H = stream.width, stream.height
        x0, y0, x1, y1 = self._crop_box(W, H)
        return x1 - x0, y1 - y0

    def get_frame_rate(self):
        with av.open(self.__path, mode="r") as container:
            stream = self._first_video_stream(container)
            if stream.average_rate:
                return Fraction(stream.average_rate)
            if stream.frames and container.duration:
                d = float(container.duration / av.time_base)
                if d > 0:
                    return Fraction(int(stream.frames) / d).limit_denominator()
        return Fraction(1)

    def get_frame_count(self):
        # The crop does not change the frame count; delegate the (light)
        # metadata-only counting to the core file implementation (the trim
        # window is honored there).
        return InputImpl.VideoFromFile(
            self.__path,
            start_time=self.__start_time,
            duration=self.__duration,
        ).get_frame_count()

    def get_stream_source(self):
        # The source is a file: stream it directly (the core VideoFromFile
        # does the same), never a save_to round-trip.
        return self.__path

    def get_duration(self):
        return InputImpl.VideoFromFile(
            self.__path,
            start_time=self.__start_time,
            duration=self.__duration,
        ).get_duration()

    def get_bit_depth(self):
        with av.open(self.__path, mode="r") as container:
            stream = self._first_video_stream(container)
            return _core_vt.video_stream_bit_depth(stream)

    def get_color_space(self):
        with av.open(self.__path, mode="r") as container:
            stream = self._first_video_stream(container)
            return _core_vt.video_stream_color_space(stream) or "sRGB"

    def get_container_format(self):
        with av.open(self.__path, mode="r") as container:
            return container.format.name

    def get_active_trim_window(self):
        start_time = self.__start_time
        if start_time < 0:
            start_time = max(
                InputImpl.VideoFromFile(self.__path).get_duration() + start_time,
                0.0,
            )
        return float(start_time), float(self.__duration)

    def as_trimmed(self, start_time=0.0, duration=0.0, strict_duration=True):
        trimmed = LoadVideoCropVideo(
            self.__path,
            *self.__crop,
            start_time=self.__start_time + float(start_time),
            duration=float(duration),
        )
        if trimmed.get_duration() < duration and strict_duration:
            return None
        return trimmed

    # ------------------------------------------------------------------ #
    # tensor path: materialize the CROPPED video only                    #
    # ------------------------------------------------------------------ #

    def get_components(self):
        """Materialize the whole (trimmed) video into tensors, accumulating
        only the cropped region. Faithful mirror of the core
        get_components_internal, with the static crop box applied to every
        frame. (Only tensor consumers - Get Video Components, ... - call
        this; saving streams instead.)"""
        with av.open(self.__path, mode="r") as container:
            video_stream = self._first_video_stream(container)
            stream = video_stream
            start_time, duration = self.get_active_trim_window()
            start_pts = int(start_time / stream.time_base)
            end_pts = int((start_time + duration) / stream.time_base)
            if start_pts != 0:
                container.seek(start_pts, stream=stream)

            W, H = stream.width, stream.height
            x0, y0, x1, y1 = self._crop_box(W, H)

            image_format = "gbrpf32le"
            process_image_format = lambda a: a
            align_graph = None
            alphas = None
            frames = []      # cropped float32 numpy frames
            audio_frames = []
            has_first_audio_frame = False
            checked_alpha = False
            video_done = False
            audio_done = True

            audio_stream = _core_vt.last_decodable_audio_stream(container) if _core_vt is not None else None
            resampler = None
            if audio_stream is not None:
                resampler = av.audio.resampler.AudioResampler(format="fltp")
                audio_done = False

            streams = [video_stream] if audio_stream is None else [video_stream, audio_stream]

            for packet in container.demux(*streams):
                if video_done and audio_done:
                    break

                if packet.stream.type == "video":
                    if video_done:
                        continue
                    try:
                        for frame in packet.decode():
                            if frame.pts is None:
                                continue
                            if frame.pts < start_pts:
                                continue
                            if duration and frame.pts >= end_pts:
                                video_done = True
                                break
                            if frame.rotation != 0:
                                raise ValueError(
                                    "LoadVideoCrop v1 does not support rotated sources on the tensor path; "
                                    "use a source without rotation metadata"
                                )
                            if not checked_alpha:
                                for comp in frame.format.components:
                                    if comp.is_alpha or frame.format.name == "pal8":
                                        alphas = []
                                        break
                                if frame.format.name in ("yuvj420p", "yuvj422p", "yuvj444p", "rgb24", "rgba", "pal8"):
                                    process_image_format = lambda a: a.float() / 255.0
                                    image_format = "rgba" if alphas is not None else "rgb24"
                                else:
                                    process_image_format = lambda a: a
                                    image_format = "gbrapf32le" if alphas is not None else "gbrpf32le"
                                checked_alpha = True
                            # Non-deterministic decode when the width is not a multiple of
                            # 32: pad with smeared borders, extract, slice back (core parity)
                            if image_format in ("gbrpf32le", "gbrapf32le") and frame.width % 32 != 0:
                                if align_graph is None:
                                    pad_w = ((frame.width + 31) // 32) * 32
                                    pad_h = ((frame.height + 31) // 32) * 32
                                    g = av.filter.Graph()
                                    g_src = g.add_buffer(
                                        width=frame.width, height=frame.height,
                                        format=frame.format.name, time_base=stream.time_base)
                                    g_pad = g.add('pad', f'{pad_w}:{pad_h}:0:0')
                                    g_fill = g.add('fillborders',
                                                   f'left=0:right={pad_w - frame.width}:top=0:bottom={pad_h - frame.height}:mode=smear')
                                    g_sink = g.add('buffersink')
                                    g_src.link_to(g_pad)
                                    g_pad.link_to(g_fill)
                                    g_fill.link_to(g_sink)
                                    g.configure()
                                    align_graph = (g, g_src, g_sink)
                                align_graph[1].push(frame)
                                img = np.ascontiguousarray(
                                    align_graph[2].pull().to_ndarray(format=image_format)[:frame.height, :frame.width])
                            else:
                                img = frame.to_ndarray(format=image_format)
                            if alphas is None:
                                frames.append(np.ascontiguousarray(img[y0:y1, x0:x1]))
                            else:
                                frames.append(np.ascontiguousarray(img[y0:y1, x0:x1, :-1]))
                                alphas.append(np.ascontiguousarray(img[y0:y1, x0:x1, -1:]))
                    except av.error.InvalidDataError:
                        import logging
                        logging.info("pyav decode error")

                elif packet.stream.type == "audio":
                    if audio_done:
                        continue
                    for frame in itertools.chain.from_iterable(
                        map(resampler.resample, packet.decode())
                    ):
                        if duration and frame.time is not None and frame.time > start_time + duration:
                            audio_done = True
                            break
                        if not has_first_audio_frame:
                            pts = frame.pts if frame.pts is not None else 0
                            offset_seconds = start_time - pts * audio_stream.time_base
                            to_skip = max(0, int(offset_seconds * audio_stream.sample_rate))
                            if to_skip < frame.samples:
                                has_first_audio_frame = True
                                audio_frames.append(frame.to_ndarray()[..., to_skip:])
                        else:
                            audio_frames.append(frame.to_ndarray())

            metadata = container.metadata

        # accumulate only the cropped region into one pre-allocated tensor
        # (no full-size frames are ever kept)
        C = 4 if alphas is not None else 3
        if frames:
            images = torch.empty(len(frames), frames[0].shape[0], frames[0].shape[1], C, dtype=torch.float32)
            for i, arr in enumerate(frames):
                images[i].copy_(torch.from_numpy(arr))
                frames[i] = None
            images = process_image_format(images)
        else:
            images = torch.zeros(0, 0, 0, 3)

        alpha = None
        if alphas is not None:
            if alphas:
                alpha = torch.empty(len(alphas), alphas[0].shape[0], alphas[0].shape[1], 1, dtype=torch.float32)
                for i, arr in enumerate(alphas):
                    alpha[i].copy_(torch.from_numpy(arr))
                    alphas[i] = None
                alpha = process_image_format(alpha)
            else:
                alpha = torch.zeros(0, 0, 0, 1)

        frame_rate = Fraction(stream.average_rate) if stream.average_rate else Fraction(1)

        audio = None
        if audio_frames:
            audio_data = np.concatenate(audio_frames, axis=1)  # (channels, total_samples)
            if duration:
                audio_data = audio_data[..., :int(duration * audio_stream.sample_rate)]
            audio = _core_in.AudioInput({
                "waveform": torch.from_numpy(audio_data).unsqueeze(0),
                "sample_rate": int(audio_stream.sample_rate) if audio_stream.sample_rate else 1,
            })

        return Types.VideoComponents(
            images=images,
            alpha=alpha,
            audio=audio,
            frame_rate=frame_rate,
            metadata=metadata,
        )

    # ------------------------------------------------------------------ #
    # streaming save: peak memory = ~one frame, for any length/size      #
    # ------------------------------------------------------------------ #

    def save_to(self, path, format=Types.VideoContainer.AUTO, codec=Types.VideoCodec.AUTO,
                metadata=None, bit_depth=None, crf=None, color_space=None):
        # v1 streaming save: 8-bit SDR only; rotated sources are rejected
        # with a clear error inside the loop
        if color_space is not None and color_space != "sRGB":
            raise ValueError("LoadVideoCrop v1 streaming save supports SDR (sRGB) output only")
        if bit_depth is not None and bit_depth != 8:
            raise ValueError("LoadVideoCrop v1 streaming save supports 8-bit output only")
        with av.open(self.__path, mode="r") as container:
            self._save_transcoded(container, path, format=format, codec=codec,
                                  metadata=metadata, crf=crf, color_space=color_space)

    def _save_transcoded(self, container, path, format, codec, metadata, crf=None, color_space=None):
        """Re-encode one frame at a time; peak memory does not scale with video
        length. Faithful mirror of the core VideoFromFile._save_transcoded,
        with the static crop box applied to every frame."""
        open_kwargs, output_format, output_codec = _core_vt.video_output_config(path, format, codec)
        video_stream = self._first_video_stream(container)
        start_time, duration = self.get_active_trim_window()
        start_pts = int(start_time / video_stream.time_base)
        end_pts = int((start_time + duration) / video_stream.time_base) if duration else None
        stream_end_pts = None
        if video_stream.duration is not None:
            stream_end_pts = (video_stream.start_time or 0) + video_stream.duration
        output_end_pts = end_pts
        if stream_end_pts is not None and (output_end_pts is None or stream_end_pts < output_end_pts):
            output_end_pts = stream_end_pts
        if start_pts != 0:
            container.seek(start_pts, stream=video_stream)

        source_bit_depth = _core_vt.video_stream_bit_depth(video_stream)
        if source_bit_depth > 8:
            raise ValueError(
                f"LoadVideoCrop v1 streaming save does not support {source_bit_depth}-bit sources; "
                f"save without a crop (aspect ratio Original) to re-encode via the core path"
            )
        source_color_space = _core_vt.video_stream_color_space(video_stream)
        if source_color_space in ("HDR", "HDR PQ"):
            raise ValueError(
                f"LoadVideoCrop v1 streaming save does not support {source_color_space} sources; "
                f"save without a crop (aspect ratio Original) to re-encode via the core path"
            )
        preserve_source_color = source_color_space is not None

        audio_stream = _core_vt.last_decodable_audio_stream(container)
        rate = Fraction(video_stream.average_rate) if video_stream.average_rate else Fraction(1)
        pts_step = max(1, int(round((1 / rate) / video_stream.time_base)))

        # crop box over the source dimensions (rotation is rejected per-frame below)
        x0, y0, x1, y1 = self._crop_box(video_stream.width, video_stream.height)

        # audio setup (identical to the core path)
        resampler = None
        sample_rate = 0
        audio_time_base = None
        duration_cap = None
        if audio_stream is not None:
            sample_rate = audio_stream.codec_context.sample_rate
            channels = audio_stream.codec_context.channels
            if not sample_rate:
                sample_rate, channels = _core_vt.probe_audio_params(container, audio_stream)
                container.seek(start_pts, stream=video_stream)
                if sample_rate:
                    audio_stream.codec_context.flush_buffers()
                else:
                    import logging
                    logging.warning("Audio stream parameters could not be determined; ignoring audio.")
                    audio_stream = None
        if audio_stream is not None:
            if output_format == Types.VideoContainer.WEBM:
                sample_rate = 48000
            audio_time_base = Fraction(1, sample_rate)
            layout = {1: "mono", 2: "stereo", 6: "5.1"}.get(channels, "stereo")
            resampler = av.audio.resampler.AudioResampler(format="fltp", layout=layout, rate=sample_rate)
            if duration:
                duration_cap = math.ceil(duration * sample_rate)
        else:
            layout = None

        streams = [video_stream] if audio_stream is None else [video_stream, audio_stream]
        video_done = False
        audio_done = audio_stream is None
        video_pts_offset = None
        last_video_pts = None
        last_video_end = None
        # rebased pts -> true display duration: the mp4 muxer pads the last
        # sample with 1/rate otherwise
        video_frame_durations = {}
        source_size = None
        audio_started = False
        samples_written = 0
        pending_audio = []
        # the output opens lazily on the first kept frame (geometry is only
        # known after the first decode, same as the core path)
        output = None
        out_video = None
        out_audio = None

        def audio_frame_from_ndarray(nd_planar):
            frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(nd_planar), format="fltp", layout=layout)
            frame.sample_rate = sample_rate
            return frame

        def drain_audio(final=False):
            nonlocal samples_written, audio_done
            if last_video_end is None:
                cap = 0
            else:
                cap = math.ceil(last_video_end * video_stream.time_base * sample_rate)
            if duration_cap is not None:
                cap = min(cap, duration_cap)
            while pending_audio and not audio_done:
                frame = pending_audio[0]
                if samples_written + frame.samples <= cap:
                    frame.pts = samples_written
                    frame.time_base = audio_time_base
                    output.mux(out_audio.encode(frame))
                    samples_written += frame.samples
                    pending_audio.pop(0)
                    continue
                if final:
                    keep = frame.to_ndarray()[..., :cap - samples_written]
                    if keep.shape[-1] > 0:
                        tail = audio_frame_from_ndarray(keep)
                        tail.pts = samples_written
                        tail.time_base = audio_time_base
                        output.mux(out_audio.encode(tail))
                        samples_written += keep.shape[-1]
                    pending_audio.clear()
                break
            if duration_cap is not None and samples_written >= duration_cap:
                audio_done = True
            return cap

        try:
            for packet in container.demux(*streams):
                if video_done and audio_done:
                    break

                if packet.stream == video_stream and not video_done:
                    try:
                        frames = packet.decode()
                    except av.error.InvalidDataError:
                        import logging
                        logging.info("pyav decode error")
                        continue
                    for frame in frames:
                        if frame.pts is not None and frame.pts < start_pts:
                            continue
                        if end_pts is not None and frame.pts is not None and frame.pts >= end_pts:
                            video_done = True
                            if last_video_pts is not None:
                                # the source continues past the window: hold the last kept
                                # frame to the window end
                                end_offset = video_pts_offset if video_pts_offset is not None else start_pts
                                last_video_end = max(last_video_end, end_pts - end_offset)
                            break
                        frame_duration = frame.duration if frame.duration else pts_step
                        if end_pts is not None and frame.pts is not None:
                            frame_duration = min(frame_duration, end_pts - frame.pts)
                        if frame.rotation != 0:
                            raise ValueError(
                                "LoadVideoCrop v1 streaming save does not support rotated sources; "
                                "save without a crop (aspect ratio Original) to use the core path"
                            )
                        if output is None:
                            out_width, out_height = x1 - x0, y1 - y0
                            if out_width % 2 or out_height % 2:
                                raise ValueError(
                                    f"{output_codec.value.upper()} output requires even dimensions, got {out_width}x{out_height}"
                                )
                            source_size = (frame.width, frame.height)
                            output = av.open(path, **open_kwargs)
                            _core_vt.write_output_metadata(container, output, metadata)
                            out_video = output.add_stream(_core_vt.VIDEO_ENCODERS[output_codec], rate=rate)
                            # no B-frames: reordering makes mp4 sample durations follow decode
                            # order, so irregular-VFR spans and trim windows land wrong
                            out_video.codec_context.max_b_frames = 0
                            out_video.width = out_width
                            out_video.height = out_height
                            out_video.pix_fmt = "yuv420p"
                            out_video.options = _core_vt.video_encoder_options(output_codec, crf)
                            if preserve_source_color:
                                _core_vt.copy_color_properties(video_stream, out_video.codec_context)
                            elif color_space is not None:
                                _core_vt.set_video_color_properties(out_video.codec_context, color_space)
                            # source pts pass through (rebased to 0), so variable frame rate survives
                            out_video.codec_context.time_base = video_stream.time_base
                            if audio_stream is not None:
                                audio_codec = "libopus" if output_format == Types.VideoContainer.WEBM else "aac"
                                out_audio = output.add_stream(audio_codec, rate=sample_rate, layout=layout)
                        if (frame.width, frame.height) != source_size:
                            raise ValueError(
                                f"Video resolution changes mid-stream "
                                f"({source_size[0]}x{source_size[1]} -> {frame.width}x{frame.height}); cannot crop it"
                            )
                        # crop: a free slice in full-resolution yuv444p, then re-encode
                        # straight to yuv420p (avoids the intermediate full-size rgb24)
                        if (x0, y0, x1, y1) != (0, 0, frame.width, frame.height):
                            # pyav returns planar formats channels-first: (C, H, W)
                            crop = frame.to_ndarray(format="yuv444p")[:, y0:y1, x0:x1]
                            frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(crop), format="yuv444p")
                            if frame.color_range == ColorRange.JPEG and not preserve_source_color:
                                # compress full-range sources (yuvj/MJPEG) to limited range
                                frame = frame.reformat(format="yuv420p", src_color_range="JPEG", dst_color_range="MPEG")
                            else:
                                frame = frame.reformat(format="yuv420p")
                        else:
                            if frame.color_range == ColorRange.JPEG and not preserve_source_color:
                                frame = frame.reformat(format="yuv420p", src_color_range="JPEG", dst_color_range="MPEG")
                            else:
                                frame = frame.reformat(format="yuv420p")
                        if preserve_source_color:
                            _core_vt.copy_color_properties(video_stream, frame)
                        elif color_space is not None:
                            _core_vt.set_video_color_properties(frame, color_space)
                        frame_output_end = None
                        if frame.pts is not None:
                            if video_pts_offset is None:
                                video_pts_offset = frame.pts
                            frame.pts -= video_pts_offset
                            if output_end_pts is not None:
                                frame_output_end = output_end_pts - video_pts_offset
                                if frame.pts + frame_duration > frame_output_end:
                                    clamped_pts = frame_output_end - frame_duration
                                    if clamped_pts >= 0 and (last_video_pts is None or clamped_pts > last_video_pts):
                                        frame.pts = min(frame.pts, clamped_pts)
                                    elif frame.pts < frame_output_end:
                                        frame_duration = frame_output_end - frame.pts
                                    else:
                                        continue
                        if frame.pts is None or (last_video_pts is not None and frame.pts <= last_video_pts):
                            # broken sources emit missing/backward timestamps mid-stream, which
                            # the muxer rejects; nudge them forward by one nominal frame interval
                            frame.pts = 0 if last_video_pts is None else last_video_pts + pts_step
                            if frame_output_end is not None and frame.pts + frame_duration > frame_output_end:
                                if frame.pts >= frame_output_end:
                                    continue
                                frame_duration = frame_output_end - frame.pts
                        last_video_pts = frame.pts
                        last_video_end = frame.pts + frame_duration
                        video_frame_durations[frame.pts] = frame_duration
                        # the decoded pict_type would force x264's frame types (intra-only
                        # sources like MJPEG/ProRes would come out all-keyframe)
                        frame.pict_type = 0
                        for out_packet in out_video.encode(frame):
                            out_packet.duration = video_frame_durations.pop(out_packet.pts, 0)
                            output.mux(out_packet)
                        drain_audio()

                elif packet.stream == audio_stream and not audio_done:
                    for resampled in itertools.chain.from_iterable(
                        map(resampler.resample, packet.decode())
                    ):
                        frame_start = None
                        if resampled.pts is not None:
                            # passthrough frames keep the source stream's time base
                            tb = resampled.time_base if resampled.time_base else audio_time_base
                            frame_start = float(resampled.pts * tb)
                            if duration and not audio_started and frame_start >= start_time + duration:
                                audio_done = True
                                break
                        if not audio_started:
                            if frame_start is None:
                                frame_start = 0.0
                            to_skip = max(0, int((start_time - frame_start) * sample_rate))
                            if to_skip >= resampled.samples:
                                continue
                            audio_started = True
                            if duration and frame_start > start_time:
                                duration_cap = min(
                                    duration_cap, math.ceil((start_time + duration - frame_start) * sample_rate)
                                )
                            if to_skip:
                                pending_audio.append(audio_frame_from_ndarray(resampled.to_ndarray()[..., to_skip:]))
                                continue
                        pending_audio.append(resampled)
                        if video_done:
                            # the video window is complete so the cap is final, but containers
                            # that interleave audio behind video (fragmented mp4) still owe most
                            # of it: stop only once the demuxed audio covers the cap
                            cap = drain_audio()
                            if pending_audio or samples_written >= cap:
                                drain_audio(final=True)
                                audio_done = True
                                break

            if output is None:
                raise ValueError(f"No decodable video frames found in file '{self.__path}'")
            if out_audio is not None and not audio_done:
                drain_audio(final=True)
            window_fill = last_video_end - last_video_pts if video_done and last_video_pts is not None else 0
            for out_packet in out_video.encode(None):
                duration = video_frame_durations.pop(out_packet.pts, 0)
                if out_packet.pts == last_video_pts:
                    duration = max(duration, window_fill)
                out_packet.duration = duration
                output.mux(out_packet)
            if out_audio is not None:
                output.mux(out_audio.encode(None))
        except BaseException:
            if output is not None:
                output.close()
                if isinstance(path, (str, os.PathLike)) and os.path.exists(path):
                    os.remove(path)
            raise
        else:
            if output is not None:
                output.close()


class LoadVideoCrop(io.ComfyNode):
    """Like the official Load Video node, plus an aspect-ratio-locked visual
    crop over the preview (WYSIWYG).

    The crop rectangle is STATIC across all frames: it is the same rectangle
    in every frame, so the output video is the input video cropped to a fixed
    aspect ratio. With aspect_ratio == "Original" (default) the video is
    returned as-is, uncropped (the core VideoFromFile, exactly like the
    official Load Video output).

    The rectangle arrives as normalized [0..1] fractions of the frame size
    (crop_x, crop_y, crop_w, crop_h), computed and stored by the frontend in
    the (hidden) crop_* widgets so it serializes into the workflow.

    The cropped output is a lazy VideoInput: saving it streams frame-by-frame
    from the source file (peak memory ~ one frame, independent of video
    length), while tensor consumers materialize only the cropped region.

    Optional trim (start_time/duration, same semantics as the core Trim Video
    node): applied via as_trimmed on top of whatever the aspect ratio produced,
    so Original + trim stays a pure core pass-through. 0 = no trim/unlimited.
    """

    @classmethod
    def define_schema(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["video"])
        return io.Schema(
            node_id="LoadVideoCrop",
            search_aliases=["load video", "crop video", "video crop", "import video"],
            display_name="Load Video + Crop",
            category="video",
            description="Load a video and crop it to a locked aspect ratio (WYSIWYG).",
            inputs=[
                io.Combo.Input("file", options=sorted(files), upload=io.UploadType.video),
                io.Combo.Input("aspect_ratio", options=ASPECT_RATIOS, default="Original"),
                io.Float.Input("crop_x", default=0.0, min=0.0, max=1.0, step=0.0001),
                io.Float.Input("crop_y", default=0.0, min=0.0, max=1.0, step=0.0001),
                io.Float.Input("crop_w", default=1.0, min=0.0, max=1.0, step=0.0001),
                io.Float.Input("crop_h", default=1.0, min=0.0, max=1.0, step=0.0001),
                io.Float.Input(
                    "start_time",
                    default=0.0,
                    min=-1e5,
                    max=1e5,
                    step=0.001,
                    tooltip="Trim: start time in seconds (negative = from the end; 0 = no trim).",
                ),
                io.Float.Input(
                    "duration",
                    default=0.0,
                    min=0.0,
                    step=0.001,
                    tooltip="Trim: duration in seconds, or 0 for unlimited duration.",
                ),
                io.Boolean.Input(
                    "strict_duration",
                    default=False,
                    tooltip="If True, raise an error when the requested duration cannot be fully satisfied.",
                ),
                io.Float.Input(
                    "frame_time",
                    default=0.0,
                    min=0.0,
                    max=1e5,
                    step=0.001,
                    tooltip="Seconds in the file: the frame the preview is showing, output as the two images. Kept in sync by the frontend; set manually to export a specific moment.",
                ),
            ],
            outputs=[
                io.Video.Output(display_name="VIDEO"),
                io.Image.Output(
                    display_name="FULL FRAME",
                    tooltip="The frame the preview is showing, full resolution (stable while the player is paused).",
                ),
                io.Image.Output(
                    display_name="CROPPED FRAME",
                    tooltip="The previewed frame cropped to the aspect-ratio box (identical to the full frame in Original mode).",
                ),
            ],
        )

    @classmethod
    def execute(cls, file, aspect_ratio, crop_x, crop_y, crop_w, crop_h,
                start_time, duration, strict_duration, frame_time=0.0) -> io.NodeOutput:
        video_path = folder_paths.get_annotated_filepath(file)
        if aspect_ratio == "Original":
            # Pure pass-through: the exact core Load Video output.
            video = InputImpl.VideoFromFile(video_path)
        elif _core_vt is None:
            # Core moved its private helpers: fall back to the legacy eager
            # path (correct but materializes the full video in RAM).
            video = cls._legacy_eager_video(video_path, crop_x, crop_y, crop_w, crop_h)
        else:
            video = LoadVideoCropVideo(video_path, crop_x, crop_y, crop_w, crop_h)

        # Same trim semantics as the core Trim Video node (VideoSlice).
        trimmed = video.as_trimmed(start_time, duration, strict_duration=strict_duration)
        if trimmed is None:
            raise ValueError(
                f"Failed to slice video:\nSource duration: {video.get_duration()}\n"
                f"Start time: {start_time}\nTarget duration: {duration}"
            )
        full, cropped = cls._preview_frames(video_path, frame_time, crop_x, crop_y, crop_w, crop_h)
        return io.NodeOutput(trimmed, full, cropped)

    @staticmethod
    def _preview_frames(video_path, frame_time, crop_x, crop_y, crop_w, crop_h):
        """The previewed frame as IMAGE tensors: (full, cropped).

        Decodes the LAST frame with pts <= frame_time - the exact frame the
        browser player displays at that instant (the same pixels the frame-
        save button captures). The rectangle is applied in display space
        (after the rotation metadata), so the output is WYSIWYG with the
        overlay box and with the saved PNGs."""
        t = max(0.0, float(frame_time))
        with av.open(video_path, mode="r") as container:
            stream = container.streams.video[0]
            if not stream:
                raise ValueError("No video stream found in file")
            dur_s = float(container.duration / av.time_base) if container.duration else 0.0
            if dur_s > 0:
                t = min(t, max(0.0, dur_s - 1e-3))
            target = int(t / stream.time_base)
            container.seek(target, any_frame=False, backward=True, stream=stream)
            frame = None
            for f in container.decode(stream):
                if f.pts is None:
                    continue
                if f.pts > target:
                    break
                frame = f
            if frame is None:  # target before the first decodable frame
                container.seek(0, any_frame=False, backward=True, stream=stream)
                frame = next(container.decode(stream))
            has_alpha = any(c.is_alpha for c in frame.format.components)
            img = frame.to_ndarray(format="rgba" if has_alpha else "rgb24")
            rotation = int(frame.rotation or 0)
        if rotation:
            k = (-rotation) % 360 // 90
            img = np.ascontiguousarray(np.rot90(img, k, axes=(0, 1)))
        full = torch.from_numpy(np.ascontiguousarray(img)).float().div_(255.0).unsqueeze(0)
        if (crop_x, crop_y, crop_w, crop_h) == (0, 0, 1, 1) or not (
            crop_w > 0.001 and crop_h > 0.001 and crop_x < 0.999 and crop_y < 0.999
        ):
            return full, full
        H, W = img.shape[0], img.shape[1]
        x0, y0, x1, y1 = _even_crop_box(crop_x, crop_y, crop_x + crop_w, crop_y + crop_h, W, H)
        cropped = full[:, y0:y1, x0:x1, :].contiguous()
        return full, cropped

    @staticmethod
    def _legacy_eager_video(video_path, crop_x, crop_y, crop_w, crop_h):
        """Pre-v1.1 behavior: decode everything, crop the tensor, re-wrap."""
        components = InputImpl.VideoFromFile(video_path).get_components()
        images, alpha = cls._crop_tensors(
            components.images, components.alpha, crop_x, crop_y, crop_w, crop_h
        )
        return InputImpl.VideoFromComponents(
            Types.VideoComponents(
                images=images,
                audio=components.audio,
                frame_rate=components.frame_rate,
                alpha=alpha,
            )
        )

    @staticmethod
    def _crop_tensors(images, alpha, crop_x, crop_y, crop_w, crop_h):
        """Crop a batch of frames (and its per-pixel alpha, if any) to a
        normalized rectangle. Slices dim 0 (frames) as a whole, so the SAME
        rectangle is applied to every frame. The math mirrors
        LoadImageCrop._crop."""
        # full-frame crop ("Original" mode): return as-is
        if (crop_x, crop_y, crop_w, crop_h) == (0, 0, 1, 1):
            return images, alpha
        # guard against degenerate values (API/workflow input): an empty or
        # out-of-range crop is returned uncropped
        if not (crop_w > 0.001 and crop_h > 0.001 and crop_x < 0.999 and crop_y < 0.999):
            return images, alpha

        H, W = images.shape[1], images.shape[2]
        x0, y0, x1, y1 = _even_crop_box(crop_x, crop_y, crop_x + crop_w, crop_y + crop_h, W, H)
        images = images[:, y0:y1, x0:x1, :].contiguous()

        if alpha is not None:
            ah, aw = alpha.shape[1], alpha.shape[2]
            ax0, ay0, ax1, ay1 = _even_crop_box(crop_x, crop_y, crop_x + crop_w, crop_y + crop_h, aw, ah)
            alpha = alpha[:, ay0:ay1, ax0:ax1].contiguous()

        return images, alpha

    @classmethod
    def fingerprint_inputs(cls, file, aspect_ratio, crop_x, crop_y, crop_w, crop_h,
                           start_time, duration, strict_duration, frame_time=0.0):
        # file identity via stat (size + mtime) instead of hashing the whole
        # file, plus the full-precision crop/trim/frame so any change forces
        # a re-run
        video_path = folder_paths.get_annotated_filepath(file)
        st = os.stat(video_path)
        return (
            f"{st.st_size}|{st.st_mtime_ns}|"
            f"{aspect_ratio}|{crop_x!r},{crop_y!r},{crop_w!r},{crop_h!r}|"
            f"{start_time!r},{duration!r},{strict_duration!r},{frame_time!r}"
        )

    @classmethod
    def validate_inputs(cls, file, aspect_ratio=None, crop_x=None, crop_y=None, crop_w=None, crop_h=None,
                        start_time=None, duration=None, strict_duration=None, frame_time=None):
        if not folder_paths.exists_annotated_filepath(file):
            return "Invalid video file: {}".format(file)
        return True
