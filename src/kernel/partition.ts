// Partições do sólido em blocos para a malha (como as "partitions" do Abaqus ou o Femap
// "Geometry > Solid > Slice"): planos perpendiculares a X, Y ou Z, inclinados ou de referência, e esboços
// extrudidos, cortam o sólido com o BRepAlgoAPI_Splitter. As faces de corte ficam partilhadas pelos blocos vizinhos (malha conforme)
// e cada bloco de 6 faces pode ser malhado com hexaedros estruturados. As faces e arestas do corpo
// original passam para as sub-faces/sub-arestas pelo histórico do corte, para as cargas, apoios e
// seeds continuarem a apontar para as mesmas superfícies.
import { type TopoDS_Shape, T, bbox, explore, gpPln, gpVec, listToArray, makeCompound, makeList, oc } from "./occ.ts";
import { ShapeIndex } from "./naming.ts";

/** Plano de corte: perpendicular a X, Y ou Z em `at`, ou inclinado ("n"): n̂·x = at com n̂ = normal normalizada. */
export interface CutPlane {
  axis: "x" | "y" | "z" | "n"; at: number; normal?: [number, number, number];
  /** Nome nas mensagens de erro. */ label?: string;
  /** Partição só nesta face: o corte fica limitado às linhas que o plano traça na face e é varrido ao longo
   *  de `sweep` (a normal da face) pela espessura, para a face oposta receber a mesma divisão (malha conforme,
   *  elementos direitos na espessura). */
  face?: TopoDS_Shape; sweep?: [number, number, number];
}

/** Ferramenta de corte já construída (p. ex. um esboço extrudido pelo sólido, como o Abaqus
 *  "Partition Cell: Extrude/Sweep Edges"): faces que o Splitter usa tal como estão. */
export interface ShapeTool { kind: "shape"; shape: TopoDS_Shape; label: string }

export type PartitionTool = CutPlane | ShapeTool;

export interface Partitioned {
  /** Compound dos blocos (vai para o model.brep). */
  shape: TopoDS_Shape;
  solids: TopoDS_Shape[];
  faces: TopoDS_Shape[];
  edges: TopoDS_Shape[];
  /** Sub-formas do resultado que vêm de uma face/aresta do sólido original (ela própria se não foi cortada). */
  sub: (s: TopoDS_Shape) => TopoDS_Shape[];
  /** Índice no resultado da face/aresta de origem (para nomes): face do resultado → face original. */
  origin: (f: TopoDS_Shape) => TopoDS_Shape | undefined;
  /** N.º de ferramentas que cortaram de facto o sólido. */
  used: number;
  /** Ferramentas ignoradas (não atravessam o sólido, dados inválidos, corte falhado), com o motivo. */
  skipped: string[];
}

const AX = { x: 0, y: 1, z: 2 } as const;

const planeLabel = (p: CutPlane) => p.label ?? (p.axis === "n" ? `Partição n·x = ${p.at}` : `Partição ${p.axis.toUpperCase()} = ${p.at}`);

