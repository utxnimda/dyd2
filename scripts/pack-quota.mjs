/**
 * pack-quota.mjs
 * Package the Quota Dashboard as a standalone distributable.
 *
 * Output: release/quota-dashboard/
 *   ├── quota-server.cjs        (server)
 *   ├── quota-dashboard.html    (frontend)
 *   ├── start.bat               (Windows launcher — double-click to run)
 *   ├── start.sh                (macOS / Linux launcher)
 *   └── README.txt              (usage instructions)
 *
 * Usage: node scripts/pack-quota.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "server");
const OUT_DIR = path.join(ROOT, "release", "quota-dashboard");

// ---- Clean & create output directory ----
if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- Copy core files ----
const filesToCopy = [
  { src: path.join(SERVER_DIR, "quota-server.cjs"), dest: "quota-server.cjs" },
  { src: path.join(SERVER_DIR, "quota-dashboard.html"), dest: "quota-dashboard.html" },
];

for (const { src, dest } of filesToCopy) {
  if (!fs.existsSync(src)) {
    console.error(`❌ Missing file: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(OUT_DIR, dest));
  console.log(`  ✅ ${dest}`);
}

// ---- Generate Windows launcher (start.bat) ----
const batContent = `@echo off
chcp 65001 >nul
title Quota Dashboard Server

echo.
echo   ========================================
echo     Quota Dashboard - Standalone Launcher
echo   ========================================
echo.

:: Check if Node.js is available
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] Node.js is not installed or not in PATH.
    echo   Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo   Starting Quota Dashboard Server...
echo   (Press Ctrl+C to stop)
echo.

node "%~dp0quota-server.cjs" --open

echo.
echo   Server stopped.
pause
`;
fs.writeFileSync(path.join(OUT_DIR, "start.bat"), batContent, "utf-8");
console.log("  ✅ start.bat");

// ---- Generate macOS / Linux launcher (start.sh) ----
const shContent = `#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "  ========================================"
echo "    Quota Dashboard - Standalone Launcher"
echo "  ========================================"
echo ""

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js is not installed or not in PATH."
    echo "  Please install Node.js from https://nodejs.org/"
    exit 1
fi

echo "  Starting Quota Dashboard Server..."
echo "  (Press Ctrl+C to stop)"
echo ""

node ./quota-server.cjs --open
`;
fs.writeFileSync(path.join(OUT_DIR, "start.sh"), shContent, "utf-8");
console.log("  ✅ start.sh");

// ---- Generate README.txt ----
const readmeContent = `Quota Dashboard - Standalone
============================

查看 Cursor / CodeBuddy 的配额使用情况。

使用方法
--------
前提：目标电脑需要安装 Node.js (v16+)
      下载地址: https://nodejs.org/

Windows:
  双击 start.bat 即可启动，会自动打开浏览器。

macOS / Linux:
  终端执行: chmod +x start.sh && ./start.sh

首次使用
--------
1. 启动后浏览器会自动打开 http://localhost:3210
2. 在页面中配置对应的 Cookie / Token
3. 配置会保存在同目录下的 .env.quota 文件中

端口
----
默认端口 3210，如果被占用会自动尝试 3211-3219。
`;
fs.writeFileSync(path.join(OUT_DIR, "README.txt"), readmeContent, "utf-8");
console.log("  ✅ README.txt");

// ---- Summary ----
const totalSize = filesToCopy.reduce((sum, { src }) => sum + fs.statSync(src).size, 0);
console.log("");
console.log(`  📦 Quota Dashboard packaged to: release/quota-dashboard/`);
console.log(`  📁 Total size: ${(totalSize / 1024).toFixed(1)} KB (server + dashboard)`);
console.log(`  💡 Copy the entire "quota-dashboard" folder to the target machine.`);
console.log("");
