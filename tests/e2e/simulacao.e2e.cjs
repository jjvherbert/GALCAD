// Simulação no Chromium: painel Simulação, exportar o caso (.zip) e calcular uma consola no agente
// local real (cad-runner --serve com Gmsh + CalculiX), com o resultado a cores no 3D.
// Uso: npm run build && node tests/e2e/simulacao.e2e.cjs  (sem Gmsh/CalculiX, o cálculo é saltado)
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4185, AGENT = 8799, TOKEN = "e2e-token-123";
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
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/simulacao.cadp.json"), "utf8"));
    await p.reload(); await settle();

    await p.click("[role=tab]:has-text('Simulação')");
    await p.click(".commands button[title^='Simulação']");
    await p.waitForSelector(".sim-panel");
    const panel = await p.textContent(".sim-panel");
    check("painel com o estudo", /Consola — estática/.test(await p.$eval(".sim-panel select[aria-label=Estudo]", (s) => s.selectedOptions[0].textContent)) && /Encastramento/.test(panel) && /Força total/.test(panel), panel.slice(0, 200));
    const [dl] = await Promise.all([p.waitForEvent("download"), p.click(".sim-panel button:has-text('Exportar caso')")]);
    const zip = fs.readFileSync(await dl.path());
    const names = zip.toString("latin1");
    check("caso exportado (.zip)", ["case.json", "model.brep", "mesh.geo", "LEIA-ME.txt"].every((n) => names.includes(n)), `${zip.length} bytes`);
    check("agente disponível para download", (await (await fetch(`${URL}/cad-runner.mjs`)).text()).includes("Agente CAD a escutar"));

    if (solvers) {
      await p.click(".sim-panel summary:has-text('Agente local')");
      await p.fill(".sim-panel label.field:has-text('Endereço') input", `http://127.0.0.1:${AGENT}`); await p.press(".sim-panel label.field:has-text('Endereço') input", "Tab");
      await p.fill(".sim-panel input[type=password]", TOKEN);
      await p.click(".sim-panel button:has-text('Testar ligação')");
      await p.waitForFunction(() => /gmsh ✓/.test(document.querySelector(".sim-panel")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
      check("ligação ao agente", /gmsh ✓ · calculix ✓/.test(await p.textContent(".sim-panel")));
      await p.click(".sim-panel button:has-text('Calcular no agente local')");
      await p.waitForSelector(".sim-panel .info-table", { timeout: 240000 });
      const t = (await p.textContent(".sim-panel .info-table")).replace(/\s+/g, " ");
      const d = Number(t.match(/Deslocamento máx\.\s*([\d.]+) mm/)?.[1]);
      // consola: δ = FL³/(3EI) + FL/(κGA) ≈ 0,192 mm
      check("flecha da consola ≈ 0,192 mm", Math.abs(d - 0.192) < 0.01, t.slice(0, 220));
      check("reação = força", /Reações totais \(N\)\s*[-\d.]+ · [-\d.]+ · 100\.00/.test(t), t.match(/Reações[^A-Z]*/)?.[0] ?? "");
      check("resultado no 3D", (await p.$eval(".viewport", (e) => e.dataset.sim)) === "1");
      await p.selectOption(".sim-panel select:near(:text('Campo'))", { index: 1 }).catch(() => {});
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-simulacao.png") });
      await p.click(".sim-panel button:has-text('Árvore')");
      check("corpo volta a aparecer", (await p.$eval(".viewport", (e) => e.dataset.sim)) === "");
    } else R.push("- cálculo no agente saltado (Gmsh/CalculiX não instalados)");
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
    agent?.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Simulação: há testes falhados"); process.exit(1); }
  console.log("Simulação: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