/** Constrói a face (ou o corte varrido) de um plano; `string` = motivo para o ignorar. */
function planeTool(p: CutPlane, b: { min: number[]; max: number[] }, far: number): TopoDS_Shape | string {
  const o = oc();
  const mid = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
  const eps = 1e-7 * far;
  let n: [number, number, number];
  if (p.axis === "n") {
    const v = p.normal ?? [0, 0, 0], len = Math.hypot(...v);
    if (!(len > 1e-12) || v.some((x) => !Number.isFinite(x))) return "a normal do plano não pode ser nula";
    n = v.map((x) => x / len) as [number, number, number];
  } else { n = [0, 0, 0]; n[AX[p.axis]] = 1; }
  // alcance de n̂·x nos 8 cantos da caixa (exato para os planos X/Y/Z, conservador para os inclinados)
  let lo = Infinity, hi = -Infinity;
  for (let c = 0; c < 8; c++) {
    const q = [0, 1, 2].map((k) => ((c >> k) & 1 ? b.max[k] : b.min[k]));
    const d = q[0] * n[0] + q[1] * n[1] + q[2] * n[2];
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  const what = p.axis === "n" ? "n·x" : p.axis.toUpperCase();
  // um plano que não corta nada não estraga a malha: fica de fora, com aviso (não é um erro do estudo)
  if (!(p.at > lo + eps && p.at < hi - eps)) return `o plano não atravessa o sólido (${what} de ${+lo.toFixed(4)} a ${+hi.toFixed(4)})`;
  // origem do plano: o centro da caixa projetado sobre ele (a face quadrada cobre o sólido todo)
  const dm = mid[0] * n[0] + mid[1] * n[1] + mid[2] * n[2] - p.at;
  const org = [0, 1, 2].map((k) => mid[k] - dm * n[k]) as [number, number, number];
  const plane = T(T(new o.BRepBuilderAPI_MakeFace(gpPln(org, n), -far, far, -far, far)).Face());
  if (!p.face) return plane;
  return sweptCut(plane, p.face, p.sweep, far) ?? "o plano não corta a face escolhida (é paralelo a ela ou passa ao lado)";
}

/** A ferramenta toca no sólido? (a secção tem arestas) */
function crosses(solid: TopoDS_Shape, tool: TopoDS_Shape): boolean {
  const s = T(new (oc() as any).BRepAlgoAPI_Section(solid, tool, false));
  s.Build();
  return !!s.IsDone() && !s.HasErrors() && explore(T(s.Shape()), "edge").length > 0;
}

function split(solid: TopoDS_Shape, tools: TopoDS_Shape[]) {
  const sp = T(new (oc()).BRepAlgoAPI_Splitter());
  sp.SetArguments(makeList([solid]));
  sp.SetTools(makeList(tools));
  sp.Build();
  return sp.HasErrors() ? null : sp;
}

/**
 * Corta o sólido por todas as ferramentas de uma vez. Cada ferramenta é diagnosticada à parte: uma que não
 * atravessa o sólido, tem dados inválidos ou faz falhar o corte fica de fora com aviso, e as outras aplicam-se.
 */
export function partitionSolid(solid: TopoDS_Shape, list: PartitionTool[]): Partitioned {
  const b = bbox(solid);
  const far = Math.max(...[0, 1, 2].map((k) => b.max[k] - b.min[k])) * 2 + 1;
  let built: { shape: TopoDS_Shape; label: string }[] = [];
  const skipped: string[] = [];
  for (const p of list) {
    const label = "kind" in p ? p.label : planeLabel(p);
    let r: TopoDS_Shape | string;
    try {
      r = "kind" in p ? (crosses(solid, p.shape) ? p.shape : "não atravessa o sólido") : planeTool(p, b, far);
    } catch (e) { r = e instanceof Error ? e.message.replace(/^Partição[^:]*: /, "") : String(e); }
    if (typeof r === "string") skipped.push(`${label}: ${r} — ignorada`);
    else built.push({ shape: r, label });
  }
  let sp = built.length ? split(solid, built.map((t) => t.shape)) : null;
  if (built.length && !sp) {
    // o corte conjunto falhou: fica só com as ferramentas que cortam sozinhas
    built = built.filter((t) => {
      if (split(solid, [t.shape])) return true;
      skipped.push(`${t.label}: o corte do sólido falhou — ignorada`);
      return false;
    });
    sp = built.length ? split(solid, built.map((t) => t.shape)) : null;
    if (built.length && !sp) throw new Error("Partições: o corte do sólido pelas ferramentas falhou");
  }
  if (!sp) {
    const faces = explore(solid, "face"), edges = explore(solid, "edge");
    return { shape: solid, solids: [solid], faces, edges, sub: (s) => [s], origin: (f) => faces.find((x) => x.IsSame(f)), used: 0, skipped };
  }
  const shape = T(sp.Shape());
  const solids = explore(shape, "solid");
  const faces = explore(shape, "face"), edges = explore(shape, "edge");
  const inFaces = new ShapeIndex<true>(), inEdges = new ShapeIndex<true>();
  faces.forEach((f) => inFaces.set(f, true));
  edges.forEach((e) => inEdges.set(e, true));
  const sub = (s: TopoDS_Shape) => {
    const has = (x: TopoDS_Shape) => inFaces.has(x) || inEdges.has(x);
    const mods = listToArray(sp.Modified(s)).filter(has);
    return mods.length ? mods : has(s) ? [s] : [];
  };
  const back = new ShapeIndex<TopoDS_Shape>();
  for (const f of explore(solid, "face")) for (const m of sub(f)) back.set(m, f);
  return { shape, solids, faces, edges, sub, origin: (f) => back.get(f), used: built.length, skipped };
}

/** Linhas que a ferramenta (um plano, um esboço extrudido) traça na face, varridas ao longo de `dir` de −far
 *  a +far (faces de corte pela espessura, como a Split Line › Projection do SolidWorks); `null` = não a toca. */
export function sweptCut(tool: TopoDS_Shape, face: TopoDS_Shape, dir: [number, number, number] | undefined, far: number): TopoDS_Shape | null {
  const o = oc() as any;
  const len = dir ? Math.hypot(...dir) : 0;
  if (!dir || !(len > 1e-12)) throw new Error("Partição numa face: a face tem de ser plana");
  const d = dir.map((x) => x / len);
  const s = T(new o.BRepAlgoAPI_Section(tool, face, false));
  s.Approximation(true);
  s.Build();
  if (!s.IsDone() || s.HasErrors()) throw new Error("Partição numa face: a interseção do corte com a face falhou");
  const edges = explore(T(s.Shape()), "edge");
  if (!edges.length) return null;
  const t = T(new o.gp_Trsf());
  t.SetTranslation(gpVec(d.map((x) => -x * far) as [number, number, number]));
  const start = T(T(new o.BRepBuilderAPI_Transform(makeCompound(edges), t, true, false)).Shape());
  return T(T(new o.BRepPrimAPI_MakePrism(start, gpVec(d.map((x) => 2 * x * far) as [number, number, number]), false, true)).Shape());
}
