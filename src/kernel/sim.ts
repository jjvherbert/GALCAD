// Do estudo (no documento) ao caso de simulação (números, grupos de faces) e aos ficheiros: BREP
// exato, script Gmsh, `case.json`, dicionários OpenFOAM/STL por patch ou configuração SU2, e um
// LEIA-ME com as hipóteses e os passos. A malha e o deck do CalculiX são feitos a seguir pelo agente
// local (que corre o Gmsh) — ver `tools/cad-runner.ts`.
import type { CfdStudy, FemStudy, Study } from "../doc/study.ts";
import { evalParam } from "../doc/variables.ts";
import type { TopoRef } from "../doc/types.ts";
import { type Ctx, type StepReport, faces as resolveFaces } from "./context.ts";
import { T, type TopoDS_Shape, bbox, distance, explore, faceProps, makeCompound, normalOnFace, oc, v3, vertexAt, volume } from "./occ.ts";
import { type CaseFace, type CfdCase, type FemCase, type FemCaseLoad, type SimCase, type V3, loadGroup } from "../sim/case.ts";
import { femGeo, su2Geo } from "../sim/gmsh.ts";
import { openfoamCase } from "../sim/openfoam.ts";
import { su2Config } from "../sim/su2.ts";

export interface SimFiles { case: SimCase; files: Record<string, string | Uint8Array>; warnings: string[] }

function bodyOf(ctx: Ctx): TopoDS_Shape {
  if (!ctx.body) throw new Error("O estudo precisa de um corpo sólido");
  const solids = explore(ctx.body.shape, "solid");
  if (solids.length !== 1) throw new Error(`O estudo precisa de um só sólido (a peça tem ${solids.length})`);
  return solids[0];
}

/** Faces do corpo com tag (1…, ordem do OCC = ordem do Gmsh), nome topológico, centroide e área. */
function caseFaces(ctx: Ctx, solid: TopoDS_Shape): CaseFace[] {
  const named = ctx.body!.faces;
  return explore(solid, "face").map((f, i) => {
    const p = faceProps(f);
    return { tag: i + 1, name: named.find((n) => n.face.IsSame(f))?.name ?? `?${i + 1}`, center: p.center as V3, area: p.area };
  });
}

function tagsOf(ctx: Ctx, faces: CaseFace[], solid: TopoDS_Shape, refs: TopoRef[], what: string, report: StepReport): number[] {
  if (!refs.length) throw new Error(`${what}: escolha as faces`);
  const all = explore(solid, "face");
  return resolveFaces(ctx, refs, report).map((nf) => {
    const i = all.findIndex((f) => f.IsSame(nf.face));
    if (i < 0) throw new Error(`${what}: a face "${nf.name}" não pertence ao corpo`);
    return faces[i].tag;
  });
}

const n3 = (e: [unknown, unknown, unknown], scope: Ctx["scope"], label: string): V3 => e.map((x, k) => evalParam(x as never, scope, `${label} ${"XYZ"[k]}`)) as V3;

const FEM_HYP: Record<FemStudy["analysis"], string> = {
  static: "Estática linear: pequenos deslocamentos e deformações, material elástico linear isotrópico, sem contacto",
  modal: "Modal: frequências próprias com as condições de apoio indicadas (sem cargas, sem amortecimento)",
  buckling: "Encurvadura linear (valores próprios): fatores sobre as cargas indicadas, sem imperfeições nem plasticidade",
  thermal: "Térmica em regime permanente: condução isotrópica, convecção e fluxo impostos, sem radiação",
};

export function femCase(ctx: Ctx, s: FemStudy, report: StepReport): FemCase {
  const solid = bodyOf(ctx);
  const faces = caseFaces(ctx, solid);
  const b = bbox(solid);
  return buildFemCase(s, ctx.scope, faces, (refs, what) => tagsOf(ctx, faces, solid, refs, what, report), { min: b.min as V3, max: b.max as V3 }, report);
}

