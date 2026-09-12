// The handover between the app and a render tab.
//
// A render runs in its own tab so that a long export doesn't freeze the window you're
// browsing runs in. Chrome lets a file handle be stored and read by another tab of the
// same site, so the render tab opens the log itself — nothing is copied.

const DB = "tbre-log-studio";
const STORE = "jobs";

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}

export const putJob = (job) => tx("readwrite", (s) => s.put(job));
export const getJob = (id) => tx("readonly", (s) => s.get(id));
export const allJobs = () => tx("readonly", (s) => s.getAll());
export const dropJob = (id) => tx("readwrite", (s) => s.delete(id));

export const newId = () =>
  `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** A job file is plain JSON — the Jetson runner reads exactly this. */
export function toJobFile(jobs) {
  return {
    version: 1,
    created: new Date().toISOString(),
    jobs: jobs.map((j) => ({
      log: j.name,
      template: j.template,
      in: Number(j.clip.start.toFixed(3)),
      out: Number(j.clip.end.toFixed(3)),
      speed: j.speed,
      fps: j.fps,
      quality: j.quality,
      scale: j.scale,
      output: j.outName,
    })),
  };
}
