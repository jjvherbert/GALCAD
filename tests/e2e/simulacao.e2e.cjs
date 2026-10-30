// Simulação no Chromium: espaços de trabalho FEM/CFD (árvore do modelo, barra própria, secções), exportar o caso (.zip) e calcular uma consola no agente
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

    // espaços de trabalho (Fusion): árvore do modelo à esquerda, secção à direita
    const ws = async (label) => { await p.click(".ws-button"); await p.click(`.ws-menu button:has-text('${label}')`); await p.waitForTimeout(250); };
    const node = async (label) => { await p.click(`.sim-node:has-text('${label}')`); await p.waitForTimeout(150); };
    const P = ".sim-panel";
    const calc = async () => {
      await node("Resolver");
      const b = p.locator(`${P} button:has-text('Calcular no agente local')`);
      try { await b.waitFor({ timeout: 15000 }); } catch { throw new Error(`sem botão Calcular; botões: ${JSON.stringify(await p.$$eval(".sim-panel button", (x) => x.map((y) => y.textContent.trim().slice(0, 28) + (y.disabled ? '(off)' : ''))))} · progresso: ${!!(await p.$(".sim-progress"))} · título: ${await p.textContent(".sim-panel .pm-title")} · estado: ${(await p.textContent(".statusbar")).slice(0, 200)}`); }
      await b.click();
    };
    // convergência: configura-se na secção «Convergência» do estudo (guardada no estudo)
    const convOn = async (on) => { await node("Convergência"); const c = p.locator(`${P} label:has-text('Correr a convergência') input`); if ((await c.isChecked()) !== on) await c.click(); };
    const gciRow = async (label) => { const t = p.locator(`${P} table.conv-table:has(caption:has-text('GCI por grandeza'))`); const row = t.locator("tbody tr", { hasText: label }); const cells = (await row.locator("td").allTextContents()); return { ext: Number(cells[6].replace(",", ".")), p: Number(cells[5].replace(",", ".")), cells }; };
    await ws("Simulação FEM");
    await p.waitForSelector(".sim-browser");
    check("espaço FEM: árvore e barra próprias", /Consola — estática/.test(await p.textContent(".sim-study.on")) && (await p.$$(".tabs button")).length === 6);
    await p.click(".tabs button:has-text('Cargas e apoios')");
    await p.waitForSelector(`${P} .pm-title:has-text('Cargas e apoios')`);
    const panel = await p.textContent(P);
    check("separador abre a secção (cargas no painel)", /Encastramento/.test(panel) && /Força total/.test(panel) && /Encastrar/.test(await p.textContent(".tb-row.commands")), panel.slice(0, 200));
    const before = (await p.textContent(".sim-node:has-text('Cargas e apoios')")).match(/(\d+) condição/)?.[1];
    await p.click(".cmd:has-text('Pressão')");
    check("barra: + pressão com seleção de faces ativa", /Modo de seleção: faces/.test(await p.textContent("body")) && Number((await p.textContent(".sim-node:has-text('Cargas e apoios')")).match(/(\d+) condição/)?.[1]) === Number(before) + 1);
    await p.keyboard.press("Escape");
    await p.click(`${P} .kw-item:has-text('Pressão') button[aria-label^='Retirar']`);
    await node("Resolver");
    const [dl] = await Promise.all([p.waitForEvent("download"), p.click(`${P} button:has-text('Exportar caso')`)]);
    const zip = fs.readFileSync(await dl.path());
    const names = zip.toString("latin1");
    check("caso exportado (.zip)", ["case.json", "model.brep", "mesh.geo", "LEIA-ME.txt"].every((n) => names.includes(n)), `${zip.length} bytes`);
    check("agente disponível para download", (await (await fetch(`${URL}/cad-runner.mjs`)).text()).includes("Agente CAD a escutar"));

    if (solvers) {
      await p.click(`${P} summary:has-text('Agente local')`);
      await p.fill(`${P} label.field:has-text('Endereço') input`, `http://127.0.0.1:${AGENT}`); await p.press(`${P} label.field:has-text('Endereço') input`, "Tab");
      await p.fill(`${P} input[type=password]`, TOKEN);
      await p.click(`${P} button:has-text('Testar ligação')`);
      await p.waitForFunction(() => /gmsh ✓/.test(document.querySelector(".sim-panel")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
      check("ligação ao agente", /gmsh ✓ · calculix ✓/.test(await p.textContent(P)));
      await p.click(`${P} button:has-text('Calcular no agente local')`);
      await p.waitForSelector(`${P} .info-table`, { timeout: 240000 });
      const t = (await p.textContent(`${P} .info-table`)).replace(/\s+/g, " ");
      const d = Number(t.match(/Deslocamento máx\.\s*([\d.]+) mm/)?.[1]);
      // consola: δ = FL³/(3EI) + FL/(κGA) ≈ 0,192 mm
      check("flecha da consola ≈ 0,192 mm", Math.abs(d - 0.192) < 0.01, t.slice(0, 220));
      check("reação = força", /Reações totais \(N\)\s*[-\d.]+ · [-\d.]+ · 100\.00/.test(t), t.match(/Reações[^A-Z]*/)?.[0] ?? "");
      check("resultado no 3D e secção Resultados", (await p.$eval(".viewport", (e) => e.dataset.sim)) === "1" && /Resultados/.test(await p.textContent(`${P} .pm-title`)));
      await p.selectOption(`${P} select:near(:text('Campo'))`, { index: 1 }).catch(() => {});
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-simulacao.png") });
      // convergência da malha: 3 malhas, configurada no estudo; F5 corre-a a partir de qualquer secção
      await convOn(true);
      await p.selectOption(`${P} label.field:has-text('Modo') select`, "three");
      check("convergência: malhas previstas visíveis antes de correr", /3 malhas previstas/.test(await p.textContent(`${P} .conv-plan`)));
      await node("Material");
      await p.keyboard.press("F5");
      await p.waitForSelector(`${P} .conv-chart svg`, { timeout: 300000 });
      const g1 = await gciRow("Deslocamento máx.");
      check("convergência: flecha extrapolada ≈ 0,192 mm (tabela GCI)", Math.abs(g1.ext - 0.192) < 0.004 && g1.p > 0, JSON.stringify(g1.cells).slice(0, 200));
      check("convergência: tabela das malhas e 3 gráficos", (await p.$$(`${P} table.conv-table:has(caption:has-text('Malhas e resultados')) tbody tr`)).length === 3 && (await p.$$(`${P} .conv-chart svg`)).length >= 2);
      check("convergência: guardada no estudo (estudo guardado)", (await p.$$(`${P} .conv-runs option`)).length === 1 && /1 guardado/.test(await p.textContent(".sim-node:has-text('Convergência')")));
      // extrair: CSV, XLSX, JSON, SVG e relatório HTML
      const dl = async (label) => { const [d] = await Promise.all([p.waitForEvent("download"), p.click(`${P} .conv-actions button:has-text('${label}')`)]); return fs.readFileSync(await d.path()); };
      const csvMalhas = (await dl("CSV malhas")).toString("utf8");
      check("extrair CSV das malhas (todas as grandezas)", /^\uFEFFNível;Tamanho \(mm\);Elementos;Tempo \(s\)/.test(csvMalhas) && /Deslocamento máx\./.test(csvMalhas) && csvMalhas.trim().split("\n").length === 4, csvMalhas.slice(0, 120));
      check("extrair CSV do GCI", /Ordem aparente p/.test((await dl("CSV GCI")).toString("utf8")));
      const xl = await dl("XLSX");
      check("extrair XLSX com folhas Malhas e GCI", xl.slice(0, 2).toString() === "PK" && xl.toString("latin1").includes('name="Malhas"') && xl.toString("latin1").includes('name="GCI"'));
      check("extrair JSON do relatório", JSON.parse((await dl("JSON")).toString("utf8")).relatorio.levels.length === 3);
      check("extrair gráfico SVG", /^<svg /.test((await dl("Gráfico SVG")).toString("utf8")));
      const html = (await dl("Relatório HTML")).toString("utf8");
      check("extrair relatório HTML (tabelas, gráficos e limites)", html.includes("<table>") && html.includes("<svg") && /não é certificação/.test(html));
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-convergencia.png") });
      await convOn(false);
      // malha manual: hexaedros estruturados (barra Malha), pré-visualização com a qualidade e as arestas no 3D
      await p.click(".tabs button:has-text('Malha')");
      await p.click(".cmd:has-text('Hexaedros')");
      await p.waitForSelector(`${P} label.field:has-text('Método') select`);
      check("barra: hexaedros no estudo", /hexaedros/.test(await p.textContent(".sim-node:has-text('Malha')")));
      await p.click(`${P} button:has-text('Pré-visualizar malha')`);
      await p.waitForSelector(`${P} details.quality`, { timeout: 120000 });
      const q = (await p.textContent(`${P} details.quality`)).replace(/\s+/g, " ");
      check("pré-visualização: qualidade dos hexaedros", /Jacobiano escalado\s*1\.00 · 1\.00 · 1\.00/.test(q) && /Empeno/.test(q), q.slice(0, 200));
      check("pré-visualização: malha estruturada no 3D", /hexaedros de 20 nós/.test(await p.textContent(`${P} .info-table`)) && (await p.$eval(".viewport", (e) => e.dataset.sim)) === "1");
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-malha.png") });
      await calc();
      await p.waitForFunction(() => /Deslocamento máx/.test(document.querySelector(".sim-panel .info-table")?.textContent ?? ""), null, { timeout: 240000 });
      const th = (await p.textContent(`${P} .info-table`)).replace(/\s+/g, " ");
      const dh = Number(th.match(/Deslocamento máx\.\s*([\d.]+) mm/)?.[1]);
      check("consola em C3D20R ≈ 0,192 mm", Math.abs(dh - 0.192) < 0.01 && /hexaedros de 20 nós/.test(th), th.slice(0, 160));
      // convergência ±3 níveis (7 malhas de hexaedros à volta de h): configurada e corrida a partir da secção
      await convOn(true);
      await p.selectOption(`${P} label.field:has-text('Modo') select`, "sweep");
      await p.fill(`${P} label.field:has-text('Níveis') input`, "3"); await p.press(`${P} label.field:has-text('Níveis') input`, "Tab");
      await p.selectOption(`${P} label.field:has-text('Grandeza seguida') select`, "umax").catch(() => {});
      check("varrimento: 7 malhas previstas", /7 malhas previstas/.test(await p.textContent(`${P} .conv-plan`)));
      await p.click(`${P} button:has-text('Correr convergência')`);
      await p.waitForFunction(() => document.querySelectorAll(".sim-panel .conv-runs option").length >= 2 || (!document.querySelector(".sim-progress") && /erro|Erro|falh/.test(document.body.textContent ?? "")), null, { timeout: 900000 });
      const sw = (await p.textContent(`${P}`)).replace(/\s+/g, " ");
      const rows = await p.$$(`${P} table.conv-table:has(caption:has-text('Malhas e resultados')) tbody tr`);
      check("convergência ±3: 7 malhas, monotonia e a pedida assinalada", rows.length === 7 && /monotónica/.test(sw) && /0 \(pedida\)/.test(sw), sw.slice(0, 240));
      check("convergência: dois estudos guardados e escolha entre eles", (await p.$$(`${P} .conv-runs option`)).length === 2);
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-varrimento.png") });
      await convOn(false);
      // dinâmica implícita (carga em degrau): pico ≈ 2× a flecha estática e a resposta no tempo
      await node("Estudo");
      await p.selectOption(`${P} label.field:has-text('Análise') select`, "dynamic");
      await p.fill(`${P} label.field:has-text('Duração') input`, "0.0015"); await p.press(`${P} label.field:has-text('Duração') input`, "Tab");
      await calc();
      await p.waitForSelector(`${P} details.history svg.time-plot`, { timeout: 600000 });
      const td = (await p.textContent(`${P} .info-table`)).replace(/\s+/g, " ");
      const pk = Number(td.match(/Deslocamento máx\. \(pico\)\s*([\d.]+) mm/)?.[1]);
      check("dinâmica implícita: pico ≈ 2 × 0,191 mm", Math.abs(pk / 0.191 - 2) < 0.12 && /implícita/.test(td), td.slice(0, 220));
      check("dinâmica: deformadas por instante", (await p.$$eval(`${P} label.field:has-text('Deformada') option`, (o) => o.length)) > 10);
      await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-dinamica.png") });
      await node("Estudo");
      await p.selectOption(`${P} label.field:has-text('Análise') select`, "static");
      await p.click(".tabs button:has-text('Malha')");
      await p.click(".cmd:has-text('Tetraedros')");
      if (has("simpleFoam") || fs.existsSync("/usr/share/openfoam/etc/bashrc")) {
        await ws("Simulação CFD");
        await calc();
        await p.waitForFunction(() => /OpenFOAM/.test(document.querySelector(".sim-panel .kw-item.ok")?.textContent ?? ""), null, { timeout: 300000 });
        const ct = (await p.textContent(`${P} .kw-item.ok`)).replace(/\s+/g, " ");
        check("CFD: queda de pressão e balanço", /Queda de pressão/.test(ct) && /Balanço de massa\s*-?0\.\d+ %/.test(ct), ct.slice(0, 200));
        const layers = await p.$eval(".viewport", (e) => e.dataset.simLayers);
        check("CFD: entrada, saída e corte no 3D", /Entrada/.test(layers) && /Saída/.test(layers) && /Corte Z/.test(layers), layers);
        await p.selectOption(`${P} select:near(:text('Campo'))`, { index: 1 }).catch(() => {});
        await p.click(`${P} fieldset label:has-text('Paredes') input`);
        check("CFD: camada das paredes ligada", /Paredes/.test(await p.$eval(".viewport", (e) => e.dataset.simLayers)));
        await p.click(`${P} fieldset label:has-text('Paredes') input`);
        await p.waitForTimeout(300);
        await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-simulacao-cfd.png") });
        await ws("Simulação FEM");
      } else R.push("- CFD no agente saltado (OpenFOAM não instalado)");
      await ws("Design");
      check("Design: corpo volta a aparecer e a árvore de features", (await p.$eval(".viewport", (e) => e.dataset.sim)) === "" && !(await p.$(".sim-browser")));
      // estudo da montagem: duas lâminas coladas ≈ a consola inteira
      await p.click(".doc-tab:has-text('Lâminas')");
      await p.waitForFunction(() => /Lâmina B<1>/.test(document.querySelector(".assembly-tree")?.textContent ?? ""), null, { timeout: 90000 });
      await ws("Simulação FEM");
      await node("Contacto");
      const ap = await p.textContent(P);
      check("montagem: árvore com contacto e corpos", /Lâminas coladas/.test(await p.textContent(".sim-study.on")) && /Colado nas faces planas/.test(ap) && /Lâmina A<1>/.test(ap), ap.slice(0, 200));
      await calc();
      await p.waitForFunction(() => /CalculiX/.test(document.querySelector(".sim-panel .kw-item.ok")?.textContent ?? ""), null, { timeout: 240000 });
      const at = (await p.textContent(`${P} .kw-item.ok`)).replace(/\s+/g, " ");
      const ad = Number(at.match(/Deslocamento máx\.\s*([\d.]+) mm/)?.[1]);
      check("montagem: flecha das lâminas coladas ≈ 0,192 mm", Math.abs(ad - 0.192) < 0.01 && /contacto colado/.test(await p.textContent(`${P} details:has(summary:text('Hipóteses'))`)), at.slice(0, 160));
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
