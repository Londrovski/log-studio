# TBRe AI Log Studio

Turn a `.mcap` run into something you can watch, and into an MP4 you can post.

**The app: https://log-studio.teambathracingelectric.com**

Open it in Chrome, point it at your logs folder, and every run is listed. Click one to
watch it back — camera, SLAM map, speed, steering, the lot — mark the part worth showing,
and render an MP4. Your logs stay on your machine; nothing is uploaded, ever.

---

## Why it exists

Foxglove is the right tool for engineering. It is the wrong tool for showing anyone what
the car did: it has no video export, and screen-recording gives you the dark debug look.
This does the public-facing half — the white website style, and a vertical cut for
Instagram — while the look lives in template files rather than in code.

## Using it

1. **Choose logs folder.** Chrome asks once and remembers. Sub-folders are searched, so
   point it at the folder holding `Sorted/` and `Raw/`; a **Folder** dropdown then filters
   between them, defaulting to Sorted.
2. **Click a run.** It opens in the player. Space plays and pauses, arrow keys step a
   frame (hold shift for a second), `i` and `o` mark the render range.
3. **The timeline says what will happen.** Grey before the car moves, green from *car
   driving from here*, and a solid blue band between *render begins* and *render ends*.
   The Render heading reads the range back: `0:52.0 → 1:24.5 · 32.5s becomes 16.3s at 2×`.
4. **Pick a template, speed and quality, then Render MP4.** The render opens in its own
   tab with a progress bar and a time estimate, so the main window stays usable.
5. **Batch:** add several runs, each with its own range, then render them all — or **Save
   job file**, a small JSON a Jetson can chew through overnight.

Opening a run costs roughly one pass over the file: about 3 seconds for a 70 MB run.
Everything after that — scrubbing, playing, jumping about — is instant.

---

## How it gets published

| | |
|---|---|
| **Lives** | this repo, `teambathracingelectric/log-studio` |
| **Deploys to** | Cloudflare Workers, static assets only |
| **Served at** | `log-studio.teambathracingelectric.com` |
| **Triggered by** | any push to `main` |

**To update the site, push to `main`.** That's the whole answer. `.github/workflows/deploy.yaml`
installs, builds, and runs `wrangler deploy`; `wrangler.jsonc` says the built `dist/`
folder is the site and claims the custom domain. GitHub records each deploy under the
**production** environment, so the repo sidebar shows when the site last went out and
links straight to it.

Two other ways in, for when a push isn't what you want:

- **Actions → Deploy → Run workflow** re-deploys the current `main` without a commit.
- `npm run deploy` builds and deploys from your own machine (`npx wrangler login` first).

### What makes it work

Two organisation secrets, the same pair the website and the portal use:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Because they are held at organisation
level, a new repo only needs to be added to the secret's repository list — there is
nothing to copy. If they ever go missing the build still runs and the deploy step skips
with a note explaining why, rather than failing red.

This is deliberately the same shape as `tbre-website` and `tbreai-portal`, so whoever
learns one has learned all three. Ours is the simplest of the three: there is no Worker
script at all, because the app is a folder of static files rather than something rendered
on the server.

The team process for this pattern is in **Processes → Web Development → Deploying with
Cloudflare**.

---

## Templates, and the GitLab repo

The look of every video is data, not code. A template is a folder of small JSON files:
`template.json` says what goes where, `theme.json` holds the colours, and each panel is
its own file.

The steering slider used to point the wrong way, because the log counts a left turn as
positive and a screen counts right as positive. The fix is the whole reason this is data
— `panels/steering.json`:

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

Panel types: `camera`, `map`, `dial`, `slider`, `stat`, `plot`, `header`, `progress`,
`label`. Adding tyre temperature is a new `stat` block, not new code.

