# fmz-dashboard

「机器猫的百宝箱」— Vue 3 + Vite 单页仪表盘，按 **功能开关** 编译进不同模块；依赖多个本机 **Node 服务** 时通过 Vite 开发代理转发。生产环境一般为 **静态资源 + Nginx 反代 + systemd 后端**。

---

## 文档索引

| 文档 | 内容 |
|------|------|
| **本 README** | 全流程概览：**操作指令**、**本地配置方式**、调试、页签、插件 |
| [`deploy/RELEASE_AND_DEPLOY.md`](deploy/RELEASE_AND_DEPLOY.md) | 版本号、`pack` 细节、**远端**静态与 Nginx、各 `fmz-*` 服务部署与自检（篇幅长） |
| [`deploy/tencent-cdn-plan2-8443-origin.md`](deploy/tencent-cdn-plan2-8443-origin.md) | CDN / 8443 回源等控制台操作 |
| [`deploy/deploy.local.env.example`](deploy/deploy.local.env.example) | 本机 `deploy` 用 SSH/Web 路径环境变量样例 |
| [`deploy/servers.json`](deploy/servers.json) | 多机 SSH 预设（密钥路径 `token/*.pem`，不含私钥内容） |
| [`deploy/AI_GATEWAY_SPLIT.md`](deploy/AI_GATEWAY_SPLIT.md) | **AI 网关分离**：主站 → 43.160.205.247（HTTP + 共享密钥） |
| [`server/local-ai-agent.env.example`](server/local-ai-agent.env.example) | `ai-agent-server` 与本机密钥、代理、`FMZ_TRIGGER_AI_MODEL` 等 |
| [`server/data/ai-agent-keys.example.json`](server/data/ai-agent-keys.example.json) | 多厂商 Key 模板（复制为 **`ai-agent-keys.json`**，勿提交） |
| [`.cursor/rules/fmz-release-workflow.mdc`](.cursor/rules/fmz-release-workflow.mdc) | **操作指令**（口语 → 打包/提交/发布）与默认**马上更新**远端 |
| [`.cursor/rules/ai-internal-chat-adapter.mdc`](.cursor/rules/ai-internal-chat-adapter.mdc) | Cursor：前端 `AiAgentPanel`、弹幕服务等调用内网 `/chat` 须走**模型降级链** |

---

## 操作指令一览（口语 → 命令）

下列 **指令词** 可直接对协作者或 AI 说出；**未写「仅」「只」「不要」** 时，按 **默认列** 理解。细则见 [`.cursor/rules/fmz-release-workflow.mdc`](.cursor/rules/fmz-release-workflow.mdc)。

| 指令词（你说） | 表示什么 | 默认执行（顺序） | 常用命令 |
|----------------|----------|------------------|----------|
| **完整发布** / **走发布流程** / **上线** | 出新包 + 上服务器；`package.json` 版本变更需入库 | **打包 → 发布（deploy）**。**`git commit` / `push`** 仅当你**本句明确要求**（如「并提交」「帮我提交」「含 git」）时由助手代劳；否则助手 **提醒** 你自行提交 | 见下「二连」 |
| **打包** | 本地出新版归档 | 只做一步 | `npm run pack`（CI/脚本可加 `-- --yes`） |
| **提交** | 代码进 Git | 只做一步（**须你明确要求**助手才代 `commit`） | `git add` → `git commit` |
| **推送** | 同步远程分支 | 只做一步（**须你明确要求**） | `git push` |
| **发布** | 默认同 **完整发布** | **同完整发布** | 见「二连」 |
| **仅发布** / **只部署** / **只上线服务器** | 只要同步服务器 | **仅** `npm run deploy`（须已有与 `package.json` 一致的 `release/<label>/`） | `npm run deploy` |
| **仅打包** | 只要 `release/` | 不 deploy | `npm run pack` |
| **构建** / **仅构建** | 只要 `dist/` | 不 bump、不进 `release/` | `npm run build` |
| **后面再发布** | 稍后再 deploy | **仅打包**（Git 自理）；**不** deploy | 稍后说 **仅发布** |
| **开发** | 只跑前端 | 一步 | `npm run dev` |
| **全栈开发** / **开发全服务** | 前端 + 已启用后端 | 一步 | `npm run dev:all` 或 `npm run dev:services:start` |
| **停开发服务** | 停托管进程 | 一步 | `npm run dev:services:stop` |

