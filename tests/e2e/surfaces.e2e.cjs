// Superfícies e análises no Chromium: separador Superfícies, espessar, zebra, curvatura e inclinação.
// Uso: npm run build && node tests/e2e/surfaces.e2e.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4181;
const URL = `http://localhost:${PORT}`;

async function main() {
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  const R = [];
  const check = (name, ok, extra = "") => R.push(`${ok ? "✓" : "✗"} ${name} ${extra}`);
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(URL)).ok) break; } catch { /* a arrancar */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    const p = await b.newPage({ viewport: { width: 1400, height: 860 } });
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    const settle = async () => { await p.waitForTimeout(250); await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 }); await p.waitForTimeout(150); };
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/superficies.cadp.json"), "utf8"));
    await p.reload(); await settle();

    const info = () => p.textContent(".side-info");
    check("corpos de superfície listados", /Corpos de superfície \(2\)/.test(await info()), (await info()).slice(0, 160));
    check("sem corpo sólido", /Ainda não há corpo/.test(await info()));

    await p.click("[role=tab]:has-text('Superfícies')");
    const tabText = await p.textContent(".commands");
    check("separador Superfícies", ["Sup. extrudida", "Preenchimento", "Costura", "Espessar", "Aparar superfície", "Riscas de zebra"].every((t) => tabText.includes(t)), tabText.slice(0, 200));

    // espessar o último corpo de superfície (meia revolução r = 60, h = 40) 2 mm: volume = π·(62² − 60²)/2·40 (ou para dentro, 60²−58²)
    await p.click(".commands button[title^='Espessar']"); await settle();
    const sel = await p.$eval(".property-panel select", (s) => s.selectedOptions[0]?.textContent ?? "");
    check("espessar: corpo pré-escolhido", /revolu/i.test(sel), sel);
    await p.click(".property-panel button.primary"); await settle();
    const vol = Number((await info()).match(/Volume\s*([\d\s,.]+)\s*cm³/)[1].replace(/\s/g, "").replace(",", "."));
    const expect = Math.PI * (62 * 62 - 60 * 60) / 2 * 40 / 1000;
    const vol2 = Math.PI * (60 * 60 - 58 * 58) / 2 * 40 / 1000;
    check("espessar: volume", Math.abs(vol - expect) < 0.01 || Math.abs(vol - vol2) < 0.01, `${vol} vs ${expect.toFixed(3)} / ${vol2.toFixed(3)}`);
    check("espessar consome a superfície", /Corpos de superfície \(1\)/.test(await info()));

    // análises
    const analysis = () => p.$eval(".viewport", (e) => e.dataset.analysis ?? "");
    await p.click(".commands button[title^='Riscas de zebra']"); await p.waitForTimeout(200);
    check("zebra ligada", (await analysis()) === "zebra");
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-zebra.png") });
    await p.click(".commands button[title^='Curvatura']");
    await p.waitForFunction(() => /Curvatura nula|Mín\./.test(document.querySelector(".analysis-panel")?.textContent ?? ""), null, { timeout: 30000 });
    const legend = await p.textContent(".analysis-panel");
    check("curvatura gaussiana de cilindros e planos = 0", (await analysis()) === "curvature" && /Curvatura nula/.test(legend), legend.replace(/\s+/g, " ").slice(0, 140));
    await p.selectOption(".analysis-panel select", "mean");
    await p.waitForSelector(".legend.diverging", { timeout: 30000 });
    // cilindros r = 60 e 62: |H| = 1/(2r) ≈ 8,3·10⁻³ / 8,1·10⁻³
    const lg = await p.textContent(".legend-labels");
    check("curvatura média ≈ 1/(2r)", /8\.\d{2}·10\^-3/.test(lg), lg);
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-curvatura.png") });
    await p.click(".commands button[title^='Análise de inclinação']"); await p.waitForTimeout(200);
    check("inclinação ligada", (await analysis()) === "draft" && /Precisa de inclinação/.test(await p.textContent(".analysis-panel")));
    await p.click(".analysis-panel button[aria-label='Desligar análise']"); await p.waitForTimeout(100);
    check("análise desligada", (await analysis()) === "");

    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Superfícies: há testes falhados"); process.exit(1); }
  console.log("Superfícies: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
