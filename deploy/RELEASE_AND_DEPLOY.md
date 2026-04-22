# fmz-dashboard：版本发布与远端部署（供维护者 / AI 参考）

本文描述从改版本号到静态资源上线、以及赞踩服务自检的固定流程。细节 SSH 与密钥路径见同目录 **`连接服务器与部署步骤.txt`**。

---

## 1. 版本号与构建标签

- 编辑仓库根目录 **`package.json`**：
  - **`version`**：语义化版本，如 `0.4.0`。
  - **`fmzReleaseLabel`**：界面与归档目录名，如 `v0.71`（可与 `version` 的展示约定一致，见下文示例）。
- 同步根目录 **`package-lock.json`** 顶层 `"version"` 及 `packages[""].version`（与 `package.json` 的 `version` 一致）。
- 构建时 **`vite.config.ts`** 会把 `version` / `fmzReleaseLabel` 注入为全局常量，并写入 **`index.html`** 的 `data-fmz-version`、`data-fmz-label`。

自检本地构建结果：

```text
dist/index.html 或 release/<fmzReleaseLabel>/index.html
```

应含例如：`data-fmz-version="0.7.1"`、`data-fmz-label="v0.71"`。

---

## 2. 打包

在仓库根目录执行：

```bash
npm run pack
```

等价于 **`vite build`** 后再执行 **`scripts/pack-release.mjs`**，将 **`dist/`** 复制到 **`release/<fmzReleaseLabel>/`**，并生成 **`BUILD_INFO.txt`**（时间戳与版本元数据）。同一归档内还会按**实际发布**的模块，把本机 **`server/data/`** 的对应子路径复制到 **`release/<fmzReleaseLabel>/server/data/`**（如歌曲库 → `audio/`，赞踩相关 → `reactions.db`；**不含** `defense_tower.db`，该库由服务在线拉取/生成，不随包分发）；若本地无该路径则提示跳过。可选： **`--skip-data`** 只打前端不打数据；**`--exclude-audio-source`** 归档 `audio` 时排除各 BV 下的 `source.*` 大文件（与 §11.3.2 的增量策略一致）。**`BUILD_INFO.txt`** 中 **`archivedServerData`** 会列出本次纳入的相对路径。

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
4. **`--yes` 参数**：仅限 CI 场景跳过交互确认，人工发布时**禁止使用**。

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

## 3. 发布流程（推荐顺序：先入库，再推送）

静态站点**不会**在 `git push` 后自动更新；**源码与文档**仍需先进入版本库并推送到远端，便于备份与协作。建议按下面顺序操作（与 §4的服务器同步相互独立）：

1. **改版本号**：完成 §1（`package.json`、`package-lock.json` 顶层版本与 `fmzReleaseLabel`）。
2. **本地打包自检**：执行 §2 的 `npm run pack`，打开 `release/<fmzReleaseLabel>/index.html` 或检查其中 `data-fmz-version` / `data-fmz-label` 是否为预期。
3. **入库（Git 提交）**：提交本次发布相关的**源码与文档**（含 `package.json` / `package-lock.json`、`deploy/RELEASE_AND_DEPLOY.md` 等）。**不要**提交 `dist/`、`release/`（已在 `.gitignore`）。
4. **推送到远端**：`git push` 到约定分支（如 `main`）。

示例（分支名按仓库实际为准）：

```bash
git add -A
git status
git commit -m "release: fmz-dashboard v0.7.1 (v0.71)"
git push origin main
```

完成后再按 §4 将本机 **`release/<fmzReleaseLabel>/`** 同步到 Web 服务器。

---

## 4. 远端静态资源部署（腾讯云示例）

目标主机、用户与 Web 根目录以实际环境为准；示例与 **`连接服务器与部署步骤.txt`** 一致：

- **Web 根目录**：`/var/www/fmz-dashboard/`
- **上传对象**：优先 **`release/<fmzReleaseLabel>/`** 下的 **`index.html`**、**`assets/`**、（可选）**`BUILD_INFO.txt`**

**Windows PowerShell（OpenSSH `scp`）示例：**

