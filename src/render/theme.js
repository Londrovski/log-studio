// Themes are plain JSON. Anything in a panel file written as "@theme.blue" is looked
// up here, so a colour is changed in one place rather than in every panel.
export const DEFAULT_THEME = {
  font: "Poppins, 'Segoe UI', system-ui, sans-serif",
  background: "#ffffff",
  card: "#f4f4f5",
  border: "#e4e4e7",
  ink: "#18181b",
  muted: "#71717a",
  faint: "#a1a1aa",
  grid: "#ececf0",
  blue: "#105bab",
  orange: "#e6642a",
  yellow: "#ffc423",
  green: "#16a34a",
  red: "#ef4444",
  magenta: "#c026d3",
  cyan: "#22d3ee",
  coneBlue: "#2563eb",
  coneYellow: "#eab308",
  coneOrange: "#e6642a",
  radius: 18,
};

/** Replace every "@theme.x" in a config tree with the theme's value. */
export function resolve(value, theme) {
  if (typeof value === "string" && value.startsWith("@theme.")) {
    const key = value.slice(7);
    return key in theme ? theme[key] : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, theme));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, theme);
    return out;
  }
  return value;
}
