const uid = "268026";
const u = `https://m.douyu.com/member/center?uid=${uid}`;
const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)" } });
const t = await r.text();
const m = t.match(/apic\.douyucdn\.cn[^"'\\\s]+/);
console.log(r.status, m?.[0]?.slice(0, 120));