```powershell
Set-Location "D:\path\to\fmz-dashboard"
npm run pack
scp -i "C:\path\to\YOUR_KEY.pem" -o StrictHostKeyChecking=accept-new `
  -r .\release\v0.71\assets `
  .\release\v0.71\index.html `
  .\release\v0.71\BUILD_INFO.txt `
  root@YOUR_SERVER_IP:/var/www/fmz-dashboard/
```

上传后 **无需** 为纯静态文件重启 Nginx（除非改了 Nginx 配置本身）。

---

## 5. 验证前端版本是否已生效

用 **HTTPS** 拉首页（自签证书需 **`curl -k`**）：

```bash
curl -sk "https://YOUR_SERVER_IP/" | findstr /i "data-fmz"
```

或浏览器「查看网页源代码」，应看到当前 **`data-fmz-version`** / **`data-fmz-label`**，且 **`/assets/index-*.js`** 哈希与本地 **`release/.../index.html`** 一致。

若仍为旧哈希或无 `data-fmz-*`，说明 **SCP 未执行、路径不对或浏览器 CDN缓存**（可强刷或无痕）。

---

## 6. 赞踩服务（reactions-server）与 Nginx

- **进程**：仓库 **`server/`**，默认监听 **`127.0.0.1:8787`**（`PORT` 可改）。生产环境需在服务器上 **`npm ci && npm start`** 或由 systemd 保活。
- **Nginx**：参考 **`deploy/nginx-fmz-dashboard.conf`**。关键片段：

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

# 经 Nginx 同源路径（替换为你的域名或 IP）
node scripts/check-reactions.mjs https://YOUR_SERVER_IP/__fmz_reactions
```

**自签 HTTPS** 时 Node 可能校验证书失败，仅用于排查时可临时：

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
node scripts/check-reactions.mjs https://YOUR_SERVER_IP/__fmz_reactions
```

**期望**：三步均为 JSON、`POST` 的 `code === 0`。

**若 GET 返回整页 HTML（带 `<!doctype`）**：说明 **`/__fmz_reactions/` 未反代到 8787**，请求落入了静态 **`try_files`**。需在服务器更新 Nginx 配置并 **`nginx -t && systemctl reload nginx`**，并确认 **reactions-server** 已监听。

**若 POST 为405**：多为该路径仍由静态 `location /` 处理或未允许 POST，同样先查 Nginx **`location /__fmz_reactions/`** 是否生效。

---

## 8. 快速对照表

| 步骤 | 命令或操作 |
|------|------------|
| 改版本 | 编辑 `package.json` + `package-lock.json` 顶层版本 |
| 打包 | `npm run pack` → `release/<fmzReleaseLabel>/` |
| 入库 | `git add` / `git commit`（勿提交 `release/`、`dist/`） |
| 推送 | `git push origin main`（分支按实际） |
| 上传静态 | `scp` 到 `/var/www/fmz-dashboard/` |
| 同步歌曲 | `rsync --exclude='source.*'` 到 `/opt/fmz-audio-server/data/audio/`（§11） |
| 验前端 | `curl -sk https://.../` 看 `data-fmz-version` |
| 验赞踩 | `node scripts/check-reactions.mjs https://.../__fmz_reactions` |
| 验歌曲 | `curl -sk https://.../__fmz_audio/library` 看歌曲列表 |
| 服务端 | Nginx `location /__fmz_reactions/` + `/__fmz_audio/` + 对应进程 |

---

## 8b. 深链（Hash）直达某页

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
| `.../#/songs` | 🎶 歌曲库 |
| `.../#captain-hud` 或 `.../#/captain-hud` | 仅战斗爽全屏（无顶栏，适合 OBS） |

切换标签或预赛子页时，地址栏会 **`replaceState`** 同步（不刷屏历史条目）。

---

## 9. 与本仓库其它文档的关系

- **`连接服务器与部署步骤.txt`**：SSH、密钥权限、**`tencent-cloud-setup.sh`** 用法。
- **`nginx-fmz-dashboard.conf`**：完整站点与反代片段，部署前替换 **`YOUR_DOMAIN_OR_IP`**。

