// Partições do sólido em blocos para a malha (como as "partitions" do Abaqus ou o Femap
// "Geometry > Solid > Slice"): planos perpendiculares a X, Y ou Z cortam o sólido com o
// BRepAlgoAPI_Splitter. As faces de corte ficam partilhadas pelos blocos vizinhos (malha conforme)
// e cada bloco de 6 faces pode ser malhado com hexaedros estruturados. As faces e arestas do corpo
// original passam para as sub-faces/sub-arestas pelo histórico do corte, para as cargas, apoios e
// seeds continuarem a apontar para as mesmas superfícies.
import { type TopoDS_Shape, T, bbox, explore, gpPln, listToArray, makeList, oc } from "./occ.ts";
import { ShapeIndex } from "./naming.ts";

export interface CutPlane { axis: "x" | "y" | "z"; at: number }

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
  /** N.º de planos que cortaram de facto o sólido. */
  used: number;
}

const AX = { x: 0, y: 1, z: 2 } as const;

export function partitionSolid(solid: TopoDS_Shape, planes: CutPlane[]): Partitioned {
  const o = oc();
  const b = bbox(solid);
  const far = Math.max(...[0, 1, 2].map((k) => b.max[k] - b.min[k])) * 2 + 1;
  const mid = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
  const tools: TopoDS_Shape[] = [];
  for (const p of planes) {
    const k = AX[p.axis];
    const eps = 1e-7 * far;
    if (!(p.at > b.min[k] + eps && p.at < b.max[k] - eps)) throw new Error(`Partição ${p.axis.toUpperCase()} = ${p.at}: o plano não atravessa o sólido (${p.axis.toUpperCase()} de ${+b.min[k].toFixed(4)} a ${+b.max[k].toFixed(4)})`);
    const org = mid.slice() as [number, number, number];
    org[k] = p.at;
    const n: [number, number, number] = [0, 0, 0];
    n[k] = 1;
    tools.push(T(T(new o.BRepBuilderAPI_MakeFace(gpPln(org, n), -far, far, -far, far)).Face()));
  }
  const sp = T(new o.BRepAlgoAPI_Splitter());
  sp.SetArguments(makeList([solid]));
  sp.SetTools(makeList(tools));
  sp.Build();
  if (sp.HasErrors()) throw new Error("Partições: o corte do sólido pelos planos falhou");
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
  return { shape, solids, faces, edges, sub, origin: (f) => back.get(f), used: solids.length - 1 };
}