**二连（完整发布：默认由助手执行）**

```text
npm run pack
npm run deploy
```

**可选：你一句说明「完整发布并提交」时**，可再执行 `git add` / `git commit` / `git push`（顺序依你的习惯）。

**曾用三连示例（自行在终端执行时）**

```text
npm run pack
git add -A && git commit -m "chore: release v…"
git push
npm run deploy
```

**说明**

- **发布** 在对话里若可能引起歧义（例如刚 pack 完只要上传），请说 **「仅发布」**。
- **仅静态**：部署前设 `FMZ_DEPLOY_SKIP_BACKEND=1`（见 [`deploy/deploy.local.env.example`](deploy/deploy.local.env.example)）。
- **`release/`** 不入库；**发布** 依赖本机刚打完的包。

---

## 环境要求

- **Node.js**：建议 **18+**（与生产 El8 + NodeSource 20.x 一类环境兼容）
- **包管理**：`npm install`（根目录）

---

## 快速开始

```bash
npm install
npm run dev
```

- 默认前端：**http://127.0.0.1:5173**（`vite.config.ts` 中 `host: 0.0.0.0`，局域网可用内网 IP 访问）
- 仅跑 **Vite** 不会自动启动弹幕、AI 等后端；需要完整联调见下文 **本地调试**。

---

## 本地配置方式

下面按**模块**说明密钥、环境变量与文件；**勿将私钥、API Key、`*.pem` 内容写入仓库或聊天**。.gitignore 已忽略常见本地文件，仍以习惯为准。

### 按模块速查

