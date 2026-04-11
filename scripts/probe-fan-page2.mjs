const t = await fetch("https://www.doseeing.com/data/fan/268026").then((r) => r.text());
console.log(t.includes("douyucdn"));
console.log(t.slice(0, 2500));
