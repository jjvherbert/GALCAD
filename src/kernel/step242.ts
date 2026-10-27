// Exportação STEP AP242 (Fase 4.6) por um documento XCAF: produtos com nome (número + nome da
// peça), cores, corpos sólidos e de superfície separados e, nas montagens, a estrutura de produto
// com uma ocorrência por instância (nome e posição). O PMI semântico fica para a Fase 5.
import { T, type TopoDS_Shape, oc } from "./occ.ts";

export interface StepBody { name: string; shape: TopoDS_Shape; color: [number, number, number] }
export interface StepPart { key: string; name: string; bodies: StepBody[] }
export interface StepInstance { name: string; part: string; matrix: number[] }

const str = (s: string) => T(new (oc().TCollection_ExtendedString)(s, true));

/** Cores por defeito: corpos sólidos em cinzento-azulado, superfícies em âmbar. */
export const SOLID_COLOR: [number, number, number] = [0.62, 0.68, 0.75];
export const SHEET_COLOR: [number, number, number] = [0.85, 0.62, 0.2];

function newDoc() {
  const o = oc();
  const doc = T(new o.TDocStd_Document(str("XmlOcaf")));
  o.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const main = doc.Main();
  return { doc, tool: o.XCAFDoc_DocumentTool.ShapeTool(main), colors: o.XCAFDoc_DocumentTool.ColorTool(main) };
}

function write(doc: InstanceType<ReturnType<typeof oc>["TDocStd_Document"]>, title: string): Uint8Array {
  const o = oc();
  const session = T(new o.XSControl_WorkSession());
  const writer = T(new o.STEPCAFControl_Writer(session, false));
  writer.SetColorMode(true);
  writer.SetNameMode(true);
  writer.SetLayerMode(true);
  o.Interface_Static.SetCVal("write.step.unit", "MM");
  o.Interface_Static.SetIVal("write.surfacecurve.mode", 1);
  o.Interface_Static.SetIVal("write.precision.mode", 0);
  o.Interface_Static.SetIVal("write.step.assembly", 1);
  o.Interface_Static.SetIVal("write.step.schema", 5); // AP242 DIS
  o.Interface_Static.SetCVal("write.step.product.name", title);
  const file = "/export242.step";
  const progress = T(new o.Message_ProgressRange());
  if (!writer.Perform(doc, file, progress)) throw new Error("A escrita do STEP AP242 falhou");
  const data = o.FS.readFile(file) as Uint8Array;
  o.FS.unlink(file);
  return data;
}

/** Acrescenta uma peça (com um ou mais corpos) e devolve o rótulo do produto. */
function addPart(t: ReturnType<typeof newDoc>, part: StepPart) {
  const o = oc();
  const C = o.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
  const color = (c: [number, number, number]) => T(new o.Quantity_ColorRGBA(c[0], c[1], c[2], 1));
  if (part.bodies.length === 1) {
    const b = part.bodies[0];
    const L = t.tool.NewShape();
    t.tool.SetShape(L, b.shape);
    o.TDataStd_Name.Set(L, str(part.name));
    t.colors.SetColor(L, color(b.color), C);
    return L;
  }
  // vários corpos: produto da peça como subconjunto dos corpos (nomes e cores próprios)
  const L = t.tool.NewShape();
  o.TDataStd_Name.Set(L, str(part.name));
  for (const b of part.bodies) {
    const B = t.tool.NewShape();
    t.tool.SetShape(B, b.shape);
    o.TDataStd_Name.Set(B, str(`${part.name} — ${b.name}`));
    t.colors.SetColor(B, color(b.color), C);
    const occ = t.tool.AddComponent(L, B, T(new o.TopLoc_Location()));
    o.TDataStd_Name.Set(occ, str(b.name));
  }
  return L;
}

/** STEP AP242 de uma peça (corpo sólido e corpos de superfície como corpos com nome). */
export function stepPart(part: StepPart): Uint8Array {
  const t = newDoc();
  addPart(t, part);
  t.tool.UpdateAssemblies();
  return write(t.doc, part.name);
}

/** STEP AP242 de uma montagem: produto de topo com uma ocorrência (nome e posição) por instância. */
export function stepAssembly(name: string, parts: StepPart[], instances: StepInstance[]): Uint8Array {
  const o = oc();
  const t = newDoc();
  const labels = new Map(parts.map((p) => [p.key, addPart(t, p)]));
  const root = t.tool.NewShape();
  o.TDataStd_Name.Set(root, str(name));
  for (const i of instances) {
    const L = labels.get(i.part);
    if (!L) continue;
    const m = i.matrix;
    const tr = T(new o.gp_Trsf());
    tr.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
    const occ = t.tool.AddComponent(root, L, T(new o.TopLoc_Location(tr)));
    o.TDataStd_Name.Set(occ, str(i.name));
  }
  t.tool.UpdateAssemblies();
  return write(t.doc, name);
}
