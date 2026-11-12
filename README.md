<p align="center"><img src="docs/banner.png" alt="ClipForge — AI 商品短视频工作台" width="820"/></p>

# ClipForge — Windows 本地商品短视频工作台（DeepSeek-only）

> 本分支来自 [xixihhhh/clipforge](https://github.com/xixihhhh/clipforge)，保留上游署名、[AGPL-3.0-only](LICENSE) 和 [NOTICE](NOTICE)。此处仅面向 **Windows 本地用户**，不是上游公开发布版。

**工作流：商品图片或商品链接 → DeepSeek 脚本 → 分镜/素材 → 图片或视频生成 → FFmpeg 合成 → 预览与导出。**

## 此分支支持什么

- **脚本 / 文本 LLM：仅官方 DeepSeek API**（`https://api.deepseek.com`）。`deepseek-flash` 支持文本及图片理解，`deepseek-v4-pro` 用于纯文本；任何请求中包含图片时统一使用 `deepseek-flash`。
- **图片/视频 AI**：保留现有媒体 provider（如 Atlas Cloud、fal.ai、Replicate 等）及各自独立的 API Key/模型选择；**媒体 provider ≠ 脚本 LLM provider**。本轮**未接入 G-Labs**。
- 保留 Product Library、从商品 URL 导入、脚本与分镜、角色、素材上传、自动素材匹配、视频生成、质量评审和修复、任务恢复、批量出片、Clone、Media Lab、FFmpeg compose、预览/导出及 TTS。
- 本地运行使用 Next.js + SQLite + Electron；`pnpm dev`、`pnpm start` 和 Electron 内嵌服务器默认仅监听 **127.0.0.1**。
- 移除 Docker 发布、MCP server、CLI、agent skills/plugins、Trending Radar 及**无商品主题生成视频**入口；不影响已存在的项目/SQLite schema。

**注意：**本地运行并不意味着离线生成。DeepSeek 和其它在线媒体/TTS provider 会向所选服务商发送请求并消耗其配额。旧版配置中的其他 LLM Key 不会自动转用 DeepSeek；媒体/TTS Key 保留。当前设置存储仍包含 **本地明文 API Key**，不要分享配置目录或上传日志中可能包含秘密的文件。

## Windows 安装与启动

要求：Windows 10/11，Node.js 22（兼容项目要求 Node >=20），仓库指定的 **pnpm 10.33.0**，以及可访问所选 API 的网络。

```powershell
git clone https://github.com/plthien/clipforge.git
cd clipforge
git switch feat/r1-local-deepseek
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

在浏览器打开 **http://127.0.0.1:3000/start**。请勿为本地开发额外开放公网端口。

生产模式及 Windows Electron 安装包：

```powershell
pnpm build
pnpm start
# Electron 包装（在 Windows 上执行，无需 GitHub Release）
pnpm pack:dir
pnpm dist
```

`pnpm pack:dir` 生成免安装测试目录，`pnpm dist` 使用 electron-builder 生成 Windows NSIS 安装包（默认 `release/`）。二者依赖本地 Node/pnpm、FFmpeg/Electron 构建所需文件。打包前请先完成下面的验收；不要将未验证的包当作已测试版本分发。

## 首次使用：商品到成片

1. 在 **Settings → LLM** 输入 **DeepSeek API Key**，选 `deepseek-flash` 或 `deepseek-v4-pro` 并测试连接。图片理解统一使用 Flash。
2. 在 **Settings → Providers / Image / Video** 配置实际使用的图片/视频服务商；按需配置独立 TTS。
3. 打开 **Products** 保存商品，或在 **Start** 上传商品图片/粘贴商品 URL。进入 **Create** 生成商品脚本和分镜。
4. 在 **Script** 检查卖点和镜头内容；前往 **Assets** 使用商品图、上传素材、免费素材或已配置的 AI 媒体。
5. 在 **Video/Compose** 使用 FFmpeg 合成、检查预览；在 **Export** 保存输出。可从 **Projects** 恢复中断的项目。Batch、Clone 和 Media Lab 仍可从高级模式访问。

**保真提示：**AI 生成内容可能偏离商品原图，务必逐镜检查颜色、文字、尺寸和材质；最终合成前审核产品形象和版权/授权来源。

## 代码结构与排查

| 位置 | 功能 |
|---|---|
| `src/app/start`、`src/app/products`、`src/app/project` | 商品创建、项目工作流、素材/导出 UI |
| `src/lib/deepseek-policy.ts`、`src/lib/llm-error.ts` | LLM allowlist、官方端点校验与统一客户端 |
| `src/lib/script-engine`、`src/lib/media-analysis.ts` | 脚本、商品图片分析、媒体分析 |
| `src/lib/providers/` | 原有独立媒体 provider，不受 LLM allowlist 的影响 |
| `src/lib/db/`、`drizzle/` | SQLite schema / 历史迁移；升级时保留用户数据 |
| `src/lib/video-composer/`、`electron/` | FFmpeg 合成、桌面应用与本地数据路径 |

专项开发文档仍保留： [素材库](docs/local-materials.md) · [任务恢复](docs/task-recovery.md) · [画幅与平台导出](docs/platform-framing.md) · [转录剪辑](docs/transcript-clips.md) · [ASR 质量](docs/asr-quality.md) · [故障排查](docs/troubleshooting/)。

## 验收（使用既有脚本；无需付费生成）

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm bundle:standalone
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-r1-acceptance.ps1
```

最后一条复用既有本地 acceptance 脚本，生成 `r1-local-results-*` 目录，保存版本、安装、lint、test、build、standalone、Electron write/read smoke 日志和 `results.json`。验收还应人工检查 Start、Settings、现有商品项目的 Assets/Compose/Export；若未实际运行付费生成，不可把 API 生成写成 PASS。

## 许可与署名

- 原作者：[xixihhhh/clipforge](https://github.com/xixihhhh/clipforge)；fork：[plthien/clipforge](https://github.com/plthien/clipforge)。该分支不代表上游官方发布。
- 代码采用 [GNU AGPL-3.0-only](LICENSE)，请同时阅读 [NOTICE](NOTICE) 并遵守上游署名、第三方服务和素材的各自条款。
- 第三方平台、模型提供商与本仓库无官方隶属关系。


### G-Labs Webhook (R2 — local media provider)

Optional provider: **Settings → G-Labs Webhook**. Start the G-Labs desktop application
and Webhook service, enter its separate `X-API-Key`, and set a **loopback port only**
(default `http://127.0.0.1:8765`). A G-Labs **MAX** plan and eligible signed-in
GPT Image 2 / Meta AI accounts are prerequisites. Health checks alone cannot
verify account eligibility. No OpenAI platform key is used for this provider.

Models: `glabs-gpt-image-2` for text-to-image / image-guided edits (≤5 positional
PNG/JPEG/WEBP references, ratio whitelist, native output ≈1.57MP, no 4K);
`meta_muse` is the ClipForge alias for Meta AI video at documented
`POST /api/meta/generate` (t2v/i2v, optional end image, 480p/720p).
**Meta does not accept a requested generation duration, generic reference videos,
or a guaranteed audio option.** Its separate Settings selector sends exactly `480p`
or `720p` without changing other providers' global resolution. ClipForge downloads
completed results to `data/uploads/glabs-webhook`, validates and atomically copies
saved project assets under `data/uploads/<projectId>` (preserving the recovery cache),
extracts video tail frames there, and stores task IDs in SQLite before polling.
Storyboard Grid tasks retain a versioned script identity and project-local source;
recovery finalizes deterministic per-shot crops idempotently before marking the task
complete. G-Labs task history is ephemeral after
a G-Labs restart; an unknown task is never automatically resubmitted. Paid
generation has no automatic POST retry. This integration needs real Webhook
acceptance on the user's Windows PC before production use.
