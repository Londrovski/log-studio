# TBRe Log Studio — test bed

Two throwaway pages that answer the questions we need answered before building the real viewer.

**Live (once GitHub Pages is on):** https://londrovski.github.io/log-studio/

| Page | What it proves |
|---|---|
| `index.html` | Whether a browser page can stream the app's templates out of the private GitLab repo `tbre-ai/software-tools/log-studio-assets`, and by which route (your login, an access token, or not at all). |
| `capability.html` | Whether Chrome can open your local logs folder, read a real `.mcap`, decode Foxglove's protobuf (including the `required`-field quirk that trips the standard decoders), draw a camera frame, and encode an MP4 on the graphics card. |

Both run entirely in your browser. No log data leaves your machine.

## The plan these feed into

`claude/log-studio-architecture.md` in the TBReAI Claude project: a Chrome app that lists your runs, plays them back in the TBRe style, and exports MP4s, with the look defined by template files rather than code.

## Where things live

- **App code:** here.
- **Templates and manifest:** `tbre-ai/software-tools/log-studio-assets` on GitLab.
- **Logs:** on your own machine. Never uploaded.
