const uid = "268026";
const paths = [
  `/api/user/info?uid=${uid}`,
  `/api/fan/info?uid=${uid}`,
  `/api/room/user?uid=${uid}`,
  `/data/api/fan/${uid}`,
];
for (const p of paths) {
  const r = await fetch("https://www.doseeing.com" + p);
  console.log(p, r.status, (await r.text()).slice(0, 200));
}
