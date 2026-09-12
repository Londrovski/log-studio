// One function per panel type. Each is handed the canvas, the box it owns, its own
// slice of the template, and the run. Adding a readout later is a new entry here plus
// a few lines of JSON — no changes anywhere else.

const TAU = Math.PI * 2;

// ---- small drawing helpers -------------------------------------------------

function rr(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function text(ctx, s, x, y, { font, fill, align = "left", baseline = "top" } = {}) {
  ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = align; ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

const f = (theme, weight, size) => `${weight} ${size}px ${theme.font}`;

function pill(ctx, x, y, label, theme, { bg = "#ffffff", ink } = {}) {
  ctx.font = f(theme, 500, 15);
  const w = ctx.measureText(label).width + 26;
  rr(ctx, x, y, w, 30, 15, bg);
  text(ctx, label, x + 13, y + 8, { font: f(theme, 500, 15), fill: ink ?? theme.ink });
}

function clipRounded(ctx, x, y, w, h, r) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
}

/** Cone colours come through as floats; map the three real ones and blend the rest. */
function coneColour(c, theme) {
  const [r, g, b, a] = c;
  if (r > 0.9 && g > 0.9 && b < 0.3) return theme.coneYellow;
  if (r > 0.9 && g > 0.3 && g < 0.8 && b < 0.3) return theme.coneOrange;
  if (b > 0.8 && r < 0.3 && g < 0.6) return theme.coneBlue;
  const al = a > 0 ? a : 1;
  const mix = (v) => Math.round(al * 255 * v + (1 - al) * 250);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function niceTicks(lo, hi, n = 4) {
  const raw = (hi - lo) / n;
  if (!Number.isFinite(raw) || raw <= 0) return [lo];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].reduce((a, b) => (Math.abs(b * mag - raw) < Math.abs(a * mag - raw) ? b : a)) * mag;
  const out = [];
  for (let s = Math.ceil(lo / step) * step; s <= hi + 1e-9; s += step) out.push(Number(s.toFixed(6)));
  return out;
}

// ---- panels ----------------------------------------------------------------

/** The forward camera, with whatever perception drew on it at record time. */
function camera(ctx, box, cfg, env) {
  const { x, y, w, h } = box;
  const { run, t, theme } = env;
  const frame = run.camera?.frameAt(t);
  rr(ctx, x, y, w, h, theme.radius, "#000000");
  if (frame?.bitmap) {
    clipRounded(ctx, x, y, w, h, theme.radius);
    // Fill the box, cropping rather than squashing.
    const s = Math.max(w / frame.bitmap.width, h / frame.bitmap.height);
    const dw = frame.bitmap.width * s, dh = frame.bitmap.height * s;
    ctx.drawImage(frame.bitmap, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    text(ctx, "waiting for camera", x + w / 2, y + h / 2, { font: f(theme, 500, 18), fill: "#71717a", align: "center", baseline: "middle" });
  }
  if (cfg.label) pill(ctx, x + 16, y + 16, cfg.label, theme);
}

/**
 * Top-down map: cones, planned path and the car, drawn in the car's own frame so the
 * car sits still and the world moves past it.
 */
function map(ctx, box, cfg, env) {
  const { x, y, w, h } = box;
  const { run, t, theme } = env;
  const bg = cfg.background ?? "#fafafb";
  rr(ctx, x, y, w, h, theme.radius, bg);
  clipRounded(ctx, x, y, w, h, theme.radius);

  const car = run.tf.get(cfg.frame ?? "/frame/graph_slam_car");
  const cx = car ? car.x.lerp(t) : 0;
  const cy = car ? car.y.lerp(t) : 0;
  const hd = run.heading ? run.heading.lerp(t) : (car ? car.yaw.lerp(t) : 0);

  const ahead = cfg.viewAhead ?? 15;
  const originY = cfg.carAt ?? 0.74;           // car sits low, so most of the view is the road ahead
  const px = x + w / 2, py = y + h * originY;
  const sc = (h * originY) / ahead;
  const ch = Math.cos(hd), sh = Math.sin(hd);
  const proj = (wx, wy) => {
    const dx = wx - cx, dy = wy - cy;
    const fwd = dx * ch + dy * sh, lat = -dx * sh + dy * ch;
    return [px - lat * sc, py - fwd * sc];
  };

  // A world-fixed metre grid, which is what makes the motion readable.
  if (cfg.grid !== false) {
    const R = 36, gx0 = Math.floor(cx) - R, gy0 = Math.floor(cy) - R;
    ctx.lineWidth = 1;
    for (let k = 0; k <= 2 * R; k++) {
      ctx.strokeStyle = (gx0 + k) % 5 === 0 ? "#d6d6de" : "#eaeaef";
      let [ax, ay] = proj(gx0 + k, gy0), [bx, by] = proj(gx0 + k, gy0 + 2 * R);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = (gy0 + k) % 5 === 0 ? "#d6d6de" : "#eaeaef";
      [ax, ay] = proj(gx0, gy0 + k); [bx, by] = proj(gx0 + 2 * R, gy0 + k);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  }

  const drawLines = (topic, colour, width, maxAge = 1.0) => {
    const track = run.scene.get(topic);
    const m = track?.at(t, maxAge);
    if (!m) return;
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.lineCap = "round";
    for (const line of m.lines) {
      if (line.pts.length < 2) continue;
      ctx.beginPath();
      // These come as disconnected segment pairs, same as Foxglove draws them.
      for (let i = 0; i + 1 < line.pts.length; i += 2) {
        const [ax, ay] = proj(...line.pts[i]), [bx, by] = proj(...line.pts[i + 1]);
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }
  };

  for (const layer of cfg.layers ?? []) {
    if (layer.kind === "lines") drawLines(layer.topic, layer.colour, layer.width ?? 2, layer.maxAge ?? 1.0);
    else if (layer.kind === "points") {
      const m = run.scene.get(layer.topic)?.at(t, layer.maxAge ?? 1.0);
      if (!m) continue;
      ctx.fillStyle = layer.colour;
      for (const c of m.cubes) {
        const [ax, ay] = proj(c.x, c.y);
        ctx.beginPath(); ctx.arc(ax, ay, layer.radius ?? 3, 0, TAU); ctx.fill();
      }
    } else if (layer.kind === "cones") {
      const track = run.scene.get(layer.topic);
      if (!track?.t.length) continue;
      // Use the fullest map seen so far, so cones don't blink out late in a run.
      const i = track.indexAt(t);
      const item = track.items[track.best ? track.best[i] : i];
      for (const c of item.cubes) {
        const [ax, ay] = proj(c.x, c.y);
        const r = Math.max(5, 0.2 * sc);
        ctx.fillStyle = "#dedee4";
        ctx.beginPath(); ctx.arc(ax + 2, ay + 3, r, 0, TAU); ctx.fill();
        const col = coneColour(c.color, theme);
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(ax, ay, r, 0, TAU); ctx.fill();
      }
    } else if (layer.kind === "target") {
      const m = run.scene.get(layer.topic)?.at(t, layer.maxAge ?? 0.5);
      const p = m?.cubes?.[0];
      if (!p) continue;
      const [ax, ay] = proj(p.x, p.y);
      ctx.strokeStyle = layer.colour; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ax, ay, layer.radius ?? 7, 0, TAU); ctx.stroke();
    }
  }

  // The car, drawn to its real size (an ADS-DV is 1.8 m by 1.2 m).
  if (cfg.car !== false) {
    const L = 1.8 * sc, Wd = 1.2 * sc;
    rr(ctx, px - Wd / 2 + 3, py - L / 2 + 4, Wd, L, 0.25 * Wd, "#d7d7de");
    ctx.fillStyle = "#27272a";
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const wx = px + sx * (Wd / 2 + 0.02 * sc), wy = py + sy * L * 0.3;
      rr(ctx, wx - 0.13 * sc, wy - 0.22 * sc, 0.26 * sc, 0.44 * sc, 0.05 * sc, "#27272a");
    }
    rr(ctx, px - Wd / 2, py - L / 2, Wd, L, 0.25 * Wd, theme.red);
    ctx.fillStyle = "#b91c1c";
    ctx.beginPath();
    ctx.moveTo(px, py - L / 2 - 0.35 * sc);
    ctx.lineTo(px - Wd * 0.28, py - L / 2 + 0.1 * sc);
    ctx.lineTo(px + Wd * 0.28, py - L / 2 + 0.1 * sc);
    ctx.closePath(); ctx.fill();
    rr(ctx, px - Wd * 0.22, py - L * 0.05, Wd * 0.44, L * 0.27, 0.08 * sc, "#18181b");
  }
  ctx.restore();

  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, theme.radius, null, theme.border);
  if (cfg.label) pill(ctx, x + 16, y + 16, cfg.label, theme);

  if (cfg.legend) {
    let lx = x + 18;
    const ly = y + h - 30;
    ctx.font = f(theme, 500, 13);
    for (const item of cfg.legend) {
      ctx.fillStyle = item.colour;
      ctx.beginPath(); ctx.arc(lx + 5, ly + 5, 5.5, 0, TAU); ctx.fill();
      text(ctx, item.label, lx + 16, ly - 2, { font: f(theme, 500, 13), fill: theme.muted });
      lx += 16 + ctx.measureText(item.label).width + 18;
    }
  }
}

/** Speed, as a half-circle dial with the number beside it. */
function dial(ctx, box, cfg, env) {
  const { x, y, w, h } = box;
  const { run, t, theme } = env;
  const v = run.valueAt(cfg.source, t) * (cfg.multiply ?? 1);
  const max = cfg.max ?? 6;
  const S = cfg.scale ?? 1;
  rr(ctx, x, y, w, h, theme.radius, theme.card);
  text(ctx, cfg.label ?? "", x + 20 * S, y + 14 * S, { font: f(theme, 500, 14 * S), fill: theme.muted });

  const rg = 92 * S;
  const cxg = x + w - (rg + 26 * S), cyg = y + h - 18 * S;
  ctx.lineCap = "butt";
  ctx.beginPath(); ctx.arc(cxg, cyg, rg - 6 * S, Math.PI, TAU); ctx.strokeStyle = "#d4d4d8"; ctx.lineWidth = 12 * S; ctx.stroke();
  const frac = Math.max(0, Math.min(1, v / max));
  ctx.beginPath(); ctx.arc(cxg, cyg, rg - 6 * S, Math.PI, Math.PI + Math.PI * frac); ctx.strokeStyle = cfg.fill ?? theme.blue; ctx.lineWidth = 12 * S; ctx.stroke();

  const steps = cfg.ticks ?? Math.round(max);
  for (let k = 0; k <= steps; k++) {
    const ang = Math.PI + Math.PI * (k / steps);
    const c = Math.cos(ang), s = Math.sin(ang);
    ctx.beginPath(); ctx.moveTo(cxg + (rg - 18 * S) * c, cyg + (rg - 18 * S) * s);
    ctx.lineTo(cxg + (rg - 26 * S) * c, cyg + (rg - 26 * S) * s);
    ctx.strokeStyle = theme.faint; ctx.lineWidth = 2 * S; ctx.stroke();
    const label = String(Math.round((max * k) / steps));
    text(ctx, label, cxg + (rg - 40 * S) * c, cyg + (rg - 40 * S) * s, { font: f(theme, 400, 12 * S), fill: theme.faint, align: "center", baseline: "middle" });
  }
  const ang = Math.PI + Math.PI * frac;
  ctx.beginPath(); ctx.moveTo(cxg, cyg); ctx.lineTo(cxg + (rg - 8 * S) * Math.cos(ang), cyg + (rg - 8 * S) * Math.sin(ang));
  ctx.strokeStyle = theme.ink; ctx.lineWidth = 4 * S; ctx.stroke();
  ctx.beginPath(); ctx.arc(cxg, cyg, 7 * S, 0, TAU); ctx.fillStyle = theme.ink; ctx.fill();

  text(ctx, v.toFixed(cfg.decimals ?? 2), x + 20 * S, y + 40 * S, { font: f(theme, 700, 40 * S), fill: cfg.valueColour ?? theme.blue });
  if (cfg.unit) text(ctx, cfg.unit, x + 20 * S, y + 88 * S, { font: f(theme, 500, 18 * S), fill: theme.muted });
}

/**
 * A centred slider, used for steering.
 * `sign` is the whole reason this is a file and not code: the log counts a left turn
 * as positive, and on screen right should be right.
 */
function slider(ctx, box, cfg, env) {
  const { x, y, w, h } = box;
  const { run, t, theme } = env;
  const raw = run.valueAt(cfg.source, t);
  const value = raw * (cfg.sign ?? 1) * (cfg.multiply ?? 1);
  const S = cfg.scale ?? 1;
  const [lo, hi] = cfg.range ?? [-25, 25];
  const span = Math.max(Math.abs(lo), Math.abs(hi));
  const dp = cfg.decimals ?? 1;

  rr(ctx, x, y, w, h, theme.radius, theme.card);
  text(ctx, cfg.label ?? "", x + 20 * S, y + 14 * S, { font: f(theme, 500, 14 * S), fill: theme.muted });

  const ends = cfg.endLabels ?? ["L", "R"];
  const shown = Math.abs(value) < 0.05
    ? `0.0${cfg.unit ?? ""}`
    : `${Math.abs(value).toFixed(dp)}${cfg.unit ?? ""} ${value > 0 ? ends[1] : ends[0]}`;
  text(ctx, shown, x + w - 20 * S, y + 8 * S, { font: f(theme, 700, 40 * S), fill: theme.ink, align: "right" });

  const bx0 = x + 24 * S, bx1 = x + w - 24 * S, by = y + h - 34 * S;
  rr(ctx, bx0, by - 6 * S, bx1 - bx0, 12 * S, 6 * S, "#d4d4d8");
  const mid = (bx0 + bx1) / 2;
  const pos = mid + Math.max(-1, Math.min(1, value / span)) * (bx1 - bx0) / 2;
  rr(ctx, Math.min(mid, pos), by - 6 * S, Math.abs(pos - mid), 12 * S, 6 * S, cfg.fill ?? theme.yellow);

  for (const k of cfg.tickValues ?? [-25, -20, -10, 0, 10, 20, 25]) {
    const tx = mid + (k / span) * (bx1 - bx0) / 2;
    ctx.beginPath(); ctx.moveTo(tx, by + 10 * S); ctx.lineTo(tx, by + 16 * S);
    ctx.strokeStyle = theme.faint; ctx.lineWidth = 2 * S; ctx.stroke();
    if ((cfg.tickLabels ?? [-20, 0, 20]).includes(k)) {
      const label = k === 0 ? `0${cfg.unit ?? ""}` : `${k < 0 ? ends[0] : ends[1]} ${Math.abs(k)}${cfg.unit ?? ""}`;
      text(ctx, label, tx, by + 18 * S, { font: f(theme, 400, 12 * S), fill: theme.faint, align: "center" });
    }
  }
  ctx.beginPath(); ctx.arc(pos, by, 10 * S, 0, TAU);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.strokeStyle = theme.ink; ctx.lineWidth = 3 * S; ctx.stroke();
}

/** A plain number in a card: lap, distance, cone count, latency. */
function stat(ctx, box, cfg, env) {
  const { x, y, w, h } = box;
  const { run, t, theme } = env;
  let v;
  if (cfg.source?.derived === "coneCount") {
    const track = run.scene.get(cfg.source.topic ?? "/graph_slam/landmarks");
    const i = track?.indexAt(t) ?? 0;
    v = track?.t.length ? track.items[track.best ? track.best[i] : i].cubes.length : 0;
  } else {
    v = run.valueAt(cfg.source, t) * (cfg.multiply ?? 1);
  }
  const S = cfg.scale ?? 1;
  const shown = cfg.decimals != null ? v.toFixed(cfg.decimals) : String(Math.round(v));
  rr(ctx, x, y, w, h, theme.radius, theme.card);
  text(ctx, cfg.label ?? "", x + 20 * S, y + 14 * S, { font: f(theme, 500, 14 * S), fill: theme.muted });
  text(ctx, shown, x + 20 * S, y + 38 * S, { font: f(theme, 700, 40 * S), fill: cfg.valueColour ?? theme.ink });
  if (cfg.unit) {
    ctx.font = f(theme, 700, 40 * S);
    text(ctx, cfg.unit, x + 24 * S + ctx.measureText(shown).width, y + 58 * S, { font: f(theme, 500, 18 * S), fill: theme.muted });
  }
}

/** A rolling window of one or more channels. */
function plot(ctx, box, cfg, env) {
  const { x, y, w, h } = box;
  const { run, t, theme } = env;
  const win = cfg.window ?? 20;
  rr(ctx, x, y, w, h, theme.radius, "#ffffff", theme.border);
  text(ctx, cfg.label ?? "", x + 20, y + 12, { font: f(theme, 500, 14), fill: theme.muted });

  const series = (cfg.lines ?? []).map((l) => ({
    ...l,
    data: l.source?.field && run.tf.get(l.source.topic)
      ? run.tf.get(l.source.topic)[l.source.field]
      : run.scalar(l.source?.topic),
  })).filter((l) => l.data?.length);
  if (!series.length) return;

  // A fixed scale over the whole clip, so the lines don't rescale as it plays.
  let lo = Infinity, hi = -Infinity;
  const { start, end } = run.span;
  for (const s of series) {
    const [a, b] = s.data.range(start, end);
    if (a < lo) lo = a; if (b > hi) hi = b;
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const pad = (hi - lo) * 0.1 || 1;
  lo -= pad; hi += pad;

  let legendX = x + w - 20;
  ctx.font = f(theme, 500, 13);
  for (const s of [...series].reverse()) {
    const tw = ctx.measureText(s.label).width;
    legendX -= tw;
    text(ctx, s.label, legendX, y + 12, { font: f(theme, 500, 13), fill: theme.muted });
    legendX -= 22;
    ctx.beginPath(); ctx.moveTo(legendX, y + 22); ctx.lineTo(legendX + 14, y + 22);
    ctx.strokeStyle = s.colour; ctx.lineWidth = 3; ctx.stroke();
    legendX -= 14;
  }

  const L = x + 56, R = x + w - 20, T = y + 42, B = y + h - 26;
  const ta = t - win, tb = t;
  const sy = (v) => B - ((v - lo) / (hi - lo)) * (B - T);

  for (const v of niceTicks(lo, hi)) {
    const yy = sy(v);
    ctx.strokeStyle = theme.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(R, yy); ctx.stroke();
    text(ctx, String(v), L - 8, yy, { font: f(theme, 400, 12), fill: theme.faint, align: "right", baseline: "middle" });
  }
  const d0 = run.meta.driveStart ?? run.span.start;
  for (let s = Math.ceil(ta - d0); s <= tb - d0; s++) {
    if (s % 5) continue;
    const xx = L + ((s + d0 - ta) / win) * (R - L);
    ctx.strokeStyle = theme.grid;
    ctx.beginPath(); ctx.moveTo(xx, T); ctx.lineTo(xx, B); ctx.stroke();
    text(ctx, `${s}s`, xx, B + 6, { font: f(theme, 400, 12), fill: theme.faint, align: "center" });
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, R - L, B - T); ctx.clip();
  for (const s of series) {
    const { t: ts, v: vs } = s.data.window(ta, tb);
    if (ts.length < 2) continue;
    ctx.beginPath();
    for (let i = 0; i < ts.length; i++) {
      const xx = L + ((ts[i] - ta) / win) * (R - L);
      i ? ctx.lineTo(xx, sy(vs[i])) : ctx.moveTo(xx, sy(vs[i]));
    }
    ctx.strokeStyle = s.colour; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.stroke();
  }
  ctx.restore();
}

/** The title bar. */
function header(ctx, box, cfg, env) {
  const { x, y } = box;
  const { theme, title, subtitle } = env;
  let cx = x;
  ctx.font = f(theme, 700, cfg.size ?? 40);
  text(ctx, "TBReAI", cx, y, { font: f(theme, 700, cfg.size ?? 40), fill: theme.blue });
  cx += ctx.measureText("TBReAI ").width;
  const mainTitle = cfg.title ?? title ?? "";
  text(ctx, mainTitle, cx, y, { font: f(theme, 700, cfg.size ?? 40), fill: theme.ink });
  cx += ctx.measureText(mainTitle + "  ").width;
  if (cfg.tag) {
    ctx.font = f(theme, 500, 15);
    const tw = ctx.measureText(cfg.tag).width + 28;
    rr(ctx, cx, y + 10, tw, 32, 16, theme.orange);
    text(ctx, cfg.tag, cx + 14, y + 15, { font: f(theme, 500, 15), fill: "#ffffff" });
  }
  if (cfg.showSubtitle !== false && (cfg.subtitle ?? subtitle)) {
    text(ctx, cfg.subtitle ?? subtitle, box.x + box.w, y + 12, { font: f(theme, 500, 22), fill: theme.muted, align: "right" });
  }
}

/** How far through the clip we are. */
function progress(ctx, box, cfg, env) {
  const { x, y, w, h } = box;
  const { theme, clip, t } = env;
  const frac = clip ? Math.max(0, Math.min(1, (t - clip.start) / (clip.end - clip.start || 1))) : 0;
  rr(ctx, x, y, w, h, h / 2, theme.border);
  rr(ctx, x, y, Math.max(4, frac * w), h, h / 2, cfg.fill ?? theme.yellow);
}

/** Free text, for captions on the social template. */
function label(ctx, box, cfg, env) {
  const { theme } = env;
  text(ctx, cfg.text ?? "", box.x + (cfg.align === "center" ? box.w / 2 : 0), box.y, {
    font: f(theme, cfg.weight ?? 500, cfg.size ?? 20),
    fill: cfg.colour ?? theme.ink,
    align: cfg.align ?? "left",
  });
}

export const PANELS = { camera, map, dial, slider, stat, plot, header, progress, label };