| 模块 | 配置位置 | 入库 | 说明 |
|------|----------|------|------|
| **发布 / SSH** | 将 `.pem` 放入 **`token/`**（已 gitignore）；复制 [`deploy/deploy.local.env.example`](deploy/deploy.local.env.example) → **`deploy/deploy.local.env`**，设置 **`FMZ_DEPLOY_TARGET`**（`dianfanbao` = 118.195.150.4 / www.dianfanbao.net，`tencent-43` = 43.160.205.247）；主机与密钥路径见 [`deploy/servers.json`](deploy/servers.json)。也可直接写 `FMZ_DEPLOY_SSH_KEY` 等覆盖单项；可选 `FMZ_DEPLOY_SKIP_BACKEND`、`FMZ_DEPLOY_SYNC_NGINX` | `deploy.local.env`、`token/*.pem` **勿提交** | `npm run deploy` 会自动读 `deploy.local.env`；PowerShell 手工 ssh 前可 `. ./deploy/load-deploy-env.ps1`。切第二台：`FMZ_DEPLOY_TARGET=tencent-43` 或 `node scripts/deploy.mjs --target=tencent-43` |
| **AI 网关分离** | 网关机 **`/etc/fmz-ai-gateway.env`**（`GEMINI_API_KEY`、`FISH_AUDIO_API_KEY`、`FMZ_REMOTE_SERVICE_SECRET`、代理）；主站同上 Secret + **`FMZ_DEPLOY_SYNC_NGINX=1`**；[`deploy/AI_GATEWAY_SPLIT.md`](deploy/AI_GATEWAY_SPLIT.md) | 机密 **勿提交** | 远端：**AI :8792**、**Fish 音声 :8793**；主站 **`/__fmz_audio` 仍本机 8789**（音频提取不分离） |
| **AI 网关** | [`server/local-ai-agent.env.example`](server/local-ai-agent.env.example) · [`server/data/ai-agent-keys.example.json`](server/data/ai-agent-keys.example.json) → 复制为 **`ai-agent-keys.json`** | **勿提交** | 环境变量优先于 JSON 同名字段；字段 `gemini` / `openai` / `qwen` 与 `GEMINI_API_KEY` 等对应关系见 `ai-agent-server.mjs` |
| **斗鱼弹幕** `douyu-danmaku-server` | `FMZ_TRIGGER_AI_MODEL`、`AI_AGENT_INTERNAL_URL` / `AI_AGENT_PORT`；**日报体积**：`FMZ_AI_REPORT_MAX_GIFT_LINES`（默认 650）、`FMZ_AI_REPORT_VERBATIM_DM_SAMPLE`（分段时原文抽样行数，默认 160）、`FMZ_AI_REPORT_DAILY_FORCE_CHUNK_CHARS`、`FMZ_AI_REPORT_DAILY_FORCE_MIN_PARTS`、`FMZ_AI_REPORT_CHUNK_DM_LINES`、`FMZ_AI_REPORT_CONTEXT_RETRY_MAX`（上下文过长时自动收窄分块重试）等 | 生产可用 **`deploy/fmz-danmaku.env.example`** → 远端 `/opt/fmz-danmaku-server/danmaku.env` + systemd `EnvironmentFile=`（见 `RELEASE_AND_DEPLOY.md` §13.2） | 见 `douyu-danmaku-server.mjs` 顶部常量；`local-ai-agent.env.example` 仅示例 AI 网关变量 |
| **赞踩** `reactions-server` | 服务端：`FMZ_REACTIONS_SECRET`、`PORT`、`FMZ_DATA_DIR` 等（见 `server/reactions-server.mjs` 头部注释） | 服务端配置 | 浏览器侧在设置栏填写 **「赞踩 API 密钥」**，须与 `FMZ_REACTIONS_SECRET` 一致 |
| **首页默认 API** | 仓库根 **`.env`** / **`.env.local`**（Vite）：见下表 **`VITE_*`** 及 [`src/shared/settings.ts`](src/shared/settings.ts) | `.env*` **勿提交** | 开发时可在 shell 设置 `FMZ_UPSTREAM_BROWSER_ORIGIN` 以覆盖 FMZ 上游 Origin（`vite.config.ts`） |
| **音频 / 忽闻宝声** | `AUDIO_PORT`（默认 8789） | 可选 env | 见 `server/audio-extractor-server.mjs`；数据目录约定见 `deploy/RELEASE_AND_DEPLOY.md` §11 |
| **细数宝罪** | `CRIMES_PORT`、`NETEASE_API`（网易云 API 基址，可选）等 | 可选 env | 见 `server/crimes-server.mjs` |
| **三国守塔** | `DEFENSE_TOWER_PORT`、`FMZ_DATA_DIR`、`FMZ_DEFENSE_DB_PATH` 等 | 可选 env | 见 `server/defense-tower-server.mjs` |
| **用量独立包** | `scripts/pack-quota.mjs` 使用 **`.env.quota`** | `.env*` 已忽略 | 与主站 `npm run pack` 不同链路 |
| **废墟 / Supabase 边缘** | `public/ruins-rebuild/supabase/functions/...` 使用 Deno `RESEND_*`、`SUPABASE_*` 等 | 机密仅在部署平台配置 | 与主仪表盘 Node 服务分离 |

### 构建与功能开关（`package.json`）

由 **`vite.config.ts`** 读取 **`fmzFeatures`**：除布尔值外支持 **`"local"`**（开发为开、**生产 `vite build` 为关**）。

| 取值 | 开发 (`npm run dev`) | 生产构建 (`vite build`) |
|------|----------------------|-------------------------|
| `false` | 关闭 | 关闭 |
| `true` | 开启 | 开启 |
| `"local"` | 开启 | **关闭** |

`npm run pack` 前会跑 **`bump-patch.mjs`**，把仍为 `"local"` 的项降为 `false`。发版前务必核对列表。

**`sanguo` vs `sanguoUi`**：后台与代理可只开 `sanguo`；顶栏 **夜观星象** 由 `sanguoUi`（未配置时跟 `sanguo`）控制，见 `vite.config.ts` 中 `sanguoUiEnabled`。

### Vite 开发代理（端口）

仅当对应 **`fmzFeatures` 为 `true` 或 `"local"`** 时注册（节选）：

