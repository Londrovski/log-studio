// Rendering a clip to MP4, using Chrome's own video encoder (the graphics card does
// the work). Frames are drawn at a fixed rate rather than in real time, so the file is
// smooth no matter how busy the machine is.

import {
  Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource,
  getFirstEncodableVideoCodec,
} from "../../vendor/bundle.js";

// H.264 is what everything plays, so it is always the first choice. Chrome on a
// machine built without the proprietary codecs still encodes VP9 or AV1, and those
// sit happily in an .mp4 too, so a render never simply fails.
const CODEC_ORDER = ["avc", "av1", "vp9", "vp8"];

export async function pickCodec(width, height, bitrate) {
  const codec = await getFirstEncodableVideoCodec(CODEC_ORDER, { width, height, bitrate });
  if (!codec) throw new Error("this browser cannot encode video — Chrome or Edge is needed");
  return codec;
}

export const QUALITIES = {
  high: 12_000_000,
  medium: 6_000_000,
  web: 2_800_000, // about 30 MB a minute — the size the website wants
};

/**
 * @param renderer  a Renderer
 * @param run       the loaded Run
 * @param opts.clip { start, end } in log seconds
 * @param opts.speed playback speed: 2 means the clip plays twice as fast
 * @param opts.fps   frames per second in the output
 */
export async function renderToMp4(renderer, run, opts) {
  const {
    clip, speed = 1, fps = 30, quality = "web", scale = 1,
    onProgress = () => {}, signal,
  } = opts;

  const W = Math.round(renderer.width * scale);
  const H = Math.round(renderer.height * scale);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (scale !== 1) ctx.scale(scale, scale);

  const bitrate = typeof quality === "number" ? quality : (QUALITIES[quality] ?? QUALITIES.web);
  const codec = opts.codec ?? (await pickCodec(W, H, bitrate));
  const webm = codec === "vp8";
  const output = new Output({
    format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const clipSeconds = Math.max(0, clip.end - clip.start);
  const outSeconds = clipSeconds / speed;
  const total = Math.max(1, Math.round(outSeconds * fps));
  const needsCamera = renderer.needsCamera();

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) { await output.cancel?.(); throw new DOMException("cancelled", "AbortError"); }
    const t = clip.start + (i / fps) * speed;
    if (needsCamera && run.camera) {
      await run.camera.ensure(t);
      await decodeFrame(run.camera.frameAt(t));
    }
    renderer.draw(ctx, run, t, { clip });
    await source.add(i / fps, 1 / fps);
    if (i % 10 === 0) onProgress((i + 1) / total, i + 1, total);
  }
  onProgress(1, total, total);

  source.close();
  await output.finalize();
  const blob = new Blob([output.target.buffer], { type: webm ? "video/webm" : "video/mp4" });
  blob.codec = codec;
  return blob;
}

/** JPEG bytes become a bitmap once, then stay on the frame object. */
export async function decodeFrame(frame) {
  if (!frame || frame.bitmap) return frame;
  try {
    const type = /png/i.test(frame.format ?? "") ? "image/png" : "image/jpeg";
    frame.bitmap = await createImageBitmap(new Blob([frame.bytes], { type }));
  } catch { frame.bitmap = null; }
  return frame;
}
