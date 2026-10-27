// Fase 4.5: publicações e referências externas entre peças (ligadas, congeladas, com posição de
// montagem), ciclos e mates a publicações.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { addFeature, type NewFeature } from "../src/doc/io.ts";
import { type CadProject, type PartDoc, newAssembly, newPart, newProject } from "../src/doc/project.ts";

before(initKernel);

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const errors = (r: { status: Record<string, { state: string; error?: string }> }) => Object.entries(r.status).filter(([, s]) => s.state === "error").map(([id, s]) => `${id}: ${s.error}`);

function part(pr: CadProject, name: string, ...features: NewFeature[]): PartDoc {
  let p = newPart(pr, name);
  for (const f of features) p = { ...p, ...addFeature(p, f).doc };
  pr.parts.push(p);
  return p;
}

/** Peça "Esqueleto": bloco 100×60×h, plano de referência a z = 50, publicações. */
function skeleton(pr: CadProject, h = 20) {
  const s = new SketchBuilder();
  s.rect(0, 0, 100, 60, 100, 60);
  const a = part(pr, "Esqueleto", s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: h } }, { type: "plane", base: { kind: "std", name: "XY" }, offset: 50 });
  a.publications = [
    { name: "Topo", ref: { kind: "face", name: "f2:end:l5" } },
    { name: "Meio", ref: { kind: "feature", feature: "f3" } },
    { name: "Corpo", ref: { kind: "body" } },
    { name: "Perfil", ref: { kind: "feature", feature: "f1" } },
  ];
  return a;
}

test("referências externas: plano, face, corpo e esboço publicados; atualização ligada", async () => {
  const pr: CadProject = { ...newProject("X"), parts: [] };
  const a = skeleton(pr);
  const sq = new SketchBuilder({ kind: "datum", feature: "f1" });
  sq.rect(0, 0, 10, 10, 10, 10);
  const b = part(pr, "Tampa",
    { type: "external", part: a.id, publication: "Meio", mode: "linked" },
    sq.build(),
    { type: "extrude", sketch: "f2", op: "add", end: { type: "blind", depth: 5 } },
    { type: "external", part: a.id, publication: "Topo", mode: "linked" },
    { type: "external", part: a.id, publication: "Corpo", mode: "linked", op: "add" },
    { type: "external", part: a.id, publication: "Perfil", mode: "linked" });
  const svc = new KernelService();
  const r = await svc.rebuild(b, false, pr.parts);
  assert.deepEqual(errors(r), []);
  near(r.planes.f1.o[2], 50);
  near(r.mass!.bbox.max[2], 55);
  near(r.mass!.volume, 10 * 10 * 5 + 100 * 60 * 20, 1e-6);
  const sheet = r.sheets.find((x) => x.id === "f4")!;
  near(sheet.area, 6000, 1e-6);

  // ligada: mudar a altura do esqueleto muda o corpo copiado (e a cache reconstrói só o necessário)
  const a2 = structuredClone(a);
  (a2.features[1] as { end: { depth: number } }).end.depth = 30;
  const parts2 = [a2, b];
  const r2 = await svc.rebuild(b, false, parts2);
  near(r2.mass!.volume, 10 * 10 * 5 + 100 * 60 * 30, 1e-6);
  // sem mudanças na origem, tudo vem da cache
  const r3 = await svc.rebuild(b, false, parts2);
  assert.equal(r3.reused, 6);

  // publicação inexistente / peça inexistente
  const bad = structuredClone(b);
  (bad.features[0] as { publication: string }).publication = "Nada";
  assert.match((await svc.rebuild(bad, false, pr.parts)).status.f1.error ?? "", /não publica "Nada"/);
  assert.match((await svc.rebuild(b, false, [])).status.f1.error ?? "", /não existe/);
});

