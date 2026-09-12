// The app: pick a folder, browse runs, watch one, mark the part worth showing, render it.

import { loadRun } from "./mcap/run.js";
import { Renderer } from "./render/engine.js";
import {
  listTemplates, loadTemplate, config,
  savedToken, saveToken, tokenInUse, checkToken, gitlabStatus,
} from "./templates.js";
import { decodeFrame } from "./export/encode.js";
import { putJob, newId, toJobFile } from "./jobs.js";

const $ = (id) => document.getElementById(id);
const state = {
  dir: null, files: [], run: null, renderer: null, templateId: "showcase",
  t: 0, playing: false, rate: 1, clip: null, batch: [], current: null,
};

// ---- names and numbers ----------------------------------------------------
// Logs are named 2026-07-18_13-53-04_Trackdrive_FINISHED_drv01m35s.mcap, which tells us
// nearly everything without opening the file.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function describe(path, size) {
  const base = path.split("/").pop().replace(/\.mcap$/i, "");
  const folder = path.includes("/") ? path.split("/")[0] : "";
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_([A-Za-z]+)_([A-Za-z_]+?)(?:_drv(\d+)m(\d+)s)?$/);
  if (!m) return { path, size, folder, title: base, sub: "", mission: "", outcome: "", when: 0, drove: null };
  const [, yyyy, mo, dd, hh, mi, ss, mission, outcome, dm, ds] = m;
  const drove = dm ? Number(dm) * 60 + Number(ds) : null;
  return {
    path, size, folder, mission, outcome, drove,
    title: `${mission}${drove != null ? ` · ${fmtDur(drove)}` : ""}`,
    sub: `${Number(dd)} ${MONTHS[Number(mo) - 1]} ${yyyy} · ${hh}:${mi}`,
    when: Date.parse(`${yyyy}-${mo}-${dd}T${hh}:${mi}:${ss}`),
  };
}

const fmtDur = (s) => {
  const m = Math.floor(s / 60), r = Math.round(s - m * 60);
  return m ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
};
/** A run is either a handle from the folder picker or a File picked on its own. */
const fileOf = (entry) => (entry.file ? Promise.resolve(entry.file) : entry.handle.getFile());

