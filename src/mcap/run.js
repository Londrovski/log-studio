// Turning an .mcap log into something playable.
//
// Opening a run costs roughly one pass over the file, so we do exactly one, and we
// pick up everything cheap in that pass: scalars, poses, and the scene geometry.
// Camera frames are the expensive part (a three-minute run is a few hundred megabytes
// of JPEG) so those stay on disk and are fetched in a sliding window as you play.

import { LogReader } from "./reader.js";

const yawOf = (q) =>
  q ? Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) : 0;

const rgba = (c) => (c ? [c.r ?? 0, c.g ?? 0, c.b ?? 0, c.a ?? 1] : [0, 0, 0, 1]);

/** A time-ordered numeric channel, with a fast "value at time t" lookup. */
export class Series {
  constructor(t = [], v = []) {
    this.t = Float64Array.from(t);
    this.v = Float64Array.from(v);
  }
  get length() { return this.t.length; }
  /** Index of the last sample at or before t. */
  indexAt(t) {
    let lo = 0, hi = this.t.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }
  at(t) { return this.t.length ? this.v[this.indexAt(t)] : 0; }
  /** Linear interpolation, for things that should move smoothly. */
  lerp(t) {
    const n = this.t.length;
    if (!n) return 0;
    const i = this.indexAt(t);
    if (i >= n - 1 || t <= this.t[0]) return this.v[Math.min(i, n - 1)];
    const f = (t - this.t[i]) / (this.t[i + 1] - this.t[i] || 1);
    return this.v[i] + f * (this.v[i + 1] - this.v[i]);
  }
  /** Samples inside a window, thinned to at most `max` points for drawing. */
  window(t0, t1, max = 600) {
    const a = this.indexAt(t0), b = this.indexAt(t1);
    const step = Math.max(1, Math.floor((b - a) / max));
    const ts = [], vs = [];
    for (let i = a; i <= b; i += step) { ts.push(this.t[i]); vs.push(this.v[i]); }
    return { t: ts, v: vs };
  }
  range(t0, t1) {
    let lo = Infinity, hi = -Infinity;
    const a = this.indexAt(t0), b = this.indexAt(t1);
    for (let i = a; i <= b; i++) { if (this.v[i] < lo) lo = this.v[i]; if (this.v[i] > hi) hi = this.v[i]; }
    return [lo, hi];
  }
}

/** A list of timestamped things, with the same "last at or before t" lookup. */
class Track {
  constructor() { this.t = []; this.items = []; }
  push(t, item) { this.t.push(t); this.items.push(item); }
  indexAt(time) {
    let lo = 0, hi = this.t.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }
  at(time, maxAge = Infinity) {
    if (!this.t.length) return null;
    const i = this.indexAt(time);
    return time - this.t[i] <= maxAge ? this.items[i] : null;
  }
}

/**
 * Camera frames, read from disk on demand.
 * Playback and export both move forward, so a window either side of the playhead
 * is nearly always a hit; scrubbing somewhere new costs one short read.
 */
class CameraCache {
  constructor(reader, topic, { ahead = 6, behind = 2 } = {}) {
    this.reader = reader; this.topic = topic;
    this.ahead = ahead; this.behind = behind;
    this.frames = new Track();
    this.loaded = []; // [start, end] windows already read
    this.pending = null;
  }
  has(t) { return this.loaded.some(([a, b]) => t >= a && t <= b); }
  async ensure(t) {
    if (this.has(t)) return;
    if (this.pending) await this.pending;
    if (this.has(t)) return;
    const a = t - this.behind, b = t + this.ahead;
    this.pending = (async () => {
      const got = [];
      for await (const m of this.reader.read([this.topic], { start: a, end: b })) {
        const v = m.value;
        if (!v?.data) continue;
        got.push([m.time, { bytes: v.data, format: v.format ?? "jpeg" }]);
      }
      // Keep the track sorted without re-sorting the whole thing every window.
      for (const [time, f] of got) this.frames.push(time, f);
      const order = this.frames.t.map((x, i) => i).sort((i, j) => this.frames.t[i] - this.frames.t[j]);
      this.frames.t = order.map((i) => this.frames.t[i]);
      this.frames.items = order.map((i) => this.frames.items[i]);
      this.loaded.push([a, b]);
      this.forget(t);
    })();
    await this.pending;
    this.pending = null;
  }
  /** Drop frames far from the playhead so a long run doesn't fill memory. */
  forget(t, keep = 60) {
    if (this.frames.t.length < 2000) return;
    const lo = t - keep, hi = t + keep;
    const idx = this.frames.t.map((x, i) => i).filter((i) => this.frames.t[i] >= lo && this.frames.t[i] <= hi);
    this.frames.t = idx.map((i) => this.frames.t[i]);
    this.frames.items = idx.map((i) => this.frames.items[i]);
    this.loaded = this.loaded.filter(([a, b]) => b >= lo && a <= hi);
  }
  frameAt(t) { return this.frames.at(t, 1.5); }
}

