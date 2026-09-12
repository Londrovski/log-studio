// Drives the built app in headless Chrome against one real log: loads a run, marks a
// render range, and adds it to the batch. Catches the things a unit test cannot —
// wiring that silently does nothing.
//
//   npm run build && node test/ui.mjs dist /path/to/run.mcap
//
// Writes out/ui.png so the layout can be looked at.
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
await new Promise((r) => srv.listen(8155, r));

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts\.g|ERR_/.test(m.text())) errs.push(m.text()); });

await page.goto("http://localhost:8155/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const show = (k, v) => console.log(k.padEnd(16), v);
show("brand", await page.evaluate(() => document.querySelector(".brand").innerText.replace(/\n/g, " ")));
show("banner", await page.evaluate(() => (document.getElementById("banner").hidden ? "hidden" : "shown")));

await page.click("#openSettings");
await page.waitForTimeout(300);
show("settings", await page.evaluate(() => document.getElementById("tokenSource").textContent));
await page.evaluate(() => document.getElementById("settings").close());

await page.setInputFiles("#fileInput", process.argv[3]);
await page.waitForFunction(() => !document.getElementById("transport").hidden, null, { timeout: 180000 });
await page.waitForTimeout(2500);
show("run row", await page.evaluate(() => document.querySelector(".run")?.innerText.replace(/\n/g, " | ")));
show("render range", await page.evaluate(() => document.getElementById("clipNote").textContent));

const seekTo = async (v) => {
  await page.evaluate((n) => { const s = document.getElementById("seek"); s.value = n; s.dispatchEvent(new Event("input")); }, v);
  await page.waitForTimeout(700);
};
await seekTo(400); await page.click("#setIn");
await seekTo(650); await page.click("#setOut");
show("after marking", await page.evaluate(() => document.getElementById("clipNote").textContent));
show("flags", await page.evaluate(() => [...document.querySelectorAll("#flags span")].map((s) => s.textContent).join(" / ")));

await page.click("#queue");
await page.waitForTimeout(500);
show("batch", await page.evaluate(() => document.querySelector("#jobs tbody tr")?.innerText.replace(/\t/g, " | ")));

fs.mkdirSync("out", { recursive: true });
await page.screenshot({ path: "out/ui.png" });
show("errors", errs.join(" ~ ") || "none");

await browser.close();
srv.close();
