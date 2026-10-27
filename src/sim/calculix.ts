// Adaptador CalculiX (ccx): deck `.inp` (formato tipo Abaqus) a partir do caso e da malha Gmsh, e
// leitura dos resultados (`.frd` ASCII e `.dat`). Puro: corre na aplicação e no agente local.
//
// Unidades do deck: mm, N, MPa, t (tonelada), s. Massa volúmica g/cm³ → t/mm³ (× 1e-9); térmica:
// k em W/(m·K) = N/(s·K) (igual), h em W/(m²·K) → N/(mm·s·K) (× 1e-3), q em W/m² → N/(mm·s) (× 1e-3).
import type { FemCase } from "./case.ts";
import { type Msh, physicalBlocks } from "./msh.ts";

/** Faces de um tetraedro (cantos, base 0) pela numeração do CalculiX: F1 = 1-2-3, F2 = 1-4-2, F3 = 2-4-3, F4 = 3-4-1. */
const TET_FACES = [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]];
/** Gmsh tet10 → CalculiX C3D10: as arestas 2-4 e 3-4 vêm trocadas (nós 9 e 10). */
const TET10_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8];

export interface Deck {
  inp: string;
  /** Número de nós e de elementos de volume. */
  nodes: number;
  elements: number;
  /** Área de cada grupo de faces (mm²) medida na malha (para conferir com o CAD). */
  groupArea: Record<string, number>;
  warnings: string[];
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toPrecision(10).replace(/\.?0+(e|$)/, "$1"));
const key3 = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(",");

