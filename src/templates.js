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

// A token saved here overrides the one built into the app, so a token that expires can
// be replaced without a redeploy. The permanent fix is still config.json in the repo.
const TOKEN_KEY = "tbre-log-studio.gitlab-token";

export function savedToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function saveToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private window */ }
}
export async function tokenInUse() {
  const cfg = await config();
  const saved = savedToken();
  if (saved) return { token: saved, source: "saved on this machine" };
  if (cfg.gitlab?.token) return { token: cfg.gitlab.token, source: "built into the app" };
  return { token: "", source: "none set" };
}

/** Why GitLab was last unreachable, for the banner. Null while all is well. */
export const gitlabStatus = { error: null, checked: false };

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
  const { token } = await tokenInUse();
  if (!token || !cfg.gitlab?.host) throw new Error("no token set");
  const r = await fetch(gitlabUrl(cfg, path), { headers: { "PRIVATE-TOKEN": token } });
  if (!r.ok) throw new Error(explain(r.status, path));
  return r.json();
}

/** Turn a bare status code into something worth reading. */
function explain(status, path) {
  if (status === 401) return "the token is expired or invalid (401)";
  if (status === 403) return "the token is missing a scope — it needs read_api (403)";
  if (status === 404) return `the token cannot see ${path} (404) — it is probably scoped to a different project`;
  return `GitLab replied ${status}`;
}

/** Check a token without changing anything. Used by the settings sheet. */
export async function checkToken(token) {
  const cfg = await config();
  if (!cfg.gitlab?.host) return { ok: false, message: "no GitLab host configured" };
  if (!token) return { ok: false, message: "no token to check" };
  try {
    const r = await fetch(gitlabUrl(cfg, "manifest.json"), { headers: { "PRIVATE-TOKEN": token } });
    if (!r.ok) return { ok: false, message: explain(r.status, "manifest.json") };
    const m = await r.json();
    const n = (m.templates ?? []).length;
    return { ok: true, message: `Works — ${n} template${n === 1 ? "" : "s"} found in GitLab.` };
  } catch {
    return { ok: false, message: "the browser could not reach gitlab.bath.ac.uk — check you are on a network that can" };
  }
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
    try {
      const m = await fetchGitlab(cfg, "manifest.json");
      gitlabStatus.error = null;
      gitlabStatus.checked = true;
      return m;
    } catch (err) {
      gitlabStatus.error = err.message;
      gitlabStatus.checked = true;
      return fetchBundled("templates/manifest.json");
    }
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
  if (source !== "bundled" && !gitlabStatus.error) {
    try { return await assemble(`templates/${id}`, (p) => fetchGitlab(cfg, p.replace(/^templates\//, ""))); }
    catch (err) {
      gitlabStatus.error = err.message;
      console.info("GitLab templates unavailable, using the bundled copy:", err.message);
    }
  }
  return assemble(`templates/${id}`, fetchBundled);
}
