// Fase 4.6: exportação STEP AP242 (esquema, produtos com nome, cores, estrutura de montagem) e
// releitura do ficheiro.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SketchBuilder, initKernel } from "./helpers.ts";
import { KernelService } from "../src/kernel/service.ts";
import { addFeature, type NewFeature } from "../src/doc/io.ts";
import { type CadProject, type PartDoc, newAssembly, newPart, newProject } from "../src/doc/project.ts";
import { explore, oc } from "../src/kernel/occ.ts";

before(initKernel);

function part(pr: CadProject, name: string, number: string, ...features: NewFeature[]): PartDoc {
  let p = { ...newPart(pr, name), properties: { number } };
  for (const f of features) p = { ...p, ...addFeature(p, f).doc };
  pr.parts.push(p);
  return p;
}

/** Relê um STEP e devolve o número de sólidos e faces. */
function reread(data: Uint8Array) {
  const o = oc();
  o.FS.writeFile("/t.step", data);
  const r = new o.STEPControl_Reader();
  r.ReadFile("/t.step");
  r.TransferRoots(new o.Message_ProgressRange());
  const s = r.OneShape();
  const out = { solids: explore(s, "solid").length, faces: explore(s, "face").length };
  r.delete();
  o.FS.unlink("/t.step");
  return out;
}

test("STEP AP242: peça com corpo e superfície, montagem com ocorrências", async () => {
  const pr: CadProject = { ...newProject("P"), parts: [] };
  const s = new SketchBuilder();
  s.rect(0, 0, 40, 20, 40, 20);
  const line = new SketchBuilder({ kind: "std", name: "XZ" });
  line.line(line.point(0, 30, { fixed: true }), line.point(40, 30, { fixed: true }));
  const a = part(pr, "Base", "GK-001", s.build(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 10 } },
    line.build(), { type: "surfaceExtrude", sketch: "f3", end: { type: "blind", depth: 20 } });
  const svc = new KernelService();
  await svc.rebuild(a);
  const r = await svc.export("step242", "Base");
  const txt = new TextDecoder().decode(r.data);
  assert.match(txt, /FILE_SCHEMA\s*\(\s*\(\s*'AP242/);
  assert.match(txt, /PRODUCT\s*\(\s*'GK-001 Base'/);
  assert.match(txt, /COLOUR_RGB/);
  assert.ok(/'Corpo'/.test(txt) && /'Superfície-extrudida1'|'Sup/.test(txt), (txt.match(/PRODUCT\s*\([^)]*\)/g) ?? []).join("\n"));
  const back = reread(r.data);
  assert.equal(back.solids, 1);
  assert.equal(back.faces, 7);

  const b = part(pr, "Pino", "GK-002", (() => { const c = new SketchBuilder(); c.circle(0, 0, 3); return c.build(); })(), { type: "extrude", sketch: "f1", op: "add", end: { type: "blind", depth: 15 } });
  const asm = newAssembly(pr, "Conjunto");
  asm.properties = { number: "GK-100" };
  asm.components = [
    { id: "c1", name: "Base<1>", ref: { kind: "part", id: a.id }, placement: { t: [0, 0, 0], r: [0, 0, 0] }, fixed: true },
    { id: "c2", name: "Pino<1>", ref: { kind: "part", id: b.id }, placement: { t: [10, 10, 10], r: [0, 0, 0] }, fixed: true },
    { id: "c3", name: "Pino<2>", ref: { kind: "part", id: b.id }, placement: { t: [30, 10, 10], r: [0, 0, 0] }, fixed: true },
  ];
  pr.assemblies.push(asm);
  await svc.assembly(pr, asm.id);
  const ra = await svc.export("step242", "Conjunto");
  const t2 = new TextDecoder().decode(ra.data);
  assert.match(t2, /PRODUCT\s*\(\s*'GK-100 Conjunto'/);
  assert.match(t2, /PRODUCT\s*\(\s*'GK-002 Pino'/);
  assert.equal((t2.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE/g) ?? []).length >= 3, true);
  assert.match(t2, /'Pino<2>'/);
  const back2 = reread(ra.data);
  assert.equal(back2.solids, 3);
});
