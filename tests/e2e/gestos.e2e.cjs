// Gestos do botão direito por contexto (C4): roda no 3D e no esboço, gesto curto ativa a ferramenta,
// clique direito sem arrastar abre o menu do esboço, Ctrl+botão direito desloca a vista.
// Uso: npm run build && node tests/e2e/gestos.e2e.cjs
const { chromium } = require("playwright");
const { startPreview } = require("./_server.cjs");

const PORT = 4191;
const URL = `http://localhost:${PORT}`;

async function main() {
  const server = startPreview(PORT);
  const R = [];
  const check = (name, ok, extra = "") => R.push(`${ok ? "✓" : "✗"} ${name} ${extra}`);
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(URL)).ok) break; } catch { /* a arrancar */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    const settle = async () => { await p.waitForTimeout(250); await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 90000 }); await p.waitForTimeout(200); };
    await p.goto(URL);
    await p.evaluate(() => localStorage.clear());
    await p.reload(); await settle();

    // 3D: manter o botão direito parado mostra a roda com os comandos do contexto 3D
    const vp = await p.locator(".viewport canvas").first().boundingBox();
    const vx = vp.x + vp.width / 2, vy = vp.y + vp.height / 2;
    await p.mouse.move(vx, vy);
    await p.mouse.down({ button: "right" });
    await p.waitForTimeout(450);
    const hud3d = await p.$eval(".gesture-hud", (e) => e.textContent).catch(() => "");
    await p.mouse.move(vx, vy - 60, { steps: 6 });
    const on3d = await p.$eval(".gesture-hud span.on", (e) => e.textContent).catch(() => "");
    await p.mouse.up({ button: "right" });
    check("3D: roda aparece ao manter o botão direito", /Ajustar ao ecrã/.test(hud3d), hud3d.slice(0, 120));
    check("3D: arrastar para cima realça o comando de cima", on3d.length > 0, on3d);
    await p.waitForTimeout(200);
    check("3D: roda some ao largar", (await p.$(".gesture-hud")) === null);
    await p.keyboard.press("Escape");
    await p.mouse.down({ button: "right" });
    await p.waitForTimeout(450);
    await p.mouse.up({ button: "right" });
    await p.waitForTimeout(200);
    check("3D: largar a roda parada não abre o menu", (await p.$(".popup[role=menu]")) === null && (await p.$(".gesture-hud")) === null);
    await p.mouse.click(vx, vy, { button: "right" });
    await p.waitForTimeout(200);
    check("3D: clique direito abre o menu", (await p.$(".popup[role=menu]")) !== null);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(150);

    // esboço
    await p.click("button.cmd:has-text('Esboço')");
    await p.click("button:has-text('Começar')");
    await p.waitForSelector(".sk-canvas.entered");
    const box = await p.locator(".sk-canvas").boundingBox();
    const cx = box.x + box.width * 0.6, cy = box.y + box.height * 0.6;
    const origin = () => p.$eval(".sk-canvas circle.origin", (e) => [Number(e.getAttribute("cx")), Number(e.getAttribute("cy"))]);
    const activeTool = () => p.$eval(".sk-toolbar button.on", (e) => e.getAttribute("title")).catch(() => "");
    const flick = async (dx, dy) => {
      await p.mouse.move(cx, cy);
      await p.mouse.down({ button: "right" });
      await p.mouse.move(cx + dx, cy + dy, { steps: 8 });
      await p.mouse.up({ button: "right" });
      await p.waitForTimeout(150);
    };

    await flick(0, -80);
    check("esboço: gesto para cima ativa a cota inteligente", /^Cota inteligente/.test(await activeTool()), await activeTool());
    await flick(-80, 0);
    check("esboço: gesto para a esquerda ativa a linha", /^Linha/.test(await activeTool()), await activeTool());
    await flick(80, 0);
    check("esboço: gesto para a direita ativa o círculo", /^Círculo/.test(await activeTool()), await activeTool());
    await flick(0, 80);
    check("esboço: gesto para baixo ativa o retângulo", /^Retângulo/.test(await activeTool()), await activeTool());
    check("esboço: continua dentro do esboço", (await p.$(".sk-canvas.entered")) !== null);

    // roda no esboço mostra os comandos do esboço
    await p.mouse.move(cx, cy);
    await p.mouse.down({ button: "right" });
    await p.waitForTimeout(450);
    const hudSk = await p.$eval(".gesture-hud", (e) => e.textContent).catch(() => "");
    await p.mouse.up({ button: "right" });
    check("esboço: roda mostra os comandos do esboço", /Cota inteligente/.test(hudSk) && /Sair do esboço/.test(hudSk), hudSk.slice(0, 160));
    await p.waitForTimeout(150);
    check("esboço: largar a roda parada não abre o menu", (await p.$(".popup[aria-label='Menu do esboço']")) === null);

    // clique direito sem arrastar: menu de contexto
    await p.mouse.click(cx, cy, { button: "right" });
    const menu = await p.waitForSelector(".popup[aria-label='Menu do esboço']", { timeout: 3000 }).catch(() => null);
    const items = menu ? await p.$$eval(".popup[aria-label='Menu do esboço'] [role=menuitem]", (els) => els.map((e) => e.textContent)) : [];
    check("esboço: clique direito abre o menu", items.some((t) => /Sair do esboço/.test(t)) && items.some((t) => /Ajustar ao ecrã/.test(t)), JSON.stringify(items));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(100);
    check("esboço: Esc fecha o menu sem sair do esboço", (await p.$(".popup[aria-label='Menu do esboço']")) === null && (await p.$(".sk-canvas.entered")) !== null);
    await p.mouse.click(cx, cy, { button: "right" });
    await p.waitForSelector(".popup[aria-label='Menu do esboço']");
    await p.click(".popup[aria-label='Menu do esboço'] [role=menuitem]:has-text('Linha')");
    check("esboço: item do menu ativa a linha e fecha o menu", /^Linha/.test(await activeTool()) && (await p.$(".popup[aria-label='Menu do esboço']")) === null, await activeTool());

    // Ctrl + botão direito desloca a vista (não é gesto)
    const o0 = await origin();
    await p.keyboard.down("Control");
    await p.mouse.move(cx, cy);
    await p.mouse.down({ button: "right" });
    await p.mouse.move(cx + 60, cy + 40, { steps: 6 });
    await p.mouse.up({ button: "right" });
    await p.keyboard.up("Control");
    await p.waitForTimeout(150);
    const o1 = await origin();
    check("esboço: Ctrl+botão direito desloca a vista", Math.abs(o1[0] - o0[0] - 60) < 3 && Math.abs(o1[1] - o0[1] - 40) < 3, JSON.stringify([o0, o1]));
    check("esboço: Ctrl+botão direito não muda a ferramenta", /^Linha/.test(await activeTool()), await activeTool());

    // gesto para baixo-direita sai do esboço
    await flick(60, 60);
    await p.waitForTimeout(300);
    check("esboço: gesto baixo-direita sai do esboço", (await p.$(".sk-canvas.entered")) === null);

    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Gestos: há testes falhados"); process.exit(1); }
  console.log("Gestos: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
