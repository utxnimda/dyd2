# fmz-dashboard：版本发布与远端部署（供维护者 / AI 参考）

本文描述从改版本号到静态资源上线、以及赞踩服务自检的固定流程。细节 SSH 与密钥路径见同目录 **`连接服务器与部署步骤.txt`**。

---

## 1. 版本号与构建标签

- 编辑仓库根目录 **`package.json`**：
  - **`version`**：语义化版本，如 `0.4.0`。
  - **`fmzReleaseLabel`**：界面与归档目录名，如 `v0.4`（建议与主版本一致）。
- 同步根目录 **`package-lock.json`** 顶层 `"version"` 及 `packages[""].version`（与 `package.json` 的 `version` 一致）。
- 构建时 **`vite.config.ts`** 会把 `version` / `fmzReleaseLabel` 注入为全局常量，并写入 **`index.html`** 的 `data-fmz-version`、`data-fmz-label`。

自检本地构建结果：

```text
dist/index.html 或 release/<fmzReleaseLabel>/index.html
```

应含例如：`data-fmz-version="0.4.0"`、`data-fmz-label="v0.4"`。

---

## 2. 打包

在仓库根目录执行：

```bash
npm run pack
```

等价于 **`vite build`** 后再执行 **`scripts/pack-release.mjs`**，将 **`dist/`** 复制到 **`release/<fmzReleaseLabel>/`**，并生成 **`BUILD_INFO.txt`**（时间戳与版本元数据）。

注意：**`release/`** 在 **`.gitignore`** 中，**不会**随 Git 推送；上线依赖本机或 CI 产物再 **SCP/同步**。

仅构建不落盘归档时可用：

```bash
npm run build
```

---

## 3. 推代码（可选）

静态站点**不会**因 `git push` 自动更新。推送仅用于备份与协作：

```bash
git add -A
git commit -m "release: fmz-dashboard v0.4.0"
git push origin main
```

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
  -r .\release\v0.4\assets `
  .\release\v0.4\index.html `
  .\release\v0.4\BUILD_INFO.txt `
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
| 上传静态 | `scp` 到 `/var/www/fmz-dashboard/` |
| 验前端 | `curl -sk https://.../` 看 `data-fmz-version` |
| 验赞踩 | `node scripts/check-reactions.mjs https://.../__fmz_reactions` |
| 服务端 | Nginx `location /__fmz_reactions/` + 本机 `server` 进程 |

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
| `.../#/treasury` | 团员金库（含四角看板） |
| `.../#captain-hud` 或 `.../#/captain-hud` | 仅四角看板全屏 |

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
