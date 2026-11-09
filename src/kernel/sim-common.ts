// Estudos: tipos e auxiliares partilhados (corpo único, faces com tag, referências → tags, LEIA-ME).
import { evalParam } from "../doc/variables.ts";
import { type TopoRef } from "../doc/types.ts";
import { type Ctx, type StepReport, faces as resolveFaces } from "./context.ts";
import { type NamedBody } from "./naming.ts";
import { type TopoDS_Shape, explore, faceProps, normalOnFace } from "./occ.ts";
import { type CaseFace, type SimCase, type V3 } from "../sim/case.ts";

export interface SimFiles { case: SimCase; files: Record<string, string | Uint8Array>; warnings: string[] }

export function bodyOf(ctx: Ctx): TopoDS_Shape {
  if (!ctx.body) throw new Error("O estudo precisa de um corpo sólido");
  const solids = explore(ctx.body.shape, "solid");
  if (solids.length !== 1) throw new Error(`O estudo precisa de um só sólido (a peça tem ${solids.length})`);
  return solids[0];
}

/** Chapa do estudo de casca: a última criada (superfície média do laminado/chapa). */
export function shellOf(ctx: Ctx): NamedBody {
  const all = [...ctx.sheets.values()];
  if (!all.length) throw new Error("O estudo de casca precisa de uma chapa (superfície)");
  return all[all.length - 1];
}

/** Faces do corpo com tag (1…, ordem do OCC = ordem do Gmsh), nome topológico, centroide e área. */
export function caseFaces(ctx: Ctx, solid: TopoDS_Shape, named: NamedBody["faces"] = ctx.body!.faces): CaseFace[] {
  return explore(solid, "face").map((f, i) => {
    const p = faceProps(f);
    return { tag: i + 1, name: named.find((n) => n.face.IsSame(f))?.name ?? `?${i + 1}`, center: p.center as V3, area: p.area, normal: p.type === "plane" ? normalOnFace(f, p.center) as V3 : undefined };
  });
}

export function tagsOf(ctx: Ctx, faces: CaseFace[], solid: TopoDS_Shape, refs: TopoRef[], what: string, report: StepReport): number[] {
  if (!refs.length) throw new Error(`${what}: escolha as faces`);
  const all = explore(solid, "face");
  return resolveFaces(ctx, refs, report).map((nf) => {
    const i = all.findIndex((f) => f.IsSame(nf.face));
    if (i < 0) throw new Error(`${what}: a face "${nf.name}" não pertence ao ${ctx.body ? "corpo" : "modelo"} do estudo`);
    return faces[i].tag;
  });
}

export const n3 = (e: [unknown, unknown, unknown], scope: Ctx["scope"], label: string): V3 => e.map((x, k) => evalParam(x as never, scope, `${label} ${"XYZ"[k]}`)) as V3;

/** Topologia do BREP exportado para o plano da malha: sólidos, faces e arestas pela ordem do Gmsh. */
export interface MeshGeo { solids: TopoDS_Shape[]; faces: TopoDS_Shape[]; edges: TopoDS_Shape[]; edgeTags: (refs: TopoRef[], what: string) => number[]; names?: string[] }

export function readme(c: SimCase): string {
  const steps = c.physics === "fem"
    ? c.solver === "code_aster"
      ? ["gmsh mesh.geo -3 -o mesh.msh", "(o agente local escreve mesh.mail, job.comm e job.export a partir de mesh.msh e case.json)", "run_aster job.export", "Resultados: job.rmed (ParaView/SALOME) e tabelas *.tab"]
      : [`gmsh mesh.geo ${c.shell ? "-2" : "-3"} -o mesh.msh`, "(o agente local escreve job.inp a partir de mesh.msh e case.json)", "ccx job", "Resultados: job.frd (ParaView/CGX) e job.dat"]
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
