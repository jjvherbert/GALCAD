// PMI 3D no Chromium: painel de anotações com os valores medidos, rótulos no modelo, erros de
// validação, vistas de modelo, atributos pesquisáveis com CSV e STEP AP242 com PMI semântico.
// Uso: npm run build && node tests/e2e/pmi.e2e.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4186;
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
    const p = await b.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    const settle = async () => { await p.waitForTimeout(250); await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 }); await p.waitForTimeout(200); };
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/pmi.cadp.json"), "utf8"));
    await p.reload(); await settle();

    await p.click("[role=tab]:has-text('PMI')");
    await p.click(".commands button[title^='PMI']");
    await p.waitForSelector(".pmi-panel");
    await p.waitForFunction(() => /todas válidas/.test(document.querySelector(".pmi-panel")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
    const panel = (await p.textContent(".pmi-panel")).replace(/\s+/g, " ");
    check("anotações válidas com os valores do modelo", /7 anotações · todas válidas/.test(panel) && /20 ±0,1/.test(panel) && /⌀10 H7 \(\+0,015\/0\)/.test(panel) && /\|⌖\|⌀0,1Ⓜ\|A\|B\|/.test(panel), panel.slice(0, 260));
    const labels = await p.$$eval(".pmi-label", (els) => els.map((e) => e.textContent));
    check("rótulos PMI no 3D", labels.length === 7 && labels.includes("[A]") && labels.includes("|⏥|0,02|"), labels.join(" ; "));
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-pmi-iso.png") });
    // os rótulos acompanham a câmara
    const before = await p.$eval(".pmi-label[data-id=pmi5]", (e) => e.style.transform);
    await p.keyboard.press("Control+1"); await p.waitForTimeout(300);
    const after = await p.$eval(".pmi-label[data-id=pmi5]", (e) => e.style.transform);
    check("rótulos seguem a vista", before !== after, `${before} → ${after}`);

    // nova tolerância sem faces: erro de validação; editar o ajustamento mostra a folga
    await p.selectOption(".pmi-panel select[aria-label='Acrescentar PMI']", "gdt"); await settle();
    check("validação: tolerância sem faces", /Escolha as faces/.test(await p.textContent(".pmi-panel")) && /1 com erros/.test(await p.textContent(".pmi-panel")));
    await p.click(".pmi-panel button[aria-label='Apagar pmi8']"); await settle();
    await p.click(".pmi-panel .pmi-head:has-text('⌀10 H7')");
    const fitTxt = (await p.textContent(".pmi-panel")).replace(/\s+/g, " ");
    check("ajustamento H7/g6 com folga", /Ajustamento H7\/g6 com folga: folga 5\.0 a 29\.0 µm/.test(fitTxt), fitTxt.match(/Ajustamento[^µ]*µm/)?.[0] ?? "");
    await p.click(".pmi-label[data-id=pmi6]");
    check("clicar no rótulo seleciona o item", (await p.$eval(".pmi-label[data-id=pmi6]", (e) => e.className)).includes("on"));

    // vista de modelo: guardar, retirar PMI, aplicar
    await p.click(".pmi-panel [role=tab]:has-text('Vistas de modelo')");
    await p.fill(".pmi-panel input[aria-label='Nome da vista']", "Furo");
    await p.click(".pmi-panel button:has-text('Guardar vista atual')"); await settle();
    await p.click(".pmi-panel button.link:has-text('Furo')"); await p.waitForTimeout(300);
    for (const t of ["[A]", "[B]", "20 ±0,1", "|⏥|0,02|", "▽ Ra 1,6"]) await p.click(`.pmi-panel fieldset label:has-text('${t}') input`);
    await settle();
    const shown = await p.$$eval(".pmi-label", (els) => els.map((e) => e.textContent).sort());
    check("vista de modelo filtra o PMI", shown.length === 2 && shown.some((x) => /⌖/.test(x)), shown.join(" ; "));
    await p.evaluate(() => document.activeElement?.blur());
    await p.keyboard.press("Control+7"); await p.waitForTimeout(200);
    const dir0 = await p.$eval(".viewport", (e) => e.dataset.viewDir);
    await p.click(".pmi-panel button.link:has-text('Furo')"); await p.waitForTimeout(300);
    const dir1 = await p.$eval(".viewport", (e) => e.dataset.viewDir);
    check("vista de modelo repõe a câmara (frente)", dir0 === "0.577,-0.577,0.577" && dir1 === "0.000,-1.000,0.000", `${dir0} → ${dir1}`);

    // atributos: acrescentar, pesquisar, CSV
    await p.click(".pmi-panel [role=tab]:has-text('Atributos')");
    await p.fill(".pmi-panel input[aria-label=Atributo]", "Fornecedor");
    await p.fill(".pmi-panel input[aria-label=Valor]", "Oficina Galega");
    await p.click(".pmi-panel button:has-text('Acrescentar')"); await settle();
    await p.fill(".pmi-panel input[aria-label='Pesquisar atributos']", "galega");
    const hits = await p.textContent(".pmi-panel .attr-hits");
    check("pesquisa de atributos", /Placa/.test(hits) && /Fornecedor/.test(hits) && !/Processo/.test(hits), hits);
    const [csv] = await Promise.all([p.waitForEvent("download"), p.click(".pmi-panel button:has-text('CSV')")]);
    check("CSV dos atributos", /Placa;Corpo;Fornecedor;Oficina Galega/.test(fs.readFileSync(await csv.path(), "utf8")));
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-pmi.png") });

    // STEP AP242 com PMI semântico
    await p.click("button:has-text('Ficheiro')");
    const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[role=menuitem]:has-text('STEP AP242')")]);
    const step = fs.readFileSync(await dl.path(), "utf8");
    check("STEP AP242 com PMI semântico", /DATUM\('A'/.test(step) && /POSITION_TOLERANCE\(\)/.test(step) && /LIMITS_AND_FITS\('H','hole','7'/.test(step) && /'Fornecedor','Oficina Galega'/.test(step), `${step.length} bytes`);
    await p.click(".pmi-panel button:has-text('Árvore')");
    check("rótulos escondidos fora do painel", (await p.$$(".pmi-label")).length === 0);
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("PMI: há testes falhados"); process.exit(1); }
  console.log("PMI: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
