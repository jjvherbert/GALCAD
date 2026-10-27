// Scripts no Chromium: exemplo de varrimento paramétrico no worker isolado, tabela, aplicar ao modelo,
// isolamento (sem rede) e, com Gmsh + CalculiX, simulações em série pelo agente local.
// Uso: npm run build && node tests/e2e/script.e2e.cjs
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4187, AGENT = 8798, TOKEN = "e2e-script-token";
const URL = `http://localhost:${PORT}`;
const has = (c) => spawnSync("which", [c]).status === 0;

async function main() {
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
    const p = await b.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    const settle = async () => { await p.waitForTimeout(250); await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 }); await p.waitForTimeout(200); };
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/script.cadp.json"), "utf8"));
    await p.reload(); await settle();
    const vol0 = await p.textContent(".side-info");

    await p.click("[role=tab]:has-text('Automação')");
    await p.click(".commands button[title^='Scripts']");
    await p.waitForSelector(".script-panel");
    await p.selectOption(".script-panel select[aria-label='Scripts guardados e exemplos']", { label: "Varrimento paramétrico (massa e dimensões)" });
    await p.click(".script-panel button:has-text('Correr script')");
    await p.waitForSelector(".script-panel .kw-item b:has-text('Concluído')", { timeout: 120000 });
    const rows = await p.$$eval(".script-panel table.data tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent)));
    // L de 80 a 120: volume = 100·L mm³ → 8 … 12 cm³
    check("varrimento: 5 linhas com o volume certo", rows.length === 5 && Math.abs(Number(rows[0][2]) - 8) < 1e-6 && Math.abs(Number(rows[4][2]) - 12) < 1e-6, JSON.stringify(rows));
    await settle();
    await p.click(".script-panel button:has-text('Aplicar ao modelo')"); await settle();
    await p.click(".script-panel button:has-text('Árvore')");
    const vol1 = await p.textContent(".side-info");
    check("aplicar ao modelo: L = 120 (volume 12 cm³)", /Volume\s*12\s*cm³/.test(vol1) && vol1 !== vol0, vol1.slice(0, 120));
    await p.keyboard.press("Control+z"); await settle();
    check("desfazer repõe o modelo", (await p.textContent(".side-info")) === vol0);
    await p.click(".commands button[title^='Scripts']");
    await p.waitForSelector(".script-panel");

    // isolamento: sem fetch nem acesso à página
    await p.fill(".script-panel textarea[aria-label='Código do script']", "return [typeof fetch, typeof document, typeof XMLHttpRequest, typeof importScripts]");
    await p.click(".script-panel button:has-text('Correr script')");
    await p.waitForSelector(".script-panel .script-value", { timeout: 30000 });
    check("worker isolado (sem rede nem página)", /"undefined",\s*"undefined",\s*"undefined",\s*"undefined"/.test(await p.textContent(".script-panel .script-value")), await p.textContent(".script-panel .script-value"));
    await p.fill(".script-panel textarea[aria-label='Código do script']", "cad.update('f99', {})");
    await p.click(".script-panel button:has-text('Correr script')");
    await p.waitForSelector(".script-panel .script-console", { timeout: 30000 });
    check("erro do script na consola", /Feature inexistente: f99/.test(await p.textContent(".script-panel .script-console")));

    if (solvers) {
      await p.click("[role=tab]:has-text('Simulação')");
      await p.click(".commands button[title^='Simulação']");
      await p.click(".sim-panel summary:has-text('Agente local')");
      await p.fill(".sim-panel label.field:has-text('Endereço') input", `http://127.0.0.1:${AGENT}`); await p.press(".sim-panel label.field:has-text('Endereço') input", "Tab");
      await p.fill(".sim-panel input[type=password]", TOKEN);
      await p.click("[role=tab]:has-text('Automação')");
      await p.click(".commands button[title^='Scripts']");
      await p.selectOption(".script-panel select[aria-label='Scripts guardados e exemplos']", { label: "Simulações em série + superfície de resposta" });
      await p.click(".script-panel button:has-text('Correr script')");
      await p.waitForSelector(".script-panel .kw-item b:has-text('Concluído'), .script-panel .kw-item b:has-text('erro')", { timeout: 600000 });
      const t = await p.$$eval(".script-panel table.data tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => Number(td.textContent))));
      // Timoshenko: δ(L) = F·L³/(3EI) + F·L/(κGA)
      const E = 210000, I = 10000 / 12, G = E / 2.6, d = (L) => (100 * L ** 3) / (3 * E * I) + (100 * L) / ((5 / 6) * G * 100);
      check("3 simulações no agente contra Timoshenko", t.length === 3 && t.every((r) => Math.abs(-r[2] - d(r[0])) < 0.03 * d(r[0])), JSON.stringify(t));
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-script.png") });
    } else R.push("- simulações em série saltadas (Gmsh/CalculiX não instalados)");
    await p.fill(".script-panel input[aria-label='Nome do script']", "Meu varrimento");
    await p.click(".script-panel button:has-text('Guardar')"); await settle();
    check("script guardado na peça", (await p.$$eval(".script-panel optgroup[label='Guardados na peça'] option", (o) => o.map((x) => x.textContent))).includes("Meu varrimento"));
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
    agent?.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Scripts: há testes falhados"); process.exit(1); }
  console.log("Scripts: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
