// Cálculos de engenharia no Chromium: biblioteca (ISA com o caso de verificação), secção lida de uma face
// plana escolhida no 3D e passada à coluna de Euler–Johnson, polar NACA 0012 no XFOIL do agente local,
// ligação do CLα à asa finita, esboço do perfil NACA 2412 e relatório.
// Uso: npm run build && node tests/e2e/calc.e2e.cjs
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4189, AGENT = 8798, TOKEN = "e2e-calc-token";
const URL = `http://localhost:${PORT}`;
const has = (c) => spawnSync("which", [c]).status === 0;

/** Propriedades de um polígono (fórmulas de Green): referência independente do núcleo. */
function polygon(p) {
  let A = 0, cx = 0, cy = 0, Ixx = 0, Iyy = 0, Ixy = 0;
  p.forEach(([x0, y0], i) => {
    const [x1, y1] = p[(i + 1) % p.length], k = x0 * y1 - x1 * y0;
    A += k / 2; cx += ((x0 + x1) * k) / 6; cy += ((y0 + y1) * k) / 6;
    Ixx += ((y0 * y0 + y0 * y1 + y1 * y1) * k) / 12; Iyy += ((x0 * x0 + x0 * x1 + x1 * x1) * k) / 12; Ixy += ((x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * k) / 24;
  });
  cx /= A; cy /= A;
  const Iu = Ixx - A * cy * cy, Iv = Iyy - A * cx * cx, Iuv = Ixy - A * cx * cy;
  return { A, I2: (Iu + Iv) / 2 - Math.hypot((Iu - Iv) / 2, Iuv) };
}

async function main() {
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  const xfoil = has("xfoil");
  const preload = process.env.CAD_XFOIL_PRELOAD ?? (fs.existsSync("/opt/xfoil/nofpe.so") ? "/opt/xfoil/nofpe.so" : undefined);
  const agent = xfoil ? spawn("node", [path.join(__dirname, "../../public/cad-runner.mjs"), "--serve", "--port", String(AGENT)], { stdio: "ignore", env: { ...process.env, CAD_TOKEN: TOKEN, ...(preload ? { CAD_XFOIL_PRELOAD: preload } : {}) } }) : null;
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
    await p.goto(URL);
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("cad-prototipo:autosave", t); }, fs.readFileSync(path.join(__dirname, "fixtures/calc.cadp.json"), "utf8"));
    await p.reload();
    await p.locator(".statusbar:has-text('Reconstruído')").waitFor({ timeout: 90000 });
    await p.locator("[role=tab]:has-text('Automação')").click();
    await p.locator(".commands button[title^='Cálculos']").click();
    const panel = p.locator(".calc-panel");
    await panel.waitFor();
    // ISA a 11 km (caso de verificação da norma)
    await panel.locator("button:has-text('Caso de verificação')").click();
    const isa = (await panel.locator("table.calc-results").textContent()).replace(/\s+/g, " ");
    check("ISA 11 km: 216,65 K, 22 632 Pa, 0,3639 kg/m³", /216,65/.test(isa) && /22\s?632/.test(isa) && /0,3639/.test(isa), isa.slice(0, 160));

    // coluna: secção lida da face de topo (vista de topo, clique no centro da cantoneira)
    await panel.locator("select[aria-label='Cálculo']").selectOption("column");
    await panel.locator(".reflist button:has-text('Selecionar faces')").click();
    await p.evaluate(() => document.activeElement?.blur());
    await p.keyboard.press("Control+5");
    await p.keyboard.press("f");
    await p.waitForTimeout(600);
    const vp = await p.locator(".viewport canvas").first().boundingBox();
    await p.mouse.click(vp.x + vp.width / 2, vp.y + vp.height / 2);
    await panel.locator("p.calc-section").waitFor({ timeout: 30000 });
    const sec = await panel.locator("p.calc-section").textContent();
    const ref = polygon([[0, 0], [60, 0], [60, 25], [25, 25], [25, 40], [0, 40]]);
    const A = Number(/A = ([\d.]+)/.exec(sec)[1]), I2 = Number(/I2 = ([\d.]+)/.exec(sec)[1]);
    check("secção da face: A e Imin iguais às fórmulas de Green (cantoneira L)", Math.abs(A - ref.A) < 0.1 && Math.abs(I2 - ref.I2) < 1, `${sec} | ref A ${ref.A} I2 ${ref.I2.toFixed(0)}`);
    const colA = Number(await panel.locator("label.field:has-text('Área da secção') input").inputValue());
    check("a secção alimenta o cálculo de coluna", Math.abs(colA - ref.A) < 0.1, String(colA));
    const col = (await panel.locator("table.calc-results").textContent()).replace(/\s+/g, " ");
    check("coluna L = 1000 mm articulada com a secção lida: Euler, L/ρ = 103", /Euler/.test(col) && /103,1/.test(col) && /Carga crítica/.test(col), col.slice(0, 200));

    if (xfoil) {
      // ligação ao agente no próprio painel (a peça não tem estudos)
      await panel.locator("summary:has-text('Agente local')").click();
      await panel.locator("label.field:has-text('Endereço') input").fill(`http://127.0.0.1:${AGENT}`);
      await panel.locator("label.field:has-text('Endereço') input").press("Tab");
      await panel.locator("input[type=password]").fill(TOKEN);
      await panel.locator("button:has-text('Testar ligação')").click();
      await panel.locator("summary:has-text('xfoil ✓')").waitFor({ timeout: 15000 });
      await panel.locator("input[aria-label='Código NACA']").fill("0012");
      await panel.locator("label.field:has-text('α de') input").fill("-4");
      await panel.locator("label.field:has-text('α até') input").fill("8");
      await panel.locator("button:has-text('Calcular polar')").click();
      await panel.locator("td:text-is('CLmax')").waitFor({ timeout: 120000 });
      const pol = (await panel.locator(".kw-item:has-text('CLα')").last().textContent()).replace(/\s+/g, " ");
      const cla = Number(/CLα\s*([\d.]+)/.exec(pol)?.[1]);
      const cd = Number(/CDmin\s*([\d.]+)/.exec(pol)?.[1]);
      check("XFOIL NACA 0012, Re 1e6: CLα ≈ 0,108/°, CDmin ≈ 0,0054", cla > 0.104 && cla < 0.112 && cd > 0.0045 && cd < 0.0065, pol.slice(0, 160));
      check("gráficos CL–α e CL–CD", (await panel.locator("svg[aria-label='CL em função de α'] circle").count()) >= 12 && (await panel.locator("svg[aria-label='Polar de arrasto CL–CD']").count()) === 1);
      await panel.locator("button:has-text('Usar CLα na asa finita')").click();
      const a0 = Number(await panel.locator("label.field:has-text('Declive do perfil') input").inputValue());
      const wing = (await panel.locator("table.calc-results").textContent()).replace(/\s+/g, " ");
      check("CLα do XFOIL na asa finita (A = 8): ≈ 4,9/rad", Math.abs(a0 - cla) < 1e-4 && /CLα da asa\s*4,8|CLα da asa\s*4,9/.test(wing), `${a0} | ${wing.slice(0, 120)}`);
    } else R.push("- XFOIL saltado (não instalado)");

    // esboço do perfil NACA 2412, corda 200 mm
    await panel.locator("input[aria-label='Código NACA']").fill("2412");
    await panel.locator("button:has-text('Criar esboço do perfil')").click();
    await p.locator(".statusbar:has-text('Reconstruído')").waitFor({ timeout: 30000 });
    await panel.locator("button:has-text('Árvore')").click();
    check("esboço do perfil na árvore", (await p.locator(".tree :text('Perfil NACA 2412')").count()) >= 1);
    await p.locator(".commands button[title^='Cálculos']").click();
    await panel.locator("select[aria-label='Cálculo']").selectOption("plate");
    const [dl] = await Promise.all([p.waitForEvent("download"), panel.locator("button:has-text('Relatório')").click()]);
    const html = fs.readFileSync(await dl.path(), "utf8");
    check("relatório com referência, hipóteses e limitação", /Timoshenko/.test(html) && /Hipóteses e limites/.test(html) && /Não é certificação/.test(html));
    await p.screenshot({ path: path.join(__dirname, "../../dist/e2e-calc.png") });
    check("sem erros na página", logs.length === 0, logs.join(" | "));
    await b.close();
  } finally {
    server.kill();
    agent?.kill();
  }
  console.log(R.join("\n"));
  if (R.some((r) => r.startsWith("✗"))) { console.error("Cálculos: há testes falhados"); process.exit(1); }
  console.log("Cálculos: todos os testes passaram.");
}

main().catch((e) => { console.error(e); process.exit(1); });