Two templates ship: **Showcase 16:9** (the website style) and **Social 9:16** (phones —
bigger type, no plots, clear of Instagram's own buttons).

### Two copies, and which one wins

Templates live in **two** places, and that is on purpose:

| Copy | Where | When it is used |
|---|---|---|
| **Live** | GitLab, `tbre-ai/software-tools/log-studio-assets` | first choice, every time the app loads |
| **Built in** | `templates/` in this repo | when GitLab can't be read, and offline |

The live copy is what makes this worth having: **edit a panel in GitLab, merge it, and the
next person to open the app sees the change — no deploy, no GitHub access needed.** That
is the whole reason a team member can restyle a video without touching this repository.

Editors should read **[the assets repo's own README](https://gitlab.bath.ac.uk/tbre-ai/software-tools/log-studio-assets)**,
which is written for exactly that job.

### Why there is a token in plain sight

**GitLab will not let browser code read raw file paths from another site, but its API
will — as long as the request carries a token rather than your login cookie.** Cookies
cannot be sent to a server that allows any origin, which is exactly how GitLab's API is
configured, so the cookie route cannot work and the token route can. Tested, not assumed.

The token therefore sits in `config.json`, readable by anyone who opens the page, because
**a web page has no secrets.** That is safe only because of what it is:

- a **project** access token on `log-studio-assets` alone — never a personal token, which
  would publish read access to everything that account can see
- **Reporter** role, scopes `read_api`, `read_repository`, `read_registry`
- the repo it can reach contains nothing but template JSON

Open **`token-check.html`** on the live site and paste a token in: it lists every GitLab
project that token can reach, and refuses to call it safe if that is more than one. Do
that before committing any token.

**When the token expires** — they do, usually after a year — the app keeps working from
its built-in templates and shows a banner saying GitLab could not be read and why (*the
token is expired or invalid*, *missing a scope*, *scoped to a different project*). Anyone
can paste a replacement into **Settings** (the gear, top right) to fix it on their own
machine immediately. The permanent fix is to update `gitlab.token` in `config.json` here
and push.

---

## Working on the app

```
npm install
npm run build     # → dist/
npm run serve     # build and serve dist/ at localhost:8080
npm run deploy    # build and deploy to Cloudflare
```

```
src/mcap/     reading logs: MCAP index, protobuf, zstd
src/render/   the drawing engine — one function per panel type
src/export/   MP4 encoding
templates/    the built-in copy of what everything looks like
vendor/       npm libraries, bundled at build time
test/         headless-Chrome checks against a real log
```

Tests need a real log to point at:

```
node test/e2e.mjs          dist /path/to/run.mcap   # loads a run, draws a frame, renders a clip
node test/ui.mjs           dist /path/to/run.mcap   # drives the interface
node test/render-flow.mjs  dist /path/to/run.mcap   # presses Render and follows the tab
```

`render-flow` is the one that matters: it clicks the button a person clicks and checks a
file comes out. Everything else can pass while the app is unusable.

### Three things that will bite whoever touches this

**Foxglove's schemas are invalid protobuf.** The SDK marks proto3 fields `required`,
which proto3 forbids, so every standard decoder refuses them. `src/mcap/reader.js` relaxes
the flag before building the type — the same workaround as the team's `crop_mcap.py`.

**Logs are zstd-compressed and the MCAP library ships no decompressor.** It carries its
own, as WebAssembly rather than JavaScript, and that is not a detail: a three-minute run
expands to about 320 MB, which the JS decoder manages at 19 MB/s. Twenty seconds to open a
file instead of three, and four minutes for one of the big runs. The JS decoder stays as a
fallback so a run always opens.

**A page whose scripts fail to load looks finished and does nothing.** Every button is
still there; none of them respond. Both pages now check for that after five seconds and
say which file is missing and what to change. If you ever see a dead-looking app, read
that panel before debugging anything else.

## Deliberately left out

- **Editing logs** — that's `mcap-cropper`'s job.
- **Engineering analysis** — that's Foxglove's. Use Foxglove to find the run worth
  showing; use this to show it.
- **Uploading anything anywhere.** Only the finished MP4 leaves, when you choose to post it.
