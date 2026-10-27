// Navegação e comandos ao estilo do SolidWorks, no Chromium. Uso: npm run build && npm run test:e2e
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4180;
const URL = `http://localhost:${PORT}`;

async function main() {
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(URL)).ok) break; } catch { /* a arrancar */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    const p = await b.newPage({ viewport: { width: 1400, height: 860 } });
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    const settle = async () => { await p.waitForTimeout(250); await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 }); await p.waitForTimeout(100); };
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/bloco.cadp.json"), "utf8"));
    await p.reload(); await settle();
    const dir = () => p.$eval(".viewport", (e) => e.dataset.viewDir);
    const zoom = async () => Number(await p.$eval(".viewport", (e) => e.dataset.zoom));
    const vb = await p.locator(".viewport").boundingBox();
    const cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2;
    await p.mouse.move(cx, cy);
    const R = [];
    const check = (name, ok, extra = "") => R.push(`${ok ? "✓" : "✗"} ${name} ${extra}`);
    await p.keyboard.press("Control+1"); check("Ctrl+1 frente", (await dir()) === "0.000,-1.000,0.000", await dir());
    await p.keyboard.press("Control+5"); check("Ctrl+5 topo", (await dir()) === "0.000,0.000,1.000", await dir());
    await p.keyboard.press("Control+7"); check("Ctrl+7 iso", (await dir()) === "0.577,-0.577,0.577", await dir());
    // meio = rodar
    await p.mouse.move(cx, cy); await p.mouse.down({ button: "middle" }); await p.mouse.move(cx + 120, cy + 30, { steps: 6 }); await p.mouse.up({ button: "middle" });
    const rotated = await dir(); check("meio rodar", rotated !== "0.577,-0.577,0.577", rotated);
    await p.keyboard.press("Control+Shift+Z"); check("vista anterior", (await dir()) === "0.577,-0.577,0.577", await dir());
    // Ctrl+meio = deslocar (a direção mantém-se)
    await p.keyboard.down("Control"); await p.mouse.move(cx, cy); await p.mouse.down({ button: "middle" }); await p.mouse.move(cx + 80, cy, { steps: 4 }); await p.mouse.up({ button: "middle" }); await p.keyboard.up("Control");
    check("Ctrl+meio deslocar", (await dir()) === "0.577,-0.577,0.577");
    // roda: para a frente afasta
    const z0 = await zoom(); await p.mouse.wheel(0, -200); await p.waitForTimeout(50); const z1 = await zoom();
    check("roda para a frente afasta", z1 < z0, `${z0} → ${z1}`);
    // Shift+meio = zoom
    await p.keyboard.down("Shift"); await p.mouse.down({ button: "middle" }); await p.mouse.move(cx, cy - 80, { steps: 4 }); await p.mouse.up({ button: "middle" }); await p.keyboard.up("Shift");
    const z2 = await zoom(); check("Shift+meio zoom", z2 !== z1, `${z1} → ${z2}`);
    // duplo clique no meio = ajustar
    await p.mouse.click(cx + 300, cy + 200, { button: "middle" }); await p.mouse.click(cx + 300, cy + 200, { button: "middle" });
    check("duplo meio ajusta", (await zoom()) === 1, String(await zoom()));
    // setas: 15°
    const d0 = (await dir()).split(",").map(Number); await p.keyboard.press("ArrowLeft"); const d1 = (await dir()).split(",").map(Number);
    const ang = Math.acos(d0.reduce((s, v, i) => s + v * d1[i], 0)) * 180 / Math.PI; check("seta = 15°", Math.abs(ang - 15) < 0.5, ang.toFixed(2) + " " + d0 + " → " + d1);
    await p.keyboard.press("Control+7");
    // menu de contexto numa face → Normal a
    await p.mouse.click(cx, cy - 40, { button: "right" });
    await p.waitForSelector(".popup[aria-label='Menu de contexto']");
    const menuText = await p.textContent(".popup"); check("menu de contexto da face", /Esboço aqui/.test(menuText) && /Editar Extrusão1/.test(menuText));
      await p.click(".popup button:has-text('Normal a')"); check("Normal a (face de topo)", (await dir()) === "0.000,0.000,1.000", await dir());
    // gesto: arrastar com o direito para a direita → vista direita
    await p.keyboard.press("Control+7");
    await p.mouse.move(cx, cy + 150); await p.mouse.down({ button: "right" }); await p.mouse.move(cx + 110, cy + 150, { steps: 6 });
    await p.mouse.up({ button: "right" }); check("gesto → direita", (await dir()) === "1.000,0.000,0.000", await dir());
    await p.keyboard.press("Control+7");
    // caixa de seleção (janela) à volta da peça → 12 arestas
    await p.mouse.move(vb.x + 30, vb.y + 60); await p.mouse.down(); await p.mouse.move(vb.x + vb.width - 30, vb.y + vb.height - 30, { steps: 8 }); await p.mouse.up();
    const selTxt = (await p.textContent(".side-info p.muted")).match(/(\d+) selecionado/)?.[1]; check("caixa → 12 arestas", selTxt === "12", selTxt);
    // S → pesquisar "file" → Enter → Filete com as 12 arestas
    await p.mouse.move(cx, cy); await p.keyboard.press("s"); await p.waitForSelector(".popup .search");
    await p.keyboard.type("filet"); await p.waitForTimeout(100); await p.keyboard.press("Enter");
    await p.waitForSelector(".property-panel"); await settle();
    const refs = await p.$$eval(".reflist li", (e) => e.length); check("S → Filete com a seleção", refs === 12, String(refs));
    await p.keyboard.press("Enter"); await settle(); check("Enter confirma", (await p.$$eval(".feat", (e) => e.length)) === 4);
    // Enter repete o último comando
    await p.keyboard.press("Enter"); await p.waitForTimeout(200); check("Enter repete Filete", (await p.textContent(".property-panel h2").catch(() => "")).includes("filete"));
    await p.keyboard.press("Escape"); await p.keyboard.press("Escape");
    // duplo clique numa face → editar a feature
    await p.mouse.dblclick(cx, cy - 40); await p.waitForTimeout(200);
    check("duplo clique → editar feature", /Extrusão|Filete/.test(await p.textContent(".property-panel h2").catch(() => "")), await p.textContent(".property-panel h2").catch(() => "-"));
    await p.keyboard.press("Escape");
    // separador Referências
    await p.click(".tabs button:has-text('Referências')"); check("separador Referências", await p.locator(".commands button:has-text('Plano')").count() === 1);
    // Ctrl+B reconstruir / Ctrl+Q forçar
    await p.keyboard.press("Control+q"); await settle(); check("Ctrl+Q força (0 da cache)", /\(0 da cache\)/.test(await p.textContent(".statusbar")), (await p.textContent(".statusbar")).slice(0, 50));
    await p.keyboard.press("Control+b"); await settle(); check("Ctrl+B reconstrói (cache)", /\(3 da cache\)/.test(await p.textContent(".statusbar")), (await p.textContent(".statusbar")).slice(0, 50));
    // Espaço → orientação
    await p.keyboard.press("Space"); check("Espaço → orientação", await p.locator(".popup[aria-label='Orientação da vista']").count() === 1);
    await p.keyboard.press("Escape");
    // estilo fio de arame
    await p.click(".heads-up button[title='Estilo de visualização']"); await p.click(".heads-up .menu button:has-text('fio de arame')");
    // regiões: dois círculos sobrepostos → extrudir só a lente
    await p.evaluate((t) => { localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/venn.cadp.json"), "utf8"));
    await p.reload(); await settle();
    await p.click(".tabs button:has-text('Features')");
    await p.click("button.cmd:has-text('Extrusão')");
    await p.waitForSelector(".reflist.active");
    check("contornos sobrepostos pedem regiões", (await p.textContent(".reflist")).includes("3 região"), (await p.textContent(".reflist")).slice(0, 90));
    await p.keyboard.press("Control+5");
    const vb2 = await p.locator(".viewport").boundingBox();
    const wpp = 240 / vb2.height;
    await p.mouse.click(vb2.x + vb2.width / 2 + 10 / wpp, vb2.y + vb2.height / 2);
    await settle();
    check("clique escolhe a lente", (await p.$$eval(".reflist li", (e) => e.length)) === 1);
    await p.click(".property-panel button:has-text('OK')"); await settle();
    const vol = Number((await p.textContent(".side-info")).match(/Volume\s*([\d\s,.]+)\s*cm³/)[1].replace(/\s/g, "").replace(",", "."));
    const lens = (2 * 400 * Math.acos(0.5) - 10 * Math.sqrt(1200)) * 10 / 1000;
    check("volume da lente", Math.abs(vol - lens) < 0.01, `${vol} vs ${lens.toFixed(3)}`);
    await b.close();
    for (const r of R) console.log(r);
    const failed = R.filter((r) => r.startsWith("✗"));
    if (logs.length) console.log("erros de página:", logs.join(" | "));
    if (failed.length || logs.length) process.exit(1);
    console.log("Navegação: todos os testes passaram.");
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
