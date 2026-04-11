const uid = "268026";
const urls = [
  `https://yuba.douyu.com/wbapi/web/post/profile?uid=${uid}`,
  `https://yuba.douyu.com/wbapi/web/post/user/profile?uid=${uid}`,
  `https://yuba.douyu.com/yapi/yuba/api/nc/user/info?uid=${uid}`,
];
for (const u of urls) {
  const r = await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://yuba.douyu.com/",
    },
  });
  console.log(u, r.status, (await r.text()).slice(0, 300));
}