---

## 10. 远端部署 reactions-server（TencentOS / RHEL8+ 备忘）

以下为在 **EL8 系**（含 TencentOS）上踩过的要点，供 AI / 运维复现。

1. **Nginx**：站点配置里必须包含 **`location /__fmz_reactions/`** 且 **`proxy_pass http://127.0.0.1:8787/;`**（**8787 后斜杠**）。若缺失，浏览器与自检脚本会看到 **HTML 而非 JSON**。
2. **Node 版本**：AppStream 自带的 **Node 10** 过旧；建议使用 [NodeSource 20.x](https://github.com/nodesource/distributions)：`setup_20.x` 后 **`dnf remove`** 旧 **`nodejs` / `npm`**，再 **`dnf install nodejs`**。
3. **编译 `better-sqlite3`**：系统默认 **g++** 可能不支持 **C++20**。需安装 **`gcc-toolset-12`**，并在 **`npm ci` 前执行**：`source /opt/rh/gcc-toolset-12/enable`（仅编译时需要；运行期不需要）。
4. **安装目录示例**：`/opt/fmz-reactions-server`（内含 **`reactions-server.mjs`**、`package.json`、`package-lock.json`，以及 **`npm ci`** 后的 **`node_modules`**）。数据库默认在同级 **`data/reactions.db`**。
5. **systemd**：单元示例见远端 **`/etc/systemd/system/fmz-reactions.service`**——**`WorkingDirectory`**指向上述目录，**`ExecStart=/usr/bin/node .../reactions-server.mjs`**，**`Environment=PORT=8787`**。修改单元后 **`systemctl daemon-reload && systemctl restart fmz-reactions`**。
6. **自检**：`node scripts/check-reactions.mjs https://服务器/__fmz_reactions`（自签证书见上文 **`NODE_TLS_REJECT_UNAUTHORIZED`**）。

---

## 11. 歌曲库与音频服务（audio-extractor-server）部署

歌曲库（`🎶 歌曲库` Tab）依赖后端 **`audio-extractor-server.mjs`**（端口 **8789**）提供歌曲列表 API 和音频文件下载。发布时需要同时部署 **前端静态资源** + **后端服务** + **歌曲数据文件**。

### 11.1 Feature Flag

`package.json` 中 `fmzFeatures.audio` 必须为 **`true`**（非 `"local"`），否则发布构建时会被 `bump-patch.mjs` 降为 `false`，歌曲库 Tab 不会出现。

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
scp -i KEY server/audio-extractor-server.mjs root@SERVER:/opt/fmz-audio-server/
```

#### 11.3.2 歌曲数据同步

歌曲数据需要从本地 `server/data/audio/` 同步到服务器。**推荐使用 rsync 增量同步**（只传输新增/变更的文件）：

**Windows PowerShell 示例（通过 scp 递归上传）：**

```powershell
# 同步所有歌曲数据（含 source.mp3，完整但体积大）
scp -i "E:\Workspace\pem\nimda_tencent.pem" -o StrictHostKeyChecking=accept-new `
  -r .\server\data\audio\ `
  root@118.195.150.4:/opt/fmz-audio-server/data/audio/

# 仅同步歌曲文件（排除 source.mp3，节省带宽）
# 需要在服务器上使用 rsync：
# rsync -avz --exclude='source.*' -e "ssh -i KEY" ./server/data/audio/ root@SERVER:/opt/fmz-audio-server/data/audio/
```

**Linux / WSL 示例（推荐，支持增量 + 排除）：**

```bash
rsync -avz --progress \
  --exclude='source.*' \
  -e "ssh -i E:/Workspace/pem/nimda_tencent.pem" \
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
| 打包前端 | `npm run pack` | 歌曲库 Tab 会包含在构建中 |
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
  -e "ssh -i E:/Workspace/pem/nimda_tencent.pem" \
  ./server/data/audio/ \
  root@118.195.150.4:/opt/fmz-audio-server/data/audio/
```

歌曲库前端会自动从 `/library` API 获取最新列表，无需任何额外操作。
