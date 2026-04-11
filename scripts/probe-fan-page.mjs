const t = await fetch("https://www.doseeing.com/data/fan/268026").then((r) => r.text());
const m = t.match(/https:\/\/apic\.douyucdn\.cn\/upload\/avatar[^"'\\\s>]+/i);
console.log(m?.[0] ?? "no match");
const m2 = t.match(/avatar[^"'\\\s]{10,120}/gi);
console.log(m2?.slice(0, 5));
