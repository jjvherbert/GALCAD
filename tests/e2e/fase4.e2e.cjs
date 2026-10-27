// Fase 4 no Chromium: separadores GSD/Classe A, análises de continuidade/realce/pentes, forma livre
// (arrastar um polo), knowledgeware (verificações, configurações, regras), referência externa e
// exportação STEP AP242.
// Uso: npm run build && node tests/e2e/fase4.e2e.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4184;
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
    const p = await b.newPage({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    const settle = async () => { await p.waitForTimeout(250); await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 }); await p.waitForTimeout(200); };
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/fase4.cadp.json"), "utf8"));
    await p.reload(); await settle();
    const vp = (k) => p.$eval(".viewport", (e, key) => e.dataset[key] ?? "", k);

    // separador Superfícies: grupos GSD, forma livre e classe A
    await p.click("[role=tab]:has-text('Superfícies')");
    const tab = await p.textContent(".commands");
    check("separador com GSD e classe A", ["Multi-secção", "Concordância", "Varrimento circular", "Extrapolar", "Curar", "Forma livre", "Continuidade", "Realce", "Pentes"].every((t) => tab.includes(t)), tab.slice(0, 300));
    check("peça GSD sem erros", !/⚠|erro/i.test(await p.textContent(".tree")), (await p.textContent(".tree")).slice(0, 200));

    // continuidade: as duas costuras da concordância G2 são pelo menos G2
    await p.click(".commands button[title^='Continuidade']");
    await p.waitForFunction(() => /G3:/.test(document.querySelector(".analysis-panel")?.textContent ?? ""), null, { timeout: 60000 });
    const cont = (await p.textContent(".analysis-panel")).replace(/\s+/g, " ");
    const g2 = Number(cont.match(/G2 \([^)]*\): (\d+)/)?.[1] ?? 0) + Number(cont.match(/G3: (\d+)/)?.[1] ?? 0);
    check("continuidade G2/G3 nas costuras", g2 >= 2, cont.slice(0, 220));
    await p.click(".commands button[title^='Linhas de realce']");
    await p.waitForFunction(() => document.querySelector(".viewport")?.dataset.exactNormals === "1", null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(300);
    check("linhas de realce com normais exatas", (await vp("analysis")) === "highlight" && (await vp("exactNormals")) === "1");
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-realce.png") });
    await p.click(".commands button[title^='Pentes de curvatura']");
    await p.waitForFunction(() => Number(document.querySelector(".viewport")?.dataset.combs ?? 0) > 0, null, { timeout: 60000 }).catch(() => {});
    check("pentes de curvatura desenhados", Number(await vp("combs")) > 0, await vp("combs"));
    await p.click(".analysis-panel button[aria-label='Desligar análise']");

    // forma livre: editar o patch e arrastar o polo central para cima
    await p.dblclick(".tree li:has-text('Patch livre')");
    await p.waitForFunction(() => document.querySelector(".viewport")?.dataset.poles === "25", null, { timeout: 30000 });
    check("rede de controlo 5 × 5", (await vp("poles")) === "25");
    const [cx, cy] = (await vp("poleCenter")).split(",").map(Number);
    await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx, cy - 30, { steps: 5 }); await p.mouse.move(cx, cy - 60, { steps: 5 }); await p.mouse.up();
    await settle();
    const ff = await p.textContent(".property-panel");
    check("polo arrastado", /1 polo\(s\) deslocado\(s\)/.test(ff), ff.replace(/\s+/g, " ").slice(0, 200));
    check("polo selecionado com deslocamento", /Polo \(3, 3\)/.test(ff));
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-forma-livre.png") });
    await p.click(".property-panel button.primary"); await settle();

    // esqueleto: verificações, configurações e regra
    await p.click(".doc-tab:has-text('Esqueleto')"); await settle();
    const info = async () => (await p.textContent(".side-info")).replace(/\s+/g, " ");
    check("verificação cumprida (Curto)", /Verificações: 1\/1 cumpridas · configuração Curto/.test(await info()), (await info()).slice(0, 200));
    const vol = async () => Number((await info()).match(/Volume\s*([\d\s,.]+)\s*cm³/)[1].replace(/\s/g, "").replace(",", "."));
    check("volume Curto = 100×60×20", Math.abs((await vol()) - 120) < 1e-3, String(await vol()));
    await p.click("[role=tab]:has-text('Conhecimento')");
    await p.click(".commands button[title^='Conhecimento']");
    await p.waitForSelector(".knowledge-panel");
    await p.click(".knowledge-panel [role=tab]:has-text('Configurações')");
    await p.click(".knowledge-panel input[aria-label='Ativar Comprido']"); await settle();
    await p.click(".knowledge-panel button:has-text('Árvore')");
    // Comprido: L = 200 → a regra põe H = 30 → 200×60×30 = 360 cm³, massa 2,8 kg > 1,5 kg (verificação falha)
    check("configuração Comprido + regra", Math.abs((await vol()) - 360) < 1e-3, String(await vol()));
    check("verificação falhada assinalada", /Verificações: 0\/1 cumpridas · ✗ Massa máx/.test(await info()), (await info()).slice(0, 200));
    await p.click(".commands button[title^='Conhecimento']");
    await p.click(".knowledge-panel [role=tab]:has-text('Publicações')");
    const pubs = await p.textContent(".knowledge-panel .kw-list");
    const names = await p.$$eval(".knowledge-panel .kw-list input[aria-label='Nome']", (es) => es.map((e) => e.value));
    check("publicações listadas e usadas", names.join() === "Meio,Topo" && /usada por Tampa/.test(pubs), `${names} · ${pubs.replace(/\s+/g, " ").slice(0, 200)}`);
    await p.click(".knowledge-panel [role=tab]:has-text('Configurações')");
    await p.click(".knowledge-panel input[aria-label='Ativar Curto']"); await settle();
    await p.click(".knowledge-panel button:has-text('Árvore')");

    // tampa: referência externa ao plano publicado (z = 50) → caixa de 30×30×4 a partir de z = 50
    await p.click(".doc-tab:has-text('Tampa')"); await settle();
    check("tampa com referência externa", /Referência externa/.test(await p.textContent(".tree")) && Math.abs((await vol()) - 3.6) < 1e-3, (await info()).slice(0, 160));
    await p.click("button:has-text('Ficheiro')");
    const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[role=menuitem]:has-text('STEP AP242')")]);
    const step = fs.readFileSync(await dl.path(), "utf8");
    check("exportação STEP AP242", step.startsWith("ISO-10303-21") && /AP242/.test(step) && /PRODUCT\s*\(\s*'Tampa'/.test(step), step.slice(0, 80));
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Fase 4: há testes falhados"); process.exit(1); }
  console.log("Fase 4: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
