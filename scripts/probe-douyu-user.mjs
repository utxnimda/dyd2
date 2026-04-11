const uid = "268026";
const urls = [
  `https://www.douyu.com/japi/moments/user/frontinfo?uid=${uid}`,
  `https://www.douyu.com/wgapi/activity/live/usercenter/getUserInfo?uid=${uid}`,
  `https://www.douyu.com/bjapi/paycenter/v1/user/getUserInfo?uid=${uid}`,
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
    const t = await r.text();
    console.log(u, r.status, t.slice(0, 200));
  } catch (e) {
    console.log(u, e.message);
  }
}
