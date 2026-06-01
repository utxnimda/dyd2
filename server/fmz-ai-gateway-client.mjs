/**
 * 主站服务访问远端 AI 网关时的请求头（与 fmz-remote-service-auth 配对）。
 */
import { getRemoteServiceSecret } from "./fmz-remote-service-auth.mjs";

/** @param {Record<string, string>} [extra] */
export function aiGatewayFetchHeaders(extra = {}) {
  const headers = { ...extra };
  const secret = getRemoteServiceSecret();
  if (secret) headers["X-FMZ-Remote-Secret"] = secret;
  return headers;
}
