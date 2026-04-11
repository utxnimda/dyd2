const uid = "268026";
const qs = [
  `fan_id=${uid}`,
  `user_id=${uid}`,
  `id=${uid}`,
  `uid=${uid}`,
];
for (const q of qs) {
  const r = await fetch("https://www.doseeing.com/api/fan/info?" + q);
  console.log(q, r.status, await r.text());
}
