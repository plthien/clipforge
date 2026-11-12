<p align="center"><img src="docs/banner.en.png" alt="ClipForge — product video creation studio" width="820"/></p>

# ClipForge — Windows-local product video studio (DeepSeek-only)

> This branch is a fork of [xixihhhh/clipforge](https://github.com/xixihhhh/clipforge). It retains upstream attribution, [AGPL-3.0-only](LICENSE), and [NOTICE](NOTICE). This fork is intended for **Windows-local use**, not as an upstream release.

**Pipeline: product photos or product URL → DeepSeek script → storyboard/assets → AI image/video generation → FFmpeg composition → preview and export.**

## Supported in this fork

- **Script/text LLM: official DeepSeek API only** (`https://api.deepseek.com`). `deepseek-flash` supports text and vision; `deepseek-v4-pro` is text-only. Image-bearing requests always use `deepseek-flash`.
- **Image/video generation:** all existing, independently configured media providers (e.g., Atlas Cloud, fal.ai, Replicate) and their API keys remain available. **Media providers are separate from the script LLM.** **No G-Labs integration in R1.**
- Product Library, product URL import, scripts/storyboards, presenter features, uploads, stock-fill, AI image/video, quality review and repair, task recovery, Batch, Clone, Media Lab, FFmpeg composition, preview/export and TTS remain supported.
- Next.js + SQLite + Electron run locally. `pnpm dev`, `pnpm start`, and the embedded Electron server bind to **127.0.0.1** by default.
- Docker publishing, MCP server, CLI, agent skills/plugins, Trending Radar and **product-free topic-to-video** entrypoints are removed. The existing project/SQLite schema is retained.

**Important:** Local execution is not offline inference. AI text, media and TTS providers make network requests and may incur charges. Existing third-party LLM keys are not reused as DeepSeek keys; separate media/TTS credentials are retained. The current local settings store still holds API keys **in plaintext**—protect your local profile and do not share it.

## Run locally on Windows

Requires Windows 10/11, Node.js 22 (project engine requires Node >=20), the pinned **pnpm 10.33.0**, and network access to your selected providers.

```powershell
git clone https://github.com/plthien/clipforge.git
cd clipforge
git switch feat/r1-local-deepseek
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:3000/start** in your browser. Do not expose the local development server to the public network.

Production build and Windows desktop packaging:

```powershell
pnpm build
pnpm start
# On Windows, build an unpacked Electron folder or NSIS installer:
pnpm pack:dir
pnpm dist
```

`pnpm pack:dir` builds an unpacked desktop directory; `pnpm dist` uses electron-builder to produce a Windows NSIS installer in `release/` by default. Both require a working local Node/pnpm environment and build dependencies. Run the checks below before distributing any installer.

## Product → video workflow

1. In **Settings → LLM**, enter your **DeepSeek API key**, select `deepseek-flash` or `deepseek-v4-pro`, and test the connection. Flash is always used for product-image understanding.
2. In **Settings → Providers / Image / Video**, configure the separate media provider(s) you want to use; configure TTS as required.
3. In **Products**, save a product, or from **Start** upload product photos or paste a product URL. Use **Create** to produce a commerce script and storyboard.
4. Review copy and shots in **Script**; use the original product photos, uploads, stock, or your configured AI generators in **Assets**.
5. In **Video/Compose**, run FFmpeg composition and preview the result; use **Export** to save it. **Projects** resumes existing work. Batch, Clone and Media Lab are available in advanced mode.

**Visual fidelity:** Always verify AI-produced results against catalog photos, including design, color, material, scale and typography. Review copyright and footage licenses before publication.

## Architecture / troubleshooting

| Path | Purpose |
|---|---|
| `src/app/start`, `src/app/products`, `src/app/project` | Product creation and project/script/assets/export UI |
| `src/lib/deepseek-policy.ts`, `src/lib/llm-error.ts` | LLM allowlist and outbound client guard |
| `src/lib/script-engine`, `src/lib/media-analysis.ts` | Script engine, product and media image analysis |
| `src/lib/providers/` | Existing independent media providers |
| `src/lib/db/`, `drizzle/` | SQLite schema and historical migrations (no destructive migration) |
| `src/lib/video-composer/`, `electron/` | FFmpeg composition and desktop/local data |

Additional engineering documentation: [Local assets](docs/local-materials.md) · [Task recovery](docs/task-recovery.md) · [Platform framing/export](docs/platform-framing.md) · [Transcript clips](docs/transcript-clips.md) · [ASR quality](docs/asr-quality.md) · [Troubleshooting](docs/troubleshooting/).

## Validation — existing checks, no paid AI required

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm bundle:standalone
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-r1-acceptance.ps1
```

The existing local acceptance runner writes version/install/lint/test/build/bundle/Electron write/read smoke logs and `results.json` to `r1-local-results-*`. Manually inspect Start and Settings, and open an existing product project's Assets/Compose/Export pages. Never claim paid AI generation passed without running it.

## License / attribution

- Original author: [xixihhhh/clipforge](https://github.com/xixihhhh/clipforge); fork: [plthien/clipforge](https://github.com/plthien/clipforge). This is not an official upstream release.
- Licensed under [GNU AGPL-3.0-only](LICENSE); also see [NOTICE](NOTICE). Follow upstream attribution requirements and all third-party service/media licenses.
- No affiliation with the named third-party platforms or model vendors is implied.
