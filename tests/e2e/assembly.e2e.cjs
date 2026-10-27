// Montagens no Chromium: abas de documentos, árvore, mates, massa e interferências.
// Uso: npm run build && node tests/e2e/assembly.e2e.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4182;
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
    const settle = async () => { await p.waitForTimeout(300); await p.waitForFunction(() => !/A reconstruir/.test(document.querySelector(".statusbar")?.textContent ?? "") && /Reconstruído|mm/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 }); await p.waitForTimeout(200); };
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/conjunto.cadp.json"), "utf8"));
    await p.reload(); await settle();

    const tabs = await p.textContent(".doc-tabs");
    check("abas do projeto", /Base/.test(tabs) && /Cubo/.test(tabs) && /Montagem1/.test(tabs), tabs);
    await p.click(".doc-tab:has-text('Montagem1')");
    await p.waitForFunction(() => /Totalmente definida|grau|Mates por resolver/.test(document.querySelector(".assembly-tree")?.textContent ?? ""), null, { timeout: 90000 });
    await p.waitForTimeout(300);
    const tree = await p.textContent(".assembly-tree");
    check("árvore da montagem", /Base<1>/.test(tree) && /Cubo<2>/.test(tree) && /Coincidente3/.test(tree), tree.slice(0, 160));
    // Cubo<2> só tem o mate de topo: 3 graus de liberdade livres
    check("graus de liberdade", /3 grau\(s\) de liberdade/.test(tree), tree.match(/\d+ grau[^C]*/)?.[0] ?? "");
    const info = await p.textContent(".side-info");
    const vol = Number(info.match(/Volume\s*([\d\s,.]+)\s*cm³/)[1].replace(/\s/g, "").replace(",", "."));
    check("volume da montagem", Math.abs(vol - 136) < 0.01, String(vol));
    const mass = Number(info.match(/Massa \(densidade de cada peça\)\s*([\d\s,.]+)\s*g/)[1].replace(/\s/g, "").replace(",", "."));
    check("massa com a densidade de cada peça", Math.abs(mass - (120 * 7.85 + 16 * 2.7)) < 0.1, String(mass));

    await p.click("[role=tab]:has-text('Montagem')");
    await p.click(".commands button[title^='Deteção de interferências']");
    await p.waitForFunction(() => /interferência|Sem interferências/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 60000 });
    check("sem interferências", /Sem interferências/.test(await p.textContent(".assembly-tree")));

    // mate novo pela interface: Cubo<2> com a face lateral alinhada à da base (plano padrão)
    await p.click(".commands button[title^='Mate: paralelo']"); await settle();
    check("painel de mate", !!(await p.$(".property-panel h2:has-text('Novo mate')")));
    const sels = await p.$$(".property-panel .reflist select");
    await sels[0].selectOption("c1:YZ");
    await sels[1].selectOption("c3:YZ"); await settle();
    check("mate cumprido na pré-visualização", /Cumprido/.test(await p.textContent(".property-panel")), (await p.textContent(".property-panel")).slice(-120));
    await p.click(".property-panel button.primary"); await settle();
    await p.waitForTimeout(500);
    const t2 = await p.textContent(".assembly-tree");
    check("mate criado", /Paralelo1/.test(t2) && /2 grau\(s\) de liberdade/.test(t2), t2.match(/\d+ grau[^C]*/)?.[0] ?? "");
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-montagem.png") });

    // nova peça e voltar
    await p.click(".doc-tab:has-text('Base')"); await settle();
    check("voltar à peça", /Extrusão1/.test(await p.textContent(".side")));
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Montagens: há testes falhados"); process.exit(1); }
  console.log("Montagens: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
