// PMI 3D semântico (Fase 5): referências (datums), cotas com tolerância ou ajustamento ISO 286,
// tolerâncias geométricas ISO 1101 (quadro de tolerância), estados de superfície ISO 21920/1302 e
// notas, ligados às faces pelo nome topológico; vistas de modelo (MBD) e atributos (tags) em
// faces, features e no corpo. Puro: regras e tabelas verificáveis sem o núcleo.
//
// Normas: ISO 1101:2017 (GPS — tolerâncias geométricas), ISO 5459:2011 (referências), ISO 286-1:2010
// e 286-2:2010 (sistema ISO de tolerâncias para dimensões lineares), ISO 21920-1:2021 (perfil de
// superfície, indicação; substitui a ISO 1302:2002). As tabelas abaixo cobrem as dimensões até 500 mm.
import type { TopoRef } from "./types.ts";

export type GdtCharacteristic =
  | "straightness" | "flatness" | "circularity" | "cylindricity"
  | "profileLine" | "profileSurface"
  | "parallelism" | "perpendicularity" | "angularity"
  | "position" | "concentricity" | "symmetry"
  | "circularRunout" | "totalRunout";

/** Símbolo, nome e família de cada característica (ISO 1101 Tabela 2). */
export const GDT: Record<GdtCharacteristic, { symbol: string; label: string; family: "form" | "profile" | "orientation" | "location" | "runout" }> = {
  straightness: { symbol: "⏤", label: "Retitude", family: "form" },
  flatness: { symbol: "⏥", label: "Planeza", family: "form" },
  circularity: { symbol: "○", label: "Circularidade", family: "form" },
  cylindricity: { symbol: "⌭", label: "Cilindricidade", family: "form" },
  profileLine: { symbol: "⌒", label: "Forma de uma linha", family: "profile" },
  profileSurface: { symbol: "⌓", label: "Forma de uma superfície", family: "profile" },
  parallelism: { symbol: "∥", label: "Paralelismo", family: "orientation" },
  perpendicularity: { symbol: "⟂", label: "Perpendicularidade", family: "orientation" },
  angularity: { symbol: "∠", label: "Inclinação", family: "orientation" },
  position: { symbol: "⌖", label: "Localização (posição)", family: "location" },
  concentricity: { symbol: "◎", label: "Coaxialidade/concentricidade", family: "location" },
  symmetry: { symbol: "⌯", label: "Simetria", family: "location" },
  circularRunout: { symbol: "↗", label: "Batimento circular", family: "runout" },
  totalRunout: { symbol: "⌰", label: "Batimento total", family: "runout" },
};

export type PmiItem =
  | { kind: "datum"; id: string; label: string; face: TopoRef }
  | {
      kind: "dimension"; id: string; type: "distance" | "diameter" | "radius" | "angle"; faces: TopoRef[];
      /** Tolerância: afastamentos (mm; graus nos ângulos) ou ajustamento ISO 286 (ex. "H7", "g6"). */
      tol?: { kind: "deviation"; upper: number; lower: number } | { kind: "fit"; code: string };
      /** Valor nominal fixado (omitido = medido no modelo). */
      nominal?: number;
    }
  | {
      kind: "gdt"; id: string; characteristic: GdtCharacteristic; faces: TopoRef[];
      /** Valor da tolerância (mm) e zona cilíndrica (⌀). */
      value: number; diameter?: boolean;
      /** Modificadores: Ⓜ máximo material, Ⓛ mínimo material. */
      modifier?: "M" | "L";
      /** Referências por ordem de precedência (primária, secundária, terciária). */
      datums: string[];
    }
  | { kind: "roughness"; id: string; faces: TopoRef[]; ra: number; process: "any" | "remove" | "noremove"; note?: string }
  | { kind: "note"; id: string; faces: TopoRef[]; text: string };

/** Vista de modelo (MBD): orientação da câmara e os PMI que mostra. */
export interface ModelView { id: string; name: string; dir: [number, number, number]; up: [number, number, number]; items: string[] }

