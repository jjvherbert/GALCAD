// Análise integrada Galkeel no Chromium: a aplicação dentro de um iframe do mesmo origin (como em
// galkeel-app/public), painéis analisados com a galkeel-calculadora, verificação FEM no agente local,
// relatório e envio dos resultados à página-mãe no contrato `galkeel:calculator-result`.
// Uso: npm run build && node tests/e2e/galkeel.e2e.cjs
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4188, AGENT = 8797, TOKEN = "e2e-galkeel-token";
const URL = `http://localhost:${PORT}`;
const has = (c) => spawnSync("which", [c]).status === 0;

async function main() {
  // página-mãe de teste (faz de galkeel-app): recolhe as mensagens do iframe
  fs.writeFileSync(path.join(__dirname, "../../dist/host-e2e.html"), `<!doctype html><meta charset="utf-8"><title>host</title>
<iframe id="cad" src="/" style="width:1380px;height:860px;border:0"></iframe>
<script>window.got=[];addEventListener("message",(e)=>{if(e.origin===location.origin&&e.data&&e.data.type==="galkeel:calculator-result")window.got.push(e.data)});</script>`);
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  const solvers = has("gmsh") && has("ccx");
  const agent = solvers ? spawn("node", [path.join(__dirname, "../../public/cad-runner.mjs"), "--serve", "--port", String(AGENT)], { stdio: "ignore", env: { ...process.env, CAD_TOKEN: TOKEN } }) : null;
  const R = [];
  const check = (name, ok, extra = "") => R.push(`${ok ? "✓" : "✗"} ${name} ${extra}`);
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(URL)).ok) break; } catch { /* a arrancar */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await b.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const logs = []; page.on("pageerror", (e) => logs.push(e.message));
    await page.goto(URL);
    await page.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/galkeel.cadp.json"), "utf8"));
    await page.goto(`${URL}/host-e2e.html`);
    const p = page.frameLocator("#cad");
    await p.locator(".statusbar:has-text('Reconstruído')").waitFor({ timeout: 90000 });
    await p.locator("[role=tab]:has-text('Automação')").click();
    await p.locator(".commands button[title^='Galkeel']").click();
    await p.locator(".galkeel-panel").waitFor();
    check("painel com o registo e o painel do casco", (await p.locator(".galkeel-panel input[aria-label='Nome do painel 1']").inputValue()) === "Fundo AV" && /galkeel-calculadora/.test(await p.locator(".galkeel-panel").textContent()));
    await p.locator(".galkeel-panel button:has-text('Analisar painéis')").click();
    await p.locator(".galkeel-panel table.data").waitFor({ timeout: 60000 });
    const row = (await p.locator(".galkeel-panel table.data tr").nth(1).textContent()).replace(/\s+/g, " ");
    // pressão de fundo 48,09 kN/m² e espessura 6,57 mm (as mesmas da galkeel-calculadora, ver tests/galkeel.test.ts)
    check("análise: fundo, P = 48,09 kN/m², t = 6,57 mm, real/req. 1,07", /Fundo/.test(row) && /400×600/.test(row) && /48\.09/.test(row) && /6\.57/.test(row) && /1\.07/.test(row), row);
    if (solvers) {
      await p.locator("[role=tab]:has-text('Simulação')").click();
      await p.locator(".commands button[title^='Simulação']").click();
      await p.locator(".sim-panel summary:has-text('Agente local')").click();
      await p.locator(".sim-panel label.field:has-text('Endereço') input").fill(`http://127.0.0.1:${AGENT}`);
      await p.locator(".sim-panel label.field:has-text('Endereço') input").press("Tab");
      await p.locator(".sim-panel input[type=password]").fill(TOKEN);
      await p.locator("[role=tab]:has-text('Automação')").click();
      await p.locator(".commands button[title^='Galkeel']").click();
      await p.locator(".galkeel-panel button:has-text('Verificar com FEM')").click();
      await p.locator(".galkeel-panel table.data td:has-text('/80.8')").waitFor({ timeout: 300000 });
      const fem = await p.locator(".galkeel-panel table.data tr").nth(1).locator("td").last().textContent();
      // von Mises no bordo encastrado ≈ 63 MPa (Roark × √(1 − ν + ν²)), σd = 80,8 MPa
      const s = Number(fem.split("/")[0]);
      check("FEM com a pressão ISO: σ ≈ 63 MPa < σd = 80,8 MPa", Math.abs(s - 63.4) < 0.05 * 63.4, fem);
    } else R.push("- verificação FEM saltada (Gmsh/CalculiX não instalados)");
    const [dl] = await Promise.all([page.waitForEvent("download"), p.locator(".galkeel-panel button:has-text('Relatório')").click()]);
    const html = fs.readFileSync(await dl.path(), "utf8");
    check("relatório com edição, rastreabilidade e veredito indeterminado", /ISO 12215-5:2008 \(edição retirada/.test(html) && /galkeel-calculadora [0-9a-f]{7}/.test(html) && /veredito indeterminado/.test(html) && /GK-2026-0001/.test(html));
    await p.locator(".galkeel-panel button:has-text('Enviar ao caso')").click();
    await page.waitForFunction(() => window.got.length > 0, null, { timeout: 10000 });
    const got = await page.evaluate(() => window.got);
    const m = got[0];
    check("mensagem para a galkeel-app no contrato das calculadoras", got.length === 1 && m.calculator === "iso12215-5-frp" && m.payload.assessment.verdict === "undetermined" && Math.abs(m.payload.results.pressureKPa - 48.0916) < 1e-3 && Array.isArray(m.payload.warnings), JSON.stringify(m).slice(0, 200));
    await page.screenshot({ path: path.join(__dirname, "../../dist/e2e-galkeel.png") });
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
    agent?.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Galkeel: há testes falhados"); process.exit(1); }
  console.log("Galkeel: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
