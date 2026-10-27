// Gera o fixture do e2e de simulação (node tests/e2e/fixtures/make-simulacao.ts).
import { writeFileSync } from "node:fs";
import { SketchBuilder } from "../../helpers.ts";
import { addFeature } from "../../../src/doc/io.ts";
import { type CadProject, newPart, newProject, serializeProject } from "../../../src/doc/project.ts";
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
}];
pr.parts.push(p);
writeFileSync(new URL("./simulacao.cadp.json", import.meta.url), serializeProject(pr));
console.log("ok");
