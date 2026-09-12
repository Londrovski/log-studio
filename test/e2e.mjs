// Runs the whole pipeline against a real log in headless Chrome.
//
//   node test/e2e.mjs /path/to/run.mcap '{"template":"showcase","at":55,"seconds":4}'
//
// Writes out/still.png and out/clip.mp4 so the result can actually be looked at.
// Note that a headless Chromium built without the proprietary codecs cannot encode
// H.264; the app negotiates a codec, so it falls back to AV1 here and uses H.264 in
// real Chrome.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const types = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm",
};
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end("no"); }
  res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8121, r));

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[error]", e.message));

await page.goto("http://localhost:8121/test/e2e.html");
const opts = JSON.parse(process.argv[3] ?? '{"template":"showcase","at":40,"seconds":0}');
await page.evaluate((o) => { window.__opts = o; }, opts);
await page.setInputFiles("#f", process.argv[2]);
await page.waitForFunction(() => window.__result, null, { timeout: 600000 }).catch(() => {});

const r = await page.evaluate(() => window.__result);
if (!r) console.log("NO RESULT — it timed out");
else {
  r.log.forEach((l) => console.log(l));
  fs.mkdirSync("out", { recursive: true });
  if (r.still) fs.writeFileSync("out/still.png", Buffer.from(r.still.split(",")[1], "base64"));
  if (r.mp4) fs.writeFileSync("out/clip.mp4", Buffer.from(r.mp4.split(",")[1], "base64"));
}
await browser.close();
srv.close();