test("referências externas: congelar, posição de montagem e ciclos", async () => {
  const pr: CadProject = { ...newProject("X"), parts: [] };
  const a = skeleton(pr);
  const b = part(pr, "Cópia", { type: "external", part: a.id, publication: "Corpo", mode: "linked", op: "add" });
  const svc = new KernelService();
  const snap = await svc.snapshot(b, pr.parts, "f1");
  assert.ok(snap.brep && snap.brep.length > 100);
  const frozen = structuredClone(b);
  Object.assign(frozen.features[0], { mode: "frozen", frozen: snap });
  const r = await svc.rebuild(frozen, false, pr.parts);
  near(r.mass!.volume, 120000);
  assert.equal(r.status.f1.state, "ok");
  // a origem muda: a cópia congelada fica igual, com aviso
  const a2 = structuredClone(a);
  (a2.features[1] as { end: { depth: number } }).end.depth = 40;
  const r2 = await svc.rebuild(frozen, false, [a2]);
  near(r2.mass!.volume, 120000);
  assert.equal(r2.status.f1.state, "warning");

  // posição: a origem da peça de origem desviada (100, 0, 0) e rodada 90° em Z
  const placed = structuredClone(b);
  Object.assign(placed.features[0], { placement: { m: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1] } });
  const r3 = await svc.rebuild(placed, false, pr.parts);
  near(r3.mass!.bbox.min[0], 40, 1e-6);
  near(r3.mass!.bbox.max[0], 100, 1e-6);
  near(r3.mass!.bbox.max[1], 100, 1e-6);

  // ciclo: o esqueleto passa a copiar da cópia
  const cyc = structuredClone(a);
  cyc.features.push({ id: "f9", name: "Ciclo", type: "external", part: b.id, publication: "X", mode: "linked" });
  b.publications = [{ name: "X", ref: { kind: "body" } }];
  const r4 = await new KernelService().rebuild(b, false, [cyc, b]);
  assert.match(r4.status.f1.error ?? "", /circular: Cópia → Esqueleto → Cópia/);
});

test("mates a publicações (nome estável)", async () => {
  const pr: CadProject = { ...newProject("X"), parts: [] };
  const a = skeleton(pr);
  const s = new SketchBuilder();
  s.rect(0, 0, 20, 20, 20, 20);
  const c = part(pr, "Cubo", s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 20 } });
  c.publications = [{ name: "Base", ref: { kind: "face", name: "f2:start:l5" } }];
  const asm = newAssembly(pr);
  asm.components = [
    { id: "c1", name: "Esqueleto<1>", ref: { kind: "part", id: a.id }, placement: { t: [0, 0, 0], r: [0, 0, 0] } },
    { id: "c2", name: "Cubo<1>", ref: { kind: "part", id: c.id }, placement: { t: [10, 10, 80], r: [0, 0, 0] } },
  ];
  asm.mates = [
    { id: "m1", name: "Base no topo", kind: "coincident", a: { component: "c1", ref: { kind: "face", name: "@Topo" } }, b: { component: "c2", ref: { kind: "face", name: "@Base" } } },
    { id: "m2", name: "Base no meio", kind: "distance", a: { component: "c1", ref: { kind: "face", name: "@Meio" } }, b: { component: "c2", ref: { kind: "face", name: "@Base" } }, value: 30, align: "aligned" },
  ];
  pr.assemblies.push(asm);
  const r = await new KernelService().assembly(pr, asm.id);
  // o 1.º mate põe a base do cubo a z = 20, frente a frente com o topo; o 2.º pede as normais
  // alinhadas com o plano a z = 50: incompatível → conflito detetado (as publicações resolvem-se)
  assert.equal(r.ok, false);
  assert.ok(r.mates.m1 && r.mates.m2 && !/publica/.test(JSON.stringify(r.mates)), JSON.stringify(r.mates));
  const pr2 = structuredClone(pr);
  pr2.assemblies[0].mates = [pr2.assemblies[0].mates[0]];
  const r2 = await new KernelService().assembly(pr2, asm.id);
  assert.ok(r2.ok, JSON.stringify(r2.mates));
  near(r2.instances.find((i) => i.top === "c2")!.matrix[14], 20, 1e-5);
});
