/**
 * 自检赞踩服务是否可用（不启动浏览器）。
 * 用法：
 *   1) 另开终端：cd server && npm start
 *   2) node scripts/check-reactions.mjs
 *      或 node scripts/check-reactions.mjs http://127.0.0.1:8787
 * 或通过 Vite 反代：node scripts/check-reactions.mjs http://127.0.0.1:5173/__fmz_reactions
 */
const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");

async function main() {
  const healthUrl = `${base}/health`;
  const h = await fetch(healthUrl);
  const ht = await h.text();
  console.log("[1] GET", healthUrl, "->", h.status, ht.slice(0, 200));

  const votesUrl = `${base}/api/votes?project=888_888`;
  const v = await fetch(votesUrl);
  const vt = await v.text();
  console.log("[2] GET", votesUrl, "->", v.status, vt.slice(0, 200));

  const incUrl = `${base}/api/votes/inc`;
  const p = await fetch(incUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: "888_888",
      memberId: `check-reactions-${Date.now()}`,
      kind: "like",
    }),
  });
  const pt = await p.text();
  console.log("[3] POST", incUrl, "->", p.status, pt.slice(0, 200));

  if (!h.ok || !v.ok || !p.ok) {
    console.error("\n失败：请确认 reactions-server 已监听8787，或通过 Vite 时根目录已 npm run dev:all");
    process.exit(1);
  }
  const pj = JSON.parse(pt);
  if (pj.code !== 0) {
    console.error("\nPOST 返回 code!=0", pj);
    process.exit(1);
  }
  console.log("\n全部 OK：浏览器请保持「赞踩 API」为 /__fmz_reactions（推荐）或已配置 CORS 的直连地址。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
