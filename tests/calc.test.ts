// Biblioteca de cálculos (aeronáutica e estruturas), propriedades de secção medidas no CAD e
// adaptador do XFOIL: casos de verificação calculados à mão, e a polar real quando o XFOIL existe.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { Engine } from "../src/kernel/rebuild.ts";
import { faceProps } from "../src/kernel/occ.ts";
import { addFeature, newDocument } from "../src/doc/io.ts";
import { panelGeometry } from "../src/kernel/panels.ts";
import { CALCS, calcReport, isa, kCompressionSS, runCalc } from "../src/calc/library.ts";
import { checkXfoilRequest, nacaCoords, parsePolar, polarSummary, xfoilCommands, xfoilRetryCommands } from "../src/sim/xfoil.ts";
import { runXfoil, tools } from "../tools/cad-runner.ts";
import { runScript } from "../src/script/api.ts";
import { polarForScript } from "../src/script/summary.ts";

before(initKernel);
// compilação Debian do XFOIL com exceções de vírgula flutuante: usar a biblioteca do LEIA-ME se existir
if (!process.env.CAD_XFOIL_PRELOAD && existsSync("/opt/xfoil/nofpe.so")) process.env.CAD_XFOIL_PRELOAD = "/opt/xfoil/nofpe.so";
const near = (a: number, b: number, rel: number, what = "") => assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-12), `${what}: ${a} vs ${b}`);

test("biblioteca: todos os casos de verificação à mão", () => {
  for (const c of CALCS) {
    const r = runCalc(c.id, c.verify.inputs);
    for (const [k, v] of Object.entries(c.verify.expect)) {
      const o = r.outputs.find((x) => x.key === k);
      assert.ok(o && typeof o.value === "number", `${c.id}.${k} em falta`);
      near(o.value as number, v, c.verify.tol, `${c.id}.${k}`);
    }
    assert.ok(c.hypotheses.length >= 2 && c.reference.length > 10, c.id);
  }
});

test("ISA: nível do mar, tropopausa e estratosfera (tabela ISO 2533)", () => {
  const s = isa(0);
  near(s.T, 288.15, 1e-9); near(s.p, 101325, 1e-9); near(s.rho, 1.225, 1e-4); near(s.a, 340.294, 1e-4); near(s.mu, 1.7894e-5, 1e-3);
  near(isa(5000).p, 54019.9, 1e-4, "p 5 km"); near(isa(5000).T, 255.65, 1e-9);
  near(isa(20000).p, 5474.89, 1e-4, "p 20 km"); near(isa(25000).T, 221.65, 1e-9); near(isa(25000).p, 2511.0, 2e-3, "p 25 km");
  // Reynolds de uma corda de 1 m a 50 m/s ao nível do mar ≈ 3,42e6
  const r = runCalc("isa", { h: 0, V: 50, L: 1 });
  near(r.outputs.find((o) => o.key === "Re")!.value as number, (1.225 * 50) / 1.7894e-5, 1e-3, "Re");
  assert.throws(() => runCalc("isa", { h: 40000 }), /fora dos limites/);
  assert.throws(() => runCalc("isa", { hh: 1 } as Record<string, number>), /desconhecida/);
});

test("placa: k de compressão tende para 4 em placas longas; Johnson abaixo da esbelteza de transição", () => {
  near(kCompressionSS(1), 4, 1e-12); near(kCompressionSS(10), 4, 1e-12); near(kCompressionSS(Math.SQRT2), 4.5, 1e-12);
  const c = runCalc("column", { L: 300, c: 1, A: 200, I: 20000, E: 71000, fcy: 280 }); // L'/ρ = 30 < 70,7
  const sig = c.outputs.find((o) => o.key === "sigma")!.value as number;
  near(sig, 280 * (1 - (280 * 900) / (4 * Math.PI ** 2 * 71000)), 1e-12, "Johnson");
  assert.equal(c.outputs.find((o) => o.key === "mode")!.value, "Johnson (inelástico)");
  const html = calcReport(runCalc("plate"), "Teste");
  assert.ok(html.includes("Timoshenko") && html.includes("Não é certificação"));
});

async function section(points: [number, number][]) {
  const s = new SketchBuilder();
  const ids = points.map(([x, y]) => s.point(x, y));
  ids.forEach((id, i) => s.line(id, ids[(i + 1) % ids.length]));
  let doc = newDocument();
  doc = addFeature(doc, s.build()).doc;
  doc = addFeature(doc, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 100 } }).doc;
  const ctx = (await new Engine().rebuild(doc)).ctx;
  const end = ctx.body!.faces.find((f) => { const p = faceProps(f.face); return p.type === "plane" && Math.abs(p.center[2] - 100) < 1e-9; })!;
  return panelGeometry(ctx, [end.name])[0].section!;
}

