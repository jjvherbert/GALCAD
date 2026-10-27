// Gera o fixture do e2e do PMI (node --experimental-strip-types tests/e2e/fixtures/make-pmi.ts).
// Placa 60 × 40 × 20 com furo Ø10 e PMI completo; os nomes das faces vêm do núcleo.
import { writeFileSync } from "node:fs";
import { SketchBuilder, initKernel } from "../../helpers.ts";
import { addFeature } from "../../../src/doc/io.ts";
import { Engine } from "../../../src/kernel/rebuild.ts";
import { faceProps } from "../../../src/kernel/occ.ts";
import { type CadProject, newPart, newProject, serializeProject } from "../../../src/doc/project.ts";

await initKernel();
const pr: CadProject = { ...newProject("PMI"), parts: [] };
let p = newPart(pr, "Placa");
const s = new SketchBuilder();
s.rect(0, 0, 60, 40, 60, 40);
p = { ...p, ...addFeature(p, s.build()).doc };
p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } }).doc };
const h = new SketchBuilder();
h.circle(30, 20, 5);
p = { ...p, ...addFeature(p, h.build()).doc };
p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f3", op: "cut", end: { type: "throughAll" }, end2: { type: "throughAll" } }).doc };
const r = await new Engine().rebuild(p);
const face = (pred: (q: ReturnType<typeof faceProps>) => boolean) => ({ kind: "face" as const, name: r.ctx.body!.faces.find((x) => pred(faceProps(x.face)))!.name });
const top = face((q) => q.type === "plane" && Math.abs(q.center[2] - 20) < 1e-6), bottom = face((q) => q.type === "plane" && Math.abs(q.center[2]) < 1e-6);
const side = face((q) => q.type === "plane" && Math.abs(q.center[0]) < 1e-6), hole = face((q) => q.type === "cylinder");
p.pmi = [
  { kind: "datum", id: "pmi1", label: "A", face: bottom },
  { kind: "datum", id: "pmi2", label: "B", face: side },
  { kind: "dimension", id: "pmi3", type: "distance", faces: [top, bottom], tol: { kind: "deviation", upper: 0.1, lower: -0.1 } },
  { kind: "dimension", id: "pmi4", type: "diameter", faces: [hole], tol: { kind: "fit", code: "H7" } },
  { kind: "gdt", id: "pmi5", characteristic: "flatness", faces: [top], value: 0.02, datums: [] },
  { kind: "gdt", id: "pmi6", characteristic: "position", faces: [hole], value: 0.1, diameter: true, modifier: "M", datums: ["A", "B"] },
  { kind: "roughness", id: "pmi7", faces: [top], ra: 1.6, process: "remove" },
];
p.attributes = [{ target: { kind: "body" }, key: "Processo", value: "Maquinação CNC" }];
pr.parts.push(p);
writeFileSync(new URL("./pmi.cadp.json", import.meta.url), serializeProject(pr));
console.log("ok");