export class Run {
  constructor(file, reader) {
    this.file = file;
    this.reader = reader;
    this.scalars = new Map();   // topic -> Series
    this.tf = new Map();        // topic -> { x: Series, y: Series, yaw: Series }
    this.scene = new Map();     // topic -> Track of { cubes, lines }
    this.camera = null;
    this.meta = {};
  }

  get span() { return this.reader.span; }

  scalar(topic) { return this.scalars.get(topic) ?? new Series(); }

  /** Value of anything a template can point at. */
  valueAt(source, t) {
    if (!source?.topic) return 0;
    const s = this.scalars.get(source.topic);
    if (s) return source.interpolate === false ? s.at(t) : s.lerp(t);
    const tfv = this.tf.get(source.topic);
    if (tfv && source.field && tfv[source.field]) return tfv[source.field].lerp(t);
    return 0;
  }
}

/** Topics we pull in the single pass. Anything a template can draw must be here. */
export const SCALAR_TOPICS = [
  "/control/ddt/vehicle_speed", "/control/ddt/steer_request", "/control/ddt/rpm_request",
  "/control/ddt/wheel_speed/fl", "/control/ddt/wheel_speed/fr",
  "/control/ddt/wheel_speed/rl", "/control/ddt/wheel_speed/rr",
  "/control/ddt/rear_axle_trq_actual", "/control/ddt/vcu/as_state", "/control/ddt/vcu/ami_state",
  "/control/driver/lap_count", "/graph_slam/landmark_count", "/taskmgr/perception_latency_ms",
];
export const TF_TOPICS = ["/frame/odom", "/frame/graph_slam_car"];
export const SCENE_TOPICS = [
  "/graph_slam/landmarks", "/graph_slam/perception", "/graph_slam/body",
  "/path_planner/centreline", "/path_planner/candidates_shifted", "/path_planner/delaunay",
  "/path_planner/extrapolation", "/path_planner/target", "/path_planner/start_zone",
];
export const CAMERA_TOPIC = "/perception/sensor_fusion_image";

export async function loadRun(file, { onProgress = () => {} } = {}) {
  onProgress(0, "opening");
  const reader = await LogReader.open(file);
  const run = new Run(file, reader);
  const { start, end } = reader.span;

  const wanted = [...SCALAR_TOPICS, ...TF_TOPICS, ...SCENE_TOPICS].filter((t) => reader.channels.has(t));
  const raw = new Map(wanted.map((t) => [t, { t: [], v: [] }]));
  const tfraw = new Map(TF_TOPICS.map((t) => [t, { t: [], x: [], y: [], yaw: [] }]));
  for (const t of SCENE_TOPICS) run.scene.set(t, new Track());

  onProgress(0.02, "reading");
  let n = 0;
  for await (const m of reader.read(wanted)) {
    const topic = m.topic, v = m.value;
    if (v == null) continue;
    if (++n % 4000 === 0) onProgress(0.02 + 0.93 * ((m.time - start) / (end - start || 1)), "reading");

    if (tfraw.has(topic)) {
      const p = v.translation ?? v.pose?.position ?? v.position ?? v;
      const q = v.rotation ?? v.pose?.orientation ?? v.orientation;
      const d = tfraw.get(topic);
      d.t.push(m.time); d.x.push(p?.x ?? 0); d.y.push(p?.y ?? 0); d.yaw.push(yawOf(q));
      continue;
    }
    if (run.scene.has(topic)) {
      const cubes = [], lines = [];
      for (const e of v.entities ?? []) {
        for (const c of e.cubes ?? []) cubes.push({
          x: c.pose?.position?.x ?? 0, y: c.pose?.position?.y ?? 0,
          sx: c.size?.x ?? 0.2, sy: c.size?.y ?? 0.2, color: rgba(c.color),
        });
        for (const s of e.spheres ?? []) cubes.push({
          x: s.pose?.position?.x ?? 0, y: s.pose?.position?.y ?? 0,
          sx: s.size?.x ?? 0.2, sy: s.size?.y ?? 0.2, color: rgba(s.color),
        });
        for (const l of e.lines ?? []) lines.push({
          pts: (l.points ?? []).map((p) => [p.x, p.y]), color: rgba(l.color),
          thickness: l.thickness ?? 0.05, type: l.type ?? 0,
        });
      }
      run.scene.get(topic).push(m.time, { cubes, lines });
      continue;
    }
    const d = raw.get(topic);
    if (d) {
      const num = typeof v === "number" ? v : (v.value ?? v.data ?? 0);
      if (typeof num === "number" && Number.isFinite(num)) { d.t.push(m.time); d.v.push(num); }
    }
  }

  for (const [topic, d] of raw) if (d.t.length) run.scalars.set(topic, new Series(d.t, d.v));
  for (const [topic, d] of tfraw) {
    if (!d.t.length) continue;
    run.tf.set(topic, { x: new Series(d.t, d.x), y: new Series(d.t, d.y), yaw: new Series(d.t, d.yaw) });
  }
  if (reader.channels.has(CAMERA_TOPIC)) run.camera = new CameraCache(reader, CAMERA_TOPIC);

  // The file name carries the mission and the time, which is what the title bar wants.
  const fn = (file.name ?? "").replace(/\.mcap$/i, "");
  const fm = fn.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_([A-Za-z]+)/);
  if (fm) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    run.meta.title = fm[7];
    run.meta.subtitle = `${Number(fm[3])} ${months[Number(fm[2]) - 1]} ${fm[1]}  ·  ${fm[4]}:${fm[5]}`;
  } else {
    run.meta.title = fn;
    run.meta.subtitle = "";
  }

  onProgress(0.97, "deriving");
  derive(run);
  onProgress(1, "ready");
  return run;
}

