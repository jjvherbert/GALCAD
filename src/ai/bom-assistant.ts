// Assistente de BOM local (determinístico, sem rede): a partir da assinatura geométrica de cada peça
// e das propriedades do projeto, propõe sugestões que o utilizador aceita ou ignora, uma a uma.
// Nunca altera nada sozinho. As tabelas de normalizados são valores nominais de referência:
// confirmar sempre na norma ou no catálogo do fornecedor.
import { type CadProject, type PartProperties, DEFAULT_DENSITY } from "../doc/project.ts";
import type { PartSignature } from "../kernel/signature.ts";
import { computeBom, itemOfComponent } from "../assembly/bom.ts";

export type SuggestionKind = "standard" | "description" | "process" | "material" | "duplicate" | "missing" | "consistency" | "cost" | "supplier";

export interface Suggestion {
  id: string;
  /** Peça a que se refere (ou vazio para o projeto). */
  part: string;
  kind: SuggestionKind;
  title: string;
  detail: string;
  /** 0–1. */
  confidence: number;
  /** Alteração às propriedades da peça, se a sugestão for aceite. */
  patch?: PartProperties;
  source: "local" | "claude";
}

// --- tabelas de normalizados (nominais) -------------------------------------------------

/** Distância entre faces do sextavado s (ISO 4032 / ISO 4017, série normal). */
const HEX_S: Record<number, number> = { 3: 5.5, 4: 7, 5: 8, 6: 10, 8: 13, 10: 16, 12: 18, 14: 21, 16: 24, 20: 30, 24: 36 };
/** Anilhas planas ISO 7089: d1 × d2 × h. */
const WASHER: Record<number, [number, number, number]> = { 3: [3.2, 7, 0.5], 4: [4.3, 9, 0.8], 5: [5.3, 10, 1], 6: [6.4, 12, 1.6], 8: [8.4, 16, 1.6], 10: [10.5, 20, 2], 12: [13, 24, 2.5], 16: [17, 30, 3], 20: [21, 37, 3], 24: [25, 44, 4] };
/** Rolamentos rígidos de esferas (ISO 15): d × D × B. */
const BEARINGS: Record<string, [number, number, number]> = {
  "608": [8, 22, 7], "6000": [10, 26, 8], "6001": [12, 28, 8], "6002": [15, 32, 9], "6003": [17, 35, 10], "6004": [20, 42, 12],
  "6200": [10, 30, 9], "6201": [12, 32, 10], "6202": [15, 35, 11], "6203": [17, 40, 12], "6204": [20, 47, 14], "6205": [25, 52, 15],
};
const PIN_D = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20];

/** Preços indicativos (€/kg de matéria-prima) e fatores de processo; editáveis na interface. */
export interface CostRates { steel: number; stainless: number; aluminium: number; copper: number; plastic: number; composite: number; process: Record<string, number> }
export const DEFAULT_RATES: CostRates = {
  steel: 1.5, stainless: 5, aluminium: 4.5, copper: 9, plastic: 6, composite: 12,
  process: { "Corte de chapa": 2, "Torneamento": 4, "Fresagem CNC": 5, "Corte de barra": 1.5, "Normalizado (catálogo)": 1 },
};

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const f1 = (x: number) => (Math.round(x * 10) / 10).toString().replace(".", ",");

/** Família do material pelo nome (para densidade e preço). */
export function materialFamily(m: string | undefined): keyof Omit<CostRates, "process"> | null {
  if (!m) return null;
  const s = m.toLowerCase();
  if (/inox|1\.43|1\.44|aisi\s*3/.test(s)) return "stainless";
  if (/alum|en aw|6082|6061|5083|7075/.test(s)) return "aluminium";
  if (/lat[ãa]o|bronze|cobre|cuzn|cusn/.test(s)) return "copper";
  if (/pom|pa6|pe-|pp|abs|pvc|nylon|ptfe|pl[aá]stico/.test(s)) return "plastic";
  if (/prfv|frp|fibra|carbono|epóx|epox|compós/.test(s)) return "composite";
  if (/a[çc]o|s235|s355|c45|42crmo|ferro|fundido|8\.8|steel/.test(s)) return "steel";
  return null;
}
const FAMILY_DENSITY: Record<string, [number, number]> = { steel: [7.7, 7.95], stainless: [7.85, 8.05], aluminium: [2.6, 2.85], copper: [8.3, 8.95], plastic: [0.85, 2.2], composite: [1.4, 2.1] };

interface Classified { kind: "bolt" | "nut" | "washer" | "bearing" | "pin" | "shaft" | "tube" | "turned" | "plate" | "block"; designation?: string; description: string; process: string; confidence: number; detail: string }

