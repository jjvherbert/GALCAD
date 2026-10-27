// Gera o fixture do e2e dos scripts (node --experimental-strip-types tests/e2e/fixtures/make-script.ts).
import { writeFileSync } from "node:fs";
import { SketchBuilder } from "../../helpers.ts";
import { addFeature } from "../../../src/doc/io.ts";
import { type CadProject, newPart, newProject, serializeProject } from "../../../src/doc/project.ts";
import { SIM_MATERIALS, newFemStudy } from "../../../src/doc/study.ts";

const pr: CadProject = { ...newProject("Scripts"), parts: [] };
const s = new SketchBuilder();
s.rect(0, 0, "L", 10, 100, 10);
let p = newPart(pr, "Consola");
p = { ...p, variables: [{ name: "L", expr: "100", comment: "comprimento (mm)" }] };
p = { ...p, ...addFeature(p, s.build()).doc };
p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } }).doc };
p.studies = [{ ...newFemStudy("s1", 1), name: "Consola — estática", material: { ...SIM_MATERIALS[0] }, mesh: { size: 3, order: 2, curvature: 0 },
  loads: [{ kind: "fixed", faces: [{ kind: "face", name: "f2:side:l8" }] }, { kind: "force", faces: [{ kind: "face", name: "f2:side:l6" }], f: [0, 0, -100] }],
  probes: [{ name: "Flecha na ponta", quantity: "uz", at: { kind: "faces", faces: [{ kind: "face", name: "f2:side:l6" }] } }] }];
pr.parts.push(p);
writeFileSync(new URL("./script.cadp.json", import.meta.url), serializeProject(pr));
console.log("ok");
