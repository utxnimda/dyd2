/**
 * deploy.mjs — Automated deploy script for fmz-dashboard
 *
 * Uploads the latest release to the remote server and cleans up
 * stale asset files that are no longer referenced by the current build.
 *
 * Usage:
 *   node scripts/deploy.mjs            # deploy latest release label
 *   node scripts/deploy.mjs v1.1.20    # deploy a specific release label
 *
 * Steps performed:
 *   1. Read package.json to determine the release label
 *   2. Verify the release directory exists locally
 *   3. SCP upload assets/, index.html, BUILD_INFO.txt to remote
 *   4. SSH to remote: list assets/ files, diff against local release,
 *      delete any files not present in the current release
 *   5. 若 release/<label>/opt/ 存在：将各子目录同步到远端 /opt/<同名>/，
 *      对需依赖的目录执行 npm install --omit=dev，并 systemctl restart 对应单元
 *   6. 若 FMZ_DEPLOY_SYNC_NGINX=1 且存在 release/config/nginx：上传到远端 conf.d 并 nginx reload
 *   7. SSH verify BUILD_INFO.txt on remote
 *
 * SSH/远端路径：自动读取 deploy/deploy.local.env 与 deploy/servers.json；
 *   FMZ_DEPLOY_TARGET（dianfanbao | tencent-43）选择预设，或用环境变量覆盖单项。
 *   也可：node scripts/deploy.mjs --target=tencent-43
 * PowerShell 可先执行 . ./deploy/load-deploy-env.ps1 加载 deploy.local.env。
 *   FMZ_DEPLOY_SSH_KEY、FMZ_DEPLOY_SSH_USER、FMZ_DEPLOY_SSH_HOST、FMZ_DEPLOY_WEB_ROOT
 * 仅发布静态、不同步后端：FMZ_DEPLOY_SKIP_BACKEND=1
 * 同步 Nginx 片段至远端（覆盖 /etc/nginx/conf.d 下同名文件）：FMZ_DEPLOY_SYNC_NGINX=1
 * 远端 conf.d 目录（可选）：FMZ_DEPLOY_NGINX_CONF_D=/etc/nginx/conf.d
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { OPT_TO_SYSTEMD, systemdUnitsToStop } from "./fmz-opt-bundles.mjs";
import {
  parseDeployTargetArg,
  resolveDeployConfig,
  stripDeployCliFlags,
} from "./fmz-deploy-env.mjs";
import {
  filterOptDirsForDeploy,
  resolveAiGateway,
  writeNginxRemoteSecretInc,
  writeNginxRemoteUpstreamsConf,
} from "./fmz-server-roles.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */
let deployCfg;
try {
  deployCfg = resolveDeployConfig({
    rootDir: root,
    targetId: parseDeployTargetArg() || undefined,
  });
} catch (e) {
  console.error(`❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const {
  sshKey: SSH_KEY,
  remoteUser: REMOTE_USER,
  remoteHost: REMOTE_HOST,
  webRoot: REMOTE_WEB_ROOT,
  targetId: DEPLOY_TARGET,
  targetLabel: DEPLOY_TARGET_LABEL,
  deployStatic: DEPLOY_STATIC,
} = deployCfg;
const AI_GATEWAY =
  DEPLOY_TARGET === "tencent-43" ? { host: REMOTE_HOST, targetId: "tencent-43" } : resolveAiGateway(DEPLOY_TARGET);
const REMOTE_SERVICE_SECRET = (process.env.FMZ_REMOTE_SERVICE_SECRET || "").trim();
const SSH_CMD = `ssh -i "${SSH_KEY}" ${REMOTE_USER}@${REMOTE_HOST}`;
const SCP_CMD = `scp -i "${SSH_KEY}"`;
const SKIP_BACKEND =
  process.env.FMZ_DEPLOY_SKIP_BACKEND === "1" || /^true$/i.test(process.env.FMZ_DEPLOY_SKIP_BACKEND || "");
const SYNC_NGINX =
  process.env.FMZ_DEPLOY_SYNC_NGINX === "1" || /^true$/i.test(process.env.FMZ_DEPLOY_SYNC_NGINX || "");
const REMOTE_NGINX_CONF_D = (process.env.FMZ_DEPLOY_NGINX_CONF_D || "/etc/nginx/conf.d").replace(/\/+$/, "");

/** 同步后需在远端安装原生/依赖模块的服务目录 */
const OPT_NEEDS_NPM = new Set([
  "fmz-ai-agent-server",
  "fmz-reactions-server",
  "fmz-defense-server",
]);

if (!existsSync(SSH_KEY)) {
  console.error(`❌ SSH 私钥不存在: ${SSH_KEY}`);
  console.error(
    "   请放置密钥到该路径，或设置 FMZ_DEPLOY_SSH_KEY；"
      + "也可在 deploy/deploy.local.env 中填写后执行：. ./deploy/load-deploy-env.ps1",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Determine release label                                            */
/* ------------------------------------------------------------------ */
const explicitLabel = stripDeployCliFlags()[0];
let label;

if (explicitLabel) {
  label = explicitLabel;
} else {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  label = String(pkg.fmzReleaseLabel ?? `v${pkg.version}`).trim() || "v0.0.0";
}

const releaseDir = join(root, "release", label);
const assetsDir = join(releaseDir, "assets");

console.log("");
console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║              🚀 远端部署（Remote Deploy）                ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  版本: ${label.padEnd(48)}║`);
console.log(`║  目标: ${DEPLOY_TARGET} (${DEPLOY_TARGET_LABEL})`.padEnd(57) + "║");
console.log(`║  远端: ${REMOTE_HOST}:${REMOTE_WEB_ROOT}`.padEnd(57) + "║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log("");

/* ------------------------------------------------------------------ */
/*  Verify local release exists                                        */
/* ------------------------------------------------------------------ */
if (!existsSync(releaseDir)) {
  console.error(`❌ 本地 release 目录不存在: release/${label}/`);
  console.error(`   请先执行 npm run pack`);
  process.exit(1);
}

if (DEPLOY_STATIC) {
  if (!existsSync(join(releaseDir, "index.html"))) {
    console.error(`❌ release/${label}/index.html 不存在`);
    process.exit(1);
  }
  if (!existsSync(assetsDir)) {
    console.error(`❌ release/${label}/assets/ 不存在`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: run command and return stdout                               */
/* ------------------------------------------------------------------ */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: opts.silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
      ...opts,
    }).trim();
  } catch (e) {
    if (opts.ignoreError) return "";
    console.error(`\n❌ 命令执行失败: ${cmd}`);
    console.error(e.message);
    process.exit(1);
  }
}

if (DEPLOY_STATIC) {
  const localAssets = new Set(readdirSync(assetsDir));
  console.log(`📦 本地 assets 文件数: ${localAssets.size}\n`);

  console.log("📤 上传静态资源到远端...");
  run(`${SSH_CMD} "mkdir -p ${REMOTE_WEB_ROOT}"`);
  const scpSources = [
    join(releaseDir, "assets"),
    join(releaseDir, "index.html"),
    join(releaseDir, "BUILD_INFO.txt"),
  ]
    .map((p) => `"${p}"`)
    .join(" ");
  const uploadCmd = `${SCP_CMD} -r ${scpSources} ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_WEB_ROOT}/`;
  console.log(`   $ ${uploadCmd}`);
  run(uploadCmd);
  console.log("   ✅ 上传完成\n");

  console.log("🧹 清理远端旧 assets 文件...");
  const remoteListRaw = run(`${SSH_CMD} "ls ${REMOTE_WEB_ROOT}/assets/"`, { silent: true });
  if (!remoteListRaw) {
    console.log("   远端 assets 目录为空，无需清理\n");
  } else {
    const remoteFiles = remoteListRaw.split("\n").map((s) => s.trim()).filter(Boolean);
    const staleFiles = remoteFiles.filter((f) => !localAssets.has(f));
    if (staleFiles.length === 0) {
      console.log(`   远端共 ${remoteFiles.length} 个文件，全部为当前版本所需，无需清理\n`);
    } else {
      console.log(`   远端共 ${remoteFiles.length} 个文件，其中 ${staleFiles.length} 个为旧版本残留：`);
      for (const f of staleFiles) console.log(`     🗑️  ${f}`);
      const rmPaths = staleFiles.map((f) => `${REMOTE_WEB_ROOT}/assets/${f}`).join(" ");
      run(`${SSH_CMD} "rm -f ${rmPaths}"`);
      console.log(`   ✅ 已删除 ${staleFiles.length} 个旧文件\n`);
    }
  }
} else {
  console.log("📤 跳过静态资源（AI 网关机仅部署 /opt 后端）\n");
}

/* ------------------------------------------------------------------ */
/*  Step 3: Sync release/opt → remote /opt (后端脚本，与版本同发)         */
/* ------------------------------------------------------------------ */
const optLocalRoot = join(releaseDir, "opt");
if (!SKIP_BACKEND && existsSync(optLocalRoot)) {
  let optDirs = readdirSync(optLocalRoot).filter((name) => {
    try {
      return statSync(join(optLocalRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  optDirs = filterOptDirsForDeploy(DEPLOY_TARGET, optDirs);
  if (AI_GATEWAY && DEPLOY_TARGET === "dianfanbao") {
    console.log(
      `   ℹ️  主站 AI 走远端网关 ${AI_GATEWAY.aiAgentUrl ?? `http://${AI_GATEWAY.host}:8792`}，跳过本地 opt：${(AI_GATEWAY.optSkipOnPrimary || []).join(", ")}`,
    );
  }

  if (optDirs.length > 0) {
    console.log("🖥️  同步 release/opt 后端到远端 /opt/ ...");
    const units = [];
    for (const name of optDirs) {
      const unit = OPT_TO_SYSTEMD[name];
      if (!unit) {
        console.log(`   ⚠️  跳过未知目录 opt/${name}（未配置 systemd 映射）`);
        continue;
      }
      const from = join(optLocalRoot, name);
      const uploadOpt = `${SCP_CMD} -r "${from}" ${REMOTE_USER}@${REMOTE_HOST}:/opt/`;
      console.log(`   $ ${uploadOpt}`);
      run(uploadOpt);
      units.push(unit);
      console.log(`   ✅ 已同步 → /opt/${name}/`);
    }
    const uniqueUnits = [...new Set(units)];
    if (uniqueUnits.length > 0) {
      if (DEPLOY_TARGET === "tencent-43") {
        const cfgSystemd = join(releaseDir, "config", "systemd");
        for (const unit of ["fmz-ai-agent.service", "fmz-voice-clone.service"]) {
          const localUnit = join(cfgSystemd, unit);
          if (existsSync(localUnit)) {
            run(`${SCP_CMD} "${localUnit}" ${REMOTE_USER}@${REMOTE_HOST}:/etc/systemd/system/${unit}`);
            console.log(`   ✅ 已上传 systemd → /etc/systemd/system/${unit}`);
          }
        }
        run(`${SSH_CMD} "systemctl daemon-reload"`);
      }
      const npmSteps = [];
      for (const name of optDirs) {
        if (OPT_NEEDS_NPM.has(name) && OPT_TO_SYSTEMD[name]) {
          npmSteps.push(`cd /opt/${name} && npm install --omit=dev`);
        }
      }
      const npmJoined = npmSteps.length ? `${npmSteps.join(" && ")} && ` : "";
      const restartCmd = `${npmJoined}systemctl enable ${uniqueUnits.join(" ")} && systemctl restart ${uniqueUnits.join(" ")}`;
      console.log("\n   🔁 远端依赖安装（如有）并 enable + restart: " + uniqueUnits.join(", "));
      run(`${SSH_CMD} "${restartCmd}"`);
      console.log("   ✅ 后端服务已重启\n");
    }
    const danmakuEnvLocal = join(releaseDir, "config", "danmaku.env");
    const danmakuAiGwLocal = join(releaseDir, "config", "danmaku-ai-gateway.env");
    if (optDirs.includes("fmz-danmaku-server") && existsSync(danmakuEnvLocal)) {
      console.log("📝 同步 danmaku.env（dream-bus-only）→ /opt/fmz-danmaku-server/ …");
      const uploadEnv = `${SCP_CMD} "${danmakuEnvLocal}" ${REMOTE_USER}@${REMOTE_HOST}:/opt/fmz-danmaku-server/danmaku.env`;
      console.log(`   $ ${uploadEnv}`);
      run(uploadEnv);
      run(`${SSH_CMD} "systemctl restart fmz-danmaku"`);
      console.log("   ✅ danmaku.env 已更新并重启 fmz-danmaku\n");
    } else if (optDirs.includes("fmz-danmaku-server") && existsSync(danmakuAiGwLocal)) {
      console.log("📝 合并 danmaku-ai-gateway.env → /opt/fmz-danmaku-server/danmaku.env …");
      const uploadSnippet = `${SCP_CMD} "${danmakuAiGwLocal}" ${REMOTE_USER}@${REMOTE_HOST}:/tmp/fmz-danmaku-ai-gateway.env`;
      run(uploadSnippet);
      let appendSecret = "";
      if (REMOTE_SERVICE_SECRET) {
        appendSecret = ` && grep -q '^FMZ_REMOTE_SERVICE_SECRET=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null || echo 'FMZ_REMOTE_SERVICE_SECRET=${REMOTE_SERVICE_SECRET.replace(/'/g, "'\\''")}' >> /opt/fmz-danmaku-server/danmaku.env`;
      }
      run(
        `${SSH_CMD} "touch /opt/fmz-danmaku-server/danmaku.env && grep -q '^AI_AGENT_INTERNAL_URL=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null || cat /tmp/fmz-danmaku-ai-gateway.env >> /opt/fmz-danmaku-server/danmaku.env${appendSecret} && rm -f /tmp/fmz-danmaku-ai-gateway.env && systemctl restart fmz-danmaku"`,
      );
      console.log("   ✅ 已追加 AI 网关 URL 并重启 fmz-danmaku\n");
    }
    if (DEPLOY_TARGET === "tencent-43") {
      console.log("   ℹ️  API 密钥应已通过 npm run sync:ai-gateway 写入 /etc/fmz-ai-gateway.env\n");
    }
  } else {
    console.log("\n   [opt] release/opt 为空，跳过后端同步。\n");
  }
} else if (SKIP_BACKEND) {
  console.log("\n   [opt] 已设置 FMZ_DEPLOY_SKIP_BACKEND，跳过后端同步。\n");
} else {
  console.log("\n   [opt] 本 release 无 opt/ 目录（旧版打包或未包含后端镜像），仅更新了静态资源。\n");
}

const danmakuAiGwLocalRoot = join(releaseDir, "config", "danmaku-ai-gateway.env");
if (
  !SKIP_BACKEND
  && AI_GATEWAY
  && DEPLOY_TARGET === "dianfanbao"
  && existsSync(danmakuAiGwLocalRoot)
) {
  console.log("📝 合并 danmaku-ai-gateway.env → /opt/fmz-danmaku-server/danmaku.env …");
  run(`${SCP_CMD} "${danmakuAiGwLocalRoot}" ${REMOTE_USER}@${REMOTE_HOST}:/tmp/fmz-danmaku-ai-gateway.env`);
  let appendSecret = "";
  if (REMOTE_SERVICE_SECRET) {
    appendSecret = `; grep -q '^FMZ_REMOTE_SERVICE_SECRET=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null || echo 'FMZ_REMOTE_SERVICE_SECRET=${REMOTE_SERVICE_SECRET.replace(/'/g, "'\\''")}' >> /opt/fmz-danmaku-server/danmaku.env`;
  }
  run(
    `${SSH_CMD} "mkdir -p /opt/fmz-danmaku-server && touch /opt/fmz-danmaku-server/danmaku.env && (grep -q '^AI_AGENT_INTERNAL_URL=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null || cat /tmp/fmz-danmaku-ai-gateway.env >> /opt/fmz-danmaku-server/danmaku.env)${appendSecret}; rm -f /tmp/fmz-danmaku-ai-gateway.env; systemctl restart fmz-danmaku 2>/dev/null || true"`,
    { ignoreError: true },
  );
  console.log("   ✅ 主站弹幕 AI 已指向远端网关\n");
}

if (!SKIP_BACKEND && AI_GATEWAY && DEPLOY_TARGET === "dianfanbao") {
  const stopLocalAi = ["fmz-ai-agent", "fmz-voice-clone"];
  console.log("⏹️  主站停用本地 AI 单元（改走远端网关）: " + stopLocalAi.join(", "));
  run(
    `${SSH_CMD} "systemctl stop ${stopLocalAi.join(" ")} 2>/dev/null || true; systemctl disable ${stopLocalAi.join(" ")} 2>/dev/null || true"`,
    { ignoreError: true },
  );
  console.log("   ✅ 已 stop + disable 本地 fmz-ai-agent / fmz-voice-clone\n");
}

/* ------------------------------------------------------------------ */
/*  Step 3a: 停用已在 fmzFeatures 中关闭的后端服务                       */
/* ------------------------------------------------------------------ */
if (!SKIP_BACKEND) {
  const pkgFeatures =
    JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).fmzFeatures || {};
  const stopUnits = systemdUnitsToStop(pkgFeatures);
  if (stopUnits.length > 0) {
    console.log("⏹️  停用未纳入本版 release 的远端后端: " + stopUnits.join(", "));
    run(
      `${SSH_CMD} "systemctl stop ${stopUnits.join(" ")} 2>/dev/null || true; systemctl disable ${stopUnits.join(" ")} 2>/dev/null || true"`,
      { ignoreError: true },
    );
    console.log("   ✅ 已 stop + disable（未安装的单元会被忽略）\n");
  }
}

/* ------------------------------------------------------------------ */
/*  Step 3b: release/config/nginx → 远端 /etc/nginx/conf.d（可选）         */
/* ------------------------------------------------------------------ */
if (SYNC_NGINX) {
  const cfgNginxLocal = join(releaseDir, "config", "nginx");
  if (existsSync(cfgNginxLocal)) {
    const nf = readdirSync(cfgNginxLocal).filter((f) => !f.startsWith("."));
    if (nf.length > 0) {
      console.log(`🌐 同步 release/config/nginx → ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_NGINX_CONF_D}/ …`);
      const tmp = mkdtempSync(join(tmpdir(), "fmz-nginx-"));
      try {
        if (AI_GATEWAY && DEPLOY_TARGET === "dianfanbao") {
          writeNginxRemoteUpstreamsConf(join(tmp, "fmz-remote-upstreams.conf"), AI_GATEWAY);
          writeNginxRemoteSecretInc(join(tmp, "fmz-remote-secret.inc"), REMOTE_SERVICE_SECRET);
        }
        for (const f of nf) {
          const localPath =
            f === "fmz-remote-upstreams.conf" && existsSync(join(tmp, f))
              ? join(tmp, f)
              : f === "fmz-remote-secret.inc" && existsSync(join(tmp, f))
                ? join(tmp, f)
                : join(cfgNginxLocal, f);
          const uploadConf = `${SCP_CMD} "${localPath}" ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_NGINX_CONF_D}/${f}`;
          console.log(`   $ ${uploadConf}`);
          run(uploadConf);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      if (AI_GATEWAY && DEPLOY_TARGET === "dianfanbao" && !REMOTE_SERVICE_SECRET) {
        console.warn(
          "   ⚠️  未设置 FMZ_REMOTE_SERVICE_SECRET，Nginx 将无法向远端网关鉴权；请在 deploy.local.env 配置后重新 deploy。",
        );
      }
      // 旧版曾用 fmz-dashboard.conf，与 nginx-fmz-dashboard.conf 并存会触发 server_name 冲突
      run(`${SSH_CMD} "rm -f ${REMOTE_NGINX_CONF_D}/fmz-dashboard.conf"`, { ignoreError: true });
      run(`${SSH_CMD} "nginx -t && systemctl reload nginx"`);
      console.log("   ✅ Nginx 已 reload\n");
    } else {
      console.log("\n   [nginx] release/config/nginx 为空，跳过。\n");
    }
  } else {
    console.log("\n   [nginx] 无 release/config/nginx（请用不带 --skip-config 的 pack-release 打包）。\n");
  }
}

if (DEPLOY_STATIC) {
  console.log("🔍 验证远端版本...");
  const remoteBuildInfo = run(`${SSH_CMD} "cat ${REMOTE_WEB_ROOT}/BUILD_INFO.txt"`, { silent: true });
  console.log("   远端 BUILD_INFO.txt:");
  for (const line of remoteBuildInfo.split("\n")) {
    console.log(`   │ ${line}`);
  }
  console.log("");
} else if (DEPLOY_TARGET === "tencent-43") {
  console.log("🔍 验证网关机服务状态...");
  run(
    `${SSH_CMD} "systemctl is-active fmz-ai-agent fmz-voice-clone 2>/dev/null || true; ss -lntp | grep -E ':8792|:8793' || true"`,
    { ignoreError: true },
  );
}

console.log("");
console.log("🎉 部署完成！");
console.log("");