export function calculixDeck(c: FemCase, m: Msh): Deck {
  const warnings: string[] = [];
  const vol = physicalBlocks(m, "SOLID").filter((b) => b.type === 4 || b.type === 11);
  if (!vol.length) throw new Error("A malha não tem tetraedros no grupo SOLID");
  const quad = vol[0].type === 11;
  const per = quad ? 10 : 4;
  // elementos de volume (numeração sequencial) e mapa face → (elemento, n.º da face)
  const elems: number[][] = [];
  for (const b of vol) for (let k = 0; k < b.conn.length; k += per) {
    const e = b.conn.slice(k, k + per);
    elems.push(quad ? TET10_ORDER.map((i) => e[i]) : e);
  }
  const faceOf = new Map<string, [number, number]>();
  elems.forEach((e, i) => TET_FACES.forEach((f, j) => faceOf.set(key3(e[f[0]], e[f[1]], e[f[2]]), [i + 1, j + 1])));
  const used = new Set<number>();
  for (const e of elems) for (const n of e) used.add(n);

  // triângulos de fronteira de cada grupo (com área e nós para cargas consistentes)
  const tri = (name: string) => {
    const bl = physicalBlocks(m, name).filter((b) => b.type === 2 || b.type === 9);
    const out: { n: number[]; area: number; face?: [number, number] }[] = [];
    for (const b of bl) {
      const p = b.type === 9 ? 6 : 3;
      for (let k = 0; k < b.conn.length; k += p) {
        const n = b.conn.slice(k, k + p);
        const [A, B, C] = n.slice(0, 3).map((t) => m.nodes.get(t)!);
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        out.push({ n, area, face: faceOf.get(key3(n[0], n[1], n[2])) });
      }
    }
    return out;
  };
  const groupArea: Record<string, number> = {};
  const tris: Record<string, ReturnType<typeof tri>> = {};
  for (const name of Object.keys(c.groups)) {
    tris[name] = tri(name);
    groupArea[name] = tris[name].reduce((s, t) => s + t.area, 0);
    if (!tris[name].length) warnings.push(`O grupo ${name} não tem triângulos na malha`);
    if (tris[name].some((t) => !t.face)) warnings.push(`Grupo ${name}: triângulos sem face de elemento correspondente`);
  }

  const L: string[] = [];
  const thermal = c.analysis === "thermal";
  L.push("*HEADING", `${c.title} — gerado pelo CAD protótipo`);
  for (const h of c.hypotheses) L.push(`** ${h}`);
  L.push("** Unidades: mm, N, MPa, t, s");
  L.push("*NODE, NSET=NALL");
  for (const [t, p] of [...m.nodes].sort((a, b) => a[0] - b[0])) if (used.has(t)) L.push(`${t}, ${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])}`);
  L.push(`*ELEMENT, TYPE=${quad ? "C3D10" : "C3D4"}, ELSET=EALL`);
  elems.forEach((e, i) => {
    // o CalculiX aceita até 16 entradas por linha
    L.push(`${i + 1}, ${e.join(", ")}`);
  });
  for (const [name, list] of Object.entries(tris)) {
    const ns = [...new Set(list.flatMap((t) => t.n))].sort((a, b) => a - b);
    L.push(`*NSET, NSET=N_${name}`);
    for (let k = 0; k < ns.length; k += 12) L.push(ns.slice(k, k + 12).join(", ") + ",");
  }
  const mat = c.material;
  L.push("*MATERIAL, NAME=MAT", `** ${mat.name}${mat.source ? ` (${mat.source})` : ""}`);
  if (thermal) {
    L.push("*CONDUCTIVITY", fmt(mat.k ?? 50));
  } else {
    L.push("*ELASTIC", `${fmt(mat.E)}, ${fmt(mat.nu)}`, "*DENSITY", fmt(mat.density * 1e-9));
    if (mat.alpha) L.push("*EXPANSION", fmt(mat.alpha));
  }
  L.push("*SOLID SECTION, ELSET=EALL, MATERIAL=MAT");
  if (thermal) L.push("*INITIAL CONDITIONS, TYPE=TEMPERATURE", "NALL, 20.");

  const bcs: string[] = [], loads: string[] = [];
  const cload = new Map<number, [number, number, number]>();
  for (const ld of c.loads) {
    switch (ld.kind) {
      case "fixed": bcs.push(`N_${ld.group}, 1, 3`); break;
      case "displacement": ld.u.forEach((u, k) => { if (u !== null) bcs.push(`N_${ld.group}, ${k + 1}, ${k + 1}, ${fmt(u)}`); }); break;
      case "temperature": bcs.push(`N_${ld.group}, 11, 11, ${fmt(ld.t)}`); break;
      case "force": {
        // tração uniforme t = F/A → forças nodais consistentes (tri3: A/3 por canto; tri6: A/3 por nó intermédio)
        const A = groupArea[ld.group];
        if (!(A > 0)) { warnings.push(`Força no grupo ${ld.group} sem área`); break; }
        for (const t of tris[ld.group]) {
          const nodes = t.n.length === 6 ? t.n.slice(3) : t.n;
          for (const n of nodes) {
            const acc = cload.get(n) ?? [0, 0, 0];
            for (let k = 0; k < 3; k++) acc[k] += (ld.f[k] * t.area) / (3 * A);
            cload.set(n, acc);
          }
        }
        break;
      }
      case "pressure":
        loads.push("*DLOAD");
        for (const t of tris[ld.group]) if (t.face) loads.push(`${t.face[0]}, P${t.face[1]}, ${fmt(ld.p)}`);
        break;
      case "gravity": {
        const g = Math.hypot(...ld.g);
        if (g > 0) loads.push("*DLOAD", `EALL, GRAV, ${fmt(g)}, ${ld.g.map((x) => fmt(x / g)).join(", ")}`);
        break;
      }
      case "convection":
        loads.push("*FILM");
        for (const t of tris[ld.group]) if (t.face) loads.push(`${t.face[0]}, F${t.face[1]}, ${fmt(ld.tInf)}, ${fmt(ld.h * 1e-3)}`);
        break;
      case "heatFlux":
        loads.push("*DFLUX");
        for (const t of tris[ld.group]) if (t.face) loads.push(`${t.face[0]}, S${t.face[1]}, ${fmt(ld.q * 1e-3)}`);
        break;
    }
  }
  if (cload.size) {
    loads.push("*CLOAD");
    for (const [n, f] of cload) f.forEach((x, k) => { if (Math.abs(x) > 0) loads.push(`${n}, ${k + 1}, ${fmt(x)}`); });
  }

  L.push("*STEP");
  if (c.analysis === "static") L.push("*STATIC");
  else if (c.analysis === "modal") L.push("*FREQUENCY", String(c.modes));
  else if (c.analysis === "buckling") L.push("*BUCKLE", String(c.modes));
  else L.push("*HEAT TRANSFER, STEADY STATE");
  if (bcs.length) L.push("*BOUNDARY", ...bcs);
  if (c.analysis !== "modal") L.push(...loads);
  if (thermal) L.push("*NODE FILE", "NT");
  else {
    L.push("*NODE FILE", "U");
    if (c.analysis === "static") L.push("*EL FILE", "S");
    // reações nos apoios (verificação do equilíbrio)
    if (c.analysis === "static") for (const ld of c.loads) if (ld.kind === "fixed" || ld.kind === "displacement") L.push(`*NODE PRINT, NSET=N_${ld.group}, TOTALS=ONLY`, "RF");
  }
  L.push("*END STEP");
  if (c.analysis === "static" && !c.loads.some((l) => l.kind === "fixed" || l.kind === "displacement")) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
  return { inp: L.join("\n") + "\n", nodes: used.size, elements: elems.length, groupArea, warnings };
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

export interface FrdBlock {
  name: string;
  /** Valor do passo (tempo, frequência). */
  value: number;
  components: string[];
  data: Map<number, number[]>;
}

/** Lê um `.frd` ASCII: coordenadas dos nós e blocos de resultados nodais. */
export function parseFrd(text: string): { nodes: Map<number, [number, number, number]>; blocks: FrdBlock[] } {
  const lines = text.split(/\r?\n/);
  const nodes = new Map<number, [number, number, number]>();
  const blocks: FrdBlock[] = [];
  const vals = (l: string, n: number) => Array.from({ length: n }, (_, k) => Number(l.slice(13 + 12 * k, 25 + 12 * k)));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("    2C")) {
      for (i++; i < lines.length && !lines[i].startsWith(" -3"); i++) {
        const r = lines[i];
        if (r.startsWith(" -1")) { const v = vals(r, 3); nodes.set(Number(r.slice(3, 13)), [v[0], v[1], v[2]]); }
      }
    } else if (l.startsWith("  100C")) {
      const value = Number(l.slice(12, 24));
      let j = i + 1;
      const head = lines[j].trim().split(/\s+/);
      const name = head[1];
      const comps: string[] = [];
      for (j++; lines[j]?.startsWith(" -5"); j++) comps.push(lines[j].trim().split(/\s+/)[1]);
      const nv = comps.filter((x) => x !== "ALL").length;
      const data = new Map<number, number[]>();
      for (; j < lines.length && !lines[j].startsWith(" -3"); j++) {
        const r = lines[j];
        if (r.startsWith(" -1")) data.set(Number(r.slice(3, 13)), vals(r, nv));
      }
      blocks.push({ name, value, components: comps.filter((x) => x !== "ALL"), data });
      i = j;
    }
  }
  return { nodes, blocks };
}

