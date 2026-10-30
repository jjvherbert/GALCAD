// Interação ao estilo do SolidWorks (R3), no Chromium: transições animadas da câmara, escolha do plano
// com rotação para o plano, dicas animadas na barra, cartão «O que faz» no painel e pré-visualização da
// feature em edição. Uso: npm run build && node tests/e2e/interacao.e2e.cjs
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
    const fixture = fs.readFileSync(path.join(__dirname, "fixtures/bloco.cadp.json"), "utf8");
    const open = async (opts = {}) => {
      const ctx = await b.newContext({ viewport: { width: 1400, height: 860 }, ...opts });
      const p = await ctx.newPage();
      const logs = []; p.on("pageerror", (e) => logs.push(e.message));
      await p.goto(URL);
      await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fixture);
      await p.reload();
      await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 });
      await p.waitForTimeout(500);
      return { p, logs, ctx };
    };
    const ds = (p, k) => p.$eval(".viewport", (e, key) => e.dataset[key], k);

    // 1. transição da câmara: o estado final fica logo publicado e a animação termina sozinha
    {
      const { p, logs, ctx } = await open();
      await p.mouse.move(700, 500);
      check("abre sem animação inicial", (await ds(p, "animating")) === "");
      await p.keyboard.press("Control+5");
      check("Ctrl+5: transição em curso", (await ds(p, "animating")) === "1");
      check("Ctrl+5: vista final já publicada", (await ds(p, "viewDir")) === "0.000,0.000,1.000");
      await p.waitForFunction(() => document.querySelector(".viewport").dataset.animating === "", null, { timeout: 3000 });
      check("a transição termina", true);
      // duas mudanças seguidas (Ctrl+5 e logo F): o enquadramento conserva a vista de topo
      await p.keyboard.press("Control+1");
      await p.keyboard.press("Control+5");
      await p.keyboard.press("f");
      await p.waitForFunction(() => document.querySelector(".viewport").dataset.animating === "", null, { timeout: 3000 });
      check("Ctrl+5 seguido de F mantém a vista de topo", (await ds(p, "viewDir")) === "0.000,0.000,1.000", await ds(p, "viewDir"));
      // um gesto do utilizador salta para o fim
      await p.keyboard.press("Control+7");
      await p.keyboard.press("ArrowLeft");
      check("rodar durante a transição salta para o fim", (await ds(p, "animating")) === "");

      // 2. dica animada ao passar o rato na barra
      await p.hover(".cmd:has-text('Filete')");
      await p.waitForSelector(".feature-tip", { timeout: 3000 });
      const tip = await p.textContent(".feature-tip");
      check("dica do Filete com figura e passos", /Filete/.test(tip) && /raio/.test(tip) && (await p.$$(".feature-tip svg.art animate, .feature-tip svg.art")).length > 0, tip.slice(0, 80));
      await p.mouse.move(700, 500);
      await p.waitForFunction(() => !document.querySelector(".feature-tip"), null, { timeout: 3000 });
      check("a dica desaparece ao sair", true);

      // 3. escolha do plano: cartões, realce e rotação para o plano
      const before = await ds(p, "viewDir");
      await p.click("button.cmd:has-text('Esboço')");
      await p.waitForSelector(".plane-card");
      check("três planos para escolher", (await p.$$(".plane-card")).length === 3);
      check("seleção no 3D ativa logo", /Modo de seleção: faces \/ planos/.test(await p.textContent("body")));
      await p.click(".plane-card:has-text('Frente')");
      check("Frente: vista normal ao plano XZ", (await ds(p, "viewDir")) === "0.000,-1.000,0.000", await ds(p, "viewDir"));
      await p.waitForSelector(".sk-canvas", { timeout: 5000 });
      check("o esboço abre depois da rotação", true);
      await p.click(".sketch-editor button:has-text('Cancelar')");
      await p.waitForFunction((b) => document.querySelector(".viewport").dataset.viewDir === b, before, { timeout: 3000 }).catch(() => {});
      check("sair do esboço volta à vista anterior", (await ds(p, "viewDir")) === before, `${before} → ${await ds(p, "viewDir")}`);
      await p.waitForTimeout(500);

      // 4. cartão «O que faz» e pré-visualização amarela
      await p.click("button.cmd:has-text('Extrusão')");
      await p.waitForSelector(".help-card");
      check("cartão «O que faz» com a figura", /O que faz «Extrusão»/.test(await p.textContent(".help-card")) && (await p.$$(".help-card svg.art")).length === 1);
      // profundidade maior do que a do bloco (20): a nova extrusão cria faces suas
      await p.fill(".property-panel label.field:has-text('Profundidade') input", "35");
      await p.press(".property-panel label.field:has-text('Profundidade') input", "Tab");
      await p.waitForFunction(() => Number(document.querySelector(".viewport").dataset.previewFaces) > 0, null, { timeout: 15000 }).catch(() => {});
      check("pré-visualização: faces da feature em edição", Number(await ds(p, "previewFaces")) > 0, await ds(p, "previewFaces"));
      await p.click(".help-card summary");
      check("a escolha de recolher fica guardada", (await p.evaluate(() => localStorage.getItem("galcad:help-open"))) === "0");
      await p.click(".property-panel button[title^='Cancelar']");
      await p.waitForTimeout(300);
      check("sem pré-visualização fora da edição", Number(await ds(p, "previewFaces")) === 0);
      check("sem erros na página", logs.length === 0, logs.join(" | "));
      await ctx.close();
    }

    // 5. movimento reduzido: sem transições
    {
      const { p, logs, ctx } = await open({ reducedMotion: "reduce" });
      await p.mouse.move(700, 500);
      await p.keyboard.press("Control+5");
      check("prefers-reduced-motion: vista instantânea", (await ds(p, "animating")) === "" && (await ds(p, "viewDir")) === "0.000,0.000,1.000");
      await p.hover(".cmd:has-text('Filete')");
      await p.waitForSelector(".feature-tip");
      check("prefers-reduced-motion: figuras sem animação", (await p.$$(".feature-tip animate")).length === 0);
      check("sem erros na página", logs.length === 0, logs.join(" | "));
      await ctx.close();
    }
    await b.close();
  } finally {
    server.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Interação: há testes falhados"); process.exit(1); }
  console.log("Interação: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
