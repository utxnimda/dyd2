const uid = "268026";
const urls = [
  `https://www.douyu.com/bdjapi/user/baseinfo?client_sys=web&uid=${uid}`,
  `https://www.douyu.com/wgapi/livenc/livewebapi/getUserInfo?uid=${uid}`,
  `https://yuba.douyu.com/wbapi/web/post/user/info?uid=${uid}`,
];
for (const u of urls) {
  try {
    const r = await fetch(u, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
        Referer: "https://www.douyu.com/",
      },
    });
    const t = await r.text();
    console.log("\n", u, r.status);
    console.log(t.slice(0, 400));
  } catch (e) {
    console.log(u, e.message);
  }
}