/** Valores próprios do `.dat`: frequências (Hz) ou fatores de encurvadura; e reações totais. */
export function parseDat(text: string): { frequencies: number[]; buckling: number[]; reactions: [number, number, number][] } {
  const lines = text.split(/\r?\n/);
  const frequencies: number[] = [], buckling: number[] = [], reactions: [number, number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/E I G E N V A L U E\s+O U T P U T/.test(l)) {
      for (let j = i + 1; j < lines.length; j++) {
        const v = lines[j].trim().split(/\s+/).map(Number);
        if (v.length >= 4 && Number.isInteger(v[0]) && v.every((x) => Number.isFinite(x))) frequencies.push(v[3]);
        else if (frequencies.length && lines[j].trim() === "") break;
      }
    } else if (/B U C K L I N G\s+F A C T O R\s+O U T P U T/.test(l)) {
      for (let j = i + 1; j < lines.length; j++) {
        const v = lines[j].trim().split(/\s+/).map(Number);
        if (v.length === 2 && Number.isInteger(v[0]) && Number.isFinite(v[1])) buckling.push(v[1]);
        else if (buckling.length && lines[j].trim() === "") break;
      }
    } else if (/total force/.test(l)) {
      const v = lines[i + 2]?.trim().split(/\s+/).map(Number);
      if (v && v.length >= 3 && v.every(Number.isFinite)) reactions.push([v[0], v[1], v[2]]);
    }
  }
  return { frequencies, buckling, reactions };
}

export interface FemResult {
  analysis: FemCase["analysis"];
  /** Superfície exterior da malha (cantos dos tetraedros) para o visualizador, em mm. */
  positions: number[];
  triangles: number[];
  /** Campos nodais na superfície. */
  fields: { name: string; unit: string; values: number[] }[];
  /** Deslocamento por nó da superfície (mm), por modo nos modais. */
  displacements: { label: string; values: number[] }[];
  frequencies: number[];
  buckling: number[];
  reactions: [number, number, number][];
  summary: [string, string][];
  hypotheses: string[];
}

