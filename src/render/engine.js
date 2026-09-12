// The renderer: a template in, a drawn frame out.
// The same code draws the live view and every exported frame, so what you watch and
// what you get in the MP4 cannot drift apart.

import { PANELS } from "./panels.js";
import { DEFAULT_THEME, resolve } from "./theme.js";

export class Renderer {
  /** @param template the parsed template.json, with its panels already inlined */
  constructor(template) {
    this.template = template;
    this.theme = { ...DEFAULT_THEME, ...(template.theme ?? {}) };
    this.width = template.canvas?.width ?? 1920;
    this.height = template.canvas?.height ?? 1080;
    this.background = template.canvas?.background ?? this.theme.background;
  }

  /** Which camera frame, if any, this template needs at time t. */
  needsCamera() {
    return (this.template.layout ?? []).some((l) => (l.panel?.type ?? l.type) === "camera");
  }

  draw(ctx, run, t, opts = {}) {
    const { width: W, height: H } = this;
    ctx.save();
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "top";

    const env = {
      run, t, theme: this.theme,
      title: opts.title ?? this.template.title ?? run.meta.title ?? "",
      subtitle: opts.subtitle ?? this.template.subtitle ?? run.meta.subtitle ?? "",
      clip: opts.clip,
    };

    for (const entry of this.template.layout ?? []) {
      const cfg = resolve(entry.panel ?? entry, this.theme);
      const fn = PANELS[cfg.type];
      if (!fn) continue;
      const [x, y, w, h] = entry.area ?? cfg.area ?? [0, 0, W, H];
      ctx.save();
      try {
        fn(ctx, { x, y, w, h }, cfg, env);
      } catch (err) {
        // One broken panel shouldn't blank the whole frame — draw the problem instead.
        ctx.restore(); ctx.save();
        ctx.fillStyle = "#fee2e2"; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#b91c1c"; ctx.font = `500 14px ${this.theme.font}`;
        ctx.fillText(`${cfg.type}: ${err.message}`, x + 12, y + 12);
        console.warn(`panel ${cfg.type} failed`, err);
      }
      ctx.restore();
    }
    ctx.restore();
  }
}
