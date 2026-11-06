// Serviço do núcleo: exportação STEP AP242 da peça ou da montagem ativa.
import type { AssemblyInstance } from "./protocol.ts";
import type { Ctx } from "./context.ts";
import type { CadDocument } from "../doc/types.ts";
import type { CadProject, PartProperties } from "../doc/project.ts";
import { configuredDoc, splitPartKey } from "../doc/knowledge.ts";
import type { PartBuild } from "./assembly.ts";
import { pmiStates } from "./pmi.ts";
import { type ResolvedPmi, addSemanticPmi } from "./step-pmi.ts";
import { SHEET_COLOR, SOLID_COLOR, type StepBody, type StepPart, stepAssembly, stepPart } from "./step242.ts";
import type { TopoDS_Shape } from "./occ.ts";

/** Estado do serviço de que a exportação STEP depende. */
export interface StepState {
  kind: "part" | "assembly";
  part: { doc: CadDocument & { properties?: PartProperties }; ctx: Ctx } | null;
  asm: { project: CadProject; id: string } | null;
  instances: AssemblyInstance[];
}

/** STEP AP242 da peça ou da montagem ativa (produtos com nome, cores e estrutura de produto). */
export async function step242(
  s: StepState, partBuild: (project: CadProject, key: string) => Promise<PartBuild>, restoreArena: () => void,
): Promise<Uint8Array> {
  const title = (d: { name: string; properties?: PartProperties }, config?: string) =>
    `${d.properties?.number ? `${d.properties.number} ` : ""}${d.name}${config ? ` [${config}]` : ""}`;
  const bodiesOf = (ctx: Ctx): StepBody[] => [
    ...(ctx.body ? [{ name: "Corpo", shape: ctx.body.shape, color: SOLID_COLOR }] : []),
    ...[...ctx.sheets].map(([id, b]) => ({ name: ctx.doc.features.find((f) => f.id === id)?.name ?? id, shape: b.shape, color: SHEET_COLOR })),
  ];
  if (s.kind === "part") {
    if (!s.part) throw new Error("Não há peça para exportar");
    const { ctx, doc } = s.part;
    const bodies = bodiesOf(ctx);
    if (!bodies.length) throw new Error("A peça não tem corpos para exportar");
    // PMI semântico e atributos: as faces referidas ficam com nome no STEP e as entidades AP242 são acrescentadas
    const pmi = doc.pmi ?? [], attrs = doc.attributes ?? [];
    if (!ctx.body || (!pmi.length && !attrs.length)) return stepPart({ key: "", name: title(doc, doc.configurations?.active), bodies });
    const faceIdx = new Map<string, number>();
    const pmiFaces: TopoDS_Shape[] = [];
    const idx = (name: string) => {
      if (!faceIdx.has(name)) {
        const f = ctx.body!.faces.find((x) => x.name === name);
        if (!f) return -1;
        faceIdx.set(name, pmiFaces.length);
        pmiFaces.push(f.face);
      }
      return faceIdx.get(name)!;
    };
    const states = new Map(pmiStates(ctx, pmi).map((x) => [x.id, x]));
    const resolved: ResolvedPmi[] = pmi.map((item) => ({ item, nominal: states.get(item.id)?.nominal, faces: (states.get(item.id)?.faces ?? []).map(idx).filter((k) => k >= 0) }));
    const at = attrs.map((attr) => {
      const k = attr.target.kind === "face" ? idx(attr.target.ref.name) : -1;
      return { attr, face: k >= 0 ? k : undefined };
    });
    const raw = stepPart({ key: "", name: title(doc, doc.configurations?.active), bodies, pmiFaces });
    const out = addSemanticPmi(new TextDecoder().decode(raw), resolved, at);
    return new TextEncoder().encode(out.step);
  }
  if (!s.asm) throw new Error("Não há montagem para exportar");
  const { project, id } = s.asm;
  const asm = project.assemblies.find((a) => a.id === id)!;
  const keys = [...new Set(s.instances.map((i) => i.part))];
  const parts: StepPart[] = [];
  for (const key of keys) {
    const b = await partBuild(project, key);
    const { id: pid, config } = splitPartKey(key);
    const doc = configuredDoc(project.parts.find((p) => p.id === pid)!, config);
    parts.push({ key, name: title(doc, config), bodies: bodiesOf(b.ctx) });
  }
  restoreArena();
  return stepAssembly(title(asm), parts.filter((p) => p.bodies.length), s.instances.map((i) => ({ name: i.name, part: i.part, matrix: i.matrix })));
}
