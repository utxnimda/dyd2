import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")) as {
  version: string;
  fmzReleaseLabel?: string;
  fmzFeatures?: Record<string, boolean | string>;
};
const releaseLabel = String(pkg.fmzReleaseLabel ?? `v${pkg.version}`).trim();
const rawFeatures = (pkg.fmzFeatures ?? {}) as Record<string, boolean | string>;

/**
 * Resolve feature flags: false = off, "local" = dev-only, true = always on.
 * During dev (vite dev / vite preview) both "local" and true are treated as enabled.
 * During build (vite build, called by `npm run pack`) bump-patch.mjs already
 * downgrades "local" → false before the build runs, so only true survives.
 */
const features = Object.fromEntries(
  Object.entries(rawFeatures).map(([k, v]) => [k, v === true || v === "local"]),
) as Record<string, boolean>;

/** 与官网 SPA Origin 一致（官方为 https://fmz.dongdongne.com ，勿用 api2）；可设 FMZ_UPSTREAM_BROWSER_ORIGIN 覆盖 */
const FMZ_UPSTREAM_BROWSER_ORIGIN = (
  process.env.FMZ_UPSTREAM_BROWSER_ORIGIN || "https://fmz.dongdongne.com"
).replace(/\/$/, "");

/** Proxy entries — only register proxies for enabled features */
const apiProxy: Record<string, import("vite").ProxyOptions> = {};

/** Helper: register a simple reverse-proxy entry (no header rewriting). */
function addSimpleProxy(prefix: string, target: string) {
  apiProxy[prefix] = {
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(new RegExp(`^${prefix.replace(/\//g, "\\/")}`), ""),
  };
}

// FMZ API proxy (needed by battle/treasury/users/preliminary)
if (features.battle || features.treasury || features.users || features.preliminary) {
  apiProxy["/__fmz_api"] = {
    target: "https://api2.dongdongne.com",
    changeOrigin: true,
    secure: true,
    rewrite: (p: string) => p.replace(/^\/__fmz_api/, ""),
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
  };
}

// Doseeing proxy (needed by battle/treasury)
if (features.battle || features.treasury) {
  addSimpleProxy("/doseeing", "https://www.doseeing.com");
}

// Reactions server (needed by battle/treasury/users/preliminary)
if (features.battle || features.treasury || features.users || features.preliminary) {
  addSimpleProxy("/__fmz_reactions", "http://127.0.0.1:8787");
}

// Defense tower server (needed by sanguo)
if (features.sanguo) {
  addSimpleProxy("/__fmz_defense", "http://127.0.0.1:8788");
}

// Audio extractor server (needed by audio)
if (features.audio) {
  addSimpleProxy("/__fmz_audio", "http://127.0.0.1:8789");
}

// Bilibili API proxy (needed by baobao)
if (features.baobao) {
  apiProxy["/__bili_api"] = {
    target: "https://api.bilibili.com",
    changeOrigin: true,
    secure: true,
    rewrite: (p: string) => p.replace(/^\/__bili_api/, ""),
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req) => {
        proxyReq.setHeader("referer", "https://www.bilibili.com/");
        proxyReq.setHeader("origin", "https://www.bilibili.com");
        proxyReq.setHeader("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        const buvid3 = (req.headers["x-bili-buvid3"] as string) || "";
        if (buvid3) {
          proxyReq.setHeader("cookie", `buvid3=${buvid3}`);
        }
        proxyReq.removeHeader("x-bili-buvid3");
      });
    },
  };
}

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
    __FEATURE_SANGUO__: JSON.stringify(!!features.sanguo),
    __FEATURE_BAOBAO__: JSON.stringify(!!features.baobao),
    __FEATURE_AUDIO__: JSON.stringify(!!features.audio),
    __FEATURE_BATTLE__: JSON.stringify(!!features.battle),
    __FEATURE_TREASURY__: JSON.stringify(!!features.treasury),
    __FEATURE_PRELIMINARY__: JSON.stringify(!!features.preliminary),
    __FEATURE_USERS__: JSON.stringify(!!features.users),
    __FEATURE_QUOTA__: JSON.stringify(!!features.quota),
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
