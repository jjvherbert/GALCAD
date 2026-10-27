// Gera o fixture do e2e de simulação (node tests/e2e/fixtures/make-simulacao.ts).
import { writeFileSync } from "node:fs";
import { SketchBuilder } from "../../helpers.ts";
import { addFeature } from "../../../src/doc/io.ts";
import { type CadProject, newAssembly, newPart, newProject, serializeProject } from "../../../src/doc/project.ts";
import { SIM_MATERIALS } from "../../../src/doc/study.ts";

const pr: CadProject = { ...newProject("Simulação"), parts: [] };
const s = new SketchBuilder();
s.rect(0, 0, 100, 10, 100, 10);
let p = newPart(pr, "Consola");
p = { ...p, ...addFeature(p, s.build()).doc };
p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc };
// faces: f2:side:l8 = x 0 (encastrada), f2:side:l6 = x 100 (força na ponta)
p.studies = [{
  id: "s1", name: "Consola — estática", physics: "fem", solver: "calculix", analysis: "static", material: { ...SIM_MATERIALS[0] },
  loads: [{ kind: "fixed", faces: [{ kind: "face", name: "f2:side:l8" }] }, { kind: "force", faces: [{ kind: "face", name: "f2:side:l6" }], f: [0, 0, -100] }],
  modes: 6, mesh: { size: 3, order: 2, curvature: 0 },
}, {
  // a mesma barra como conduta de água: entrada em x = 0, saída em x = 100 (Re ≈ 100)
  id: "s2", name: "Conduta — laminar", physics: "cfd", solver: "openfoam", regime: "internal", fluid: { name: "Água doce (20 °C)", rho: 998.2, nu: 1.004e-6 }, turbulence: "laminar",
  inlet: { faces: [{ kind: "face", name: "f2:side:l8" }], velocity: [0.01, 0, 0] }, outlet: { faces: [{ kind: "face", name: "f2:side:l6" }] },
  iterations: 300, mesh: { size: 1.25, surfaceLevel: [0, 0], layers: 0 },
}];
pr.parts.push(p);
// montagem: duas lâminas 100 × 10 × 5 empilhadas e coladas (comportam-se como a consola 100 × 10 × 10)
for (const name of ["Lâmina A", "Lâmina B"]) {
  const k = new SketchBuilder();
  k.rect(0, 0, 100, 10, 100, 10);
  let q = newPart(pr, name);
  q = { ...q, ...addFeature(q, k.build()).doc };
  q = { ...q, ...addFeature(q, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 5 } }).doc };
  pr.parts.push(q);
}
const asm = newAssembly(pr, "Lâminas");
asm.components = [
  { id: "c1", name: "Lâmina A<1>", ref: { kind: "part", id: pr.parts[1].id }, placement: { t: [0, 0, 0], r: [0, 0, 0] }, fixed: true },
  { id: "c2", name: "Lâmina B<1>", ref: { kind: "part", id: pr.parts[2].id }, placement: { t: [0, 0, 5], r: [0, 0, 0] }, fixed: true },
];
asm.studies = [{
  id: "s1", name: "Lâminas coladas — estática", physics: "fem", solver: "calculix", analysis: "static", material: { ...SIM_MATERIALS[0] }, contact: { mode: "bonded" },
  loads: [
    { kind: "fixed", faces: [{ kind: "face", name: "c1/f2:side:l8" }, { kind: "face", name: "c2/f2:side:l8" }] },
    { kind: "force", faces: [{ kind: "face", name: "c1/f2:side:l6" }, { kind: "face", name: "c2/f2:side:l6" }], f: [0, 0, -100] },
  ],
  modes: 6, mesh: { size: 3, order: 2, curvature: 0 },
}];
pr.assemblies.push(asm);
writeFileSync(new URL("./simulacao.cadp.json", import.meta.url), serializeProject(pr));
console.log("ok");
