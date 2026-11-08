// Estudos: caso FEM de uma montagem (um volume por corpo e contacto colado ou com atrito).
import { type FemStudy, loadEdges } from "../doc/study.ts";
import { type TopoRef } from "../doc/types.ts";
import { type Ctx, type StepReport, edges as resolveEdges, faces as resolveFaces } from "./context.ts";
import { T, type TopoDS_Shape, bbox, explore, faceProps, makeCompound, normalOnFace, oc, v3 } from "./occ.ts";
import { type CaseFace, type V3 } from "../sim/case.ts";
import { femGeo } from "../sim/gmsh.ts";
import { type SimFiles, type MeshGeo, bodyOf, readme } from "./sim-common.ts";
import { buildFemCase } from "./sim-fem.ts";

/** Corpo de uma montagem para um estudo: instância, peça reconstruída e sólido já posicionado. */
export interface AsmBody { path: string; name: string; ctx: Ctx; solid: TopoDS_Shape; placed: TopoDS_Shape }

/** Sólido único de uma peça (para os estudos). */
export const singleSolid = bodyOf;

/**
 * Pares de faces planas coincidentes (normais opostas, mesmo plano, área comum > 0) entre corpos
 * diferentes: as zonas de contacto a colar. Devolve índices de faces em `faces` (ordem global).
 */
function contactPairs(bodies: AsmBody[], tol: number): { a: number; b: number; area: number }[] {
  const o = oc();
  const all: { body: number; face: TopoDS_Shape; idx: number; n: Vec3D | null; c: V3; area: number; box: { min: number[]; max: number[] } }[] = [];
  let idx = 0;
  bodies.forEach((bd, k) => {
    for (const f of explore(bd.placed, "face")) {
      const p = faceProps(f);
      all.push({ body: k, face: f, idx: idx++, n: p.type === "plane" ? normalOnFace(f, p.center) as Vec3D : null, c: p.center as V3, area: p.area, box: bbox(f) });
    }
  });
  const out: { a: number; b: number; area: number }[] = [];
  const near = (A: { min: number[]; max: number[] }, B: { min: number[]; max: number[] }) => [0, 1, 2].every((q) => A.min[q] <= B.max[q] + tol && B.min[q] <= A.max[q] + tol);
  for (const fa of all) for (const fb of all) {
    if (fb.body <= fa.body || !fa.n || !fb.n || !near(fa.box, fb.box)) continue;
    if (v3.dot(fa.n, fb.n) > -0.9999) continue;
    if (Math.abs(v3.dot(v3.sub(fb.c, fa.c), fa.n)) > tol) continue;
    const cm = T(new o.BRepAlgoAPI_Common(fa.face, fb.face));
    cm.Build();
    if (!cm.IsDone()) continue;
    const area = explore(T(cm.Shape()), "face").reduce((s, f) => s + faceProps(f).area, 0);
    if (area > 1e-6 * Math.min(fa.area, fb.area)) out.push({ a: fa.idx, b: fb.idx, area });
  }
  return out;
}
type Vec3D = [number, number, number];

/**
 * Caso FEM de uma montagem: um volume por corpo (material próprio), faces "caminho/face" nas
 * condições e contacto colado (*TIE) nas faces planas coincidentes entre corpos.
 */
