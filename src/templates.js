// Where templates come from.
//
// Three sources, in the order the app tries them:
//   gitlab  — the live copy in the assets repo, so a pushed change is live immediately
//   bundled — the copy that ships with the app, and the offline fallback
//   local   — a folder you pick, reloaded whenever you save, for actually editing one
//
// A template is a folder: template.json names the panels, each panel is its own file,
// and theme.json holds the colours. Panels are inlined here so the renderer sees one
// plain object.

// Paths are resolved against the app's own folder, not the page that happens to be
// open, so the modules work the same from index.html, render.html or a test page.
const ROOT = new URL("../", import.meta.url);
export const appUrl = (path) => new URL(path, ROOT).href;

let CONFIG = null;

export async function config() {
  if (!CONFIG) {
    CONFIG = await fetch(appUrl("config.json")).then((r) => r.json()).catch(() => ({}));
  }
  return CONFIG;
}

function gitlabUrl(cfg, path) {
  const { host, projectId, ref = "main" } = cfg.gitlab ?? {};
  return `${host}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw?ref=${ref}`;
}

/**
 * GitLab will not let a browser read raw file paths across origins, but its API does,
 * as long as the request carries a token rather than your login cookie. That single
 * fact is why this goes through /api/v4 and why a token exists at all.
 */
async function fetchGitlab(cfg, path) {
  const token = cfg.gitlab?.token;
  if (!token || !cfg.gitlab?.host) throw new Error("no GitLab token configured");
  const r = await fetch(gitlabUrl(cfg, path), { headers: { "PRIVATE-TOKEN": token } });
  if (!r.ok) throw new Error(`GitLab ${r.status} for ${path}`);
  return r.json();
}

async function fetchBundled(path) {
  const r = await fetch(appUrl(path));
  if (!r.ok) throw new Error(`missing ${path}`);
  return r.json();
}

/** Read a template folder through whichever getter is handed in. */
async function assemble(dir, get) {
  const template = await get(`${dir}/template.json`);
  if (typeof template.theme === "string") {
    template.theme = await get(`${dir}/${template.theme}`);
  }
  template.layout = await Promise.all((template.layout ?? []).map(async (entry) => {
    if (typeof entry.panel === "string") entry.panel = await get(`${dir}/${entry.panel}`);
    return entry;
  }));
  return template;
}

export async function listTemplates() {
  const cfg = await config();
  const manifest = await (async () => {
    try { return await fetchGitlab(cfg, "manifest.json"); }
    catch { return fetchBundled("templates/manifest.json"); }
  })();
  return manifest.templates ?? [];
}

export async function loadTemplate(id, { source = "auto", localDir = null } = {}) {
  const cfg = await config();
  if (source === "local" && localDir) {
    return assemble(id, async (path) => {
      const parts = path.split("/");
      let dir = localDir;
      for (const p of parts.slice(1, -1)) dir = await dir.getDirectoryHandle(p);
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      return JSON.parse(await (await fh.getFile()).text());
    });
  }
  if (source !== "bundled") {
    try { return await assemble(`templates/${id}`, (p) => fetchGitlab(cfg, p.replace(/^templates\//, ""))); }
    catch (err) { console.info("GitLab templates unavailable, using the bundled copy:", err.message); }
  }
  return assemble(`templates/${id}`, fetchBundled);
}