/** Classificação geométrica de uma peça. */
export function classify(s: PartSignature): Classified {
  const outer = s.cylinders.filter((c) => c.outer).sort((a, b) => b.r - a.r);
  const inner = s.cylinders.filter((c) => !c.outer).sort((a, b) => b.r - a.r);
  const nominal = (d: number, tol: number) => Object.keys(HEX_S).map(Number).find((n) => near(d, n, tol));
  // parafuso: cabeça sextavada + haste cilíndrica com o diâmetro nominal
  if (s.hex && outer.length) {
    const shaft = outer.find((c) => nominal(2 * c.r, 0.15) !== undefined);
    const m = shaft && nominal(2 * shaft.r, 0.15);
    if (shaft && m && near(s.hex.across, HEX_S[m], 0.35)) {
      const L = Math.round(shaft.len);
      return { kind: "bolt", designation: `ISO 4017 M${m} × ${L}`, description: `Parafuso de cabeça sextavada M${m} × ${L}`, process: "Normalizado (catálogo)", confidence: 0.85, detail: `Sextavado s = ${f1(s.hex.across)} mm (ISO 4017: ${HEX_S[m]}) e haste ⌀${f1(2 * shaft.r)} × ${L} mm.` };
    }
  }
  // porca: sextavado com furo (diâmetro nominal ou de broca de roscar)
  if (s.hex && inner.length && !outer.length) {
    const hole = 2 * inner[0].r;
    const m = Object.keys(HEX_S).map(Number).find((n) => near(s.hex!.across, HEX_S[n], 0.35) && (near(hole, n, 0.2) || near(hole, n - n * 0.17, 0.4)));
    if (m) return { kind: "nut", designation: `ISO 4032 M${m}`, description: `Porca sextavada M${m}`, process: "Normalizado (catálogo)", confidence: 0.8, detail: `Sextavado s = ${f1(s.hex.across)} mm, furo ⌀${f1(hole)} mm.` };
  }
  if (s.revolution && outer.length && inner.length) {
    const D = 2 * outer[0].r, d = 2 * inner[0].r, B = Math.max(outer[0].len, inner[0].len);
    // anilha: anel fino
    for (const [m, [d1, d2, h]] of Object.entries(WASHER)) {
      if (near(d, d1, 0.15) && near(D, d2, 0.3) && near(s.box[2], h, 0.15)) return { kind: "washer", designation: `ISO 7089 - ${m}`, description: `Anilha plana para M${m}`, process: "Normalizado (catálogo)", confidence: 0.8, detail: `⌀${f1(d)} / ⌀${f1(D)} × ${f1(s.box[2])} mm. Falta a classe de dureza na designação (ex.: 200 HV).` };
    }
    // rolamento modelado como anel (d × D × B)
    for (const [code, [bd, bD, bB]] of Object.entries(BEARINGS)) {
      if (near(d, bd, 0.1) && near(D, bD, 0.1) && near(B, bB, 0.1)) return { kind: "bearing", designation: `${code} (ISO 15)`, description: `Rolamento rígido de esferas ${code}`, process: "Normalizado (catálogo)", confidence: 0.7, detail: `${bd} × ${bD} × ${bB} mm coincide com a série ${code}. Confirmar vedação/folga.` };
    }
    const t = (D - d) / 2;
    if (B > 2 * D && t < D * 0.2) return { kind: "tube", description: `Tubo ⌀${f1(D)} × ${f1(t)} × ${Math.round(B)}`, process: "Corte de barra", confidence: 0.6, detail: "Revolução com parede fina e comprimento grande." };
    return { kind: "turned", description: `Casquilho ⌀${f1(D)} / ⌀${f1(d)} × ${f1(B)}`, process: "Torneamento", confidence: 0.6, detail: "Peça de revolução com furo axial." };
  }
  if (s.revolution && outer.length) {
    const D = 2 * outer[0].r, L = s.box[0];
    if (outer.length === 1 && L > 2 * D) {
      const std = PIN_D.find((x) => near(D, x, 0.02));
      if (std && L <= 10 * D) return { kind: "pin", designation: `ISO 2338 ⌀${std} × ${Math.round(L)}`, description: `Cavilha cilíndrica ⌀${std} × ${Math.round(L)}`, process: "Normalizado (catálogo)", confidence: 0.45, detail: "Cilindro simples com diâmetro normalizado; pode também ser um veio. Confirmar a tolerância (m6/h8)." };
      return { kind: "shaft", description: `Veio ⌀${f1(D)} × ${Math.round(L)}`, process: "Torneamento", confidence: 0.6, detail: "Revolução maciça, comprida." };
    }
    return { kind: "turned", description: `Peça torneada ⌀${f1(2 * outer[0].r)} × ${f1(s.box[0])}`, process: "Torneamento", confidence: 0.55, detail: "Todas as faces partilham o mesmo eixo." };
  }
  if (s.plate) {
    return { kind: "plate", description: `Chapa ${f1(s.plate.t)} mm — ${Math.round(s.box[0])} × ${Math.round(s.box[1])}`, process: "Corte de chapa", confidence: 0.7, detail: `Duas faces paralelas grandes a ${f1(s.plate.t)} mm (espessura constante): corte laser/plasma/jato de água.` };
  }
  const machined = s.cylinders.some((c) => !c.outer) || Object.keys(s.faces).length > 1 || (s.faces.plane ?? 0) > 6;
  return { kind: "block", description: `Bloco ${Math.round(s.box[0])} × ${Math.round(s.box[1])} × ${Math.round(s.box[2])}`, process: machined ? "Fresagem CNC" : "Corte de barra", confidence: 0.5, detail: machined ? "Prismática com furos ou rebaixos." : "Prisma simples." };
}