/** Caso FEM a partir das faces com tag e de um resolvedor de referências (peça ou montagem). */
function buildFemCase(s: FemStudy, sc: Ctx["scope"], faces: CaseFace[], tags: (refs: TopoRef[], what: string) => number[], box: { min: V3; max: V3 }, report: StepReport): FemCase {
  const groups: Record<string, number[]> = {};
  const loads: FemCaseLoad[] = [];
  s.loads.forEach((l, i) => {
    if (l.kind === "gravity") { loads.push({ kind: "gravity", g: n3(l.g, sc, "Gravidade") }); return; }
    const g = loadGroup(i, l.kind);
    groups[g] = tags(l.faces, `Condição ${i + 1}`);
    switch (l.kind) {
      case "fixed": loads.push({ kind: "fixed", group: g }); break;
      case "displacement": loads.push({ kind: "displacement", group: g, u: [l.ux, l.uy, l.uz].map((x, k) => (x === undefined || x === "" ? null : evalParam(x, sc, `Deslocamento ${"XYZ"[k]}`))) }); break;
      case "force": loads.push({ kind: "force", group: g, f: n3(l.f, sc, "Força") }); break;
      case "pressure": loads.push({ kind: "pressure", group: g, p: evalParam(l.p, sc, "Pressão") }); break;
      case "temperature": loads.push({ kind: "temperature", group: g, t: evalParam(l.t, sc, "Temperatura") }); break;
      case "convection": loads.push({ kind: "convection", group: g, h: evalParam(l.h, sc, "Coeficiente h"), tInf: evalParam(l.tInf, sc, "Temperatura do fluido") }); break;
      case "heatFlux": loads.push({ kind: "heatFlux", group: g, q: evalParam(l.q, sc, "Fluxo de calor") }); break;
    }
  });
  const local = (s.mesh.local ?? []).map((l, i) => {
    const g = `R${i + 1}`;
    groups[g] = tags(l.faces, `Refinamento ${i + 1}`);
    return { group: g, size: evalParam(l.size, sc, "Tamanho local") };
  });
  const size = evalParam(s.mesh.size, sc, "Tamanho da malha");
  if (size <= 0) throw new Error("Tamanho da malha: tem de ser positivo");
  const thermal = s.analysis === "thermal";
  if (thermal && !s.loads.some((l) => l.kind === "temperature" || l.kind === "convection")) report.warnings.push("Térmica sem temperatura nem convecção imposta: o problema não tem solução única");
  if (!thermal && s.analysis !== "modal" && !s.loads.some((l) => l.kind === "fixed" || l.kind === "displacement")) report.warnings.push("Sem apoios: movimento de corpo rígido");
  const nl = s.analysis === "static" && (s.nonlinear?.geometry || s.nonlinear?.plasticity)
    ? { geometry: !!s.nonlinear.geometry, plasticity: !!s.nonlinear.plasticity, increments: Math.max(1, Math.round(s.nonlinear.increments ?? 10)) } : undefined;
  const m = s.material;
  if (nl?.plasticity && !(m.yield! > 0)) throw new Error("Plasticidade: indique a tensão de cedência do material");
  if (nl?.plasticity && !(m.tangent! >= 0 && m.tangent! < m.E)) throw new Error("Plasticidade: o módulo tangente tem de estar entre 0 e E");
  const analysisHyp = !nl ? FEM_HYP[s.analysis]
    : `Estática não linear (${[nl.geometry && "grandes deslocamentos e rotações", nl.plasticity && "plasticidade de von Mises com encruamento isotrópico bilinear"].filter(Boolean).join("; ")}), carga aplicada em ${nl.increments}+ incrementos, cargas de direção fixa, sem contacto`;
  return {
    format: "cadp-sim-case", version: 1, physics: "fem", solver: s.solver ?? "calculix", title: s.name, analysis: s.analysis, modes: s.modes ?? 6, nonlinear: nl,
    material: s.material, groups, faces, loads, bbox: box,
    mesh: { size, minSize: evalParam(s.mesh.minSize, sc, "Tamanho mínimo", size / 10), curvature: s.mesh.curvature ?? 12, order: s.mesh.order, local },
    hypotheses: [
      analysisHyp,
      `Material: ${m.name} (E = ${m.E} MPa, ν = ${m.nu}${thermal ? `, k = ${m.k ?? 50} W/(m·K)` : `, ρ = ${m.density} g/cm³`}${nl?.plasticity ? `, σy = ${m.yield} MPa, Et = ${m.tangent} MPa` : ""})${m.source ? ` — ${m.source}` : ""}`,
      `Malha: tetraedros de ordem ${s.mesh.order} (Gmsh), tamanho máx. ${size} mm — confirmar a convergência refinando`,
      "Forças distribuídas uniformemente pela área das faces; apoios ideais (rígidos)",
      "Apoio à decisão de engenharia: não é certificação nem decisão de uma autoridade ou de um organismo notificado",
    ],
  };
}

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
  const faces: CaseFace[] = [];
  const offset: number[] = [];
  for (const bd of bodies) {
    offset.push(faces.length);
    const orig = explore(bd.solid, "face");
    explore(bd.placed, "face").forEach((f, i) => {
      const p = faceProps(f);
      const nm = bd.ctx.body!.faces.find((n) => n.face.IsSame(orig[i]))?.name ?? `?${i + 1}`;
      faces.push({ tag: faces.length + 1, name: `${bd.path}/${nm}`, center: p.center as V3, area: p.area });
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
  const c = buildFemCase(s, scope, faces, tags, box, report);
  c.title = title;
  c.bodies = bodies.map((b, k) => ({ group: `B${k + 1}`, path: b.path, name: b.name, material: s.bodyMaterials?.[b.path] ?? s.material, bbox: { min: boxes[k].min as V3, max: boxes[k].max as V3 } }));
  c.ties = [];
  if ((s.contact?.mode ?? "bonded") === "bonded") {
    const tol = s.contact?.tolerance ?? Math.max(0.01, 0.05 * c.mesh.size);
    contactPairs(bodies, Math.min(tol, 0.01)).forEach((pr, k) => {
      // escravo = a face menor (os nós dele têm de cair na face mestre)
      const [sl, ms] = faces[pr.a].area <= faces[pr.b].area ? [pr.a, pr.b] : [pr.b, pr.a];
      c.groups[`T${k + 1}_S`] = [faces[sl].tag];
      c.groups[`T${k + 1}_M`] = [faces[ms].tag];
      c.ties!.push({ name: `T${k + 1}`, slave: `T${k + 1}_S`, master: `T${k + 1}_M`, tolerance: tol });
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
    `Montagem: ${bodies.length} corpos; ${c.ties.length ? `contacto colado (TIE) em ${c.ties.length} par(es) de faces planas coincidentes` : "sem ligação entre corpos"}; sem atrito, separação nem pré-esforço; faces curvas em contacto não são coladas`,
  );
  if (mats.length > 1) c.hypotheses.push("Interfaces entre materiais diferentes: as tensões junto às arestas da interface são singulares (não convergem)");
  const compound = makeCompound(bodies.map((b) => b.placed));
  const files: Record<string, string | Uint8Array> = { "model.brep": oc().BRepToolsWrapper.Write(compound) as string, "mesh.geo": femGeo(c) };
  files["case.json"] = JSON.stringify(c, null, 1);
  files["LEIA-ME.txt"] = readme(c);
  return { case: c, files, warnings: report.warnings };
}

/** Ponto dentro do sólido (para o snappyHexMesh nos casos internos). */
function pointInside(solid: TopoDS_Shape, b: { min: number[]; max: number[] }): V3 {
  const c = volume(solid).center as V3;
  const inside = (p: V3) => distance(vertexAt(p), solid) < 1e-9 && distance(vertexAt(p), T(oc().TopoDS.Shell(explore(solid, "shell")[0]))) > 1e-6;
  if (inside(c)) return c;
  // procura numa grelha grosseira dentro da caixa
  for (let n = 3; n <= 9; n += 2) for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) for (let k = 1; k < n; k++) {
    const p: V3 = [0, 1, 2].map((q) => b.min[q] + ((b.max[q] - b.min[q]) * [i, j, k][q]) / n) as V3;
    if (inside(p)) return p;
  }
  throw new Error("Não foi possível encontrar um ponto dentro do volume de fluido");
}

export function cfdCase(ctx: Ctx, s: CfdStudy, report: StepReport): CfdCase {
  const solid = bodyOf(ctx);
  const faces = caseFaces(ctx, solid);
  const b = bbox(solid);
  const L = Math.max(...b.max.map((x, i) => x - b.min[i]));
  const groups: Record<string, number[]> = {};
  let velocity: V3, domain: CfdCase["domain"], insidePoint: V3;
  if (s.regime === "internal") {
    groups.inlet = tagsOf(ctx, faces, solid, s.inlet?.faces ?? [], "Entrada", report);
    groups.outlet = tagsOf(ctx, faces, solid, s.outlet?.faces ?? [], "Saída", report);
    const used = new Set([...groups.inlet, ...groups.outlet]);
    if (groups.inlet.some((t) => groups.outlet.includes(t))) throw new Error("Uma face não pode ser entrada e saída");
    groups.walls = faces.map((f) => f.tag).filter((t) => !used.has(t));
    velocity = n3(s.inlet!.velocity, ctx.scope, "Velocidade de entrada");
    insidePoint = pointInside(solid, b);
  } else {
    groups.body = faces.map((f) => f.tag);
    velocity = n3(s.freestream?.velocity ?? [1, 0, 0], ctx.scope, "Velocidade");
    const [up, down, side] = s.freestream?.domain ?? [3, 6, 2];
    // domínio alinhado com a direção principal do escoamento (eixo de maior componente)
    const ax = [0, 1, 2].reduce((m, k) => (Math.abs(velocity[k]) > Math.abs(velocity[m]) ? k : m), 0);
    const sign = Math.sign(velocity[ax]) || 1;
    const min = b.min.map((x) => x - side * L) as V3, max = b.max.map((x) => x + side * L) as V3;
    if (sign > 0) { min[ax] = b.min[ax] - up * L; max[ax] = b.max[ax] + down * L; } else { min[ax] = b.min[ax] - down * L; max[ax] = b.max[ax] + up * L; }
    domain = { min, max };
    insidePoint = min.map((x, k) => x + 0.05 * (max[k] - x)) as V3;
  }
  const U = Math.hypot(...velocity);
  if (!(U > 0)) throw new Error("Velocidade: tem de ser não nula");
  // comprimento característico: diâmetro hidráulico da entrada (interno) ou maior dimensão (externo)
  let refLength = L;
  if (s.regime === "internal") {
    const inl = faces.filter((f) => groups.inlet.includes(f.tag));
    const A = inl.reduce((a, f) => a + f.area, 0);
    const P = explore(solid, "face").filter((_, i) => groups.inlet.includes(i + 1)).reduce((a, f) => {
      const p = new (oc().GProp_GProps)(); oc().BRepGProp.LinearProperties(f, p, false, false); const m = p.Mass(); p.delete(); return a + m;
    }, 0);
    refLength = P > 0 ? (4 * A) / P : L;
  }
  const reynolds = (U * refLength * 1e-3) / s.fluid.nu;
  if (s.turbulence === "laminar" && reynolds > (s.regime === "internal" ? 2300 : 5e5)) report.warnings.push(`Re ≈ ${reynolds.toExponential(2)}: provavelmente turbulento (escolha um modelo de turbulência)`);
  const size = evalParam(s.mesh.size, ctx.scope, "Tamanho das células");
  if (size <= 0) throw new Error("Tamanho das células: tem de ser positivo");
  return {
    format: "cadp-sim-case", version: 1, physics: "cfd", solver: s.solver, title: s.name, regime: s.regime, fluid: s.fluid, turbulence: s.turbulence,
    groups, faces, velocity, domain, insidePoint, iterations: s.iterations, bbox: { min: b.min as V3, max: b.max as V3 },
    mesh: { size, surfaceLevel: s.mesh.surfaceLevel ?? [1, 2], layers: s.mesh.layers ?? 3 }, refLength, reynolds,
    hypotheses: [
      `Escoamento incompressível em regime permanente (${s.solver === "openfoam" ? "simpleFoam" : "SU2 INC_RANS/INC_NAVIER_STOKES"}), fluido newtoniano: ${s.fluid.name} (ρ = ${s.fluid.rho} kg/m³, ν = ${s.fluid.nu} m²/s)`,
      `Turbulência: ${s.turbulence === "laminar" ? "laminar" : s.turbulence === "kOmegaSST" ? "RANS k-ω SST" : "RANS k-ε"}; Re ≈ ${reynolds.toExponential(2)} (comprimento ${refLength.toFixed(2)} mm)`,
      s.regime === "internal" ? "Entrada com velocidade uniforme, saída à pressão 0, paredes sem escorregamento" : `Domínio em caixa (${(s.freestream?.domain ?? [3, 6, 2]).join(" × ")} × dimensão) com escoamento livre uniforme e paredes laterais com escorregamento`,
      `Malha: ${s.solver === "openfoam" ? `snappyHexMesh (fundo ${size} mm, níveis ${(s.mesh.surfaceLevel ?? [1, 2]).join("–")}, ${s.mesh.layers ?? 3} camadas)` : `tetraédrica Gmsh ${size} mm`} — confirmar a independência da malha`,
      "Apoio à decisão de engenharia: não é certificação nem decisão de uma autoridade ou de um organismo notificado",
    ],
  };
}

export function studyCase(ctx: Ctx, s: Study): SimFiles {
  const report: StepReport = { warnings: [] };
  const solid = bodyOf(ctx);
  const brep = oc().BRepToolsWrapper.Write(solid) as string;
  const files: Record<string, string | Uint8Array> = { "model.brep": brep };
  let c: SimCase;
  if (s.physics === "fem") {
    c = femCase(ctx, s, report);
    files["mesh.geo"] = femGeo(c);
  } else {
    c = cfdCase(ctx, s, report);
    if (c.solver === "openfoam") Object.assign(files, openfoamCase(c, stlPatches(ctx, solid, c)));
    else { files["mesh.geo"] = su2Geo(c); files["case.cfg"] = su2Config(c); }
  }
  files["case.json"] = JSON.stringify(c, null, 1);
  files["LEIA-ME.txt"] = readme(c);
  return { case: c, files, warnings: report.warnings };
}

/** STL ASCII (em metros) de cada patch, a partir da triangulação exata das faces do OCC. */
function stlPatches(ctx: Ctx, solid: TopoDS_Shape, c: CfdCase): Record<string, string> {
  const o = oc();
  const size = Math.max(...c.bbox.max.map((x, i) => x - c.bbox.min[i]));
  T(new o.BRepMesh_IncrementalMesh(solid, size * 1e-3, false, 0.2, false));
  const all = explore(solid, "face");
  const out: Record<string, string> = {};
  for (const [name, tags] of Object.entries(c.groups)) {
    const L = [`solid ${name}`];
    for (const tag of tags) {
      const f = T(o.TopoDS.Face(all[tag - 1]));
      const loc = T(new o.TopLoc_Location());
      const tri = o.BRep_Tool.Triangulation(f, loc, 0);
      if (!tri || (tri as unknown as { IsNull?: () => boolean }).IsNull?.()) continue;
      const trsf = loc.Transformation();
      const rev = f.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED;
      const P = (k: number) => { const p = tri.Node(k).Transformed(trsf); const r: V3 = [p.X() * 1e-3, p.Y() * 1e-3, p.Z() * 1e-3]; p.delete(); return r; };
      for (let k = 1; k <= tri.NbTriangles(); k++) {
        const t = tri.Triangle(k);
        let [a, b2, cc] = [t.Value(1), t.Value(2), t.Value(3)];
        if (rev) [b2, cc] = [cc, b2];
        const A = P(a), B = P(b2), C = P(cc);
        const n = v3.norm(v3.cross(v3.sub(B, A), v3.sub(C, A)));
        L.push(`  facet normal ${n.join(" ")}`, "    outer loop", ...[A, B, C].map((p) => `      vertex ${p.map((x) => x.toPrecision(9)).join(" ")}`), "    endloop", "  endfacet");
      }
    }
    L.push(`endsolid ${name}`);
    out[name] = L.join("\n") + "\n";
  }
  return out;
}

function readme(c: SimCase): string {
  const steps = c.physics === "fem"
    ? c.solver === "code_aster"
      ? ["gmsh mesh.geo -3 -o mesh.msh", "(o agente local escreve mesh.mail, job.comm e job.export a partir de mesh.msh e case.json)", "run_aster job.export", "Resultados: job.rmed (ParaView/SALOME) e tabelas *.tab"]
      : ["gmsh mesh.geo -3 -o mesh.msh", "(o agente local escreve job.inp a partir de mesh.msh e case.json)", "ccx job", "Resultados: job.frd (ParaView/CGX) e job.dat"]
    : c.solver === "openfoam"
      ? ["sh Allrun   (blockMesh, surfaceFeatureExtract, snappyHexMesh, checkMesh, simpleFoam — com o ambiente do OpenFOAM carregado)", "Resultados: último tempo; paraFoam ou foamToVTK"]
      : ["gmsh mesh.geo -3 -format su2 -o mesh.su2", "SU2_CFD case.cfg"];
  return [
    `${c.title}`,
    "",
    "Gerado pelo CAD protótipo (pré-processador F1). Com o agente local (`node cad-runner.mjs .`) os passos correm sozinhos.",
    "",
    "Hipóteses:",
    ...c.hypotheses.map((h) => `- ${h}`),
    "",
    "Passos manuais:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Grupos de faces (tag Gmsh/OCC):",
    ...Object.entries(c.groups).map(([k, v]) => `- ${k}: ${v.join(", ")}`),
    "",
  ].join("\n");
}
