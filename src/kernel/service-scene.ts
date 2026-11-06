// Serviço do núcleo: auxiliares de cena (hash de revisão, área, corpo+superfícies numa só forma).
import type { Ctx } from "./context.ts";
import type { NamedBody } from "./naming.ts";
import { makeCompound, oc, type TopoDS_Shape } from "./occ.ts";

/** Hash curto (FNV-1a de 32 bits) de um texto, para revisões. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + s.length.toString(16);
}

export const surfaceArea = (s: TopoDS_Shape) => {
  const o = oc();
  const props = new o.GProp_GProps();
  o.BRepGProp.SurfaceProperties(s, props, false, false);
  const a = props.Mass();
  props.delete();
  return a;
};

/** Corpo sólido + corpos de superfície numa só forma (malha, exportação, análises). */
export function sceneOf(ctx: Ctx): { scene: NamedBody | null; owner: (name: string) => string } {
  const parts: [string, NamedBody][] = [...(ctx.body ? [["", ctx.body] as [string, NamedBody]] : []), ...ctx.sheets];
  const owners = new Map<string, string>();
  for (const [id, b] of parts) for (const f of b.faces) owners.set(f.name, id);
  const owner = (n: string) => owners.get(n) ?? "";
  const curves = [...ctx.curves.values()];
  if (!parts.length && !curves.length) return { scene: null, owner };
  if (parts.length === 1 && !curves.length) return { scene: parts[0][1], owner };
  return { scene: { shape: makeCompound([...parts.map(([, b]) => b.shape), ...curves.map((c) => c.shape)]), faces: parts.flatMap(([, b]) => b.faces) }, owner };
}
