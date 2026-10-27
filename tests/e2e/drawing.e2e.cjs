// Desenhos 2D no Chromium: vistas, cotas do modelo, nota, BOM, balões e exportação PDF/DXF/SVG.
// Uso: npm run build && node tests/e2e/drawing.e2e.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4183;
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
    const ctx = await b.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    const idle = async () => { await p.waitForTimeout(300); await p.waitForFunction(() => !/A reconstruir/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 120000 }); await p.waitForTimeout(300); };
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/conjunto.cadp.json"), "utf8"));
    await p.reload(); await idle();

    await p.click("button[aria-label='Novo documento']");
    await p.click("button:has-text('Novo desenho')"); await idle();
    check("desenho criado", /Desenho1/.test(await p.textContent(".doc-tabs")));
    await p.selectOption(".drawing-panel select[aria-label='Modelo']", "part:p1");
    await p.click(".drawing-panel button:has-text('3 vistas + iso')"); await idle();
    await p.waitForFunction(() => document.querySelectorAll(".sheet-svg line").length > 50, null, { timeout: 120000 });
    const views = await p.$$eval(".drawing-panel .tree .feat", (els) => els.map((e) => e.textContent));
    check("quatro vistas sem erro", views.length === 4 && !(await p.$(".drawing-panel .feat.error")), views.join(" | "));
    // a vista de cima (2.ª) tem o esboço do retângulo paralelo: importar cotas do modelo
    await p.click(".drawing-panel .tree .feat >> nth=1");
    await p.click(".drawing-panel button:has-text('Importar cotas do modelo')"); await idle();
    check("cotas do modelo importadas", /2 cota\(s\) importada/.test(await p.textContent(".statusbar")), (await p.textContent(".statusbar")).slice(0, 120));
    const svgText = await p.$eval(".sheet-svg", (e) => e.textContent);
    check("cotas 100 e 60 na folha", /100/.test(svgText) && /60/.test(svgText));
    check("legenda com o número e o material", /GK-001/.test(svgText) && /Aço S235JR/.test(svgText) && /Placa base/.test(svgText));

    // nota pela barra de Anotação
    await p.click("[role=tab]:has-text('Anotação')");
    await p.click(".commands button[title^='Nota']");
    const box = await p.locator(".sheet-svg").boundingBox();
    await p.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.8); await idle();
    check("nota criada", /Nota/.test(await p.$eval(".sheet-svg", (e) => e.textContent)));
    await p.keyboard.press("Escape");

    // exportações
    const exp = async (title) => {
      const [dl] = await Promise.all([p.waitForEvent("download"), p.click(`[role=tab]:has-text('Esquema de vistas')`).then(() => p.click(`.commands button[title^='${title}']`))]);
      const f = await dl.path();
      return fs.readFileSync(f);
    };
    const pdf = await exp("Exportar PDF");
    check("PDF vetorial", pdf.slice(0, 8).toString("latin1") === "%PDF-1.4" && pdf.length > 5000, String(pdf.length));
    const dxf = (await exp("Exportar DXF")).toString("latin1");
    check("DXF R12", dxf.includes("AC1009") && dxf.includes("VISIBLE") && dxf.trimEnd().endsWith("EOF"));
    const svg = (await exp("Exportar SVG")).toString("utf8");
    check("SVG", svg.includes('viewBox="0 0 420 297"'));
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-desenho.png") });

    // desenho da montagem: vista, tabela de BOM e balões automáticos
    await p.click("button[aria-label='Novo documento']");
    await p.click("button:has-text('Novo desenho')"); await idle();
    await p.selectOption(".drawing-panel select[aria-label='Modelo']", "assembly:a1");
    await p.selectOption(".drawing-panel select[aria-label='Orientação']", "iso");
    await p.click(".drawing-panel button:has-text('Colocar vista')");
    await p.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4); await idle();
    await p.waitForFunction(() => document.querySelectorAll(".sheet-svg line").length > 50, null, { timeout: 120000 });
    await p.click(".drawing-panel button:has-text('Balões automáticos')"); await idle();
    check("balões automáticos", /2 balão/.test(await p.textContent(".statusbar")), (await p.textContent(".statusbar")).slice(0, 100));
    await p.click("[role=tab]:has-text('Anotação')");
    await p.click(".commands button[title^='Tabela de BOM']");
    await p.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.7); await idle();
    await p.waitForTimeout(800);
    const t2 = await p.$eval(".sheet-svg", (e) => e.textContent);
    check("tabela de BOM", /GK-001/.test(t2) && /GK-002/.test(t2) && /Qtd\./.test(t2) && /Placa base/.test(t2), "");
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-desenho-montagem.png") });
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Desenhos: há testes falhados"); process.exit(1); }
  console.log("Desenhos: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
