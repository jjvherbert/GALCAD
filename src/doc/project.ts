// Projeto: o ficheiro .cadp.json guarda várias peças, montagens e desenhos (como os ficheiros
// .sldprt/.sldasm/.slddrw de um projeto SolidWorks, mas num só documento aberto e legível).
// Um ficheiro antigo de uma só peça (format "cadp") abre como um projeto com essa peça.
import type { CadDocument, Expr, Feature, StdAxis, StdPlane, TopoRef, Variable, Vec3 } from "./types.ts";
import { parseDocument } from "./io.ts";

// ---------------------------------------------------------------------------
// Propriedades (BOM, legenda)
// ---------------------------------------------------------------------------

export interface PartProperties {
  /** Referência / número da peça. */
  number?: string;
  description?: string;
  material?: string;
  /** Massa volúmica em g/cm³ (por defeito 7,85, aço). */
  density?: number;
  finish?: string;
  supplier?: string;
  /** Propriedades personalizadas (aparecem como colunas da BOM). */
  custom?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Montagens
// ---------------------------------------------------------------------------

export interface Placement {
  /** Translação (mm). */
  t: Vec3;
  /** Rotação (graus) em torno de X, depois Y, depois Z. */
  r: Vec3;
}

export interface Component {
  id: string;
  name: string;
  ref: { kind: "part" | "assembly"; id: string };
  /** Posição inicial (o solver de mates parte daqui). */
  placement: Placement;
  /** Fixo: o solver não o move (o primeiro componente é fixo por defeito). */
  fixed?: boolean;
  suppressed?: boolean;
  /** Configuração da peça usada por este componente (tabela de configurações); omitida = a ativa. */
  config?: string;
}

export type MateKind = "coincident" | "concentric" | "parallel" | "perpendicular" | "distance" | "angle" | "tangent" | "lock";

/**
 * Referência de um mate: face/aresta de um componente (pelo nome topológico na peça) ou plano/eixo
 * de referência do componente. `component: ""` = a origem da própria montagem.
 */
export type MateRef =
  | { component: string; ref: TopoRef }
  | { component: string; std: StdPlane | StdAxis };

export interface Mate {
  id: string;
  name: string;
  kind: MateKind;
  a: MateRef;
  b: MateRef;
  /** Distância (mm) ou ângulo (graus). */
  value?: Expr;
  /** Alinhamento das normais/eixos: anti (faces frente a frente, por defeito nas faces) ou alinhado. */
  align?: "aligned" | "anti";
  suppressed?: boolean;
}

export interface AssemblyDoc {
  id: string;
  name: string;
  components: Component[];
  mates: Mate[];
  properties?: PartProperties;
  variables?: Variable[];
}

// ---------------------------------------------------------------------------
// Desenhos
// ---------------------------------------------------------------------------

export type SheetSize = "A4" | "A3" | "A2" | "A1" | "A0";

export interface SheetSpec {
  size: SheetSize;
  orientation: "landscape" | "portrait";
  /** Método de projeção: 1.º diedro (ISO, Europa) ou 3.º diedro (ASME). */
  projection: "first" | "third";
  /** Escala da folha [numerador, denominador], ex. [1, 2] = 1:2. */
  scale: [number, number];
}

export interface TitleBlock {
  title: string;
  number: string;
  company: string;
  author: string;
  checker: string;
  approver: string;
  date: string;
  revision: string;
  /** Vazio = material da peça (propriedades). */
  material: string;
  generalTolerance: string;
  sheet: string;
}

export type ViewSource = { kind: "part" | "assembly"; id: string };
export type StdView = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso";

interface ViewBase {
  id: string;
  name: string;
  /** Centro da vista na folha (mm). */
  at: [number, number];
  /** Escala própria (omitida = escala da folha; nas vistas derivadas, a da vista-mãe). */
  scale?: number;
  hidden?: boolean; // mostrar linhas ocultas
  tangent?: "visible" | "none"; // arestas tangentes
  centerMarks?: boolean;
}

export type DrawingView =
  | (ViewBase & { kind: "model"; source: ViewSource; orientation: StdView })
  /** Vista projetada da vista-mãe para um dos lados (respeita o método de projeção da folha). */
  | (ViewBase & { kind: "projected"; parent: string; side: "right" | "left" | "above" | "below" })
  /** Corte: linha de corte de a a b em coordenadas da vista-mãe (mm do modelo); `flip` troca o sentido de observação. */
  | (ViewBase & { kind: "section"; parent: string; a: [number, number]; b: [number, number]; label: string; flip?: boolean })
  /** Pormenor: círculo na vista-mãe (coordenadas da vista-mãe), ampliado. */
  | (ViewBase & { kind: "detail"; parent: string; center: [number, number]; radius: number; label: string })
  /** Vista auxiliar: perpendicular a uma aresta reta da vista-mãe (mostra em verdadeira grandeza a face inclinada). */
  | (ViewBase & { kind: "auxiliary"; parent: string; edge: string; flip?: boolean });

/** Ponto de ancoragem associativo: aresta do modelo vista numa vista (ou ponto fixo da vista). */
export type Anchor =
  | { view: string; edge: string; at: "start" | "end" | "mid" | "center" }
  | { view: string; point: [number, number] };

export type DimType = "horizontal" | "vertical" | "aligned" | "radius" | "diameter" | "angle";

export type GdtChar =
  | "straightness" | "flatness" | "circularity" | "cylindricity" | "profileLine" | "profileSurface"
  | "parallelism" | "perpendicularity" | "angularity" | "position" | "concentricity" | "symmetry" | "runout" | "totalRunout";

export type Annotation =
  /**
   * Cota. `offset`: distância (mm na folha) da linha de cota aos pontos medidos (lineares), ou
   * comprimento do prolongamento para fora do círculo (raio/diâmetro). `angle`: direção (graus) da linha
   * de chamada do raio/diâmetro. `model`: cota importada de um esboço (segue o modelo).
   */
  | { kind: "dim"; id: string; type: DimType; a: Anchor; b?: Anchor; offset: number; angle?: number; tol?: { plus?: string; minus?: string; fit?: string }; prefix?: string; precision?: number; model?: { feature: string; constraint: string; view: string } }
  | { kind: "note"; id: string; at: [number, number]; text: string; leader?: Anchor; height?: number }
  | { kind: "gdt"; id: string; at: [number, number]; leader?: Anchor; char: GdtChar; tol: string; dia?: boolean; modifier?: "M" | "L"; datums: string[] }
  | { kind: "datum"; id: string; at: [number, number]; anchor: Anchor; letter: string }
  | { kind: "surface"; id: string; at: [number, number]; anchor?: Anchor; process: "any" | "removal" | "noRemoval"; value: string }
  | { kind: "weld"; id: string; at: [number, number]; anchor: Anchor; symbol: "fillet" | "butt" | "v" | "spot"; size: string; length?: string; otherSide?: boolean; allAround?: boolean }
  | { kind: "balloon"; id: string; at: [number, number]; view: string; component: string; edge?: string }
  | { kind: "bom"; id: string; at: [number, number]; source: string; mode: "top" | "parts" | "indented"; columns?: string[] };

export interface DrawingDoc {
  id: string;
  name: string;
  sheet: SheetSpec;
  title: TitleBlock;
  views: DrawingView[];
  annotations: Annotation[];
}

// ---------------------------------------------------------------------------
// Projeto
// ---------------------------------------------------------------------------

/**
 * Template de features (estilo PowerCopy/UDF do CATIA): um grupo de features copiado com as suas
 * entradas (referências exteriores ao grupo, a substituir na instância) e parâmetros (variáveis).
 */
export interface FeatureTemplate {
  id: string;
  name: string;
  description?: string;
  features: Feature[];
  inputs: TemplateInput[];
  parameters: Variable[];
}

/** Entrada de um template: uma feature (esboço, plano, corpo de superfície, curva) ou uma face/aresta. */
export type TemplateInput =
  | { key: string; label: string; kind: "feature"; type: string; original: string }
  | { key: string; label: string; kind: "face" | "edge"; original: string };

export interface CadProject {
  format: "cadp-project";
  version: 1;
  name: string;
  /** Peças (cada uma é um documento de features com `id`). */
  parts: (CadDocument & { id: string; properties?: PartProperties })[];
  assemblies: AssemblyDoc[];
  drawings: DrawingDoc[];
  templates?: FeatureTemplate[];
}

export type PartDoc = CadProject["parts"][number];
export type DocKind = "part" | "assembly" | "drawing";
export interface DocRef { kind: DocKind; id: string }

const nextId = (prefix: string, ids: string[]) => {
  const n = ids.reduce((m, id) => (id.startsWith(prefix) ? Math.max(m, Number(id.slice(prefix.length)) || 0) : m), 0);
  return `${prefix}${n + 1}`;
};
const uniqueName = (base: string, names: string[]) => {
  for (let i = 1; ; i++) if (!names.includes(`${base}${i}`)) return `${base}${i}`;
};

export function newPart(project: CadProject | null, name?: string): PartDoc {
  const ids = project?.parts.map((p) => p.id) ?? [];
  return { format: "cadp", version: 1, id: nextId("p", ids), name: name ?? uniqueName("Peça", project?.parts.map((p) => p.name) ?? []), units: "mm", variables: [], features: [] };
}

export function newAssembly(project: CadProject, name?: string): AssemblyDoc {
  return { id: nextId("a", project.assemblies.map((a) => a.id)), name: name ?? uniqueName("Montagem", project.assemblies.map((a) => a.name)), components: [], mates: [] };
}

export const DEFAULT_TITLE: TitleBlock = {
  title: "", number: "", company: "", author: "", checker: "", approver: "", date: "", revision: "A", material: "",
  generalTolerance: "ISO 2768-mK", sheet: "1/1",
};

export function newDrawing(project: CadProject, name?: string): DrawingDoc {
  return {
    id: nextId("d", project.drawings.map((d) => d.id)),
    name: name ?? uniqueName("Desenho", project.drawings.map((d) => d.name)),
    sheet: { size: "A3", orientation: "landscape", projection: "first", scale: [1, 1] },
    title: { ...DEFAULT_TITLE, date: new Date().toISOString().slice(0, 10) },
    views: [],
    annotations: [],
  };
}

export function newProject(name = "Projeto"): CadProject {
  const p: CadProject = { format: "cadp-project", version: 1, name, parts: [], assemblies: [], drawings: [] };
  p.parts.push(newPart(p, "Peça1"));
  return p;
}

/** Projeto a partir de um documento de peça (ficheiros antigos). */
export function projectFromPart(doc: CadDocument, id = "p1"): CadProject {
  return { format: "cadp-project", version: 1, name: doc.name, parts: [{ ...doc, id }], assemblies: [], drawings: [] };
}

export function serializeProject(p: CadProject): string {
  return JSON.stringify(p, null, 2) + "\n";
}

/** Lê um projeto (.cadp.json): aceita o formato de projeto e o de peça única. */
export function parseProject(text: string): CadProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Ficheiro inválido: não é JSON (${(e as Error).message})`);
  }
  const r = raw as Partial<CadProject> & { format?: string };
  if ((r as { format?: string })?.format === "cadp") return projectFromPart(parseDocument(text));
  if (r?.format !== "cadp-project") throw new Error("Ficheiro inválido: não é um projeto .cadp");
  if (r.version !== 1) throw new Error(`Versão de projeto não suportada: ${String(r.version)}`);
  if (!Array.isArray(r.parts) || !Array.isArray(r.assemblies) || !Array.isArray(r.drawings)) throw new Error("Projeto inválido: faltam peças, montagens ou desenhos");
  const parts = r.parts.map((p) => {
    if (typeof p.id !== "string") throw new Error("Projeto inválido: peça sem id");
    return { ...parseDocument(JSON.stringify(p)), id: p.id, properties: p.properties };
  });
  const ids = new Set<string>();
  for (const id of [...parts.map((p) => p.id), ...r.assemblies.map((a) => a.id), ...r.drawings.map((d) => d.id)]) {
    if (ids.has(id)) throw new Error(`Id repetido no projeto: ${id}`);
    ids.add(id);
  }
  return { format: "cadp-project", version: 1, name: r.name ?? "Projeto", parts, assemblies: r.assemblies, drawings: r.drawings };
}

export function docName(project: CadProject, ref: DocRef): string {
  const list = ref.kind === "part" ? project.parts : ref.kind === "assembly" ? project.assemblies : project.drawings;
  return list.find((d) => d.id === ref.id)?.name ?? ref.id;
}

/** Onde é usado um documento (montagens que o incluem, desenhos que o mostram). */
export function usages(project: CadProject, id: string): string[] {
  const out: string[] = [];
  for (const a of project.assemblies) if (a.components.some((c) => c.ref.id === id)) out.push(a.name);
  for (const d of project.drawings) if (d.views.some((v) => v.kind === "model" && v.source.id === id) || d.annotations.some((x) => x.kind === "bom" && x.source === id)) out.push(d.name);
  return out;
}

/** Montagens contidas (recursivamente) — para impedir ciclos (uma montagem dentro de si própria). */
export function containsAssembly(project: CadProject, asmId: string, target: string, seen = new Set<string>()): boolean {
  if (asmId === target) return true;
  if (seen.has(asmId)) return false;
  seen.add(asmId);
  const a = project.assemblies.find((x) => x.id === asmId);
  return !!a?.components.some((c) => c.ref.kind === "assembly" && containsAssembly(project, c.ref.id, target, seen));
}

export const DEFAULT_DENSITY = 7.85;

/** Omit distributivo (mantém a união de tipos). */
export type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewView = DistOmit<DrawingView, "id" | "name"> & { name?: string };
export type NewAnnotation = DistOmit<Annotation, "id">;
