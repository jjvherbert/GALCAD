// Gera o fixture do e2e dos cálculos (node --experimental-strip-types tests/e2e/fixtures/make-calc.ts):
// uma cantoneira L 60×40 com abas de 25 mm extrudida 800 mm (coluna) para ler a secção no CAD.
import { writeFileSync } from "node:fs";
import { SketchBuilder, initKernel } from "../../helpers.ts";
import { addFeature } from "../../../src/doc/io.ts";
import { type CadProject, newPart, newProject, serializeProject } from "../../../src/doc/project.ts";

await initKernel();
const pr: CadProject = { ...newProject("Cálculos"), parts: [] };
let p = newPart(pr, "Coluna L");
const s = new SketchBuilder();
const ids = ([[0, 0], [60, 0], [60, 25], [25, 25], [25, 40], [0, 40]] as [number, number][]).map(([x, y]) => s.point(x, y));
ids.forEach((id, i) => s.line(id, ids[(i + 1) % ids.length]));
p = { ...p, ...addFeature(p, s.build()).doc };
p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 800 } }).doc };
pr.parts.push(p);
writeFileSync(new URL("./calc.cadp.json", import.meta.url), serializeProject(pr));
console.log("ok");
