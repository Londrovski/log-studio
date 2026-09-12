// The app: pick a folder, browse runs, watch one, mark a clip, render it.

import { loadRun } from "./mcap/run.js";
import { Renderer } from "./render/engine.js";
import { listTemplates, loadTemplate, config } from "./templates.js";
import { decodeFrame } from "./export/encode.js";
import { putJob, newId, toJobFile } from "./jobs.js";

const $ = (id) => document.getElementById(id);
const state = {
  dir: null, files: [], run: null, renderer: null, templateId: "showcase",
  t: 0, playing: false, rate: 1, clip: null, batch: [], current: null,
};

// ---- run names ------------------------------------------------------------
// Logs are named 2026-07-18_13-53-04_Trackdrive_FINISHED_drv01m35s.mcap, which tells us
// nearly everything without opening the file.
function describe(path, size) {
  const base = path.split("/").pop().replace(/\.mcap$/i, "");
  const m = base.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_([A-Za-z]+)_([A-Za-z_]+?)(?:_drv(\d+)m(\d+)s)?$/);
  if (!m) return { path, size, title: base, sub: "", mission: "", outcome: "", when: 0 };
  const [, date, hh, mm, ss, mission, outcome, dm, ds] = m;
  const drove = dm ? Number(dm) * 60 + Number(ds) : null;
  return {
    path, size, mission, outcome,
    title: `${mission} · ${hh}:${mm}`,
    sub: `${date}${drove != null ? ` · drove ${dm}m ${ds}s` : ""}`,
    when: Date.parse(`${date}T${hh}:${mm}:${ss}`),
  };
}

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
  const missions = [...new Set(state.files.map((f) => f.mission).filter(Boolean))].sort();
  $("mission").innerHTML = `<option value="">All missions</option>` + missions.map((m) => `<option>${m}</option>`).join("");
  $("folderNote").textContent = state.files.length
    ? `${dir.name} — ${state.files.length} runs. Nothing leaves this machine.`
    : `No .mcap files under ${dir.name}. Pick the folder that holds Sorted and Raw.`;
  drawList();
}

