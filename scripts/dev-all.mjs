/**
 * dev-all.mjs — 单终端 concurrently：彩色前缀，Ctrl+C 一次全停。
 * 若需「后台托管 + 选择性重启」，请用 npm run dev:services:start / stop / restart-changed。
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  readFeatures,
  getConcurrentlySpecs,
  preflightAudioDeps,
} from "./fmz-dev-services.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const features = readFeatures();
preflightAudioDeps(features);

const { names, colors, commands } = getConcurrentlySpecs(features);

const concurrentlyArgs = [
  "-n", names.join(","),
  "-c", colors.join(","),
  ...commands.map((c) => JSON.stringify(c)),
];

console.log(`[dev-all] Enabled features: ${Object.entries(features).filter(([, v]) => v === true || v === "local").map(([k]) => k).join(", ")}`);
console.log(`[dev-all] Starting services: ${names.join(", ")}`);

const child = spawn("npx", ["concurrently", ...concurrentlyArgs], {
  cwd: join(__dirname, ".."),
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