/** Propriedades de um polígono pelas fórmulas de Green (referência independente do OpenCASCADE). */
function polygon(p: [number, number][]) {
  let A = 0, cx = 0, cy = 0, Ixx = 0, Iyy = 0, Ixy = 0;
  p.forEach(([x0, y0], i) => {
    const [x1, y1] = p[(i + 1) % p.length], k = x0 * y1 - x1 * y0;
    A += k / 2; cx += ((x0 + x1) * k) / 6; cy += ((y0 + y1) * k) / 6;
    Ixx += ((y0 * y0 + y0 * y1 + y1 * y1) * k) / 12; Iyy += ((x0 * x0 + x0 * x1 + x1 * x1) * k) / 12; Ixy += ((x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * k) / 24;
  });
  cx /= A; cy /= A;
  const Iu = Ixx - A * cy * cy, Iv = Iyy - A * cx * cx, Iuv = Ixy - A * cx * cy;
  const avg = (Iu + Iv) / 2, rad = Math.hypot((Iu - Iv) / 2, Iuv);
  return { A, I1: avg + rad, I2: avg - rad };
}

test("secção de face plana: retângulo e cantoneira L 60×40×10 (eixos principais rodados)", async () => {
  const r = await section([[0, 0], [40, 0], [40, 10], [0, 10]]);
  near(r.A, 400, 1e-9); near(r.I1, (10 * 40 ** 3) / 12, 1e-6, "I1"); near(r.I2, (40 * 10 ** 3) / 12, 1e-6, "I2");
  near(r.rmin, 10 / Math.sqrt(12), 1e-6); near(r.W1, (10 * 40 ** 2) / 6, 1e-3, "W1"); near(r.W2, (40 * 10 ** 2) / 6, 1e-3, "W2");
  const L: [number, number][] = [[0, 0], [60, 0], [60, 10], [10, 10], [10, 40], [0, 40]];
  const ref = polygon(L), s = await section(L);
  near(s.A, ref.A, 1e-9, "A"); near(s.I1, ref.I1, 1e-6, "I1 L"); near(s.I2, ref.I2, 1e-6, "I2 L");
  // o eixo principal fraco de uma cantoneira desigual está rodado (não é x nem y)
  assert.ok(Math.abs(s.e2[0]) > 0.1 && Math.abs(s.e2[1]) > 0.1, JSON.stringify(s.e2));
  // a secção alimenta o cálculo de coluna
  const col = runCalc("column", { L: 800, c: 1, A: s.A, I: s.I2, E: 210000, fcy: 355 });
  assert.ok((col.outputs.find((o) => o.key === "P")!.value as number) > 0);
});

test("XFOIL: comandos só com números validados, coordenadas NACA, leitura e resumo da polar", () => {
  assert.throws(() => checkXfoilRequest({ airfoil: { naca: "0012\nQUIT" }, re: 1e6, alpha: { from: 0, to: 4, step: 1 } }), /NACA inválido/);
  assert.throws(() => checkXfoilRequest({ airfoil: { naca: "0012" }, re: 1e6, alpha: { from: -30, to: 30, step: 0.1 } }), /Demasiados/);
  const named = checkXfoilRequest({ airfoil: { name: "x\nQUIT\nrm", coords: nacaCoords("2412", 30) }, re: 1e6, alpha: { from: 0, to: 2, step: 1 } });
  assert.ok("name" in named.airfoil && !named.airfoil.name.includes("\n"));
  const c = xfoilCommands({ airfoil: { naca: "0012" }, re: 1e6, alpha: { from: -4, to: 8, step: 2 } });
  assert.ok(c.stdin.includes("ASEQ 0.000 8.000 2.000") && c.stdin.includes("ASEQ -2.000 -4.000 -2.000") && c.stdin.includes("VISC 1000000"));
  // segunda passagem: sem INIT antes da primeira solução, aproximação em passos de 0,25°, +10 painéis
  const rt = xfoilRetryCommands({ airfoil: { naca: "0012" }, re: 1e6, alpha: { from: 0, to: 8, step: 2 } }, [2, 8], [0, 4, 6]).stdin.split("\n");
  const i0 = rt.indexOf("ALFA 0.000");
  assert.ok(i0 > 0 && rt[i0 - 1] !== "INIT" && rt.includes("ASEQ 0.250 1.750 0.250") && rt.includes("N 170") && rt.includes("ITER 300"));
  assert.ok(rt.indexOf("INIT") > i0 && rt.includes("ALFA 6.000") && rt.includes("ASEQ 6.250 7.750 0.250") && rt.includes("ALFA 8.000"));
  // NACA 0012: espessura máxima 12 % em ~30 %, bordo de fuga aberto (0,252 %)
  const xy = nacaCoords("0012", 100);
  const th = Math.max(...xy.map(([, y]) => y)) * 2;
  near(th, 0.12, 2e-3, "espessura"); near(xy[0][1] - xy[xy.length - 1][1], 0.00252, 1e-3, "bordo de fuga");
  const txt = `  ------ -------- --------- --------- -------- -------- --------\n   2.000   0.2142   0.00566   0.00110  0.0000   0.6  0.8\n   0.000   0.0000   0.00540   0.00100  0.0000   0.7  0.7\n  -2.000  -0.2142   0.00566   0.00110  0.0000   0.8  0.6\n   4.000   0.4278   0.00728   0.00200  0.0000   0.4  0.9\n`;
  const pol = parsePolar(txt);
  assert.deepEqual(pol.map((p) => p.alpha), [-2, 0, 2, 4]);
  const s = polarSummary(pol, { airfoil: { naca: "0012" }, re: 1e6, alpha: { from: -2, to: 6, step: 2 } });
  assert.deepEqual(s.missing, [6]);
  near(s.cdMin, 0.0054, 1e-9); assert.equal(s.clMax, null);
  assert.ok(Math.abs(s.alpha0!) < 0.05 && Math.abs(s.clAlphaDeg! - 0.107) < 0.002, JSON.stringify(s));
});

const hasXfoil = !!tools().xfoil;
test("XFOIL real: NACA 0012 a Re = 1e6 (Abbott & von Doenhoff: CLα ≈ 0,105–0,110/°, CDmin ≈ 0,0055)", { skip: hasXfoil ? false : "XFOIL não instalado" }, async () => {
  const r = await runXfoil({ airfoil: { naca: "0012" }, re: 1e6, alpha: { from: -4, to: 8, step: 1 } });
  assert.ok(r.ok && r.polar.length >= 12, `${r.polar.length} pontos`);
  assert.ok(r.summary.clAlphaDeg! > 0.104 && r.summary.clAlphaDeg! < 0.112, `CLα ${r.summary.clAlphaDeg}`);
  assert.ok(Math.abs(r.summary.alpha0!) < 0.1, `α0 ${r.summary.alpha0}`);
  assert.ok(r.summary.cdMin > 0.0045 && r.summary.cdMin < 0.0065, `CDmin ${r.summary.cdMin}`);
  // perfil de coordenadas geradas pelo CAD contra o gerador interno do XFOIL
  const g = await runXfoil({ airfoil: { name: "NACA 2412 gerado", coords: nacaCoords("2412", 80) }, re: 3e6, mach: 0.1, alpha: { from: 0, to: 4, step: 2 } });
  const n = await runXfoil({ airfoil: { naca: "2412" }, re: 3e6, mach: 0.1, alpha: { from: 0, to: 4, step: 2 } });
  // diferença só no arredondamento do bordo de fuga e na distribuição de pontos: |ΔCL| < 0,01
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(g.polar[i].cl - n.polar[i].cl) < 0.01, `CL α=${g.polar[i].alpha}: ${g.polar[i].cl} vs ${n.polar[i].cl}`);
  assert.ok(g.summary.alpha0! > -2.4 && g.summary.alpha0! < -1.9, `α0 do 2412 ${g.summary.alpha0}`); // Abbott (ensaio): α0 ≈ −2,1°
});

