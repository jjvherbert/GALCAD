// App de ambiente de trabalho (Electron): arranca a GALCAD como o utilizador a abre, confirma que o
// agente vem embutido (endereço e token injetados, sem configurar nada) e corre a consola de
// referência no CalculiX a partir da janela. Em Linux usa os solvers do sistema (ou CAD_GMSH/CAD_CCX,
// ex. os executáveis Windows através do Wine).
// Uso: npm run build && xvfb-run -a node tests/e2e/desktop.e2e.cjs   (empacotada: DESKTOP_EXE=… )
const { _electron: electron } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const R = [];
  const check = (name, ok, extra = "") => R.push(`${ok ? "✓" : "✗"} ${name} ${extra}`);
  // DESKTOP_EXE: executável da app empacotada (ex. release/linux-unpacked/galcad); senão, o código
  const packaged = process.env.DESKTOP_EXE;
  const app = await electron.launch({
    executablePath: packaged ?? require("electron"),
    args: [...(packaged ? [] : [path.join(__dirname, "../..")]), "--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  });
  try {
    // ecrã de arranque com a marca (janela data:, que o Playwright não lista): confirmado no processo principal
    let p = app.windows().find((w) => w.url().startsWith("http://127.0.0.1"));
    while (!p) { const w = await app.waitForEvent("window", { timeout: 120000 }); await w.waitForLoadState("domcontentloaded").catch(() => {}); if (w.url().startsWith("http://127.0.0.1")) p = w; else p = app.windows().find((x) => x.url().startsWith("http://127.0.0.1")); }
    const logs = []; p.on("pageerror", (e) => logs.push(e.message));
    await p.waitForLoadState("domcontentloaded");
    check("ecrã de arranque com a marca mostrado", (await app.evaluate(() => global.galcadSplash)) === "shown");
    const desk = await p.evaluate(() => window.cadDesktop);
    check("agente embutido injetado (endereço e token)", !!desk?.agent?.url?.startsWith("http://127.0.0.1:") && /^[0-9a-f]{32}$/.test(desk.agent.token), JSON.stringify(desk?.agent?.url));
    check("a página não tem Node", await p.evaluate(() => typeof require === "undefined" && typeof process === "undefined"));
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/simulacao.cadp.json"), "utf8"));
    await p.reload();
    await p.waitForFunction(() => /Reconstruído/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 120000 });
    await p.click(".ws-button"); await p.click(".ws-menu button:has-text('Simulação FEM')"); await p.click(".sim-node:has-text('Resolver')");
    await p.waitForSelector(".sim-panel");
    await p.click(".sim-panel summary:has-text('Agente local')");
    check("painel indica o agente embutido", /embutido na app/.test(await p.textContent(".sim-panel")));
    await p.click(".sim-panel button:has-text('Ver solvers')");
    await p.waitForFunction(() => /calculix ✓/.test(document.querySelector(".sim-panel")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
    check("solvers encontrados", /gmsh ✓ · calculix ✓/.test(await p.textContent(".sim-panel")));
    await p.click(".sim-panel button:has-text('Calcular no agente local')");
    await p.waitForSelector(".sim-panel .info-table", { timeout: 600000 });
    const t = (await p.textContent(".sim-panel .info-table")).replace(/\s+/g, " ");
    const d = Number(t.match(/Deslocamento máx\.\s*([\d.]+) mm/)?.[1]);
    check("consola calculada na app: flecha ≈ 0,192 mm", Math.abs(d - 0.192) < 0.01, t.slice(0, 160));
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-desktop.png") });
    check("sem erros na página", logs.length === 0, logs.join(" | "));
  } finally {
    await app.close();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Desktop: há testes falhados"); process.exit(1); }
  console.log("Desktop: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