/** Junta a malha e os resultados num formato leve para o visualizador e para o relatório. */
export function femResult(c: FemCase, m: Msh, frd: string, dat: string): FemResult {
  const r = parseFrd(frd);
  const d = parseDat(dat);
  // superfície exterior: faces de tetraedro usadas uma só vez
  const vol = physicalBlocks(m, "SOLID").filter((b) => b.type === 4 || b.type === 11);
  const count = new Map<string, { n: number[]; k: number }>();
  for (const b of vol) {
    const per = b.type === 11 ? 10 : 4;
    for (let k = 0; k < b.conn.length; k += per) {
      const e = b.conn.slice(k, k + 4);
      for (const f of TET_FACES) {
        const tri = [e[f[0]], e[f[2]], e[f[1]]]; // normal para fora
        const key = key3(tri[0], tri[1], tri[2]);
        const x = count.get(key);
        if (x) x.k++; else count.set(key, { n: tri, k: 1 });
      }
    }
  }
  const index = new Map<number, number>();
  const positions: number[] = [], triangles: number[] = [];
  for (const { n, k } of count.values()) {
    if (k !== 1) continue;
    for (const t of n) {
      if (!index.has(t)) { index.set(t, index.size); positions.push(...m.nodes.get(t)!); }
      triangles.push(index.get(t)!);
    }
  }
  const order = [...index.keys()];
  const field = (b: FrdBlock | undefined, f: (v: number[]) => number) => order.map((t) => { const v = b?.data.get(t); return v ? f(v) : 0; });
  const fields: FemResult["fields"] = [];
  const displacements: FemResult["displacements"] = [];
  const disp = r.blocks.filter((b) => b.name === "DISP");
  const summary: [string, string][] = [];
  const max = (a: number[]) => a.reduce((x, y) => Math.max(x, y), 0);
  if (c.analysis === "thermal") {
    const t = r.blocks.find((b) => b.name === "NDTEMP");
    const T = field(t, (v) => v[0]);
    fields.push({ name: "Temperatura", unit: "°C", values: T });
    summary.push(["Temperatura mín.", `${Math.min(...T).toFixed(2)} °C`], ["Temperatura máx.", `${Math.max(...T).toFixed(2)} °C`]);
  } else {
    disp.forEach((b, k) => {
      const vals = order.flatMap((t) => b.data.get(t)?.slice(0, 3) ?? [0, 0, 0]);
      const label = c.analysis === "modal" ? `Modo ${k + 1}${d.frequencies[k] !== undefined ? ` — ${d.frequencies[k].toFixed(2)} Hz` : ""}`
        : c.analysis === "buckling" ? `Modo ${k + 1}${d.buckling[k] !== undefined ? ` — fator ${d.buckling[k].toFixed(3)}` : ""}` : "Deformada";
      displacements.push({ label, values: vals });
    });
    if (c.analysis === "static" && disp[0]) {
      const U = field(disp[0], (v) => Math.hypot(v[0], v[1], v[2]));
      fields.push({ name: "Deslocamento", unit: "mm", values: U });
      const s = r.blocks.find((b) => b.name === "STRESS");
      if (s) {
        const vm = field(s, (v) => Math.sqrt(0.5 * ((v[0] - v[1]) ** 2 + (v[1] - v[2]) ** 2 + (v[2] - v[0]) ** 2) + 3 * (v[3] ** 2 + v[4] ** 2 + v[5] ** 2)));
        fields.push({ name: "Tensão de von Mises", unit: "MPa", values: vm });
        summary.push(["Tensão de von Mises máx.", `${max(vm).toFixed(2)} MPa`]);
        if (c.material.yield) summary.push(["Fator de segurança mín. (cedência)", (c.material.yield / Math.max(max(vm), 1e-12)).toFixed(2)]);
      }
      summary.unshift(["Deslocamento máx.", `${max(U).toFixed(4)} mm`]);
    }
    if (c.analysis === "modal") d.frequencies.slice(0, c.modes).forEach((f, k) => summary.push([`Frequência ${k + 1}`, `${f.toFixed(2)} Hz`]));
    if (c.analysis === "buckling") d.buckling.forEach((f, k) => summary.push([`Fator de encurvadura ${k + 1}`, f.toFixed(3)]));
  }
  if (d.reactions.length) {
    const R = d.reactions.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as [number, number, number], [0, 0, 0] as [number, number, number]);
    summary.push(["Reações totais (N)", R.map((x) => x.toFixed(2)).join(" · ")]);
  }
  return { analysis: c.analysis, positions, triangles, fields, displacements, frequencies: d.frequencies, buckling: d.buckling, reactions: d.reactions, summary, hypotheses: c.hypotheses };
}