/** Atributo (tag) de um alvo: o corpo, uma feature ou uma face. */
export interface Attribute {
  target: { kind: "body" } | { kind: "feature"; feature: string } | { kind: "face"; ref: TopoRef };
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// ISO 286: graus de tolerância IT e afastamentos fundamentais
// ---------------------------------------------------------------------------

/** Limites superiores dos escalões de dimensões (mm), ISO 286-1 Tabela 1 (até 500 mm). */
const STEPS = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];
/** Valores dos graus IT5–IT11 (µm), ISO 286-1 Tabela 1. */
const IT: Record<number, number[]> = {
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
};
/**
 * Afastamentos fundamentais dos veios (µm), ISO 286-1 Tabela 2/3: es para e, f, g, h (superior) e ei
 * para k, m, n, p (inferior). k: +valor só nos graus IT4–IT7 (0 até 3 mm e fora desses graus).
 */
const SHAFT: Record<string, number[]> = {
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5],
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};

/** Índice do escalão: "acima de a até b inclusive". */
export function sizeStep(d: number): number {
  if (!(d > 0) || d > 500) throw new Error(`ISO 286: dimensão ${d} mm fora do intervalo suportado (0–500 mm)`);
  return STEPS.findIndex((b) => d <= b);
}

export function itValue(grade: number, d: number): number {
  const t = IT[grade];
  if (!t) throw new Error(`ISO 286: grau IT${grade} não tabelado (IT5–IT11)`);
  return t[sizeStep(d)];
}

/**
 * Afastamentos (mm) de uma classe de tolerância ISO 286: furos E F G H JS (maiúsculas) e veios
 * e f g h js k m n p (minúsculas), graus 5–11. Devolve { upper, lower }.
 */
export function fitDeviation(code: string, d: number): { upper: number; lower: number } {
  const m = /^(js|JS|[A-Za-z])(\d{1,2})$/.exec(code.trim());
  if (!m) throw new Error(`Classe de tolerância inválida: "${code}" (ex.: H7, g6)`);
  const [, letter, g] = m;
  const it = itValue(Number(g), d);
  const i = sizeStep(d);
  let upper: number, lower: number;
  if (letter === "js" || letter === "JS") { upper = it / 2; lower = -it / 2; }
  else if (letter === letter.toLowerCase()) {
    const f = SHAFT[letter];
    if (!f) throw new Error(`ISO 286: veio "${letter}" não tabelado (e, f, g, h, js, k, m, n, p)`);
    if ("efgh".includes(letter)) { upper = f[i]; lower = upper - it; }
    else {
      const ei = letter === "k" && (Number(g) > 7 || d <= 3) ? 0 : f[i];
      lower = ei; upper = ei + it;
    }
  } else {
    // furos E–H: EI = −es do veio da mesma letra (regra geral, ISO 286-1 §5.3)
    const f = SHAFT[letter.toLowerCase()];
    if (!f || !"EFGH".includes(letter)) throw new Error(`ISO 286: furo "${letter}" não tabelado (E, F, G, H, JS)`);
    lower = 0 - f[i]; upper = lower + it;
  }
  return { upper: upper / 1000, lower: lower / 1000 };
}

/** Ajustamento furo/veio: tipo e folgas limite (mm; negativas = aperto). */
export function fit(hole: string, shaft: string, d: number) {
  const H = fitDeviation(hole, d), S = fitDeviation(shaft, d);
  const maxClear = H.upper - S.lower, minClear = H.lower - S.upper;
  const type = minClear >= 0 ? "clearance" : maxClear <= 0 ? "interference" : "transition";
  return { hole: H, shaft: S, maxClearance: maxClear, minClearance: minClear, type } as const;
}

// ---------------------------------------------------------------------------
// Regras ISO 1101 / ISO 5459
// ---------------------------------------------------------------------------

