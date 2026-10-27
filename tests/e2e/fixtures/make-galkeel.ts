// Gera o fixture do e2e da análise Galkeel (node --experimental-strip-types tests/e2e/fixtures/make-galkeel.ts).
import { writeFileSync } from "node:fs";
import { SketchBuilder, initKernel } from "../../helpers.ts";
import { addFeature } from "../../../src/doc/io.ts";
import { Engine } from "../../../src/kernel/rebuild.ts";
import { faceProps } from "../../../src/kernel/occ.ts";
import { type CadProject, newPart, newProject, serializeProject } from "../../../src/doc/project.ts";
import { SIM_MATERIALS, newFemStudy } from "../../../src/doc/study.ts";

await initKernel();
const pr: CadProject = { ...newProject("Galkeel"), parts: [] };
let p = newPart(pr, "Painel de fundo");
const s = new SketchBuilder();
s.rect(2700, -200, 600, 400, 600, 400);
p = { ...p, ...addFeature(p, s.build()).doc };
p = { ...p, ...addFeature(p, { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 7 } }).doc };
const r = await new Engine().rebuild(p);
const faces = r.ctx.body!.faces.map((f) => ({ name: f.name, p: faceProps(f.face) }));
const bottom = faces.find((f) => f.p.type === "plane" && f.p.normal![2] < -0.99)!;
const sides = faces.filter((f) => f.p.type === "plane" && Math.abs(f.p.normal![2]) < 1e-6);
p.studies = [{ ...newFemStudy("s1", 1), name: "Painel encastrado", material: { ...SIM_MATERIALS[0], name: "PRFV equivalente", E: 7540, nu: 0.3, density: 1.5 }, mesh: { size: 7, order: 2, curvature: 0 },
  loads: [{ kind: "fixed", faces: sides.map((f) => ({ kind: "face", name: f.name })) }] }];
p.galkeel = {
  vessel: { craft: "motor", category: "C", LH: 7.5, LWL: 6.5, Bc: 2.2, beta04: 18, V: 30, mLDC: 2200, xAft: 0, forward: 1, zWL: 200, Zside: 0.9 },
  laminate: { layup: "mat_roving_wr_cp", psi: 0.33, k5: 1, name: "CSM/WR" },
  panels: [{ face: bottom.name, label: "Fundo AV", target: "auto", b: 400, l: 600, thickness: 7 }],
  caseRef: "GK-2026-0001", femStudy: "s1",
};
pr.parts.push(p);
writeFileSync(new URL("./galkeel.cadp.json", import.meta.url), serializeProject(pr));
console.log("ok");
