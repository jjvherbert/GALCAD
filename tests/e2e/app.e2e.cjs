// Teste de ponta a ponta no browser (Playwright + Chromium). Uso: npm run build && npm run test:e2e
// Arranca o "vite preview", percorre os fluxos principais e verifica volumes e estados.
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4179;
const URL = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cad-e2e-"));
const num = (s) => Number(String(s).replace(/\s/g, "").replace(",", "."));

async function main() {
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(URL)).ok) break; } catch { /* ainda a arrancar */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    const p = await browser.newPage({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (d) => d.accept()); // confirmações (descartar alterações, apagar dependentes)
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    const settle = async () => {
      await p.waitForTimeout(250);
      await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 });
      await p.waitForTimeout(100);
    };
    const volume = async () => num((await p.textContent(".side-info")).match(/Volume\s*([\d\s,.]+)\s*cm³/)[1]);
    const states = () => p.$$eval(".feat:not(.origin)", (els) => els.map((e) => e.className.replace("feat", "").replace("selected", "").trim()));
    const step = (name) => console.log(`✓ ${name}`);

    await p.goto(URL);
    await p.evaluate(() => localStorage.clear());
    await p.reload();
    await settle();

    // 1. variáveis
    await p.click("button:has-text('Variáveis')");
    await p.click(".modal button:has-text('+ Variável')");
    await p.fill(".modal tbody tr:nth-child(1) input[aria-label=Nome]", "W");
    await p.fill(".modal tbody tr:nth-child(1) input[aria-label='Expressão']", "120");
    await p.click(".modal button:has-text('+ Variável')");
    await p.fill(".modal tbody tr:nth-child(2) input[aria-label=Nome]", "H");
    await p.fill(".modal tbody tr:nth-child(2) input[aria-label='Expressão']", "W / 2");
    assert.match(await p.textContent(".modal tbody"), /60/);
    await p.click(".modal button:has-text('Aplicar')");
    await settle();
    step("variáveis W e H = W/2");

    // 2. esboço: retângulo com canto na origem, cotas W e H
    await p.click("button.cmd:has-text('Esboço')");
    await p.click("button:has-text('Começar')");
    const box = await p.locator(".sk-canvas").boundingBox();
    const o = await p.$eval(".sk-canvas circle.origin", (e) => [Number(e.getAttribute("cx")), Number(e.getAttribute("cy"))]);
    await p.keyboard.press("r");
    await p.mouse.click(box.x + o[0], box.y + o[1]);
    await p.mouse.click(box.x + o[0] + 200, box.y + o[1] - 120);
    const pts = () => p.$$eval(".sk-canvas rect.pt", (els) => els.map((e) => [Number(e.getAttribute("x")) + 3, Number(e.getAttribute("y")) + 3]));
    await p.keyboard.press("d");
    let P = await pts();
    let xs = P.map((q) => q[0]), ys = P.map((q) => q[1]);
    await p.mouse.click(box.x + (Math.min(...xs) + Math.max(...xs)) / 2, box.y + Math.max(...ys));
    await p.mouse.click(box.x + (Math.min(...xs) + Math.max(...xs)) / 2, box.y + Math.max(...ys) + 40);
    await p.fill(".dim-input input", "W");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(200);
    P = await pts(); xs = P.map((q) => q[0]); ys = P.map((q) => q[1]);
    await p.mouse.click(box.x + Math.max(...xs), box.y + (Math.min(...ys) + Math.max(...ys)) / 2);
    await p.mouse.click(box.x + Math.max(...xs) + 50, box.y + (Math.min(...ys) + Math.max(...ys)) / 2);
    await p.fill(".dim-input input", "H");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(400);
    assert.equal(await p.textContent(".sk-status span"), "Totalmente definido");
    await p.click("button:has-text('Sair do esboço')");
    await settle();
    step("esboço totalmente definido por variáveis");

    // 3. extrusão 15 mm
    await p.click("button.cmd:has-text('Extrusão')");
    await p.fill(".property-panel .expr input", "15");
    await settle();
    await p.click(".property-panel button:has-text('OK')");
    await settle();
    assert.ok(Math.abs((await volume()) - 108) < 0.01);
    step("extrusão: 108 cm³");

    // 4. esboço na face de topo com 2 pontos → furos M8 roscados cegos
    const vb = await p.locator(".viewport").boundingBox();
    await p.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2 - 40);
    await p.click("button.cmd:has-text('Esboço')");
    await p.waitForSelector(".sketch-editor");
    await p.waitForTimeout(400);
    const b2 = await p.locator(".sk-canvas").boundingBox();
    const ref = await p.$$eval(".ref-in", (els) => els.map((e) => [Number(e.getAttribute("x1")), Number(e.getAttribute("y1"))]));
    assert.equal(ref.length, 4, "o contorno da face aparece como referência");
    const rx = ref.map((q) => q[0]), ry = ref.map((q) => q[1]);
    await p.keyboard.press("p");
    await p.mouse.click(b2.x + Math.min(...rx) + (Math.max(...rx) - Math.min(...rx)) * 0.25, b2.y + (Math.min(...ry) + Math.max(...ry)) / 2);
    await p.mouse.click(b2.x + Math.min(...rx) + (Math.max(...rx) - Math.min(...rx)) * 0.75, b2.y + (Math.min(...ry) + Math.max(...ry)) / 2);
    await p.click("button:has-text('Sair do esboço')");
    await settle();
    await p.click("button.cmd:has-text('Furo')");
    const field = (label) => p.locator(`.property-panel label.field:has(.field-label:text-is("${label}")) select`);
    await field("Tipo").selectOption("tapped");
    await field("Rosca ISO métrica").selectOption("M8");
    await field("Fim").selectOption("blind");
    await settle();
    await p.click(".property-panel button:has-text('OK')");
    await settle();
    const drill = 2 * (Math.PI * 3.4 ** 2 * 10 + (Math.PI * 3.4 ** 2 * (3.4 / Math.tan((59 * Math.PI) / 180))) / 3) / 1000;
    assert.ok(Math.abs((await volume()) - (108 - drill)) < 0.01, `volume com furos ${await volume()}`);
    step("furos M8 roscados cegos (broca ⌀6,8, ponta 118°)");

    // 5. filete das arestas de topo e edição de uma variável: tudo atualiza
    await p.click("button.cmd:has-text('Filete')");
    await p.waitForSelector(".reflist.active");
    await p.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2 - 40);
    await p.fill(".property-panel .expr input", "2");
    await settle();
    await p.click(".property-panel button:has-text('OK')");
    await settle();
    assert.ok((await states()).every((s) => s === "ok"), (await states()).join());
    const vBefore = await volume();
    await p.click("button:has-text('Variáveis')");
    await p.fill(".modal tbody tr:nth-child(1) input[aria-label='Expressão']", "160");
    await p.click(".modal button:has-text('Aplicar')");
    await settle();
    assert.ok((await states()).every((s) => s === "ok"), `depois de W=160: ${(await states()).join()}`);
    assert.ok((await volume()) > vBefore * 1.5);
    step("filete + W=160: features continuam válidas (nomes topológicos estáveis)");

    // 6. desfazer / refazer
    const v160 = await volume();
    await p.keyboard.press("Control+z");
    await settle();
    assert.ok(Math.abs((await volume()) - vBefore) < 1e-6);
    await p.keyboard.press("Control+y");
    await settle();
    assert.ok(Math.abs((await volume()) - v160) < 1e-6);
    step("desfazer e refazer");

    // 7. exportar STEP e guardar/abrir o projeto
    await p.click("button:has-text('Exportar')");
    const [stepDl] = await Promise.all([p.waitForEvent("download"), p.click(".menu button:has-text('STEP')")]);
    const stepFile = path.join(tmp, stepDl.suggestedFilename());
    await stepDl.saveAs(stepFile);
    assert.match(fs.readFileSync(stepFile, "utf8").slice(0, 20), /ISO-10303-21/);
    await p.click("button:has-text('Ficheiro')");
    const [projDl] = await Promise.all([p.waitForEvent("download"), p.click(".menu button:has-text('Guardar projeto')")]);
    const projFile = path.join(tmp, projDl.suggestedFilename());
    await projDl.saveAs(projFile);
    await p.click("button:has-text('Ficheiro')");

    await p.click(".menu button:has-text('Novo')");
    await settle();
    await p.setInputFiles("input[type=file][accept*=json]", projFile);
    await p.waitForFunction(() => /Volume/.test(document.querySelector(".side-info")?.textContent ?? ""), null, { timeout: 60000 });
    assert.ok(Math.abs((await volume()) - v160) < 1e-6);
    step(`exportar STEP (${path.basename(stepFile)}), guardar e reabrir o projeto`);

    // 8. importar o STEP num documento novo, módulo náutico, rollback e apagar
    await p.click("button:has-text('Ficheiro')");

    await p.click(".menu button:has-text('Novo')");
    await settle();
    await p.setInputFiles("input[type=file][accept*=step]", stepFile);
    await settle();
    assert.ok(Math.abs((await volume()) - v160) < 0.01);
    await p.click("button:has-text('Módulos')");
    await p.click(".menu button:has-text('Casco')");
    await p.locator(".property-panel label.field:has(.field-label:text-is('Operação')) select").selectOption("new");
    await settle();
    await p.click(".property-panel button:has-text('OK')");
    await settle();
    await p.click(".feat:has-text('Casco1')");
    assert.match(await p.textContent(".side-info"), /Volume imerso ∇4,8\d m³/);
    await p.click(".feat:has-text('Casco1') .menu-btn");
    await p.click(".feat .menu button:has-text('Rollback')");
    await settle();
    assert.ok(Math.abs((await volume()) - v160) < 0.01);
    await p.click(".rollback button:has-text('Avançar')");
    await settle();
    await p.click(".feat:has-text('Casco1') .menu-btn");
    await p.click(".feat .menu button:has-text('Apagar')");
    await settle();
    assert.equal((await states()).length, 1);
    step("importar STEP, casco náutico, rollback e apagar");

    // 9. converter o contorno da face, deslocar 5 mm para dentro, moldura; mudar W: tudo acompanha
    await p.click("button:has-text('Ficheiro')");

    await p.click(".menu button:has-text('Novo')");
    await settle();
    await p.click("button:has-text('Variáveis')");
    await p.click(".modal button:has-text('+ Variável')");
    await p.fill(".modal tbody tr:nth-child(1) input[aria-label=Nome]", "W");
    await p.fill(".modal tbody tr:nth-child(1) input[aria-label='Expressão']", "100");
    await p.click(".modal button:has-text('Aplicar')");
    await settle();
    await p.click("button.cmd:has-text('Esboço')");
    await p.click("button:has-text('Começar')");
    const b3 = await p.locator(".sk-canvas").boundingBox();
    const o3 = await p.$eval(".sk-canvas circle.origin", (e) => [Number(e.getAttribute("cx")), Number(e.getAttribute("cy"))]);
    await p.keyboard.press("r");
    await p.mouse.click(b3.x + o3[0], b3.y + o3[1]);
    await p.mouse.click(b3.x + o3[0] + 200, b3.y + o3[1] - 120);
    await p.keyboard.press("d");
    P = await pts(); xs = P.map((q) => q[0]); ys = P.map((q) => q[1]);
    await p.mouse.click(b3.x + (Math.min(...xs) + Math.max(...xs)) / 2, b3.y + Math.max(...ys));
    await p.mouse.click(b3.x + (Math.min(...xs) + Math.max(...xs)) / 2, b3.y + Math.max(...ys) + 40);
    await p.fill(".dim-input input", "W");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(200);
    P = await pts(); xs = P.map((q) => q[0]); ys = P.map((q) => q[1]);
    await p.mouse.click(b3.x + Math.max(...xs), b3.y + (Math.min(...ys) + Math.max(...ys)) / 2);
    await p.mouse.click(b3.x + Math.max(...xs) + 50, b3.y + (Math.min(...ys) + Math.max(...ys)) / 2);
    await p.fill(".dim-input input", "60");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(300);
    await p.click("button:has-text('Sair do esboço')");
    await settle();
    await p.click("button.cmd:has-text('Extrusão')");
    await p.fill(".property-panel .expr input", "20");
    await settle();
    await p.click(".property-panel button:has-text('OK')");
    await settle();
    await p.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2 - 40);
    await p.click("button.cmd:has-text('Esboço')");
    await p.waitForSelector(".sketch-editor");
    await p.waitForTimeout(400);
    await p.keyboard.press("k");
    await p.click("button:has-text('Contorno no plano')");
    await p.waitForTimeout(300);
    assert.equal(await p.locator(".sk-canvas path.ent.ext").count(), 4);
    await p.keyboard.press("o");
    const extc = await p.$$eval(".sk-canvas path.ent.ext", (els) => els.map((e) => e.getBBox()).map((r) => [r.x + r.width / 2, r.y + r.height / 2]));
    await p.mouse.click(b3.x + extc[0][0], b3.y + extc[0][1]);
    await p.fill(".dim-input input", "-5");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(400);
    assert.equal(await p.textContent(".sk-status span"), "Totalmente definido");
    await p.click("button:has-text('Sair do esboço')");
    await settle();
    await p.click("button.cmd:has-text('Extrusão')");
    await p.fill(".property-panel .expr input", "5");
    await settle();
    await p.click(".property-panel button:has-text('OK')");
    await settle();
    assert.ok(Math.abs((await volume()) - 127.5) < 0.01, `moldura ${await volume()}`);
    await p.click("button:has-text('Variáveis')");
    await p.fill(".modal tbody tr:nth-child(1) input[aria-label='Expressão']", "140");
    await p.click(".modal button:has-text('Aplicar')");
    await settle();
    assert.ok(Math.abs((await volume()) - 177.5) < 0.01, `moldura com W=140 ${await volume()}`);
    step("converter arestas + deslocar: a moldura acompanha a peça (127,5 → 177,5 cm³)");

    assert.deepEqual(errors, [], `erros na consola: ${errors.join(" | ")}`);
    await browser.close();
    console.log("Todos os fluxos passaram.");
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