| 本地前缀 | 目标 | 关联能力 |
|----------|------|----------|
| `/__fmz_reactions` | `127.0.0.1:8787` | battle / treasury / users / preliminary |
| `/__fmz_defense` | `127.0.0.1:8788` | `sanguo` · 守塔 |
| `/__fmz_audio` | `127.0.0.1:8789` | `audio` |
| `/__fmz_crimes` | `127.0.0.1:8790` | `crimes` |
| `/__fmz_danmaku` | `127.0.0.1:8791` | `douyuDanmaku` |
| `/__fmz_ai_agent` | `127.0.0.1:8792` | `aiAgent` |
| `/__fmz_api` | `api2.dongdongne.com` | FMZ 业务 API（需相关 feature） |
| `/__bili_api`、`/__douyu_api` | B 站 / 斗鱼 | `baobao` |

可选 **`VITE_*`**（根目录 `.env`，见 [`src/vite-env.d.ts`](src/vite-env.d.ts)）：`VITE_API_BASE`、`VITE_LIVE_ROOM`、`VITE_X_PROJECT`、`VITE_CURRENCY_PROPORTION`、`VITE_PRELIMINARY_MONEY_PAGE_SIZE`；战斗爽头像还可用 `VITE_DOSEEING_BASE`（生产）、`VITE_DOSEEING_AVATAR=0`（关闭头像，如 E2E）。

### Hash 路由与默认 Tab

- 解析实现：[`src/shared/appRoute.ts`](src/shared/appRoute.ts)。
- **无有效 hash**（`#`、空、`#/`）时：不根据旧逻辑误设为夜观星象；保留 **`firstAvailableMainTab()`**，随后由 `App.vue` 把地址栏 **同步为当前 Tab 的 `#/...`**。

### 浏览器内配置（设置栏）

顶部 **设置栏**（`SettingsBar`）：API 根路径、直播间号、**赞踩密钥**、主题、**宝宝版**（`baobaoMode`，控制拾观宝片 / 遥忆宝章 Tab）等，持久化在 **浏览器 localStorage**（[`src/shared/settings.ts`](src/shared/settings.ts)），与上文「文件/env」互补、互不替代。

---

## 本地调试

| 命令 | 说明 |
|------|------|
| `npm run dev` | 仅 **Vite**（端口 **5173**） |
| `npm run dev:all` | **concurrently**：按当前 `fmzFeatures` 拉起已启用后端 + Vite，单终端 `Ctrl+C` 全停 |
| `npm run dev:services:start` | **托管**进程（Vite + 后端），PID 写入 **`.fmz-dev/pids.json`**，日志在 **`.fmz-dev/logs/`** |
| `npm run dev:services:stop` | 停掉上述托管进程 |
| `npm run dev:services:restart-changed` | 据 **git 变更**尝试只重启受影响服务（规则在 `scripts/fmz-dev-services.mjs` 的 `SERVICE_FILE_WATCH`） |
| `npm run dev:services:status` | 查看各进程与日志路径 |

开启 **`audio`** 时，`dev:all` / `dev:services:start` 会做 **yt-dlp / ffmpeg** 等预检（见 `preflightAudioDeps`）。

---

## 打包 / 提交 / 发布（详解与运维）

**口语指令与默认含义**已集中在上方 **「操作指令一览」**（默认 **完整发布** = `pack` + `deploy`，**Git 提交/推送** 须你当句要求或由你本地完成）。

- **运维细节**（`--yes`、Nginx、systemd 等）：[`deploy/RELEASE_AND_DEPLOY.md`](deploy/RELEASE_AND_DEPLOY.md)
- **马上更新**：未说「后面再发布」→ **完整发布** 在 **pack 后执行 deploy**。

---

## 顶部页签（Main Tab）与 Hash

路由为 **`location.hash`**（无 vue-router），便于静态部署与 OBS 深链；解析见 **`src/shared/appRoute.ts`**。

