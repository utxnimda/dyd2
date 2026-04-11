const id = "268026";
const t = await fetch("https://www.doseeing.com/room/" + id).then((r) => r.text());
const m = t.match(/https:\/\/apic\.douyucdn\.cn\/upload\/avatar[^"'\\\s>]+/i);
console.log("status", m?.[0]);
