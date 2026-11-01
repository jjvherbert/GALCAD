// Corre todas as suites e2e em sequência e reporta todas as falhas (em vez de parar na primeira).
// Uso: npm run build && npm run test:e2e   |   só algumas: node tests/e2e/run-all.cjs app drawing
// As suites partilham portas (pmi/interacao) e o agente local, por isso não correm em paralelo.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ALL = ["app", "navigation", "interacao", "surfaces", "assembly", "drawing", "fase4", "simulacao", "pmi", "script", "galkeel", "calc"];
const pick = process.argv.slice(2);
const unknown = pick.filter((s) => !ALL.includes(s));
if (unknown.length) { console.error(`Suites desconhecidas: ${unknown.join(", ")}. Disponíveis: ${ALL.join(", ")}`); process.exit(2); }
const suites = pick.length ? pick : ALL;

const results = [];
for (const name of suites) {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, `${name}.e2e.cjs`)], { stdio: "inherit" });
  results.push({ name, ok: r.status === 0, code: r.status ?? r.signal, s: ((Date.now() - t0) / 1000).toFixed(1) });
}

console.log("\n=== Resumo e2e ===");
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name} (${r.s} s)${r.ok ? "" : ` — saída ${r.code}`}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) { console.error(`\n${failed.length} de ${results.length} suites falharam: ${failed.map((r) => r.name).join(", ")}`); process.exit(1); }
console.log(`\nTodas as ${results.length} suites passaram.`);
