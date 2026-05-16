# fmz-dashboard：版本发布与远端部署（供维护者 / AI 参考）

**本地密钥 / `.pem` / 各模块 env**：见仓库根目录 **[README.md](../README.md#本地配置方式)（章节「本地配置方式」）**。

---

**与本仓库其它说明的关系**：根目录 [**`README.md`**](../README.md) 为全流程索引（本地调试、**本地配置方式**、`fmzFeatures`、页签/插件/目录）；本文**侧重**远端与运维细节。名词 **打包 / 提交 / 发布** 以 **[`.cursor/rules/fmz-release-workflow.mdc`](../.cursor/rules/fmz-release-workflow.mdc)** 为准。

---

## 1. 版本号与构建标签

版本号由 **`scripts/bump-patch.mjs`** 在每次 `npm run pack` 时**自动递增** patch 位（如 `1.1.11` → `1.1.12`），并同步 `fmzReleaseLabel` 为 `v<version>`。**无需手动编辑 `package.json` 的版本号**。

如需跳过自动递增（如大版本升级 `1.1.x` → `1.2.0`），先手动修改 `package.json` 的 `version` 和 `fmzReleaseLabel`，再执行 `npm run pack`（bump-patch 会在新版本基础上 +1 patch）。

构建时 **`vite.config.ts`** 会把 `version` / `fmzReleaseLabel` 注入为全局常量，并写入 **`index.html`** 的 `data-fmz-version`、`data-fmz-label`。

自检本地构建结果：

```text
dist/index.html 或 release/<fmzReleaseLabel>/index.html
```

应含例如：`data-fmz-version="1.1.12"`、`data-fmz-label="v1.1.12"`。

---

## 2. 打包

在仓库根目录执行：

```bash
npm run pack
```

等价于 **`vite build`** 后再执行 **`scripts/pack-release.mjs`**，将 **`dist/`** 复制到 **`release/<fmzReleaseLabel>/`**，并生成 **`BUILD_INFO.txt`**（时间戳与版本元数据）。同一归档内还会按**实际发布**的模块，把本机 **`server/data/`** 的对应子路径复制到 **`release/<fmzReleaseLabel>/server/data/`**（如歌曲库 → `audio/`，赞踩相关 → `reactions.db`；**不含** `defense_tower.db`，该库由服务在线拉取/生成，不随包分发）；若本地无该路径则提示跳过。另有 **`release/<label>/opt/<fmz-*-server>/`**，镜像 **CVM `/opt/`** 下各 Node 服务的入口脚本（弹幕、AI、音频、细数宝罪、三国守塔、赞踩等，**不含** `ai-agent-keys.json` 等密钥）。可选： **`--skip-data`**；**`--exclude-audio-source`**（与 §11.3.2 一致）；**`--skip-opt`** 不纳入后端镜像。**`BUILD_INFO.txt`** 中 **`archivedServerData`** / **`archivedOptServices`** 为本次归档清单。

### 2.1 发布模块强制确认（⚠️ 强制规则）

**`pack-release.mjs`** 在归档前会**强制列出所有模块的发布状态**，要求用户手动输入 `yes` 确认后才会执行。这是为了防止误将 `"local"` 模块（如用量看板）发布到生产环境。

确认面板示例：

```
╔══════════════════════════════════════════════════════════╗
║           📦 发布模块确认（Release Confirmation）        ║
╠══════════════════════════════════════════════════════════╣
║  版本: v1.1                                            ║
╠══════════════════════════════════════════════════════════╣
║  ✅ 三国守塔                      ✅ 发布               ║
║  ✅ 百宝箱（B站搜索）              ✅ 发布               ║
║  ✅ 🎶 歌曲库 / 音频提取           ✅ 发布               ║
║  ⛔ 战斗爽                        ⛔ 不发布              ║
║  ⛔ 用量看板                      ⛔ 不发布              ║
╠══════════════════════════════════════════════════════════╣
║  将发布 3 个模块，关闭 5 个模块                          ║
╚══════════════════════════════════════════════════════════╝

确认以上模块列表正确？输入 yes 继续，其他任意键取消:
```

**关键规则**：

1. **必须通过 `npm run pack` 执行**：该命令会先运行 `bump-patch.mjs`（自动将 `"local"` 降为 `false`），再 `vite build`，最后 `pack-release.mjs`（含确认）。**绝不能跳过 `bump-patch.mjs` 直接 build**，否则 `"local"` 模块不会被降级。
2. **手动设置大版本号时**：如果需要跳过自动 patch 递增（如从 `1.0.x` 升到 `1.1.0`），应先手动修改 `package.json` 的 `version` 和 `fmzReleaseLabel`，然后仍然执行 `npm run pack`（bump-patch 会在新版本基础上 +1 patch，但更重要的是它会降级 `"local"` features）。或者手动运行 `node scripts/bump-patch.mjs` 后再手动改回目标版本号，再 `vite build && node scripts/pack-release.mjs`。
3. **`BUILD_INFO.txt` 会记录发布的模块列表**：可用于事后审计。
4. **`--yes` 参数**：CI 或本地脚本可跳过交互；**人工发版**时若使用，仍须在打包前核对 `package.json` 的 **`fmzFeatures`** 与确认面板列表是否可信。

### 2.2 Feature Flag 三态规则

| 值 | 含义 | 本地开发 | 发布构建 |
|----|------|---------|---------|
| `false` | 关闭 | ⛔ 不可用 | ⛔ 不发布 |
| `"local"` | 仅本地 | ✅ 可用 | ⛔ 不发布（bump-patch 自动降为 false） |
| `true` | 始终启用 | ✅ 可用 | ✅ 发布 |

注意：**`release/`** 在 **`.gitignore`** 中，**不会**随 Git 推送；上线依赖本机或 CI 产物再 **SCP/同步**。

仅构建不落盘归档时可用：

```bash
npm run build
```

---

## 3. 发布流程（推荐顺序）

静态站点**不会**在 `git push` 后自动更新。项目约定 **完整链路** 为：**打包 → 提交 → 发布**（见根目录 `README.md` 与 `.cursor/rules/fmz-release-workflow.mdc`）。

**推荐做法（与约定一致）**

1. **打包**：`npm run pack`（含 `bump-patch` 递增版本、`vite build`、`pack-release` 归档 `release/<label>/`；人工打包时建议看清模块确认输出，CI 可用 `--yes`）。
2. **提交**：将**本次功能改动**与 **`package.json` / `package-lock.json` 的版本递增**一并 `git commit`（也可拆成两次 commit：先 `feat:`，再 `chore: bump`）。需要协作/备份时再 **`git push`**。
3. **发布**：`npm run deploy`（上传 `index.html` + `assets/` + `BUILD_INFO.txt`；若本地 `release/.../opt/` 存在则同步到远端 **`/opt/<...>/`**，对需依赖的服务执行对应安装与 **systemd restart**）。若**只要静态**、暂不同步后端：设置 **`FMZ_DEPLOY_SKIP_BACKEND=1`**。
4. **手动兜底**（极少用）：未走 `pack-release` 的 `opt/` 或需改 unit 时，可单独 `scp` + `systemctl restart`。
5. **验证**：SSH 查看 **`BUILD_INFO.txt`**、服务 **`systemctl is-active`**；抽查弹幕、AI `/models` 等。

**说明**：`deploy` 已从 **`release/<label>/opt/fmz-danmaku-server/`** 等同路径同步时，**不必**再为弹幕服务单独 `scp` 一遍，除非应急覆盖单文件。

**分两回提交示例**：

```bash
git add -A && git commit -m "feat: some feature"
npm run pack
git add -A && git commit -m "chore: bump version to 1.1.15"
git push origin main
npm run deploy
```

**单次提交示例**（功能与 bump 同一笔）：

```bash
npm run pack
git add -A && git commit -m "feat: xxx; chore bump v1.1.15"
git push origin main
npm run deploy
```

---

## 4. 远端静态资源部署

- **Web 根目录**：`/var/www/fmz-dashboard/`
- **上传对象**：`release/<fmzReleaseLabel>/` 下的 **`index.html`**、**`assets/`**、**`BUILD_INFO.txt`**
- **SSH 私钥与服务器信息**：见附录 A

**推荐方式（自动上传 + 清理旧 assets + 验证）：**

```bash
npm run deploy
```

该命令执行 `scripts/deploy.mjs`，自动完成：
1. 读取 `package.json` 确定当前 release label
2. SCP 上传 `assets/`、`index.html`、`BUILD_INFO.txt` 到远端
3. **自动清理远端旧版本残留的 assets 文件**（对比本地 release 与远端，删除不再需要的文件）
4. 验证远端 `BUILD_INFO.txt` 和 assets 文件数一致性

也可指定特定版本部署：`node scripts/deploy.mjs v1.1.20`

**手动方式（不推荐）：** 下述命令中的 **`D:/path/to/your-key.pem`** 为占位符，请替换为 **`deploy/deploy.local.env` 中的 `FMZ_DEPLOY_SSH_KEY`**（见仓库根目录 **`README.md` · 本地配置方式**）。后文 §11～§13 中手工 `scp`/`ssh` 示例同此。

```powershell
scp -i "D:/path/to/your-key.pem" -r release/v1.1.15/assets release/v1.1.15/index.html release/v1.1.15/BUILD_INFO.txt root@118.195.150.4:/var/www/fmz-dashboard/
```

⚠️ 手动 SCP 不会清理旧 assets，多次发布后远端会堆积大量无用文件。

上传后 **无需** 为纯静态文件重启 Nginx（除非改了 Nginx 配置本身）。

---

## 5. 验证前端版本是否已生效

```bash
ssh -i "D:/path/to/your-key.pem" root@118.195.150.4 "cat /var/www/fmz-dashboard/BUILD_INFO.txt"
```

或浏览器访问 `https://www.dianfanbao.net/`，「查看网页源代码」应看到当前 **`data-fmz-version`** / **`data-fmz-label`**，且 **`/assets/index-*.js`** 哈希与本地 **`release/.../index.html`** 一致。

若仍为旧哈希或无 `data-fmz-*`，说明 **SCP 未执行、路径不对或浏览器 CDN 缓存**（可强刷或无痕）。

---

## 6. 赞踩服务（reactions-server）与 Nginx

- **进程**：仓库 **`server/`**，默认监听 **`127.0.0.1:8787`**（`PORT` 可改）。生产环境需在服务器上 **`npm ci && npm start`** 或由 systemd 保活。
- **Nginx**：参考 **`deploy/nginx-fmz-dashboard.conf`** 与同目录 **`nginx-fmz-dashboard-locations.inc`**（`include` 引用，需一并部署到 `/etc/nginx/conf.d/`）。关键片段：

  ```nginx
  location /__fmz_reactions/ {
      proxy_pass http://127.0.0.1:8787/;
      ...
  }
  ```

  **`proxy_pass` 末尾必须有 `/`**，否则路径会整段转发到 Node 导致 404。

- **安全组**：公网一般 **不必** 开放 **8787**；仅本机反代即可。

---

## 7. 赞踩自检脚本在仓库根目录：

```bash
# 本机直连 Node
node scripts/check-reactions.mjs http://127.0.0.1:8787

# 经 Nginx 同源路径
node scripts/check-reactions.mjs https://www.dianfanbao.net/__fmz_reactions
```

**自签 HTTPS** 时 Node 可能校验证书失败，仅用于排查时可临时：

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
node scripts/check-reactions.mjs https://www.dianfanbao.net/__fmz_reactions
```

**期望**：三步均为 JSON、`POST` 的 `code === 0`。

**若 GET 返回整页 HTML（带 `<!doctype`）**：说明 **`/__fmz_reactions/` 未反代到 8787**，请求落入了静态 **`try_files`**。需在服务器更新 Nginx 配置并 **`nginx -t && systemctl reload nginx`**，并确认 **reactions-server** 已监听。

**若 POST 为405**：多为该路径仍由静态 `location /` 处理或未允许 POST，同样先查 Nginx **`location /__fmz_reactions/`** 是否生效。

---

## 8. 快速对照表

| 步骤 | 命令或操作 |
|------|------------|
| 打包 | `npm run pack` |
| 提交 | `git add -A && git commit`（可与版本 bump 同一笔或分两笔，见 §3） |
| 推送 | `git push`（协作/备份需要时） |
| 发布 | `npm run deploy`（静态 + 若存在则 `opt/` 与 systemd；见 `deploy.mjs`） |
| 弹幕等服务**仅应急** | 单独 `scp` + `systemctl restart`（常规无需：已在 `release/.../opt/` 并由 deploy 同步） |
| 同步歌曲 | `rsync --exclude='source.*'` 到 `/opt/fmz-audio-server/data/audio/`（§11） |
| 验前端 | SSH 查看 `BUILD_INFO.txt` 或浏览器检查 `data-fmz-version` |
| 验赞踩 | `node scripts/check-reactions.mjs https://.../__fmz_reactions` |
| 验歌曲 | `curl -sk https://.../__fmz_audio/library` |
| 验弹幕 | `curl -sk https://.../__fmz_danmaku/triggers` |

---

### 8.1 深链（Hash）直达某页

主界面通过 **`#/路径`** 打开对应标签，便于收藏与 OBS 单链：

| 链接示例 | 说明 |
|----------|------|
| `.../index.html#/pre` | 预赛数据 · 总分排名 |
| `.../#/pre/gf` | 预赛数据 · **伐木值积分** |
| `.../#/pre/total` | 预赛 · 总分排名（显式） |
| `.../#/pre/nogf` | 预赛 · 除掉伐木值积分 |
| `.../#/pre/perround` | 预赛 · 每轮游戏排名 |
| `.../#/pre/logging` | 预赛 · 按日预赛伐木值 |
| `.../#/users` | 用户积分 |
| `.../#/battle` | 战斗爽（与顶栏同级） |
| `.../#/treasury` | 团员金库 |
| `.../#/songs` | 忽闻宝声（曲库） |
| `.../#/crimes` | 细数宝罪 |
| `.../#/danmaku` | 窃听宝语（斗鱼弹幕） |
| `.../#/ruins` | 废墟重建 · 调试（总览） |
| `.../#/ruins/playlist` 等 | 废墟子页（playlist / treasures / awards / admin） |
| `.../#captain-hud` 或 `.../#/captain-hud` | 仅战斗爽全屏（无顶栏，适合 OBS） |

切换标签或预赛子页时，地址栏会 **`replaceState`** 同步（不刷屏历史条目）。

---

## 9. 与本仓库其它文档的关系

- **根目录 [`README.md`](../README.md)**：规范、本地调试、`fmzFeatures`、代理端口、页签/插件、代码目录、打包发布索引。
- **`tencent-cdn-plan2-8443-origin.md`**：CDN 回源配置（控制台手动操作指南）。
- **`nginx-fmz-dashboard.conf`** + **`nginx-fmz-dashboard-locations.inc`**：完整站点与反代片段。
- SSH 密钥与连接方式见本文 **附录 A**。

---

## 10. 远端部署 reactions-server（TencentOS / RHEL8+ 备忘）

以下为在 **EL8 系**（含 TencentOS）上踩过的要点，供 AI / 运维复现。

1. **Nginx**：站点配置里必须包含 **`location /__fmz_reactions/`** 且 **`proxy_pass http://127.0.0.1:8787/;`**（**8787 后斜杠**）。若缺失，浏览器与自检脚本会看到 **HTML 而非 JSON**。
2. **Node 版本**：AppStream 自带的 **Node 10** 过旧；建议使用 [NodeSource 20.x](https://github.com/nodesource/distributions)：`setup_20.x` 后 **`dnf remove`** 旧 **`nodejs` / `npm`**，再 **`dnf install nodejs`**。
3. **编译 `better-sqlite3`**：系统默认 **g++** 可能不支持 **C++20**。需安装 **`gcc-toolset-12`**，并在 **`npm ci` 前执行**：`source /opt/rh/gcc-toolset-12/enable`（仅编译时需要；运行期不需要）。
4. **安装目录示例**：`/opt/fmz-reactions-server`（内含 **`reactions-server.mjs`**、`package.json`、`package-lock.json`，以及 **`npm ci`** 后的 **`node_modules`**）。数据库默认在同级 **`data/reactions.db`**。
5. **systemd**：单元示例见远端 **`/etc/systemd/system/fmz-reactions.service`**——**`WorkingDirectory`**指向上述目录，**`ExecStart=/usr/bin/node .../reactions-server.mjs`**，**`Environment=PORT=8787`**。修改单元后 **`systemctl daemon-reload && systemctl restart fmz-reactions`**。
6. **自检**：`node scripts/check-reactions.mjs https://www.dianfanbao.net/__fmz_reactions`（自签证书见上文 **`NODE_TLS_REJECT_UNAUTHORIZED`**）。

---

## 11. 歌曲库与音频服务（audio-extractor-server）部署

歌曲库（顶栏 **忽闻宝声**，原「歌曲库」Tab）依赖后端 **`audio-extractor-server.mjs`**（端口 **8789**）提供歌曲列表 API 和音频文件下载。发布时需要同时部署 **前端静态资源** + **后端服务** + **歌曲数据文件**。

### 11.1 Feature Flag

`package.json` 中 `fmzFeatures.audio` 必须为 **`true`**（非 `"local"`），否则发布构建时会被 `bump-patch.mjs` 降为 `false`，**忽闻宝声** Tab 不会出现。

```json
"fmzFeatures": {
  "audio": true
}
```

### 11.2 歌曲数据目录结构

歌曲数据存储在 **`server/data/audio/`**，按 BV 号和分 P 组织：

```
server/data/audio/
├── BV1xxxxxxxxx/
│   ├── video_info.json          # 视频元信息
│   ├── source.mp3               # 完整音频（可选，体积大）
│   └── music/
│       ├── metadata.json        # 歌曲元数据（label、时间戳等）
│       ├── [00_01_30-00_04_15] 01.mp3
│       └── [00_05_00-00_08_30] 02.mp3
├── BV1yyyyyyyyy/
│   ├── p2/                      # 多 P 视频的子目录
│   │   ├── video_info.json
│   │   ├── source.mp3
│   │   └── music/
│   │       ├── metadata.json
│   │       └── ...
│   └── p3/
│       └── ...
```

**关键规则**：
- **`music/` 目录下的 `.mp3` 文件**是实际歌曲，必须同步到服务器
- **`metadata.json`** 包含歌曲标签、时间范围等元数据，必须同步
- **`video_info.json`** 包含视频 URL 和提取时间，必须同步
- **`source.mp3`** 是完整音频源文件，**体积很大（通常 30–100MB）**，可选择不同步以节省空间和带宽；不影响歌曲库功能（歌曲库只读取 `music/` 下的分割文件）

### 11.3 服务器端部署

#### 11.3.1 安装目录

建议将 `audio-extractor-server.mjs` 放在 **`/opt/fmz-audio-server/`**：

```bash
mkdir -p /opt/fmz-audio-server
# 从本地上传服务端脚本
scp -i "D:/path/to/your-key.pem" server/audio-extractor-server.mjs root@118.195.150.4:/opt/fmz-audio-server/
```

#### 11.3.2 歌曲数据同步

歌曲数据需要从本地 `server/data/audio/` 同步到服务器。**推荐使用 rsync 增量同步**（只传输新增/变更的文件）：

**Windows PowerShell 示例（通过 scp 递归上传）：**

```powershell
# 同步所有歌曲数据（含 source.mp3，完整但体积大）
scp -i "D:/path/to/your-key.pem" -o StrictHostKeyChecking=accept-new `
  -r .\server\data\audio\ `
  root@118.195.150.4:/opt/fmz-audio-server/data/audio/

# 仅同步歌曲文件（排除 source.mp3，节省带宽）
# 需要在服务器上使用 rsync：
# rsync -avz --exclude='source.*' -e "ssh -i D:/path/to/your-key.pem" ./server/data/audio/ root@118.195.150.4:/opt/fmz-audio-server/data/audio/
```

**Linux / WSL 示例（推荐，支持增量 + 排除）：**

```bash
rsync -avz --progress \
  --exclude='source.*' \
  -e "ssh -i D:/path/to/your-key.pem" \
  ./server/data/audio/ \
  root@118.195.150.4:/opt/fmz-audio-server/data/audio/
```

#### 11.3.3 环境变量

`audio-extractor-server.mjs` 默认从脚本同级的 `data/audio/` 读取数据。如果数据目录不在默认位置，可通过环境变量覆盖：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUDIO_PORT` | `8789` | 监听端口 |

服务器上的数据目录结构应为：

```
/opt/fmz-audio-server/
├── audio-extractor-server.mjs
└── data/
    └── audio/
        ├── BV1xxxxxxxxx/
        │   └── music/...
        └── BV1yyyyyyyyy/
            └── ...
```

#### 11.3.4 依赖

音频服务是纯 Node.js 脚本，**无 npm 依赖**（不需要 `npm ci`）。但以下外部工具在**提取新歌曲时**需要（仅播放/浏览已有歌曲不需要）：

- **yt-dlp**：从 B 站下载音频
- **ffmpeg**：音频转码与分割
- **Python 3 + music_detector.py**：歌曲片段检测

如果服务器仅用于**托管已提取的歌曲**（不在服务器上提取新歌曲），则 **不需要** 安装 yt-dlp / ffmpeg / Python。

#### 11.3.5 systemd 服务

创建 **`/etc/systemd/system/fmz-audio.service`**：

```ini
[Unit]
Description=FMZ Audio Extractor Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/fmz-audio-server
ExecStart=/usr/bin/node /opt/fmz-audio-server/audio-extractor-server.mjs
Environment=AUDIO_PORT=8789
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable fmz-audio
systemctl start fmz-audio
systemctl status fmz-audio
```

#### 11.3.6 Nginx 反代

在 **`nginx-fmz-dashboard.conf`** 中已包含音频服务的反代配置：

```nginx
location /__fmz_audio/ {
    proxy_pass http://127.0.0.1:8789/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    client_max_body_size 200m;
}
```

**注意**：
- **`proxy_pass` 末尾必须有 `/`**
- **超时设置较长**（300s）：因为音频提取可能耗时较久
- **`client_max_body_size 200m`**：允许上传大文件（未来可能需要）
- 更新 Nginx 配置后执行：`nginx -t && systemctl reload nginx`

### 11.4 自检

```bash
# 1. 检查服务是否运行
curl http://127.0.0.1:8789/check
# 期望：{"ok":true,"ytdlp":...,"ffmpeg":...,"message":"..."}

# 2. 检查歌曲库 API
curl http://127.0.0.1:8789/library
# 期望：{"ok":true,"videos":[...]}

# 3. 经 Nginx 反代检查
curl -sk https://www.dianfanbao.net/__fmz_audio/library
# 期望：同上
```

### 11.5 歌曲发布快速对照表

| 步骤 | 命令或操作 | 说明 |
|------|------------|------|
| 确认 feature flag | `package.json` → `fmzFeatures.audio: true` | 非 `"local"` |
| 打包前端 | `npm run pack` | 忽闻宝声 Tab 会包含在构建中 |
| 上传前端 | `scp` 到 `/var/www/fmz-dashboard/` | 同 §4 |
| 上传服务端脚本 | `scp audio-extractor-server.mjs` → `/opt/fmz-audio-server/` | 仅脚本变更时需要 |
| 同步歌曲数据 | `scp -r` 或 `rsync` → `/opt/fmz-audio-server/data/audio/` | **增量同步，排除 source.mp3** |
| 启动/重启服务 | `systemctl restart fmz-audio` | 脚本变更后需要 |
| 更新 Nginx | 上传 conf → `nginx -t && systemctl reload nginx` | 仅首次或配置变更时 |
| 自检 | `curl .../library` | 确认歌曲列表正常返回 |

### 11.6 日常新增歌曲的发布流程

当在本地提取了新歌曲后，只需要增量同步歌曲数据到服务器，**不需要** 重新打包前端或重启服务：

```bash
# 增量同步新歌曲（rsync 只传输新增/变更的文件）
rsync -avz --progress --exclude='source.*' \
  -e "ssh -i D:/path/to/your-key.pem" \
  ./server/data/audio/ \
  root@118.195.150.4:/opt/fmz-audio-server/data/audio/
```

歌曲库前端会自动从 `/library` API 获取最新列表，无需任何额外操作。

---

## 12. 大陆环境 HTTPS（直连 443 异常、8443 可访问：走 CDN）

部分网络下访客 **直连 CVM `443`** 可能被链路干扰，但 **`8443`** 正常。在用户侧仍以 **`https://www.域名`** 访问时，需要在 **腾讯云控制台** 配置 **CDN（或 EdgeOne）**：边缘 **443**，**HTTPS 回源到 `服务器IP:8443`**；并在 DNS 把 **`www` 改为 CDN 分配的 CNAME**。**无法通过本仓库脚本或远端 SSH 代你登录控制台完成**。详细点击顺序、`/__fmz_*` 勿缓存、`dianfanbao.net` apex 的处理，见：**`deploy/tencent-cdn-plan2-8443-origin.md`**。

---

## 13. 弹幕捕捉服务（douyu-danmaku-server）部署

弹幕捕捉（`🎯 窃听宝语` Tab）依赖后端 **`douyu-danmaku-server.mjs`**（端口 **8791**）提供弹幕 SSE 推送、触发器管理和点歌统计。

### 13.1 Feature Flag

`package.json` 中 `fmzFeatures.douyuDanmaku` 必须为 **`true`**。

### 13.2 服务器端部署

#### 安装目录

```bash
mkdir -p /opt/fmz-danmaku-server
scp -i "D:/path/to/your-key.pem" server/douyu-danmaku-server.mjs root@118.195.150.4:/opt/fmz-danmaku-server/
```

#### systemd 服务

创建 **`/etc/systemd/system/fmz-danmaku.service`**：

```ini
[Unit]
Description=FMZ Douyu Danmaku Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/fmz-danmaku-server
ExecStart=/usr/bin/node /opt/fmz-danmaku-server/douyu-danmaku-server.mjs
Restart=always
RestartSec=5
Environment=PORT=8791

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable fmz-danmaku
systemctl start fmz-danmaku
systemctl status fmz-danmaku
```

#### Nginx 反代

已在 **`nginx-fmz-dashboard-locations.inc`** 中配置：

```nginx
location /__fmz_danmaku/ {
    proxy_pass http://127.0.0.1:8791/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    chunked_transfer_encoding on;
}
```

**注意**：SSE 需要 `proxy_buffering off` 和长超时。

### 13.3 数据持久化

服务运行时数据存储在 **`/opt/fmz-danmaku-server/data/danmaku/`**：

- `backend-rooms.json`：已添加的直播间列表（服务重启后自动恢复连接）
- `triggers.json`：触发器配置
- `action-log.json`：触发日志
- `song-requests/`：各直播间点歌统计
- `records/`：弹幕录制文件

### 13.4 自检

```bash
# 检查服务是否运行
curl http://127.0.0.1:8791/triggers
# 期望：{"ok":true,"triggers":[...]}

# 经 Nginx 反代检查
curl -sk https://www.dianfanbao.net/__fmz_danmaku/triggers
```

### 13.5 更新流程

弹幕服务脚本变更后：

```bash
scp -i "D:/path/to/your-key.pem" server/douyu-danmaku-server.mjs root@118.195.150.4:/opt/fmz-danmaku-server/
ssh -i "D:/path/to/your-key.pem" root@118.195.150.4 "systemctl restart fmz-danmaku"
```

**无需重新打包前端**（除非前端也有变更）。

---

## 附录 A：SSH 连接与密钥

**以本机为准**：`scripts/deploy.mjs` 默认私钥为 **`D:\nimda1.pem`**、主机 **`118.195.150.4`**；推荐复制 [`deploy/deploy.local.env.example`](deploy.local.env.example) 为 `deploy.local.env` 后按需覆盖。下文 **IP / 路径** 仅为历史示例。

### 服务器信息（示例）

| 项目 | 值 |
|------|-----|
| 公网 IP | `118.195.150.4` |
| 用户名 | `root` |
| Web 根目录 | `/var/www/fmz-dashboard/` |

### 连接命令（示例）

```powershell
ssh -i "D:\nimda1.pem" root@118.195.150.4
```

### 密钥权限（Windows）

首次使用需设置仅当前用户可读，否则 OpenSSH 报 `Permissions too open`：

```powershell
icacls "D:\nimda1.pem" /inheritance:r
icacls "D:\nimda1.pem" /grant:r "%USERDOMAIN%\%USERNAME%:(R)"
```

### 安全组入站规则

TCP 22（SSH）、80、443、8443 放行。

### 安全提醒

- 不要把 `.pem` 内容粘贴到聊天或提交到 Git。
- 若私钥曾泄露，请在腾讯云控制台「更换/作废」密钥并重新绑定。

