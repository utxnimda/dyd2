/**
 * Auto-bump the patch version in package.json before packing.
 * e.g. 1.0.0 -> 1.0.1, and sync fmzReleaseLabel to "v1.0.1".
 * Called by `npm run pack` before build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const parts = pkg.version.split(".").map(Number);
parts[2] += 1; // bump patch
const newVersion = parts.join(".");

pkg.version = newVersion;
pkg.fmzReleaseLabel = `v${newVersion}`;

// Downgrade "local"-only features to false for release builds.
// Feature values: false = off, "local" = dev-only, true = always on.
if (pkg.fmzFeatures) {
  for (const [key, val] of Object.entries(pkg.fmzFeatures)) {
    if (val === "local") {
      pkg.fmzFeatures[key] = false;
      console.log(`  ⚠ 已关闭仅限本地的功能: ${key}`);
    }
  }
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
console.log(`版本号已自动递增: ${parts.map((v, i) => i === 2 ? v - 1 : v).join(".")} → ${newVersion}`);