function drawList() {
  const want = $("mission").value;
  const list = state.files.filter((f) => !want || f.mission === want);
  $("runs").innerHTML = list.map((f) => {
    const cls = f.outcome === "FINISHED" ? "fin" : f.outcome === "EBRAKE" ? "ebrake" : "other";
    const on = state.current?.path === f.path ? " on" : "";
    return `<div class="run${on}" data-path="${f.path}">
      <input type="checkbox" data-batch="${f.path}" ${state.batch.some((b) => b.path === f.path) ? "checked" : ""}>
      <div><div class="t">${f.title}</div><div class="s">${f.sub}</div></div>
      <div class="b"><span class="tag ${cls}">${f.outcome || "—"}</span><br>${fmtSize(f.size)}</div>
    </div>`;
  }).join("") || `<div class="pad hint">Nothing matches that filter.</div>`;

  $("runs").querySelectorAll(".run").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.matches("input")) return;
      openRun(state.files.find((f) => f.path === el.dataset.path));
    };
  });
  $("runs").querySelectorAll("input[data-batch]").forEach((el) => {
    el.onchange = () => {
      const f = state.files.find((x) => x.path === el.dataset.batch);
      if (el.checked) state.batch.push(f);
      else state.batch = state.batch.filter((b) => b.path !== f.path);
      $("openBatch").textContent = `Batch (${state.batch.length})`;
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
  $("folderNote").textContent = `Opening ${entry.title}…`;
  const file = await entry.handle.getFile();
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
  $("folderNote").textContent = `${state.dir?.name ?? ""} — ${state.files.length} runs.`;
  const { start, end } = state.run.span;
  state.t = state.run.meta.driveStart ?? start;
  state.clip = null;
  $("transport").hidden = false;
  $("tTitle").textContent = `${entry.title} · ${entry.sub}`;
  $("tEnd").textContent = fmtTime(end - start);
  markDrive();
  await tick(true);
}

function markDrive() {
  const { start, end } = state.run.span;
  const d = state.run.meta.driveStart ?? start;
  const left = ((d - start) / (end - start)) * 100;
  $("markDrive").style.left = `${left}%`;
  $("markDrive").style.width = `${100 - left}%`;
  drawSel();
}

function drawSel() {
  const { start, end } = state.run.span;
  const el = $("markSel");
  if (!state.clip) { el.style.width = "0"; $("clipNote").textContent = "Whole run"; return; }
  const a = ((state.clip.start - start) / (end - start)) * 100;
  const b = ((state.clip.end - start) / (end - start)) * 100;
  el.style.left = `${a}%`; el.style.width = `${Math.max(0, b - a)}%`;
  const len = state.clip.end - state.clip.start;
  const speed = Number($("renderSpeed").value);
  $("clipNote").textContent = `Clip ${fmtTime(len)} → ${fmtTime(len / speed)} at ${speed}×`;
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
async function tick(force = false) {
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
function clipNow() {
  const { start, end } = state.run.span;
  return state.clip ?? { start, end };
}
function outName(entry, tpl, clip) {
  const base = entry.path.split("/").pop().replace(/\.mcap$/i, "");
  const s = (x) => fmtTime(x - state.run.span.start).replace(":", "-").replace(".", "-");
  return `${base}_${tpl}_${s(clip.start)}_${s(clip.end)}.mp4`;
}
async function makeJob(entry) {
  const clip = clipNow();
  return {
    id: newId(), name: entry.path, handle: entry.handle,
    template: state.templateId, clip,
    speed: Number($("renderSpeed").value),
    scale: Number($("renderScale").value),
    quality: $("renderQuality").value,
    fps: 30,
    outName: outName(entry, state.templateId, clip),
    status: "queued",
  };
}
async function renderNow() {
  if (!state.run || !state.current) return;
  const job = await makeJob(state.current);
  await putJob({ ...job, jobs: [job] });
  window.open(`render.html#${job.id}`, "_blank", "noopener");
}
async function renderBatch() {
  if (!state.batch.length) return;
  const jobs = [];
  for (const entry of state.batch) {
    jobs.push({
      id: newId(), name: entry.path, handle: entry.handle,
      template: state.templateId, clip: null,     // whole run unless the app had it open
      speed: Number($("renderSpeed").value), scale: Number($("renderScale").value),
      quality: $("renderQuality").value, fps: 30,
      outName: `${entry.path.split("/").pop().replace(/\.mcap$/i, "")}_${state.templateId}.mp4`,
    });
  }
  const id = newId();
  await putJob({ id, jobs });
  window.open(`render.html#${id}`, "_blank", "noopener");
}
function saveJobFile() {
  const jobs = state.batch.length
    ? state.batch.map((e) => ({ name: e.path, template: state.templateId, clip: { start: 0, end: 0 }, speed: 1, fps: 30, quality: $("renderQuality").value, scale: 1, outName: `${e.path.split("/").pop()}.mp4` }))
    : [{ name: state.current.path, template: state.templateId, clip: clipNow(), speed: Number($("renderSpeed").value), fps: 30, quality: $("renderQuality").value, scale: Number($("renderScale").value), outName: outName(state.current, state.templateId, clipNow()) }];
  const blob = new Blob([JSON.stringify(toJobFile(jobs), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "render-jobs.json"; a.click();
}

// ---- wiring ---------------------------------------------------------------
let seeking = false;
$("pick").onclick = chooseFolder;
$("pickFile").onclick = () => $("fileInput").click();
$("fileInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const entry = { ...describe(file.name, file.size), handle: { getFile: async () => file } };
  state.files = [entry]; drawList(); openRun(entry);
};
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
  const { end } = state.run.span;
  state.clip = { start: state.t, end: state.clip?.end ?? end };
  if (state.clip.end <= state.clip.start) state.clip.end = end;
  drawSel();
};
$("setOut").onclick = () => {
  const { start } = state.run.span;
  state.clip = { start: state.clip?.start ?? start, end: state.t };
  if (state.clip.end <= state.clip.start) state.clip.start = start;
  drawSel();
};
$("clearSel").onclick = () => { state.clip = null; drawSel(); };
$("renderSpeed").onchange = drawSel;
$("render").onclick = renderNow;
$("queue").onclick = () => {
  if (!state.current) return;
  if (!state.batch.some((b) => b.path === state.current.path)) state.batch.push(state.current);
  $("openBatch").textContent = `Batch (${state.batch.length})`;
  drawList();
};
$("openBatch").onclick = () => {
  const el = $("jobs");
  el.classList.toggle("on");
  el.innerHTML = state.batch.length
    ? `<div class="row spread"><span>${state.batch.length} runs queued, whole run each, ${state.templateId} template.</span>
        <span class="row"><button id="runBatch">Render all</button><button class="ghost" id="saveJobs">Save job file</button><button class="quiet" id="clearBatch">Clear</button></span></div>`
    : `<span>Tick runs in the list, or use “Add to batch”, then render them all in one go or save a job file for a Jetson to chew through overnight.</span>`;
  if (state.batch.length) {
    $("runBatch").onclick = renderBatch;
    $("saveJobs").onclick = saveJobFile;
    $("clearBatch").onclick = () => { state.batch = []; $("openBatch").textContent = "Batch (0)"; drawList(); el.classList.remove("on"); };
  }
};
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,select")) return;
  if (e.code === "Space") { e.preventDefault(); state.playing ? stop() : play(); }
  if (e.key === "i") $("setIn").click();
  if (e.key === "o") $("setOut").click();
  if (e.key === "ArrowLeft") { stop(); state.t -= e.shiftKey ? 1 : 1 / 30; tick(); }
  if (e.key === "ArrowRight") { stop(); state.t += e.shiftKey ? 1 : 1 / 30; tick(); }
});

(async () => {
  const cfg = await config();
  $("ver").textContent = cfg.version ?? "";
  let templates = [];
  try { templates = await listTemplates(); } catch { templates = [{ id: "showcase", name: "Showcase 16:9" }]; }
  $("template").innerHTML = templates.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  $("template").onchange = async () => {
    state.templateId = $("template").value;
    state.renderer = null;
    await tick(true);
  };
  await document.fonts.ready;
})();
