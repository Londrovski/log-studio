// The whole render path, end to end: open a run, mark a short clip, press Render MP4,
// follow the render tab, and confirm a file actually comes out. This is the test that
// would have caught the render tab doing nothing.
//
//   npm run build && node test/render-flow.mjs dist /path/to/run.mcap
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? "dist";
const types = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
};
const srv = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end("no"); }
  res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8166, r));

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("app: " + e.message));
const show = (k, v) => console.log(k.padEnd(15), v);

await page.goto("http://localhost:8166/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__logStudioReady, null, { timeout: 20000 })
  .then(() => show("app ready", "modules loaded and wired"))
  .catch(() => show("app ready", "NO — main.js never finished; the site is probably unbuilt"));

await page.setInputFiles("#fileInput", process.argv[3]);
await page.waitForFunction(() => !document.getElementById("transport").hidden, null, { timeout: 180000 });
await page.waitForTimeout(1500);

// A three-second clip, so the test is quick but exercises everything.
const seekTo = async (v) => {
  await page.evaluate((n) => { const s = document.getElementById("seek"); s.value = n; s.dispatchEvent(new Event("input")); }, v);
  await page.waitForTimeout(600);
};
await seekTo(500); await page.click("#setIn");
await seekTo(523); await page.click("#setOut");
show("clip marked", await page.evaluate(() => document.getElementById("clipNote").textContent));

const popup = ctx.waitForEvent("page", { timeout: 20000 });
await page.click("#render");
const tab = await popup.catch(() => null);
if (!tab) {
  show("render tab", "NEVER OPENED");
  show("app says", await page.evaluate(() => document.getElementById("folderNote").textContent));
  process.exit(1);
}
tab.on("pageerror", (e) => errs.push("render tab: " + e.message));
show("render tab", "opened");

const dl = tab.waitForEvent("download", { timeout: 300000 }).catch(() => null);
const download = await dl;
if (download) {
  fs.mkdirSync("out", { recursive: true });
  const to = "out/flow-" + download.suggestedFilename();
  await download.saveAs(to);
  show("downloaded", `${download.suggestedFilename()}  ${(fs.statSync(to).size / 1048576).toFixed(2)} MB`);
} else {
  show("downloaded", "NOTHING — the render never finished");
}
show("final status", await tab.evaluate(() => document.getElementById("s0")?.innerText ?? "?"));
show("errors", errs.join(" ~ ") || "none");

await browser.close();
srv.close();
