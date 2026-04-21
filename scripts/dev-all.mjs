/**
 * dev-all.mjs — Start dev server + only the backend services required by enabled features.
 * Reads `fmzFeatures` from package.json to decide which services to launch.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const features = pkg.fmzFeatures || {};

// Map feature keys to their required backend npm scripts
const FEATURE_SERVICES = {
  sanguo: { name: "defense", script: "defense-tower-server", color: "blue" },
  audio: { name: "audio", script: "audio-server", color: "yellow" },
  quota: { name: "quota", script: "quota-server", color: "green" },
  // reactions server is needed by battle/treasury/users/preliminary
  battle: { name: "reactions", script: "reactions-server", color: "cyan" },
  treasury: { name: "reactions", script: "reactions-server", color: "cyan" },
  users: { name: "reactions", script: "reactions-server", color: "cyan" },
  preliminary: { name: "reactions", script: "reactions-server", color: "cyan" },
};

const servicesToStart = new Map(); // dedup by name
for (const [feature, svc] of Object.entries(FEATURE_SERVICES)) {
  // "local" and true both count as enabled for dev
  if (features[feature] === true || features[feature] === "local") {
    servicesToStart.set(svc.name, svc);
  }
}

// Always start vite
const names = [...[...servicesToStart.values()].map((s) => s.name), "vite"];
const colors = [...[...servicesToStart.values()].map((s) => s.color), "magenta"];
const commands = [
  ...[...servicesToStart.values()].map((s) => `npm run ${s.script}`),
  "npm run dev",
];

const concurrentlyArgs = [
  "-n", names.join(","),
  "-c", colors.join(","),
  ...commands.map((c) => JSON.stringify(c)),
];

console.log(`[dev-all] Enabled features: ${Object.entries(features).filter(([,v]) => v === true || v === "local").map(([k]) => k).join(", ")}`);
console.log(`[dev-all] Starting services: ${names.join(", ")}`);

const child = spawn("npx", ["concurrently", ...concurrentlyArgs], {
  cwd: join(__dirname, ".."),
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