test("XFOIL: pedido inválido recusado antes de correr o processo", async () => {
  await assert.rejects(runXfoil({ airfoil: { naca: "abc" }, re: 1e6, alpha: { from: 0, to: 2, step: 1 } }), /NACA inválido/);
  await assert.rejects(runXfoil({ airfoil: { naca: "0012" }, re: 10, alpha: { from: 0, to: 2, step: 1 } }), /Reynolds/);
});

test("scripts: cad.calc em varrimento e cad.xfoil pelo anfitrião", { skip: hasXfoil ? false : "XFOIL não instalado" }, async () => {
  const host = {
    rebuild: async () => { throw new Error("não usado"); },
    simulate: async () => { throw new Error("não usado"); },
    xfoil: async (req: Parameters<typeof runXfoil>[0]) => polarForScript(await runXfoil(req)),
  };
  const code = `
    const rows = cad.linspace(0, 10000, 3).map((h) => ({ h, rho: cad.calc("isa", { h }).outputs.rho }));
    cad.table(rows, "ISA");
    const p = await cad.xfoil({ airfoil: { name: "gerado", coords: cad.naca("0012", 60) }, re: 1e6, alpha: { from: 0, to: 4, step: 2 } });
    const w = cad.calc("wing", { a0: p.summary.clAlphaDeg, AR: 6 });
    return { cla: p.summary.clAlphaDeg, wing: w.outputs.claRad, n: p.polar.length };`;
  const out = await runScript(code, newDocument(), host as never);
  assert.ok(out.ok, out.error ?? "");
  const v = out.value as { cla: number; wing: number; n: number };
  assert.equal(v.n, 3);
  near(out.tables[0].rows[1].rho as number, isa(5000).rho, 1e-12);
  assert.ok(v.cla > 0.1 && v.cla < 0.115 && v.wing > 4 && v.wing < 5, JSON.stringify(v));
  const noHost = await runScript(`return await cad.xfoil({ airfoil: { naca: "0012" }, re: 1e6, alpha: { from: 0, to: 2, step: 1 } })`, newDocument(), { rebuild: host.rebuild, simulate: host.simulate } as never);
  assert.ok(!noHost.ok && /XFOIL/.test(noHost.error!));
});
