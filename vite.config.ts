import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")) as {
  version: string;
  fmzReleaseLabel?: string;
};
const releaseLabel = String(pkg.fmzReleaseLabel ?? `v${pkg.version}`).trim();

/**
 * 开发时通过同源代理转发，避免浏览器 CORS。
 * 生产环境需自行配置反向代理或将 API 与前端同域部署。
 */
const apiProxy = {
  "/__fmz_api": {
    target: "https://api2.dongdongne.com",
    changeOrigin: true,
    secure: true,
    rewrite: (p: string) => p.replace(/^\/__fmz_api/, ""),
  },
  /** [在看直播](https://www.doseeing.com/) 搜索与房间页，供头像补全（避免浏览器 CORS） */
  "/doseeing": {
    target: "https://www.doseeing.com",
    changeOrigin: true,
    secure: true,
    rewrite: (p: string) => p.replace(/^\/doseeing/, ""),
  },
  /** 赞踩 SQLite服务：本地先 `cd server && npm i && npm start` */
  "/__fmz_reactions": {
    target: "http://127.0.0.1:8787",
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/__fmz_reactions/, ""),
  },
} as const;

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "fmz-index-version",
      transformIndexHtml(html) {
        const esc = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        return html.replace(
          "<html lang=\"zh-CN\">",
          `<html lang="zh-CN" data-fmz-version="${esc(pkg.version)}" data-fmz-label="${esc(releaseLabel)}">`,
        );
      },
    },
  ],
  define: {
    __FMZ_RELEASE_LABEL__: JSON.stringify(releaseLabel),
    __FMZ_APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    /** 显式0.0.0.0：本机局域网请用 http://内网IP:5173，不要用公网 IP（多数路由器不支持回环） */
    host: "0.0.0.0",
    port: 5173,
    /** 避免通过域名/反代访问时 403 Blocked request */
    allowedHosts: true,
    proxy: { ...apiProxy },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: true,
    proxy: { ...apiProxy },
  },
});