/** Tipo geométrico das faces referidas (do núcleo): plane, cylinder, cone, sphere, torus, bspline, … */
export type FaceKinds = (ref: TopoRef) => string | null;

/** Erros de um item PMI (vazio = válido). `datums`: rótulos definidos na peça. */
export function checkPmi(item: PmiItem, datums: string[], kinds: FaceKinds): string[] {
  const e: string[] = [];
  const faces = item.kind === "datum" ? [item.face] : item.faces;
  if (!faces.length && item.kind !== "note") e.push("Escolha as faces");
  const k = faces.map(kinds);
  if (k.some((x) => x === null)) e.push("Face inexistente no modelo (o nome topológico mudou?)");
  switch (item.kind) {
    case "datum":
      if (!/^[A-Z]{1,2}$/.test(item.label)) e.push("Rótulo da referência: uma ou duas letras maiúsculas");
      else if (/[IOQ]/.test(item.label)) e.push("ISO 5459: as letras I, O e Q não se usam em referências");
      break;
    case "dimension": {
      const need = item.type === "distance" || item.type === "angle" ? [1, 2] : [1, 1];
      if (faces.length < need[0] || faces.length > need[1]) e.push(item.type === "distance" ? "Distância: duas faces planas paralelas (ou uma, com o valor fixado)" : item.type === "angle" ? "Ângulo: duas faces planas" : "Diâmetro/raio: uma face cilíndrica, cónica ou esférica");
      if ((item.type === "diameter" || item.type === "radius") && k[0] && !["cylinder", "sphere", "cone", "torus"].includes(k[0])) e.push(`${item.type === "diameter" ? "Diâmetro" : "Raio"} pede uma face de revolução (a face é ${k[0]})`);
      if ((item.type === "distance" || item.type === "angle") && k.some((x) => x && x !== "plane")) e.push("Distância e ângulo entre faces planas");
      if (item.tol?.kind === "deviation" && !(item.tol.upper > item.tol.lower)) e.push("O afastamento superior tem de ser maior que o inferior");
      if (item.tol?.kind === "fit" && item.type === "angle") e.push("Os ajustamentos ISO 286 são para dimensões lineares");
      break;
    }
    case "gdt": {
      const g = GDT[item.characteristic];
      if (!(item.value > 0)) e.push("Valor da tolerância tem de ser positivo");
      if (g.family === "form" && item.datums.length) e.push(`${g.label}: tolerância de forma, sem referências (ISO 1101)`);
      if ((g.family === "orientation" || g.family === "runout") && !item.datums.length) e.push(`${g.label}: precisa de pelo menos uma referência`);
      if ((item.characteristic === "concentricity" || item.characteristic === "symmetry") && !item.datums.length) e.push(`${g.label}: precisa de referência`);
      if (item.datums.length > 3) e.push("No máximo três referências (primária, secundária, terciária)");
      if (new Set(item.datums).size !== item.datums.length) e.push("Referências repetidas");
      for (const d of item.datums) if (!datums.includes(d)) e.push(`Referência "${d}" não definida na peça`);
      if (item.characteristic === "flatness" && k.some((x) => x && x !== "plane")) e.push("Planeza: só em faces planas");
      if ((item.characteristic === "cylindricity" || item.characteristic === "circularity") && k.some((x) => x && !["cylinder", "cone", "sphere", "torus"].includes(x))) e.push(`${g.label}: só em faces de revolução`);
      if (item.diameter && !["position", "concentricity", "straightness", "perpendicularity", "parallelism", "angularity"].includes(item.characteristic)) e.push(`${g.label}: a zona cilíndrica (⌀) não se aplica`);
      if (item.modifier && !["position", "straightness", "perpendicularity", "parallelism", "angularity", "symmetry"].includes(item.characteristic)) e.push(`${g.label}: os modificadores Ⓜ/Ⓛ aplicam-se a elementos de dimensão (localização, orientação, retitude do eixo)`);
      if (item.modifier && faces.length === 1 && k[0] === "plane") e.push("Ⓜ/Ⓛ pedem um elemento de dimensão (furo, veio, ranhura), não uma face plana isolada");
      break;
    }
    case "roughness":
      if (!(item.ra > 0)) e.push("Ra tem de ser positivo");
      break;
    case "note":
      if (!item.text.trim()) e.push("Nota vazia");
      break;
  }
  return e;
}

