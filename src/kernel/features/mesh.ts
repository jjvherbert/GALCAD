// Importação de malhas (STL e STEP só com tesselação): triângulos → faces planas costuradas → sólido(s).
// O resultado é um corpo de malha utilizável (ver, medir, secções, booleanas simples); converter num
// B-rep editável (reconhecer planos/cilindros) fica para mais tarde (ROADMAP F5e).
import type { TopoDS_Shape } from "replicad-opencascadejs";
import { T, bbox, explore, hash, isValid, makeShell, oc, volume } from "../occ.ts";
import { sew } from "./surface-common.ts";

/** Limite de triângulos: cada triângulo vira uma face B-rep (memória e tempo crescem depressa). */
export const MAX_TRIANGLES = 50000;

/** Número de triângulos de um STL (binário: cabeçalho de 80 bytes + uint32 + 50 bytes por triângulo). */
export function stlTriangles(b: Uint8Array): number {
  if (isBinary(b)) return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  const text = new TextDecoder().decode(b);
  return (text.match(/\bfacet\s+normal\b/gi) ?? []).length;
}

/** STL binário: o tamanho bate certo com o número de triângulos e não há texto «facet normal» no início. */
function isBinary(b: Uint8Array): boolean {
  if (b.length < 84) return false;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  return 84 + 50 * n === b.length && !/\bfacet\s+normal\b/i.test(new TextDecoder().decode(b.subarray(0, 512)));
}

/** O leitor do OCC trata como ASCII um ficheiro cujos primeiros bytes são todos < 128 — acontece em STL
 *  binários com normais a zero e coordenadas redondas. Marca o cabeçalho (texto livre) para o forçar a binário. */
function forOcc(b: Uint8Array): Uint8Array {
  if (!isBinary(b) || b.subarray(0, 512).some((x) => x > 127)) return b;
  const c = b.slice();
  c[79] = 0xff;
  return c;
}

export interface MeshResult { solids: TopoDS_Shape[]; open: TopoDS_Shape | null; triangles: number }

let seq = 0;

/** Lê um STL (bytes) e costura os triângulos: cascas fechadas → sólidos; o resto → superfície aberta. */
export function readMesh(bytes: Uint8Array): MeshResult {
  const triangles = stlTriangles(bytes);
  if (!triangles) throw new Error("A malha não tem triângulos (STL vazio ou inválido)");
  if (triangles > MAX_TRIANGLES)
    throw new Error(`A malha tem ${triangles} triângulos; o limite é ${MAX_TRIANGLES}. Simplifique-a (decimação) antes de importar`);
  const o = oc() as any;
  const path = `/galcad-mesh-${++seq}.stl`;
  const raw = T(new o.TopoDS_Shape()) as TopoDS_Shape;
  try {
    o.FS.writeFile(path, forOcc(bytes));
    if (!T(new o.StlAPI_Reader()).Read(raw, path) || raw.IsNull()) throw new Error("Não foi possível ler o STL");
  } finally {
    try { o.FS.unlink(path); } catch { /* já não existe */ }
  }
  const { min, max } = bbox(raw);
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(diag > 0)) throw new Error("A malha é degenerada (dimensão nula)");
  const sewn = sew([raw], Math.max(1e-9, diag * 1e-6)).shape;
  const solids: TopoDS_Shape[] = [];
  const openFaces: TopoDS_Shape[] = [];
  const inShell = new Set<number>();
  for (const sh of explore(sewn, "shell")) {
    const faces = explore(sh, "face");
    for (const f of faces) inShell.add(hash(f));
    let solid: TopoDS_Shape | null = null;
    try {
      solid = T(T(new o.ShapeFix_Solid()).SolidFromShell(o.TopoDS.Shell(sh))) as TopoDS_Shape;
    } catch { solid = null; }
    if (solid && !solid.IsNull() && isValid(solid) && volume(solid).volume > diag ** 3 * 1e-9) solids.push(unify(solid, triangles));
    else openFaces.push(...faces);
  }
  for (const f of explore(sewn, "face")) if (!inShell.has(hash(f))) openFaces.push(f);
  return { solids, open: openFaces.length ? makeShell(openFaces) : null, triangles };
}

/** Junta triângulos coplanares em faces maiores (só se o resultado for válido e mantiver o volume). */
function unify(solid: TopoDS_Shape, triangles: number): TopoDS_Shape {
  if (triangles > 20000) return solid;
  try {
    const u = T(new (oc().ShapeUpgrade_UnifySameDomain)(solid, true, true, false));
    u.Build();
    const r = T(u.Shape());
    const v0 = volume(solid).volume, v1 = volume(r).volume;
    return isValid(r) && Math.abs(v1 - v0) <= 1e-6 * v0 ? r : solid;
  } catch {
    return solid;
  }
}
