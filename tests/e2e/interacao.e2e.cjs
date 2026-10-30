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
      await p.keyboard.press("2");  // tecla 2 = Frente (sem clicar)
      await p.waitForFunction(() => document.querySelector(".viewport").dataset.viewDir === "0.000,-1.000,0.000", null, { timeout: 5000 }).catch(() => {});
      check("Frente: a vista roda normal ao plano XZ", (await ds(p, "viewDir")) === "0.000,-1.000,0.000", await ds(p, "viewDir"));
      await p.waitForSelector(".sk-canvas.entered", { timeout: 5000 });
      check("o esboço entra depois da rotação (fundo transparente sobre o 3D)", (await p.$eval(".sketch-editor", (e) => getComputedStyle(e).backgroundColor)) === "rgba(0, 0, 0, 0)");
      check("canto de confirmação ✓/✕", (await p.$$(".sk-confirm button")).length === 2);
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

    // 6. espaço FEM: duplo clique, renomear, atalhos e poucos cliques
    {
      const ctx = await b.newContext({ viewport: { width: 1400, height: 860 } });
      const p = await ctx.newPage();
      const logs = []; p.on("pageerror", (e) => logs.push(e.message));
      await p.goto(URL);
      await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/simulacao.cadp.json"), "utf8"));
      await p.reload();
      await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 });
      await p.waitForTimeout(500);
      await p.keyboard.press("Control+Alt+2");
      await p.waitForSelector(".sim-browser");
      const vb = await p.locator(".viewport canvas").first().boundingBox(); const cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2; // o canvas, não a área com os painéis
      await p.mouse.move(cx, cy);
      check("FEM abre no separador «Cargas e apoios» (sem clicar)", /Cargas e apoios/.test(await p.textContent(".tabs button.on")) && /Encastrar/.test(await p.textContent(".tb-row.commands")) && /Cargas e apoios/.test(await p.textContent(".sim-panel .pm-title")));
      // duplo clique na face com a força (vista da direita) → abre a condição e destaca-a
      await p.keyboard.press("Control+4"); await p.waitForTimeout(600);
      const d4 = await ds(p, "viewDir");
      await p.mouse.dblclick(cx, cy); await p.waitForTimeout(400);
      const foc = d4 === "1.000,0.000,0.000" ? "Força" : "Encastramento";
      check("duplo clique numa face com condição abre-a e destaca-a", /Cargas e apoios/.test(await p.textContent(".sim-panel .pm-title")) && (await p.$$(".sim-panel .kw-item.focus")).length === 1 && new RegExp(foc).test(await p.textContent(".sim-panel .kw-item.focus")), `${d4} ${await p.textContent(".sim-panel .kw-item.focus").catch(() => "—")}`.slice(0, 80));
      check("duplo clique não deixa features em edição às escuras", (await p.$$(".toolbar .cmd:disabled")).length === 0);
      // face sem condição: mensagem, sem efeitos
      await p.keyboard.press("Control+5"); await p.waitForTimeout(600);
      await p.mouse.dblclick(cx, cy); await p.waitForTimeout(300);
      check("duplo clique numa face sem condição avisa", /não tem condições/.test(await p.textContent(".statusbar")) && (await p.$$(".toolbar .cmd:disabled")).length === 0);
      // folha da árvore: duplo clique escolhe as faces da condição
      await p.dblclick(".sim-leaves li:has-text('Força')");
      check("duplo clique na condição da árvore ativa a escolha de faces", /Modo de seleção: faces/.test(await p.textContent("body")));
      await p.keyboard.press("Enter");
      check("Enter conclui a escolha de faces", !/Modo de seleção/.test(await p.textContent("body")));
      // renomear o estudo
      await p.dblclick(".sim-study-head b");
      await p.fill(".sim-study-head input.rename", "Consola v2"); await p.keyboard.press("Enter");
      check("duplo clique renomeia o estudo", /Consola v2/.test(await p.textContent(".sim-study-head")));
      // um clique + uma face = uma condição nova (sem passar por menus)
      const n0 = (await p.$$(".sim-panel .kw-item")).length;
      await p.click(".cmd:has-text('Pressão')");
      await p.keyboard.press("Control+4"); await p.waitForTimeout(500);
      await p.mouse.click(cx, cy);
      await p.keyboard.press("Enter");
      check("Pressão: 1 clique na barra + 1 na face", (await p.$$(".sim-panel .kw-item")).length === n0 + 1 && /1 face/.test(await p.textContent(".sim-node:has-text('Cargas e apoios')") + await p.textContent(".sim-leaves")));
      // R4: conjuntos, simetria, verificação do modelo e compatibilidade por solver
      await p.click(".sim-node:has-text('Cargas e apoios')");
      await p.click(`.sim-panel .kw-item:has-text('Força total') button:has-text('guardar como conjunto')`);
      check("→ conjunto: a condição passa a usar o conjunto", (await p.$$(".sim-panel .set-chips .chip.on")).length === 1 && /Conjuntos de faces \(1\)/.test(await p.textContent(".sim-panel .sets-box summary")));
      await p.click(".tabs button:has-text('Cargas e apoios')");
      await p.click(".cmd:has-text('Simetria')");
      await p.keyboard.press("Escape");
      check("barra: Simetria acrescenta a condição", /Simetria \(plano\)/.test(await p.textContent(".sim-panel")));
      await p.click(".sim-node:has-text('Verificação')");
      await p.waitForSelector(".sim-panel .check-list");
      check("verificação: simetria sem faces é erro", (await p.$$(".sim-panel .chk-erro")).length >= 1 && /sem faces/.test(await p.textContent(".sim-panel .chk-erro")));
      check("verificação: matriz com os 3 solvers", (await p.$$(".sim-panel .verdict")).length === 3 && (await p.$$(".sim-panel table.matrix tr.used")).length >= 4);
      await p.keyboard.press("F5");
      await p.waitForTimeout(300);
      check("F5 com erros no modelo: bloqueia e explica", /sem faces/.test(await p.textContent(".statusbar")) && /Verificação do modelo/.test(await p.textContent(".sim-panel .pm-title")));
      await p.click(".sim-panel .verdict:has-text('OpenRadioss')");
      check("matriz: escolher outro solver recalcula a verificação", /Estática linear: não suportado/.test(await p.textContent(".sim-panel .check-list")));
      await p.click(".sim-panel .verdict:has-text('CalculiX')");
      // retirar a simetria vazia: o modelo volta a estar limpo de erros
      await p.click(".sim-node:has-text('Cargas e apoios')");
      await p.click(".sim-panel .kw-item:has-text('Simetria') button[aria-label^='Retirar']");
      await p.click(".sim-node:has-text('Verificação')");
      check("sem erros depois de retirar a condição vazia", (await p.$$(".sim-panel .chk-erro")).length === 0);
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
