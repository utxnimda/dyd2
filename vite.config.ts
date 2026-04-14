import { readFileSync, existsSync } from "node:fs";
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

/** 与官网 SPA Origin 一致（官方为 https://fmz.dongdongne.com ，勿用 api2）；可设 FMZ_UPSTREAM_BROWSER_ORIGIN 覆盖 */
const FMZ_UPSTREAM_BROWSER_ORIGIN = (
  process.env.FMZ_UPSTREAM_BROWSER_ORIGIN || "https://fmz.dongdongne.com"
).replace(/\/$/, "");

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
    /**
     * 上游校验 Origin；仪表盘域名会被拒。伪造为 fmz 官网 Origin，并去掉/重写 Sec-Fetch-*，
     * 否则浏览器仍带 same-origin 等，与伪造 Origin 不一致易 403。
     */
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq) => {
        const strip = [
          "sec-fetch-site",
          "sec-fetch-mode",
          "sec-fetch-dest",
          "sec-fetch-user",
          "sec-ch-ua",
          "sec-ch-ua-mobile",
          "sec-ch-ua-platform",
        ];
        for (const h of strip) proxyReq.removeHeader(h);
        proxyReq.setHeader("origin", FMZ_UPSTREAM_BROWSER_ORIGIN);
        proxyReq.setHeader("referer", `${FMZ_UPSTREAM_BROWSER_ORIGIN}/`);
        proxyReq.setHeader("sec-fetch-site", "same-site");
        proxyReq.setHeader("sec-fetch-mode", "cors");
        proxyReq.setHeader("sec-fetch-dest", "empty");
      });
    },
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
  /** 大话三国攻城快照：本地 `npm run defense-tower-server`（默认 8788） */
  "/__fmz_defense": {
    target: "http://127.0.0.1:8788",
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/__fmz_defense/, ""),
  },
} as const satisfies Record<string, import("vite").ProxyOptions>;

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
    {
      name: "serve-image-dir",
      configureServer(server) {
        server.middlewares.use("/image", (req, res, next) => {
          const filePath = join(__dirname, "image", req.url ?? "");
          if (existsSync(filePath)) {
            const ext = filePath.split(".").pop()?.toLowerCase();
            const mime: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
            res.setHeader("Content-Type", mime[ext ?? ""] ?? "application/octet-stream");
            res.end(readFileSync(filePath));
          } else {
            next();
          }
        });
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