/** Everything that isn't in the log but is drawn from it. */
function derive(run) {
  const { start, end } = run.span;

  // When the car actually started driving (as_state 3 = DRIVING).
  const as = run.scalars.get("/control/ddt/vcu/as_state");
  let driveStart = start;
  if (as) for (let i = 0; i < as.length; i++) if (as.v[i] === 3) { driveStart = as.t[i]; break; }
  run.meta.driveStart = driveStart;

  // Distance driven, by integrating speed from the moment it started driving.
  const spd = run.scalars.get("/control/ddt/vehicle_speed");
  if (spd?.length) {
    const d = new Float64Array(spd.length);
    for (let i = 1; i < spd.length; i++) {
      d[i] = d[i - 1] + (spd.t[i] - spd.t[i - 1]) * 0.5 * (spd.v[i] + spd.v[i - 1]);
    }
    const atStart = new Series(spd.t, d).lerp(driveStart);
    for (let i = 0; i < d.length; i++) d[i] -= atStart;
    run.scalars.set("@distance", new Series(spd.t, d));
  }

  // The SLAM map grows as the car drives; showing the richest map seen so far stops
  // cones vanishing when a later message carries fewer of them.
  const lm = run.scene.get("/graph_slam/landmarks");
  if (lm?.t.length) {
    const best = []; let bestN = -1, bestI = 0;
    lm.items.forEach((it, i) => { if (it.cubes.length >= bestN) { bestN = it.cubes.length; bestI = i; } best.push(bestI); });
    lm.best = best;
  }

  // Direction of travel, smoothed from the SLAM track. Using the car's own yaw would
  // shake; using raw track differences jumps whenever SLAM relocalises at the lap line.
  const car = run.tf.get("/frame/graph_slam_car");
  if (car?.x.length > 4) {
    const t0 = car.x.t[0] + 0.5, t1 = car.x.t[car.x.length - 1];
    const ts = [], ang = [], ok = [];
    for (let t = t0; t < t1; t += 0.05) {
      const dx = car.x.lerp(t) - car.x.lerp(t - 0.5);
      const dy = car.y.lerp(t) - car.y.lerp(t - 0.5);
      const step = Math.hypot(dx, dy);
      ts.push(t); ang.push(Math.atan2(dy, dx));
      ok.push(step > 0.3 && step < 3.0); // moving, and not a relocalisation jump
    }
    // Keep only trustworthy samples, unwrap them, then fill the gaps by interpolation.
    const gi = [], ga = [];
    let prev = null;
    for (let i = 0; i < ts.length; i++) {
      if (!ok[i]) continue;
      let a = ang[i];
      if (prev != null) { while (a - prev > Math.PI) a -= 2 * Math.PI; while (a - prev < -Math.PI) a += 2 * Math.PI; }
      prev = a; gi.push(i); ga.push(a);
    }
    const filled = new Float64Array(ts.length);
    if (gi.length) {
      let k = 0;
      for (let i = 0; i < ts.length; i++) {
        while (k < gi.length - 1 && gi[k + 1] < i) k++;
        if (i <= gi[0]) filled[i] = ga[0];
        else if (i >= gi[gi.length - 1]) filled[i] = ga[ga.length - 1];
        else {
          const f = (i - gi[k]) / (gi[k + 1] - gi[k] || 1);
          filled[i] = ga[k] + f * (ga[k + 1] - ga[k]);
        }
      }
    }
    const win = 21, half = 10, sm = new Float64Array(ts.length);
    for (let i = 0; i < ts.length; i++) {
      let s = 0;
      for (let j = -half; j <= half; j++) s += filled[Math.min(ts.length - 1, Math.max(0, i + j))];
      sm[i] = s / win;
    }
    run.heading = new Series(ts, sm);
  }
}