const SUPPLIER: Record<string, string> = {
  "Normalizado (catálogo)": "Distribuidor de normalizados (parafusaria / rolamentos)",
  "Corte de chapa": "Serralharia / corte a laser",
  Torneamento: "Torneiro / maquinação CNC",
  "Fresagem CNC": "Maquinação CNC",
  "Corte de barra": "Armazém de aços / serralharia",
};
const LEAD: Record<string, string> = {
  "Normalizado (catálogo)": "em stock (dias)", "Corte de chapa": "~1 semana", Torneamento: "1–2 semanas", "Fresagem CNC": "2–3 semanas", "Corte de barra": "dias",
};

/** Sugestões locais para todo o projeto (ou só para as peças de uma montagem). */
export function localSuggestions(project: CadProject, sigs: Record<string, PartSignature | { error: string }>, rates: CostRates = DEFAULT_RATES, asmId?: string): Suggestion[] {
  const out: Suggestion[] = [];
  let n = 0;
  const add = (s: Omit<Suggestion, "id" | "source">) => out.push({ ...s, id: `s${++n}`, source: "local" });
  const scope = asmId ? new Set(computeBom(project, asmId, "parts", {}).map((r) => r.id)) : null;
  const parts = project.parts.filter((p) => !scope || scope.has(p.id));

  for (const p of parts) {
    const sig = sigs[p.id];
    const props = p.properties ?? {};
    if (!sig || "error" in sig) {
      add({ part: p.id, kind: "consistency", title: `${p.name}: sem geometria`, detail: sig && "error" in sig ? sig.error : "Peça por reconstruir.", confidence: 1 });
      continue;
    }
    const c = classify(sig);
    if (c.designation && props.number !== c.designation) {
      add({ part: p.id, kind: "standard", title: `${p.name} parece ${c.designation}`, detail: `${c.detail} Usar a peça do catálogo em vez de a desenhar e fabricar.`, confidence: c.confidence, patch: { ...props, number: c.designation, description: c.description } });
    } else if (!props.description || props.description === p.name) {
      add({ part: p.id, kind: "description", title: `Descrição normalizada para ${p.name}`, detail: `"${c.description}". ${c.detail}`, confidence: c.confidence, patch: { ...props, description: c.description } });
    }
    if (!props.custom?.Processo) add({ part: p.id, kind: "process", title: `${p.name}: processo provável — ${c.process}`, detail: c.detail, confidence: c.confidence * 0.9, patch: { ...props, custom: { ...props.custom, Processo: c.process } } });
    if (!props.material) {
      const m = c.kind === "bolt" || c.kind === "nut" ? "Aço classe 8.8 zincado" : c.kind === "washer" ? "Aço zincado (200 HV)" : c.kind === "bearing" ? "Aço para rolamentos 100Cr6" : c.kind === "plate" ? "Aço S235JR" : c.kind === "shaft" || c.kind === "pin" ? "Aço C45" : "Aço S235JR";
      add({ part: p.id, kind: "material", title: `${p.name}: material por definir`, detail: `Sugestão de partida: ${m} (escolha de engenharia a confirmar: cargas, ambiente, corrosão, custo).`, confidence: 0.3, patch: { ...props, material: m, density: 7.85 } });
    } else {
      const fam = materialFamily(props.material);
      const dens = props.density ?? DEFAULT_DENSITY;
      if (fam && !(dens >= FAMILY_DENSITY[fam][0] && dens <= FAMILY_DENSITY[fam][1])) {
        const typical = (FAMILY_DENSITY[fam][0] + FAMILY_DENSITY[fam][1]) / 2;
        add({ part: p.id, kind: "consistency", title: `${p.name}: massa volúmica incoerente com "${props.material}"`, detail: `${dens} g/cm³ não é típico desta família (${FAMILY_DENSITY[fam].join("–")} g/cm³). A massa na BOM e na legenda está errada.`, confidence: 0.9, patch: { ...props, density: Math.round(typical * 100) / 100 } });
      }
    }
    if (!props.supplier && !props.custom?.["Fornecedor (categoria)"]) {
      add({ part: p.id, kind: "supplier", title: `${p.name}: tipo de fornecedor`, detail: `${SUPPLIER[c.process] ?? "—"} (categoria, não um fornecedor concreto). Prazo indicativo: ${LEAD[c.process] ?? "—"}.`, confidence: 0.5, patch: { ...props, custom: { ...props.custom, "Fornecedor (categoria)": SUPPLIER[c.process] ?? "" } } });
    }
    // custo indicativo: massa × €/kg × fator de processo
    const fam = materialFamily(props.material) ?? "steel";
    const kg = (sig.volume / 1e6) * (props.density ?? DEFAULT_DENSITY);
    const proc = props.custom?.Processo ?? c.process;
    const cost = kg * rates[fam] * (rates.process[proc] ?? 3);
    add({ part: p.id, kind: "cost", title: `${p.name}: custo indicativo ~${cost.toLocaleString("pt-PT", { maximumFractionDigits: 2 })} €/un.`, detail: `${kg.toLocaleString("pt-PT", { maximumFractionDigits: 3 })} kg × ${rates[fam]} €/kg (${fam}) × fator ${rates.process[proc] ?? 3} (${proc}). Ordem de grandeza para comparar alternativas, não um orçamento: pedir cotação.`, confidence: 0.2, patch: { ...props, custom: { ...props.custom, "Custo indicativo (€)": cost.toFixed(2) } } });
    if (!props.number) add({ part: p.id, kind: "missing", title: `${p.name}: sem número de peça`, detail: "A BOM usa o nome do documento. Atribua uma referência (codificação da empresa).", confidence: 1 });
  }

  // duplicados e quase-duplicados (geometria)
  const valid = parts.filter((p) => sigs[p.id] && !("error" in sigs[p.id]));
  for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
    const a = sigs[valid[i].id] as PartSignature, b = sigs[valid[j].id] as PartSignature;
    const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(1e-9, Math.max(x, y));
    const sameFaces = JSON.stringify(a.faces) === JSON.stringify(b.faces);
    const boxSame = a.box.every((x, k) => near(x, b.box[k], 0.05));
    if (sameFaces && boxSame && rel(a.volume, b.volume) < 0.002 && rel(a.area, b.area) < 0.002) {
      add({ part: valid[j].id, kind: "duplicate", title: `${valid[j].name} é igual a ${valid[i].name}`, detail: "Mesma geometria (volume, área, caixa e faces). Usar uma só peça com quantidade 2 simplifica a BOM e o stock.", confidence: 0.9 });
    } else if (sameFaces && rel(a.volume, b.volume) < 0.05 && a.box.every((x, k) => rel(x, b.box[k]) < 0.05)) {
      add({ part: valid[j].id, kind: "duplicate", title: `${valid[j].name} é quase igual a ${valid[i].name}`, detail: `Volumes a ${(rel(a.volume, b.volume) * 100).toFixed(1)}% e mesma topologia. Avaliar se uma variante (configuração) chega.`, confidence: 0.5 });
    }
  }

  // números repetidos
  const byNumber = new Map<string, string[]>();
  for (const p of parts) if (p.properties?.number) byNumber.set(p.properties.number, [...(byNumber.get(p.properties.number) ?? []), p.name]);
  for (const [num, names] of byNumber) if (names.length > 1) add({ part: "", kind: "consistency", title: `Número ${num} repetido`, detail: `Usado por ${names.join(", ")}: dois itens diferentes com a mesma referência.`, confidence: 1 });

  // desenhos: balões em falta para itens da tabela de BOM; número na legenda diferente do da peça
  for (const d of project.drawings) {
    for (const t of d.annotations) {
      if (t.kind !== "bom") continue;
      const rows = computeBom(project, t.source, "top", {});
      const ballooned = new Set(d.annotations.flatMap((x) => (x.kind === "balloon" ? [itemOfComponent(project, t.source, x.component) ?? ""] : [])));
      const missing = rows.filter((r) => !ballooned.has(r.item)).map((r) => r.item);
      if (missing.length) add({ part: "", kind: "consistency", title: `${d.name}: itens da BOM sem balão`, detail: `Itens ${missing.join(", ")} estão na tabela mas não têm balão no desenho.`, confidence: 1 });
    }
    const mv = d.views.find((v) => v.kind === "model");
    if (mv?.kind === "model" && mv.source.kind === "part" && d.title.number) {
      const p = project.parts.find((x) => x.id === mv.source.id);
      if (p?.properties?.number && p.properties.number !== d.title.number) add({ part: p.id, kind: "consistency", title: `${d.name}: n.º do desenho ≠ n.º da peça`, detail: `Legenda "${d.title.number}", peça "${p.properties.number}".`, confidence: 0.8 });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
