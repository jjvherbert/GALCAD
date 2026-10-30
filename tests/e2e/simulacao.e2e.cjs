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
      // convergência da malha: três malhas e GCI da flecha
      await p.click(".sim-panel label:has-text('Estudo de convergência') input");
      await p.click(".sim-panel button:has-text('Calcular no agente local')");
      await p.waitForSelector(".sim-panel details.convergence", { timeout: 300000 });
      const cv = (await p.textContent(".sim-panel details.convergence")).replace(/\s+/g, " ");
      const ext = Number(cv.match(/Deslocamento máx\. \(mm\)[\d.\s/]+→\s*([\d.]+)/)?.[1]);
      check("convergência: flecha extrapolada ≈ 0,192 mm", Math.abs(ext - 0.192) < 0.004 && /GCI/.test(cv), cv.slice(0, 260));
      await p.click(".sim-panel label:has-text('Estudo de convergência') input");
      // malha manual: hexaedros estruturados, pré-visualização com a qualidade e as arestas no 3D
      await p.selectOption(".sim-panel label.field:has-text('Elementos') select", "hex");
      await p.waitForSelector(".sim-panel label.field:has-text('Método') select");
      await p.click(".sim-panel button:has-text('Pré-visualizar malha')");
      await p.waitForSelector(".sim-panel details.quality", { timeout: 120000 });
      const q = (await p.textContent(".sim-panel details.quality")).replace(/\s+/g, " ");
      check("pré-visualização: qualidade dos hexaedros", /Jacobiano escalado\s*1\.00 · 1\.00 · 1\.00/.test(q) && /Empeno/.test(q), q.slice(0, 200));
      check("pré-visualização: malha estruturada no 3D", /hexaedros de 20 nós/.test(await p.textContent(".sim-panel .info-table")) && (await p.$eval(".viewport", (e) => e.dataset.sim)) === "1");
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-malha.png") });
      await p.click(".sim-panel button:has-text('Calcular no agente local')");
      await p.waitForFunction(() => /Deslocamento máx/.test(document.querySelector(".sim-panel .info-table")?.textContent ?? ""), null, { timeout: 240000 });
      const th = (await p.textContent(".sim-panel .info-table")).replace(/\s+/g, " ");
      const dh = Number(th.match(/Deslocamento máx\.\s*([\d.]+) mm/)?.[1]);
      check("consola em C3D20R ≈ 0,192 mm", Math.abs(dh - 0.192) < 0.01 && /hexaedros de 20 nós/.test(th), th.slice(0, 160));
      // convergência ±3 níveis (7 malhas de hexaedros à volta de h)
      await p.click(".sim-panel label:has-text('Estudo de convergência') input");
      await p.selectOption(".sim-panel label.field:has-text('Modo') select", "sweep");
      await p.click(".sim-panel button:has-text('Calcular no agente local')");
      await p.waitForSelector(".sim-panel table.sweep", { timeout: 600000 });
      const sw = (await p.textContent(".sim-panel details.convergence")).replace(/\s+/g, " ");
      check("convergência ±3: 7 malhas e monotonia", (await p.$$(".sim-panel table.sweep tr")).length === 8 && /monotónica/.test(sw) && /\(pedida\)/.test(sw), sw.slice(0, 240));
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-varrimento.png") });
      await p.click(".sim-panel label:has-text('Estudo de convergência') input");
      await p.selectOption(".sim-panel label.field:has-text('Elementos') select", "tet");
      if (has("simpleFoam") || fs.existsSync("/usr/share/openfoam/etc/bashrc")) {
        await p.selectOption(".sim-panel select[aria-label=Estudo]", "s2");
        await p.waitForTimeout(300);
        await p.click(".sim-panel button:has-text('Calcular no agente local')");
        await p.waitForFunction(() => /OpenFOAM/.test(document.querySelector(".sim-panel .kw-item.ok")?.textContent ?? ""), null, { timeout: 300000 });
        const ct = (await p.textContent(".sim-panel .kw-item.ok")).replace(/\s+/g, " ");
        check("CFD: queda de pressão e balanço", /Queda de pressão/.test(ct) && /Balanço de massa\s*-?0\.\d+ %/.test(ct), ct.slice(0, 200));
        const layers = await p.$eval(".viewport", (e) => e.dataset.simLayers);
        check("CFD: entrada, saída e corte no 3D", /Entrada/.test(layers) && /Saída/.test(layers) && /Corte Z/.test(layers), layers);
        await p.selectOption(".sim-panel select:near(:text('Campo'))", { index: 1 }).catch(() => {});
        await p.click(".sim-panel fieldset label:has-text('Paredes') input");
        check("CFD: camada das paredes ligada", /Paredes/.test(await p.$eval(".viewport", (e) => e.dataset.simLayers)));
        await p.click(".sim-panel fieldset label:has-text('Paredes') input");
        await p.waitForTimeout(300);
        await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-simulacao-cfd.png") });
      } else R.push("- CFD no agente saltado (OpenFOAM não instalado)");
      await p.click(".sim-panel button:has-text('Árvore')");
      check("corpo volta a aparecer", (await p.$eval(".viewport", (e) => e.dataset.sim)) === "");
      // estudo da montagem: duas lâminas coladas ≈ a consola inteira
      await p.click(".doc-tab:has-text('Lâminas')");
      await p.waitForFunction(() => /Lâmina B<1>/.test(document.querySelector(".assembly-tree")?.textContent ?? ""), null, { timeout: 90000 });
      await p.click("[role=tab]:has-text('Simulação')");
      await p.click(".commands button[title^='Simulação']");
      await p.waitForSelector(".sim-panel");
      const ap = await p.textContent(".sim-panel");
      check("montagem: painel com corpos e contacto", /Lâminas coladas/.test(ap) && /Colado nas faces planas/.test(ap) && /Lâmina A<1>/.test(ap), ap.slice(0, 200));
      await p.click(".sim-panel button:has-text('Calcular no agente local')");
      await p.waitForFunction(() => /Deslocamento máx\./.test(document.querySelector(".sim-panel .info-table:last-of-type")?.textContent ?? "") || /CalculiX/.test(document.querySelector(".sim-panel .kw-item.ok")?.textContent ?? ""), null, { timeout: 240000 });
      const at = (await p.textContent(".sim-panel .kw-item.ok")).replace(/\s+/g, " ");
      const ad = Number(at.match(/Deslocamento máx\.\s*([\d.]+) mm/)?.[1]);
      check("montagem: flecha das lâminas coladas ≈ 0,192 mm", Math.abs(ad - 0.192) < 0.01 && /contacto colado/.test(await p.textContent(".sim-panel details:has(summary:text('Hipóteses'))")), at.slice(0, 160));
      check("montagem: resultado no 3D", (await p.$eval(".viewport", (e) => e.dataset.sim)) === "1");
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-simulacao-montagem.png") });
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
