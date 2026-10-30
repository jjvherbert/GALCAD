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
    const calc = async () => { await node("Resolver"); await p.click(`${P} button:has-text('Calcular no agente local')`); };
    const convOn = async (on) => { await node("Resolver"); const c = p.locator(`${P} label:has-text('Estudo de convergência') input`); if ((await c.isChecked()) !== on) await c.click(); };
    await ws("Simulação FEM");
    await p.waitForSelector(".sim-browser");
    check("espaço FEM: árvore e barra próprias", /Consola — estática/.test(await p.textContent(".sim-study.on")) && (await p.$$(".tabs button")).length === 6 && /Encastrar/.test(await p.textContent(".tb-row.commands")) === false);
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
      // convergência da malha: três malhas e GCI da flecha (F5 calcula a partir de qualquer secção)
      await convOn(true);
      await node("Material");
      await p.keyboard.press("F5");
      await p.waitForSelector(`${P} details.convergence`, { timeout: 300000 });
      const cv = (await p.textContent(`${P} details.convergence`)).replace(/\s+/g, " ");
      const ext = Number(cv.match(/Deslocamento máx\. \(mm\)[\d.\s/]+→\s*([\d.]+)/)?.[1]);
      check("convergência: flecha extrapolada ≈ 0,192 mm", Math.abs(ext - 0.192) < 0.004 && /GCI/.test(cv), cv.slice(0, 260));
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
      // convergência ±3 níveis (7 malhas de hexaedros à volta de h)
      await convOn(true);
      await p.selectOption(`${P} label.field:has-text('Modo') select`, "sweep");
      await p.click(`${P} button:has-text('Calcular no agente local')`);
      await p.waitForFunction(() => document.querySelector(".sim-panel table.sweep") || (!document.querySelector(".sim-progress") && /erro|Erro|falh/.test(document.body.textContent ?? "")), null, { timeout: 900000 });
      if (!(await p.$(`${P} table.sweep`))) throw new Error(`varrimento sem tabela: ${(await p.textContent(".statusbar")) ?? ""} ${(await p.textContent(P)).slice(0, 400)}`);
      const sw = (await p.textContent(`${P} details.convergence`)).replace(/\s+/g, " ");
      check("convergência ±3: 7 malhas e monotonia", (await p.$$(`${P} table.sweep tr`)).length === 8 && /monotónica/.test(sw) && /\(pedida\)/.test(sw), sw.slice(0, 240));
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
