// Porta dos plugins: o worker não tem localStorage, por isso a decisão «este plugin está ligado?» é
// tomada aqui, na app, antes de cada pedido. As features de plugins desligados seguem como suprimidas
// (o documento não perde nada e as features seguintes comportam-se como com uma feature suprimida).
import { activePlugins, type PluginFlags } from "../plugins/index.ts";
import type { CadDocument, Feature } from "../doc/types.ts";
import type { CadProject } from "../doc/project.ts";
import type { Request } from "../kernel/protocol.ts";

/** A feature é de um plugin que as definições atuais não ativam? */
export function inactivePluginFeature(f: Feature, flags: PluginFlags): boolean {
  return f.type === "plugin" && !activePlugins(flags).some((p) => p.id === f.plugin);
}

/** Devolve o documento com as features de plugins desligados suprimidas (o mesmo objeto se não houver nenhuma). */
export function gateDoc<D extends CadDocument>(doc: D, flags: PluginFlags): D {
  if (!doc.features.some((f) => inactivePluginFeature(f, flags) && !f.suppressed)) return doc;
  return { ...doc, features: doc.features.map((f) => (inactivePluginFeature(f, flags) ? { ...f, suppressed: true } : f)) };
}

function gateParts<D extends CadDocument>(parts: D[] | undefined, flags: PluginFlags): D[] | undefined {
  if (!parts) return parts;
  const out = parts.map((p) => gateDoc(p, flags));
  return out.some((p, i) => p !== parts[i]) ? out : parts;
}

function gateProject(project: CadProject, flags: PluginFlags): CadProject {
  const parts = gateParts(project.parts, flags)!;
  return parts === project.parts ? project : { ...project, parts };
}

/** Aplica a porta a todos os documentos de um pedido ao worker. */
export function gateRequest(req: Request, flags: PluginFlags): Request {
  const r = req as Request & { doc?: CadDocument; parts?: CadDocument[]; project?: CadProject };
  if (!r.doc && !r.parts && !r.project) return req;
  const out = { ...r };
  if (r.doc) out.doc = gateDoc(r.doc, flags);
  if (r.parts) out.parts = gateParts(r.parts, flags);
  if (r.project) out.project = gateProject(r.project, flags);
  return out as Request;
}