export function assemblyStudyCase(bodies: AsmBody[], s: FemStudy, scope: Ctx["scope"], title: string): SimFiles {
  const report: StepReport = { warnings: [] };
  if (!bodies.length) throw new Error("A montagem não tem corpos sólidos para o estudo");
  if (s.loads.some((l) => loadEdges(l).length)) throw new Error("Montagem: condições em arestas não suportadas — escolha faces");
  const faces: CaseFace[] = [];
  const offset: number[] = [];
  for (const bd of bodies) {
    offset.push(faces.length);
    const orig = explore(bd.solid, "face");
    explore(bd.placed, "face").forEach((f, i) => {
      const p = faceProps(f);
      const nm = bd.ctx.body!.faces.find((n) => n.face.IsSame(orig[i]))?.name ?? `?${i + 1}`;
      faces.push({ tag: faces.length + 1, name: `${bd.path}/${nm}`, center: p.center as V3, area: p.area, normal: p.type === "plane" ? normalOnFace(f, p.center) as V3 : undefined });
    });
  }
  const tags = (refs: TopoRef[], what: string) => {
    if (!refs.length) throw new Error(`${what}: escolha as faces`);
    return refs.map((r) => {
      const cut = r.name.lastIndexOf("/");
      const path = r.name.slice(0, cut), face = r.name.slice(cut + 1);
      const k = bodies.findIndex((b) => b.path === path);
      if (cut < 0 || k < 0) throw new Error(`${what}: a face "${r.name}" não é de um corpo da montagem`);
      const [nf] = resolveFaces(bodies[k].ctx, [{ ...r, name: face }], report);
      const i = nf ? explore(bodies[k].solid, "face").findIndex((f) => f.IsSame(nf.face)) : -1;
      if (i < 0) throw new Error(`${what}: a face "${face}" não existe em ${bodies[k].name}`);
      return offset[k] + i + 1;
    });
  };
  const boxes = bodies.map((b) => bbox(b.placed));
  const box = { min: [0, 1, 2].map((q) => Math.min(...boxes.map((b) => b.min[q]))) as V3, max: [0, 1, 2].map((q) => Math.max(...boxes.map((b) => b.max[q]))) as V3 };
  const edgeOffset: number[] = [];
  const allEdges: TopoDS_Shape[] = [];
  for (const bd of bodies) { edgeOffset.push(allEdges.length); allEdges.push(...explore(bd.placed, "edge")); }
  const edgeTags = (refs: TopoRef[], what: string) => {
    if (!refs.length) throw new Error(`${what}: escolha as arestas`);
    return refs.flatMap((r) => {
      const cut = r.name.lastIndexOf("/");
      const path = r.name.slice(0, cut), name = r.name.slice(cut + 1);
      const k = bodies.findIndex((b) => b.path === path);
      if (cut < 0 || k < 0) throw new Error(`${what}: a aresta "${r.name}" não é de um corpo da montagem`);
      const local = explore(bodies[k].solid, "edge");
      return resolveEdges(bodies[k].ctx, [{ ...r, name }], report).map((ne) => {
        const i = local.findIndex((e) => e.IsSame(ne.edge));
        if (i < 0) throw new Error(`${what}: a aresta "${name}" não existe em ${bodies[k].name}`);
        return edgeOffset[k] + i + 1;
      });
    });
  };
  const geo: MeshGeo = { solids: bodies.map((b) => b.placed), faces: bodies.flatMap((b) => explore(b.placed, "face")), edges: allEdges, edgeTags, names: bodies.map((b) => b.name) };
  const c = buildFemCase(s, scope, faces, tags, box, report, geo);
  c.title = title;
  c.bodies = bodies.map((b, k) => ({ group: `B${k + 1}`, path: b.path, name: b.name, material: s.bodyMaterials?.[b.path] ?? s.material, bbox: { min: boxes[k].min as V3, max: boxes[k].max as V3 } }));
  c.ties = [];
  const mode = s.contact?.mode ?? "bonded";
  const mu = Math.max(0, s.contact?.mu ?? 0.3);
  if (mode === "bonded" || mode === "friction") {
    const tol = s.contact?.tolerance ?? Math.max(0.01, 0.05 * c.mesh.size);
    contactPairs(bodies, Math.min(tol, 0.01)).forEach((pr, k) => {
      // escravo = a face menor (os nós dele têm de cair na face mestre)
      const [sl, ms] = faces[pr.a].area <= faces[pr.b].area ? [pr.a, pr.b] : [pr.b, pr.a];
      c.groups[`T${k + 1}_S`] = [faces[sl].tag];
      c.groups[`T${k + 1}_M`] = [faces[ms].tag];
      c.ties!.push({ name: `T${k + 1}`, slave: `T${k + 1}_S`, master: `T${k + 1}_M`, tolerance: tol, slaveBody: `B${bodyOfTag(faces[sl].tag) + 1}`, masterBody: `B${bodyOfTag(faces[ms].tag) + 1}`, ...(mode === "friction" ? { kind: "contact" as const, mu } : {}) });
    });
  }
  // corpos soltos: sem apoio e sem contacto colado
  const supported = new Set<number>();
  for (const ld of c.loads) if (ld.kind === "fixed" || ld.kind === "displacement") for (const t of c.groups[ld.group]) supported.add(bodyOfTag(t));
  for (const t of c.ties) { supported.add(bodyOfTag(c.groups[t.slave][0])); supported.add(bodyOfTag(c.groups[t.master][0])); }
  function bodyOfTag(t: number) { let k = 0; while (k + 1 < offset.length && offset[k + 1] < t) k++; return k; }
  bodies.forEach((b, k) => { if (!supported.has(k) && s.analysis !== "modal") report.warnings.push(`${b.name}: sem apoio nem contacto colado (movimento de corpo rígido)`); });
  const mats = [...new Set(c.bodies.map((b) => b.material.name))];
  c.hypotheses.splice(1, 1, `Materiais: ${c.bodies.map((b) => `${b.name} — ${b.material.name} (E = ${b.material.E} MPa, ν = ${b.material.nu})`).join("; ")}`);
  c.hypotheses.push(
    mode === "friction"
      ? `Montagem: ${bodies.length} corpos; contacto com atrito de Coulomb (μ = ${mu}) e separação em ${c.ties.length} par(es) de faces planas coincidentes: penalidade face a face (CalculiX), carga em incrementos; sem pré-esforço; faces curvas em contacto não são tratadas`
      : `Montagem: ${bodies.length} corpos; ${c.ties.length ? `contacto colado (TIE) em ${c.ties.length} par(es) de faces planas coincidentes` : "sem ligação entre corpos"}; sem atrito, separação nem pré-esforço; faces curvas em contacto não são coladas`,
  );
  if (mode === "friction") {
    c.hypotheses = c.hypotheses.map((h) => h.replace(/, sem contacto$/, ", com contacto unilateral e atrito (o único efeito não linear)"));
    if (s.solver === "code_aster") report.warnings.push("Contacto com atrito: o adaptador code_aster só faz contacto colado — corra com o CalculiX");
    if (mu === 0) report.warnings.push("Contacto sem atrito (μ = 0): os corpos apoiados só por contacto podem deslizar sem resistência (sistema singular)");
  }
  if (mats.length > 1) c.hypotheses.push("Interfaces entre materiais diferentes: as tensões junto às arestas da interface são singulares (não convergem)");
  const compound = makeCompound(bodies.map((b) => b.placed));
  const files: Record<string, string | Uint8Array> = { "model.brep": oc().BRepToolsWrapper.Write(compound) as string, "mesh.geo": femGeo(c) };
  files["case.json"] = JSON.stringify(c, null, 1);
  files["LEIA-ME.txt"] = readme(c);
  return { case: c, files, warnings: report.warnings };
}
