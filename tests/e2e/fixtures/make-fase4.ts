// Gera o fixture do e2e da Fase 4 (node tests/e2e/fixtures/make-fase4.ts).
import { writeFileSync } from "node:fs";
import { SketchBuilder } from "../../helpers.ts";
import { addFeature, type NewFeature } from "../../../src/doc/io.ts";
import { type CadProject, type PartDoc, newPart, newProject, serializeProject } from "../../../src/doc/project.ts";
import type { CurveRef, Vec3 } from "../../../src/doc/types.ts";

const pr: CadProject = { ...newProject("Fase 4"), parts: [] };
const part = (name: string, ...fs: NewFeature[]): PartDoc => {
  let p = newPart(pr, name);
  for (const f of fs) p = { ...p, ...addFeature(p, f).doc };
  pr.parts.push(p);
  return p;
};
const line = (a: Vec3, b: Vec3): NewFeature => ({ type: "curve", def: { kind: "points", points: [a, b] } });
const cv = (id: string): CurveRef => ({ kind: "curve", feature: id });

// 1. superfícies GSD: duas tiras desfasadas, concordância G2 costurada e um patch de forma livre
part("Superfícies GSD",
  line([0, 0, 0], [100, 0, 0]), line([0, 50, 0], [100, 50, 0]), { type: "boundary", dir1: [cv("f1"), cv("f2")], dir2: [] },
  line([0, 100, 40], [100, 100, 40]), line([0, 150, 40], [100, 150, 40]), { type: "boundary", dir1: [cv("f4"), cv("f5")], dir2: [] },
  { type: "blend", side1: { curve: cv("f2"), support: { kind: "face", name: "f3:bnd" }, continuity: "curvature" }, side2: { curve: cv("f4"), support: { kind: "face", name: "f6:bnd" }, continuity: "curvature" } },
  { type: "knit", sheets: ["f3", "f6", "f7"], tolerance: 0.01 },
  { type: "freeform", source: { kind: "patch", plane: { kind: "std", name: "XY" }, width: 80, height: 80, nu: 5, nv: 5 }, moves: [], name: "Patch livre" } as NewFeature);
pr.parts[0].features.find((f) => f.type === "freeform")!.name = "Patch livre";

// 2. esqueleto com variáveis, regra, verificação, configurações e publicações
const s = new SketchBuilder();
s.rect(0, 0, "L", 60, 100, 60);
const sk = part("Esqueleto", s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: "H" } }, { type: "plane", base: { kind: "std", name: "XY" }, offset: 50 });
sk.properties = { number: "GK-010", density: 7.85 };
sk.variables = [{ name: "L", expr: "100" }, { name: "H", expr: "20" }];
sk.rules = [{ name: "Grosso se comprido", condition: "L > 150", assign: [{ variable: "H", expr: "30" }] }];
sk.checks = [{ name: "Massa máx. 1,5 kg", expr: "massa < 1500", severity: "warning" }];
sk.configurations = { active: "Curto", columns: ["L", "$p:number"], rows: [{ name: "Curto", values: { L: "100", "$p:number": "GK-010-100" } }, { name: "Comprido", values: { L: "200", "$p:number": "GK-010-200" } }] };
sk.publications = [{ name: "Meio", ref: { kind: "feature", feature: "f3" } }, { name: "Topo", ref: { kind: "face", name: "f2:end:l5" } }];

// 3. tampa: esboço no plano publicado "Meio" do esqueleto
const t = new SketchBuilder({ kind: "datum", feature: "f1" });
t.rect(0, 0, 30, 30, 30, 30);
part("Tampa", { type: "external", part: sk.id, publication: "Meio", mode: "linked" }, t.build(), { type: "extrude", sketch: "f2", op: "add", end: { type: "blind", depth: 4 } });

writeFileSync(new URL("./fase4.cadp.json", import.meta.url), serializeProject(pr));
console.log("ok", pr.parts.map((p) => `${p.id}:${p.name}`).join(", "));
