/**
 * 将 dist/ 复制到 release/<fmzReleaseLabel>/，便于按版本归档、上传服务器。
 * 由 npm run pack 在 vite build 之后调用。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const label = String(pkg.fmzReleaseLabel ?? `v${pkg.version}`).trim() || "v0.0.0";
const dist = join(root, "dist");
const target = join(root, "release", label);
const metaPath = join(target, "BUILD_INFO.txt");

mkdirSync(join(root, "release"), { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true });

const meta = [
  `release: ${label}`,
  `package.version: ${pkg.version}`,
  `packedAt: ${new Date().toISOString()}`,
  "",
].join("\n");
writeFileSync(metaPath, meta, "utf-8");

console.log(`已打包到 release/${label}/（含 BUILD_INFO.txt）`);
