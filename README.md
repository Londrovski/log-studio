# TBRe Log Studio

Turn a `.mcap` run into something you can watch, and into an MP4 you can post.

**The app:** https://londrovski.github.io/log-studio/

Open it in Chrome, point it at your logs folder, and every run is listed. Click one to
watch it back — camera, SLAM map, speed, steering, the lot — mark an in and out point,
and render an MP4. Your logs stay on your machine; nothing is uploaded, ever.

---

## Why it exists

Foxglove is the right tool for engineering. It is the wrong tool for showing anyone what
the car did: it has no video export, and screen-recording gives you the dark debug look.
This does the public-facing half — the white website style, and a vertical cut for
Instagram — while the look lives in template files rather than in code.

## Using it

1. **Choose logs folder.** Chrome asks once, and remembers. Sub-folders are searched, so
   point it at the folder holding `Sorted/` and `Raw/`.
2. **Click a run.** It opens in the player. Space plays and pauses, arrow keys step a
   frame (hold shift for a second), `i` and `o` set the in and out points.
3. **Pick a template**, a render speed and a quality, then **Render MP4**. The render
   opens in its own tab with a progress bar, so the main window stays usable.
4. **Batch:** tick several runs, then render them all, or **Save job file** — a small
   JSON a Jetson can chew through overnight.

Opening a run costs roughly one pass over the file: about 3 seconds for a 70 MB run.
Everything after that — scrubbing, playing, jumping about — is instant.

## Changing how it looks

A template is a folder of small JSON files. `template.json` says what goes where,
`theme.json` holds the colours, and each panel is its own file.

The steering slider used to point the wrong way, because the log counts a left turn as
positive and a screen counts right as positive. The fix is the whole reason this is data
and not code — `templates/showcase/panels/steering.json`:

```json
{
  "type": "slider",
  "label": "STEERING REQUEST",
  "source": { "topic": "/control/ddt/steer_request" },
  "sign": -1,
  "range": [-25, 25],
  "endLabels": ["L", "R"]
}
```

Panel types available: `camera`, `map`, `dial`, `slider`, `stat`, `plot`, `header`,
`progress`, `label`. Adding tyre temperature is a new `stat` block, not new code.

Two templates ship: **Showcase 16:9** (the website style) and **Social 9:16** (phones —
bigger type, no plots, clear of Instagram's own buttons).

## Templates and GitLab

Templates can come from the GitLab assets repo
(`tbre-ai/software-tools/log-studio-assets`) so a pushed change is live immediately,
with the copy in this repo as the offline fallback.

That needs a token, and here is why: **GitLab will not let browser code read raw file
paths from another site, but its API will, as long as the request carries a token rather
than your login cookie.** Cookies can't be sent to a server that allows any origin, which
is exactly how GitLab's API is configured — so the cookie route cannot work and the token
route can. Tested, not assumed.

The token sits in `config.json`, in plain sight, because a web page has no secrets.
So it **must** be a project access token scoped to `log-studio-assets` alone, with
read-only access. Never a personal token — that would publish read access to everything
your account can see. Open `token-check.html` and paste a token in to see exactly what it
reaches before committing it. Leave `token` empty and the app quietly uses its own copy
of the templates.

## Working on it

```
npm install
npm run build     # → dist/
npm run serve     # build and serve dist/ at localhost:8080
```

Pushing to `main` builds and publishes to GitHub Pages automatically.

```
src/mcap/     reading logs: MCAP index, protobuf, zstd
src/render/   the drawing engine — one function per panel type
src/export/   MP4 encoding
templates/    what everything looks like
vendor/       npm libraries, bundled at build time
test/         headless-Chrome checks against a real log
```

### Two things that will bite whoever touches the reader

**Foxglove's schemas are invalid protobuf.** The SDK marks proto3 fields `required`,
which proto3 forbids, so every standard decoder refuses them. `src/mcap/reader.js`
relaxes the flag before building the type — the same workaround as the team's
`crop_mcap.py`.

**Your logs are zstd-compressed and the MCAP library ships no decompressor.** It carries
its own. It uses the WebAssembly build rather than the pure-JavaScript one, and that is
not a detail: a three-minute run expands to about 320 MB, which the JS decoder manages at
19 MB/s. That is twenty seconds to open a file instead of three, and four minutes for one
of the big runs. The JS decoder stays as a fallback so a run always opens.

## Deliberately left out

- **Editing logs** — that's `mcap-cropper`'s job.
- **Engineering analysis** — that's Foxglove's. Use Foxglove to find the run worth
  showing; use this to show it.
- **Uploading anything anywhere.** Only the finished MP4 leaves, when you choose to post it.