| 顶栏名称 | `MainTab` | `fmzFeatures`（主要） | Hash 示例 |
|----------|-----------|------------------------|-----------|
| 预赛数据 | `pre` | `preliminary` | `#/pre`、`#/pre/gf` |
| 用户积分 | `users` | `users` | `#/users` |
| 团员金库 | `treasury` | `treasury` | `#/treasury` |
| 战斗爽 | `battle` | `battle` | `#/battle`、`#/captain-hud`（全屏 HUD） |
| 夜观星象 | `sanguo` | **`sanguoUi`**（及 `sanguo`） | `#/sanguo` |
| 拾观宝片 | `baobao` | `baobao` + **设置栏 · 宝宝版** | `#/baobao` |
| 遥忆宝章 | `douyu` | 同上 | `#/douyu` |
| 用量看板 | `quota` | `quota` | `#/quota` |
| 忽闻宝声 | `songs` | `audio` | `#/songs` |
| 细数宝罪 | `crimes` | `crimes` | `#/crimes` |
| 窃听宝语 | `danmaku` | `douyuDanmaku` | `#/danmaku` |
| 废墟重建 · 调试 | `ruins` | `ruinsRebuild` | `#/ruins`、`#/ruins/playlist` |

别名如 `#/bili`、`#/douyu-danmaku` 等见 **`TAB_ALIASES`**。

---

## 插件（Plugins）

与 **顶栏 Tab** 不同：插件在 **`src/shared/plugins.ts`** 注册，由 **`PluginHost`**（嵌在 `SettingsBar`）打开，一般为**浮动窗**或**右侧侧栏**（`panelMode: "side"`）。

- 当前内置：**音频提取**（需 `audio` + **`audioPlugin`**）、**AI 分析**（`aiAgent`）
- 跨组件打开：`requestPluginOpen(pluginId, payload?)`、`onPluginOpen`
- 构建时 `enabled: false` 的插件会被 **tree-shake**（组件为 `null`）

---

## 代码组织（仓库习惯）

```
src/
  App.vue              # 顶栏 Tab、Hash 同步、全局 Player 等
  components/          # 通用 UI（如 SettingsBar、PluginHost）
  features/<域>/       # 按功能域划分的页面 *.vue 与逻辑
  shared/              # settings、theme、plugins、appRoute、API 封装等
server/
  *-server.mjs         # 各后端入口（弹幕、AI、音频…）
  gemini-openai-compat-chat-filter.mjs 等
scripts/
  deploy.mjs           # 远端发布
  pack-release.mjs     # 归档 release/
  fmz-dev.mjs          # 托管开发进程
  fmz-dev-services.mjs # feature → 后端脚本、文件监听规则
  dev-all.mjs          # concurrently 一键开发
deploy/                # 部署文档、nginx/systemd 样例、环境变量样例
release/               # 打包产出（gitignore，勿依赖进库）
```

---

## 规范与协作

1. **对内 `/chat` 调用**：须遵守 [`.cursor/rules/ai-internal-chat-adapter.mdc`](.cursor/rules/ai-internal-chat-adapter.mdc)（前端 `fetchChatStreamWithFallback`、服务端 `resolveAiAgentTriggerModelCandidates` + `chatAiAgentAccumulateFirstAvailable` 等），避免单次请求单模型写死。
2. **发布流程用语**：见 [`.cursor/rules/fmz-release-workflow.mdc`](.cursor/rules/fmz-release-workflow.mdc)。
3. **密钥与本地文件**：勿提交 `.pem`、API Key、**`deploy/deploy.local.env`**、**`server/local-ai-agent.env`**、**`server/data/ai-agent-keys.json`** 等；协作用 **`*example`** 与表格说明即可。

---

## 其它 npm 脚本（摘录）

| 脚本 | 说明 |
|------|------|
| `npm run build` | 仅 `vite build` → `dist/`，**不**递增版本、**不**写 `release/` |
| `npm run preview` / `preview:public` | 预览生产构建（带与 dev 类似的 proxy 配置） |
| `npm run danmaku-server` 等 | 单独启动某一 `server/*.mjs` |
| `npm run check:reactions` | 赞踩服务自检 |
| `npm run test:e2e` | Playwright |

---

## 许可证与私有性质

仓库 **private**，对外分发与许可证以维护者约定为准。
