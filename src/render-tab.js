// A render tab. It takes a job out of the handover store, opens the log itself, and
// renders — so the window you're browsing runs in stays responsive.

import { loadRun } from "./mcap/run.js";
import { Renderer } from "./render/engine.js";
import { loadTemplate } from "./templates.js";
import { renderToMp4 } from "./export/encode.js";
import { getJob, dropJob } from "./jobs.js";

const $ = (id) => document.getElementById(id);
const controller = new AbortController();
$("cancel").onclick = () => controller.abort();

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function main() {
  $("sub").textContent = "Reading the render job…";
  const id = location.hash.slice(1);
  const record = await getJob(id);
  if (!record) { $("sub").textContent = "That render job has gone. Start it again from the main window."; return; }
  const jobs = record.jobs ?? [record];
  $("sub").textContent = "Keep this tab open. The main window stays usable while this runs.";

  $("list").innerHTML = jobs.map((j, i) => `
    <div class="job" id="j${i}">
      <div class="row spread"><b>${j.outName}</b><span class="hint" id="s${i}">queued</span></div>
      <div class="track"><i id="p${i}"></i></div>
    </div>`).join("");

  let done = 0;
  for (const [i, job] of jobs.entries()) {
    $(`s${i}`).textContent = "opening the log…";
    $("overall").textContent = `${done} of ${jobs.length} finished`;
    try {
      // A job carries either a handle from the folder picker or the File itself.
      const file = job.file ?? await job.handle.getFile();
      const run = await loadRun(file, {
        onProgress: (p) => { $(`p${i}`).style.width = `${p * 20}%`; },
      });
      const renderer = new Renderer(await loadTemplate(job.template));
      const clip = job.clip ?? run.span;
      const canvas = $("preview");
      canvas.width = renderer.width; canvas.height = renderer.height;
      const ctx = canvas.getContext("2d", { alpha: false });

      const t0 = performance.now();
      const blob = await renderToMp4(renderer, run, {
        clip, speed: job.speed, fps: job.fps, quality: job.quality, scale: job.scale,
        signal: controller.signal,
        onProgress: (p, n, total) => {
          $(`p${i}`).style.width = `${20 + p * 80}%`;
          const elapsed = (performance.now() - t0) / 1000;
          const left = p > 0.02 ? elapsed / p - elapsed : null;
          $(`s${i}`).textContent = `frame ${n} of ${total}${left ? ` · about ${fmt(left)} left` : ""}`;
          // Show what's being rendered, every so often, without slowing it down.
          if (n % 30 === 0) renderer.draw(ctx, run, clip.start + (n / job.fps) * job.speed, { clip });
        },
      });

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = job.outName;
      a.click();
      $(`s${i}`).innerHTML = `<b>done</b> · ${(blob.size / 2 ** 20).toFixed(1)} MB · saved to your downloads`;
      done++;
    } catch (err) {
      $(`s${i}`).textContent = err.name === "AbortError" ? "cancelled" : `failed: ${err.message}`;
      console.error(err);
      if (err.name === "AbortError") break;
    }
  }
  $("overall").textContent = `${done} of ${jobs.length} finished`;
  $("sub").textContent = done === jobs.length
    ? "All done. You can close this tab."
    : "Finished, with some jobs unfinished — see below.";
  await dropJob(id);
}

main().catch((e) => {
  $("sub").textContent = `Something went wrong: ${e.message}`;
  console.error(e);
});