/** Texto curto do item (lista, rótulos no 3D, exportações). `nominal`: medido no modelo (mm ou graus). */
export function pmiText(item: PmiItem, nominal?: number): string {
  const n = (x: number) => (Math.abs(x) < 1e-9 ? "0" : String(+x.toFixed(4)).replace(".", ","));
  const sgn = (x: number) => (x > 0 ? `+${n(x)}` : n(x));
  switch (item.kind) {
    case "datum": return `[${item.label}]`;
    case "dimension": {
      const v = item.nominal ?? nominal;
      const pre = item.type === "diameter" ? "⌀" : item.type === "radius" ? "R" : "";
      const base = v === undefined ? `${pre}?` : `${pre}${n(v)}${item.type === "angle" ? "°" : ""}`;
      if (!item.tol) return base;
      if (item.tol.kind === "fit") {
        try {
          const t = v !== undefined ? fitDeviation(item.tol.code, item.type === "radius" ? 2 * v : v) : null;
          return `${base} ${item.tol.code}${t ? ` (${sgn(t.upper)}/${sgn(t.lower)})` : ""}`;
        } catch { return `${base} ${item.tol.code}`; }
      }
      return Math.abs(item.tol.upper + item.tol.lower) < 1e-12 ? `${base} ±${n(item.tol.upper)}` : `${base} ${sgn(item.tol.upper)}/${sgn(item.tol.lower)}`;
    }
    case "gdt": return `|${GDT[item.characteristic].symbol}|${item.diameter ? "⌀" : ""}${n(item.value)}${item.modifier ? (item.modifier === "M" ? "Ⓜ" : "Ⓛ") : ""}${item.datums.map((d) => `|${d}`).join("")}|`;
    case "roughness": return `${item.process === "remove" ? "▽" : item.process === "noremove" ? "◯▽" : "√"} Ra ${n(item.ra)}`;
    case "note": return item.text;
  }
}

/** Próximo rótulo livre de referência (A, B, …, saltando I, O, Q). */
export function nextDatumLabel(used: string[]): string {
  for (const c of "ABCDEFGHJKLMNPRSTUVWXYZ") if (!used.includes(c)) return c;
  return "AA";
}

// ---------------------------------------------------------------------------
// Atributos: pesquisa e exportação
// ---------------------------------------------------------------------------

export interface AttributeHit { doc: string; docName: string; target: string; key: string; value: string }

/** Pesquisa (sem distinguir maiúsculas nem acentos) em chaves e valores dos atributos de vários documentos. */
export function searchAttributes(docs: { id: string; name: string; attributes?: Attribute[] }[], query: string): AttributeHit[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(query.trim());
  const out: AttributeHit[] = [];
  for (const d of docs) for (const a of d.attributes ?? []) {
    if (q && !norm(`${a.key} ${a.value}`).includes(q) && !norm(d.name).includes(q)) continue;
    out.push({ doc: d.id, docName: d.name, target: targetLabel(a.target), key: a.key, value: a.value });
  }
  return out;
}

export const targetLabel = (t: Attribute["target"]) => (t.kind === "body" ? "Corpo" : t.kind === "feature" ? `Feature ${t.feature}` : `Face ${t.ref.name}`);

/** CSV (separador ";", UTF-8 com BOM para folhas de cálculo) de atributos encontrados. */
export function attributesCSV(hits: AttributeHit[]): string {
  const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return "﻿" + ["Documento;Alvo;Atributo;Valor", ...hits.map((h) => [h.docName, h.target, h.key, h.value].map(q).join(";"))].join("\n") + "\n";
}