const fmtSize = (b) => (b > 1 << 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`);
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return "0:00.0";
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
};

// ---- folder ---------------------------------------------------------------
async function scan(dir, prefix = "", depth = 0, out = []) {
  if (depth > 4) return out;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file") {
      if (name.toLowerCase().endsWith(".mcap")) out.push({ path: prefix + name, handle });
    } else if (handle.kind === "directory" && !name.startsWith(".")) {
      await scan(handle, `${prefix}${name}/`, depth + 1, out);
    }
    if (out.length > 2000) break;
  }
  return out;
}

async function chooseFolder() {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: "tbre-logs", mode: "read" }); }
  catch { return; }
  state.dir = dir;
  $("folderNote").textContent = `Scanning ${dir.name}…`;
  const found = await scan(dir);
  state.files = [];
  for (const f of found) {
    const file = await f.handle.getFile();
    state.files.push({ ...describe(f.path, file.size), handle: f.handle });
  }
  state.files.sort((a, b) => b.when - a.when || a.path.localeCompare(b.path));

  // Sub-folders become a filter, defaulting to Sorted when there is one, since that's
  // where the runs worth watching live.
  const folders = [...new Set(state.files.map((f) => f.folder).filter(Boolean))].sort();
  $("folder").innerHTML = `<option value="">All folders</option>` +
    folders.map((f) => `<option>${f}</option>`).join("");
  const sorted = folders.find((f) => /^sorted$/i.test(f));
  if (sorted) $("folder").value = sorted;

  const missions = [...new Set(state.files.map((f) => f.mission).filter(Boolean))].sort();
  $("mission").innerHTML = `<option value="">All missions</option>` + missions.map((m) => `<option>${m}</option>`).join("");

  drawList();
}

function visible() {
  const folder = $("folder").value, mission = $("mission").value;
  return state.files.filter((f) => (!folder || f.folder === folder) && (!mission || f.mission === mission));
}

function drawList() {
  const list = visible();
  const runs = $("runs");
  runs.classList.toggle("batching", state.batch.length > 0);
  runs.innerHTML = list.map((f) => {
    const cls = f.outcome === "FINISHED" ? "fin" : f.outcome === "EBRAKE" ? "ebrake" : "other";
    const on = state.current?.path === f.path ? " on" : "";
    return `<div class="run${on}" data-path="${f.path}">
      <input type="checkbox" data-batch="${f.path}" ${state.batch.some((b) => b.entry.path === f.path) ? "checked" : ""}>
      <div><div class="t">${f.title}</div><div class="s">${f.sub}</div></div>
      <div class="b"><span class="tag ${cls}">${f.outcome || "—"}</span><br>${fmtSize(f.size)}</div>
      <button class="go">View</button>
    </div>`;
  }).join("") || `<div class="pad hint">Nothing matches those filters.</div>`;

  if (state.dir) {
    $("folderNote").textContent = state.files.length
      ? `${state.dir.name} — ${list.length} of ${state.files.length} runs shown. Nothing leaves this machine.`
      : `No .mcap files under ${state.dir.name}. Pick the folder that holds Sorted and Raw.`;
  }

  runs.querySelectorAll(".run").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.matches("input")) return;
      openRun(state.files.find((f) => f.path === el.dataset.path));
    };
  });
  runs.querySelectorAll("input[data-batch]").forEach((el) => {
    el.onchange = () => {
      const f = state.files.find((x) => x.path === el.dataset.batch);
      if (el.checked) addToBatch(f, null);
      else state.batch = state.batch.filter((b) => b.entry.path !== f.path);
      refreshBatch();
    };
  });
}

// ---- opening a run --------------------------------------------------------
async function openRun(entry) {
  if (!entry) return;
  stop();
  state.current = entry;
  drawList();
  $("empty").hidden = true;
  const file = await fileOf(entry);
  try {
    state.run = await loadRun(file, {
      onProgress: (p, what) => {
        $("progress").style.width = `${Math.round(p * 100)}%`;
        $("folderNote").textContent = `${what} ${entry.title} — ${Math.round(p * 100)}%`;
      },
    });
  } catch (err) {
    $("folderNote").textContent = `Could not open that run: ${err.message}`;
    $("progress").style.width = "0";
    return;
  }
  $("progress").style.width = "0";
  if (!state.dir) $("folderNote").textContent = `${entry.title} · ${entry.sub}`;
  drawList();
  const { start, end } = state.run.span;
  state.t = state.run.meta.driveStart ?? start;
  state.clip = null;
  $("transport").hidden = false;
  $("tTitle").textContent = `${entry.title} · ${entry.sub}`;
  $("tEnd").textContent = fmtTime(end - start);
  drawMarkers();
  await tick();
}

/** The green band, the render band, and the little labels above them. */
function drawMarkers() {
  const { start, end } = state.run.span;
  const span = end - start || 1;
  const pct = (t) => Math.max(0, Math.min(100, ((t - start) / span) * 100));

  const drive = state.run.meta.driveStart ?? start;
  $("markDrive").style.left = `${pct(drive)}%`;
  $("markDrive").style.width = `${100 - pct(drive)}%`;

  const sel = $("markSel");
  const flags = [`<span class="fdrive" style="left:${pct(drive)}%">car driving from here</span>`];
  if (state.clip) {
    sel.style.left = `${pct(state.clip.start)}%`;
    sel.style.width = `${Math.max(0, pct(state.clip.end) - pct(state.clip.start))}%`;
    flags.push(`<span class="fin" style="left:${pct(state.clip.start)}%">render begins</span>`);
    flags.push(`<span class="fout" style="left:${pct(state.clip.end)}%">render ends</span>`);
  } else {
    sel.style.width = "0";
  }
  $("flags").innerHTML = flags.join("");

  const speed = Number($("renderSpeed").value);
  if (state.clip) {
    const len = state.clip.end - state.clip.start;
    $("clipNote").textContent =
      `${fmtTime(state.clip.start - start)} → ${fmtTime(state.clip.end - start)} · ${len.toFixed(1)}s becomes ${(len / speed).toFixed(1)}s at ${speed}×`;
  } else {
    $("clipNote").textContent = `the whole run · ${span.toFixed(1)}s becomes ${(span / speed).toFixed(1)}s at ${speed}×`;
  }
}

// ---- drawing --------------------------------------------------------------
async function ensureTemplate() {
  if (state.renderer?.id === state.templateId) return state.renderer;
  const tpl = await loadTemplate(state.templateId);
  state.renderer = new Renderer(tpl);
  state.renderer.id = state.templateId;
  const c = $("view");
  c.width = state.renderer.width; c.height = state.renderer.height;
  return state.renderer;
}

let drawing = false;
async function tick() {
  if (!state.run || drawing) return;
  drawing = true;
  try {
    const r = await ensureTemplate();
    if (r.needsCamera() && state.run.camera) {
      await state.run.camera.ensure(state.t);
      await decodeFrame(state.run.camera.frameAt(state.t));
    }
    const ctx = $("view").getContext("2d", { alpha: false });
    const { start, end } = state.run.span;
    r.draw(ctx, state.run, state.t, { clip: state.clip ?? { start, end } });
    $("tNow").textContent = fmtTime(state.t - start);
    if (!seeking) $("seek").value = String(Math.round(((state.t - start) / (end - start)) * 1000));
  } finally { drawing = false; }
}

let last = 0;
function loop(now) {
  if (!state.playing) return;
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  const { start, end } = state.run.span;
  const a = state.clip?.start ?? start, b = state.clip?.end ?? end;
  state.t += dt * state.rate;
  if (state.t > b) state.t = a;
  tick();
  requestAnimationFrame(loop);
}
function play() { if (!state.run) return; state.playing = true; last = 0; $("play").textContent = "Pause"; requestAnimationFrame(loop); }
function stop() { state.playing = false; $("play").textContent = "Play"; }

// ---- rendering ------------------------------------------------------------
const clipNow = () => state.clip ?? { ...state.run.span };
const settings = () => ({
  template: state.templateId,
  speed: Number($("renderSpeed").value),
  scale: Number($("renderScale").value),
  quality: $("renderQuality").value,
  fps: 30,
});

function outName(entry, tpl, clip, runStart) {
  const base = entry.path.split("/").pop().replace(/\.mcap$/i, "");
  const s = (x) => fmtTime(x - runStart).replace(":", "-").replace(".", "-");
  return clip ? `${base}_${tpl}_${s(clip.start)}_${s(clip.end)}.mp4` : `${base}_${tpl}.mp4`;
}

async function renderNow() {
  if (!state.run || !state.current) return;
  const job = {
    id: newId(), name: state.current.path,
    handle: state.current.handle ?? null, file: state.current.file ?? null,
    clip: clipNow(), ...settings(),
    outName: outName(state.current, state.templateId, state.clip, state.run.span.start),
  };
  try {
    await putJob({ id: job.id, jobs: [job] });
  } catch (err) {
    $("folderNote").textContent = `Could not start the render: ${err.message}`;
    return;
  }
  const tab = window.open(`render.html?job=${job.id}`, "_blank");
  if (!tab) $("folderNote").textContent = "The render tab was blocked — allow pop-ups for this site and try again.";
}

function addToBatch(entry, clip) {
  if (!entry) return;
  state.batch = state.batch.filter((b) => b.entry.path !== entry.path);
  state.batch.push({ entry, clip, ...settings() });
}

function refreshBatch() {
  const n = state.batch.length;
  $("openBatch").hidden = n === 0;
  $("openBatch").textContent = `Batch (${n})`;
  drawList();
  if (n === 0) { $("jobs").classList.remove("on"); return; }
  const el = $("jobs");
  el.innerHTML = `<table><thead><tr><th>Run</th><th style="width:150px">Part rendered</th><th style="width:110px">Template</th><th style="width:70px">Speed</th><th style="width:40px"></th></tr></thead><tbody>
    ${state.batch.map((b, i) => `<tr>
      <td>${b.entry.title} · ${b.entry.sub}</td>
      <td>${b.clip ? `${fmtTime(b.clip.start - b.clip.runStart)} → ${fmtTime(b.clip.end - b.clip.runStart)}` : "whole run"}</td>
      <td>${b.template}</td><td>${b.speed}×</td>
      <td><button class="drop" data-drop="${i}">×</button></td></tr>`).join("")}
  </tbody></table>
  <div class="row"><button id="runBatch">Render all ${n}</button>
    <button class="ghost" id="saveJobs">Save job file</button>
    <button class="quiet" id="clearBatch">Clear the batch</button></div>`;
  el.querySelectorAll("[data-drop]").forEach((b) => {
    b.onclick = () => { state.batch.splice(Number(b.dataset.drop), 1); refreshBatch(); };
  });
  $("runBatch").onclick = renderBatch;
  $("saveJobs").onclick = saveJobFile;
  $("clearBatch").onclick = () => { state.batch = []; refreshBatch(); };
}

async function renderBatch() {
  if (!state.batch.length) return;
  const jobs = state.batch.map((b) => ({
    id: newId(), name: b.entry.path,
    handle: b.entry.handle ?? null, file: b.entry.file ?? null,
    clip: b.clip, template: b.template, speed: b.speed, scale: b.scale,
    quality: b.quality, fps: b.fps,
    outName: outName(b.entry, b.template, b.clip, b.clip?.runStart ?? 0),
  }));
  const id = newId();
  try {
    await putJob({ id, jobs });
  } catch (err) {
    $("folderNote").textContent = `Could not start the batch: ${err.message}`;
    return;
  }
  const tab = window.open(`render.html?job=${id}`, "_blank");
  if (!tab) $("folderNote").textContent = "The render tab was blocked — allow pop-ups for this site and try again.";
}

function saveJobFile() {
  const rows = state.batch.length
    ? state.batch.map((b) => ({
        name: b.entry.path, template: b.template,
        clip: b.clip ?? { start: 0, end: 0 }, speed: b.speed, fps: b.fps,
        quality: b.quality, scale: b.scale,
        outName: outName(b.entry, b.template, b.clip, b.clip?.runStart ?? 0),
      }))
    : [{
        name: state.current.path, clip: clipNow(), ...settings(),
        outName: outName(state.current, state.templateId, state.clip, state.run.span.start),
      }];
  const blob = new Blob([JSON.stringify(toJobFile(rows), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "render-jobs.json"; a.click();
}

// ---- settings and the GitLab banner ---------------------------------------
async function showTokenSource() {
  const { source } = await tokenInUse();
  $("tokenSource").textContent = `Currently using the token ${source}.`;
}

async function showBanner() {
  // Only worth saying when a token exists and has stopped working. With no token at
  // all, using the built-in templates is the normal, quiet state.
  const { token } = await tokenInUse();
  if (!gitlabStatus.error || !token) { $("banner").hidden = true; return; }
  $("banner").hidden = false;
  $("banner").innerHTML = `<b>Using the templates built into the app.</b>
    GitLab could not be read — ${gitlabStatus.error}. Editing a template in GitLab will not show up here until this is fixed.
    <button id="fixToken">Fix the token</button>`;
  $("fixToken").onclick = () => $("settings").showModal();
}

async function wireSettings() {
  $("openSettings").onclick = async () => {
    $("tokenInput").value = savedToken();
    $("tokenStatus").className = "status";
    $("tokenStatus").textContent = gitlabStatus.error
      ? `Right now GitLab cannot be read: ${gitlabStatus.error}`
      : "";
    await showTokenSource();
    $("settings").showModal();
  };
  const setStatus = (cls, msg) => { $("tokenStatus").className = `status ${cls}`; $("tokenStatus").textContent = msg; };
  $("testToken").onclick = async () => {
    const token = $("tokenInput").value.trim();
    setStatus("busy", "Asking GitLab…");
    const r = await checkToken(token);
    setStatus(r.ok ? "ok" : "bad", r.ok ? r.message : `No — ${r.message}. Make a project access token on log-studio-assets with read_api, read_repository and read_registry.`);
  };
  $("saveToken").onclick = async () => {
    const token = $("tokenInput").value.trim();
    saveToken(token);
    const r = token ? await checkToken(token) : { ok: false, message: "cleared" };
    if (r.ok) {
      gitlabStatus.error = null;
      setStatus("ok", `${r.message} Saved on this machine — reload to pick up the GitLab templates.`);
    } else {
      setStatus("bad", `Saved, but it still does not work: ${r.message}`);
    }
    await showBanner();
    await showTokenSource();
  };
  $("clearToken").onclick = async () => {
    saveToken(""); $("tokenInput").value = "";
    setStatus("busy", "Cleared. The app will use the token built into it, if there is one.");
    await showTokenSource();
  };
}

// ---- wiring ---------------------------------------------------------------
let seeking = false;
$("pick").onclick = chooseFolder;
$("pickFile").onclick = () => $("fileInput").click();
$("fileInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  // Keep the File itself rather than wrapping it in an object with a method: a render
  // job is handed to another tab through IndexedDB, and a function cannot be stored.
  const entry = { ...describe(file.name, file.size), file };
  state.files = [entry]; drawList(); openRun(entry);
};
$("folder").onchange = drawList;
$("mission").onchange = drawList;
$("play").onclick = () => (state.playing ? stop() : play());
$("rate").onchange = () => { state.rate = Number($("rate").value); };
$("stepBack").onclick = () => { stop(); state.t -= 1 / 30; tick(); };
$("stepFwd").onclick = () => { stop(); state.t += 1 / 30; tick(); };
$("seek").oninput = () => {
  seeking = true;
  const { start, end } = state.run.span;
  state.t = start + (Number($("seek").value) / 1000) * (end - start);
  tick();
};
$("seek").onchange = () => { seeking = false; };
$("setIn").onclick = () => {
  const { start, end } = state.run.span;
  state.clip = { start: state.t, end: state.clip?.end ?? end, runStart: start };
  if (state.clip.end <= state.clip.start) state.clip.end = end;
  drawMarkers();
};
$("setOut").onclick = () => {
  const { start } = state.run.span;
  state.clip = { start: state.clip?.start ?? start, end: state.t, runStart: start };
  if (state.clip.end <= state.clip.start) state.clip.start = start;
  drawMarkers();
};
$("clearSel").onclick = () => { state.clip = null; drawMarkers(); };
$("renderSpeed").onchange = () => drawMarkers();
$("render").onclick = renderNow;
$("queue").onclick = () => {
  if (!state.current) return;
  addToBatch(state.current, state.clip ? { ...state.clip, runStart: state.run.span.start } : null);
  refreshBatch();
  $("jobs").classList.add("on");
};
$("openBatch").onclick = () => $("jobs").classList.toggle("on");
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,select,textarea") || $("settings").open) return;
  if (e.code === "Space") { e.preventDefault(); state.playing ? stop() : play(); }
  if (e.key === "i") $("setIn").click();
  if (e.key === "o") $("setOut").click();
  if (e.key === "ArrowLeft") { stop(); state.t -= e.shiftKey ? 1 : 1 / 30; tick(); }
  if (e.key === "ArrowRight") { stop(); state.t += e.shiftKey ? 1 : 1 / 30; tick(); }
});

(async () => {
  await config();
  await wireSettings();
  let templates = [];
  try { templates = await listTemplates(); } catch { templates = [{ id: "showcase", name: "Showcase 16:9" }]; }
  $("template").innerHTML = templates.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  $("template").onchange = async () => {
    state.templateId = $("template").value;
    state.renderer = null;
    await tick();
  };
  await showBanner();
  await document.fonts.ready;
  // The page checks this. If the module fails to load, nothing is wired and every
  // button silently does nothing, so the page needs to be able to tell.
  window.__logStudioReady = true;
})();
