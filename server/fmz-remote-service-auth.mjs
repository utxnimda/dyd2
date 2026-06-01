/**
 * 远端 AI 网关：非 loopback 监听时要求 X-FMZ-Remote-Secret（与主站 Nginx / 弹幕服务一致）。
 */
import { isIP } from "node:net";

/** @returns {string} */
export function getRemoteServiceSecret() {
  return String(process.env.FMZ_REMOTE_SERVICE_SECRET || "").trim();
}

/** @returns {string} */
export function getServiceBindHost(defaultHost = "127.0.0.1") {
  const raw = String(process.env.FMZ_SERVICE_BIND_HOST || process.env.AI_AGENT_BIND_HOST || "").trim();
  return raw || defaultHost;
}

/** @returns {boolean} */
export function isRemoteServiceAuthRequired(bindHost = getServiceBindHost()) {
  const host = bindHost.trim().toLowerCase();
  if (!host || host === "127.0.0.1" || host === "localhost" || host === "::1") return false;
  if (host === "0.0.0.0" || host === "::") return true;
  const v = isIP(host);
  return v === 4 || v === 6;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {{ bindHost?: string; logTag?: string }} [opts]
 * @returns {{ ok: true } | { ok: false; status: number; error: string }}
 */
export function checkRemoteServiceAuth(req, opts = {}) {
  const bindHost = opts.bindHost ?? getServiceBindHost();
  if (!isRemoteServiceAuthRequired(bindHost)) return { ok: true };

  const expected = getRemoteServiceSecret();
  if (!expected) {
    const tag = opts.logTag || "fmz-remote";
    console.error(
      `[${tag}] 监听 ${bindHost} 但未配置 FMZ_REMOTE_SERVICE_SECRET，拒绝外连（请在 /etc/fmz-ai-gateway.env 设置）`,
    );
    return { ok: false, status: 503, error: "Remote service secret not configured on gateway host" };
  }

  const got = String(req.headers["x-fmz-remote-secret"] || "").trim();
  if (got && got === expected) return { ok: true };

  return { ok: false, status: 401, error: "Missing or invalid X-FMZ-Remote-Secret" };
}

/** @param {import("node:http").IncomingMessage} req */
export function remoteServiceAuthFailureResponse(req, res, result, sendJson) {
  if (result.ok) return false;
  sendJson(res, result.status, { error: result.error });
  return true;
}
