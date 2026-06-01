/**
 * 按顺序部署 AI 网关：先 tencent-43，再主站 dianfanbao（需 FMZ_REMOTE_SERVICE_SECRET、FMZ_DEPLOY_SYNC_NGINX=1）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

function runDeploy(target, label) {
  console.log(`\n========== ${label} (--target=${target}) ==========\n`);
  const r = spawnSync(node, [join(root, "scripts", "deploy.mjs"), `--target=${target}`], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("\n========== 同步 API 密钥 → 网关机 ==========\n");
const sync = spawnSync(node, [join(root, "scripts", "sync-ai-gateway-remote.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
if (sync.status !== 0) process.exit(sync.status ?? 1);

runDeploy("tencent-43", "AI 网关机");
runDeploy("dianfanbao", "主站");
console.log("\n✅ AI 网关分离部署流程已完成。请按 deploy/AI_GATEWAY_SPLIT.md 做 curl 验证。\n");
