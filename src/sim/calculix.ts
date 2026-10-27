// Adaptador CalculiX (ccx): deck `.inp` (formato tipo Abaqus) a partir do caso e da malha Gmsh, e
// leitura dos resultados (`.frd` ASCII e `.dat`). Puro: corre na aplicação e no agente local.
//
// Unidades do deck: mm, N, MPa, t (tonelada), s. Massa volúmica g/cm³ → t/mm³ (× 1e-9); térmica:
// k em W/(m·K) = N/(s·K) (igual), h em W/(m²·K) → N/(mm·s·K) (× 1e-3), q em W/m² → N/(mm·s) (× 1e-3).
import type { FemCase } from "./case.ts";
import { type Msh, physicalBlocks, solidBlocks } from "./msh.ts";
import type { Metric } from "./convergence.ts";

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
  /**
   * Cargas aplicadas diretamente nos graus de liberdade restringidos (N), com a carga total: o RF do
   * CalculiX é a força interna, e a reação verdadeira é RF − esta parcela (f_int = f_ext + R).
   */
  supportLoad: [number, number, number];
  warnings: string[];
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toPrecision(10).replace(/\.?0+(e|$)/, "$1"));
const key3 = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(",");

export function calculixDeck(c: FemCase, m: Msh): Deck {
  const warnings: string[] = [];
  const groupsOfBodies = c.bodies?.length ? c.bodies.map((b) => b.group) : ["SOLID"];
  const vol = solidBlocks(m, c.bodies);
  if (!vol.length) throw new Error(`A malha não tem tetraedros nos grupos ${groupsOfBodies.join(", ")}`);
  const quad = vol[0].type === 11;
  const per = quad ? 10 : 4;
  // elementos de volume (numeração sequencial, corpo a corpo) e mapa face → (elemento, n.º da face)
  const elems: number[][] = [];
  const bodyRange: [number, number][] = [];
  for (const g of groupsOfBodies) {
    const first = elems.length + 1;
    for (const b of physicalBlocks(m, g).filter((x) => x.type === 4 || x.type === 11)) for (let k = 0; k < b.conn.length; k += per) {
      const e = b.conn.slice(k, k + per);
      elems.push(quad ? TET10_ORDER.map((i) => e[i]) : e);
    }
    if (elems.length < first) throw new Error(`O corpo ${g} não tem elementos na malha`);
    bodyRange.push([first, elems.length]);
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
  // reações: um conjunto por grau de liberdade com os apoios que o restringem (nos graus livres o RF
  // de um nó é a carga aplicada nele, que não é reação)
  const dofSets = [0, 1, 2].map((k) => c.loads.flatMap((ld) => (ld.kind === "fixed" || (ld.kind === "displacement" && ld.u[k] !== null) ? [`N_${ld.group}`] : [])));
  if (!thermal) dofSets.forEach((sets, k) => { if (sets.length) L.push(`*NSET, NSET=N_R${"XYZ"[k]}`, ...sets.map((x) => `${x},`)); });
  const material = (name: string, mat: FemCase["material"]) => {
    L.push(`*MATERIAL, NAME=${name}`, `** ${mat.name}${mat.source ? ` (${mat.source})` : ""}`);
    if (thermal) {
      L.push("*CONDUCTIVITY", fmt(mat.k ?? 50));
      return;
    }
    L.push("*ELASTIC", `${fmt(mat.E)}, ${fmt(mat.nu)}`, "*DENSITY", fmt(mat.density * 1e-9));
    if (mat.alpha) L.push("*EXPANSION", fmt(mat.alpha));
    if (c.nonlinear?.plasticity) {
      if (!(mat.yield! > 0)) throw new Error(`Plasticidade: o material ${mat.name} não tem tensão de cedência`);
      // bilinear: σ = σy + Hp·εp, com o módulo plástico Hp = E·Et/(E − Et) (Et = módulo tangente)
      const Et = mat.tangent ?? 0, Hp = (mat.E * Et) / (mat.E - Et);
      L.push("*PLASTIC", `${fmt(mat.yield!)}, 0.`, `${fmt(mat.yield! + Hp)}, 1.`);
    }
  };
  if (c.bodies?.length) {
    // um conjunto de elementos e um material por corpo da montagem
    c.bodies.forEach((b, k) => {
      L.push(`*ELSET, ELSET=${b.group}, GENERATE`, `${bodyRange[k][0]}, ${bodyRange[k][1]}, 1`);
      material(`MAT_${b.group}`, b.material);
      L.push(`*SOLID SECTION, ELSET=${b.group}, MATERIAL=MAT_${b.group}`);
    });
  } else {
    material("MAT", c.material);
    L.push("*SOLID SECTION, ELSET=EALL, MATERIAL=MAT");
  }
  // contacto colado: nós da face escrava presos (por MPC) às faces dos elementos da face mestra
  for (const t of c.ties ?? []) {
    const master = tris[t.master].filter((x) => x.face);
    if (!tris[t.slave]?.length || !master.length) { warnings.push(`Contacto ${t.name}: faces sem malha`); continue; }
    L.push(`*SURFACE, NAME=S_${t.slave}, TYPE=NODE`, `N_${t.slave}`);
    L.push(`*SURFACE, NAME=S_${t.master}, TYPE=ELEMENT`, ...master.map((x) => `${x.face![0]}, S${x.face![1]}`));
    L.push(`*TIE, NAME=${t.name}, POSITION TOLERANCE=${fmt(t.tolerance)}`, `S_${t.slave}, S_${t.master}`);
  }
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
  // parcela das cargas que cai nos nós dos apoios (CLOAD e pressão consistente; a gravidade nesses
  // nós, uma fração mínima da massa, não entra)
  const dofNodes = dofSets.map((sets) => new Set(sets.flatMap((n) => tris[n.slice(2)]?.flatMap((t) => t.n) ?? [])));
  const supportLoad: [number, number, number] = [0, 0, 0];
  for (const [n, f] of cload) for (let k = 0; k < 3; k++) if (dofNodes[k].has(n)) supportLoad[k] += f[k];
  for (const ld of c.loads) {
    if (ld.kind !== "pressure") continue;
    for (const t of tris[ld.group]) {
      if (!t.face) continue;
      const [A, B, C] = t.n.slice(0, 3).map((x) => m.nodes.get(x)!);
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      // normal para fora do elemento (afastada do canto oposto)
      const e = elems[t.face[0] - 1].slice(0, 4).map((x) => m.nodes.get(x)!);
      const ce = [0, 1, 2].map((q) => (e[0][q] + e[1][q] + e[2][q] + e[3][q]) / 4);
      const sgn = Math.sign(nrm[0] * (A[0] - ce[0]) + nrm[1] * (A[1] - ce[1]) + nrm[2] * (A[2] - ce[2])) || 1;
      const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
      const nodes = t.n.length === 6 ? t.n.slice(3) : t.n;
      for (const nd of nodes) for (let k = 0; k < 3; k++) if (dofNodes[k].has(nd)) supportLoad[k] += (-ld.p * sgn * nrm[k] / len) * (t.area / 3);
    }
  }
  if (cload.size) {
    loads.push("*CLOAD");
    for (const [n, f] of cload) f.forEach((x, k) => { if (Math.abs(x) > 0) loads.push(`${n}, ${k + 1}, ${fmt(x)}`); });
  }

  const nl = c.analysis === "static" ? c.nonlinear : undefined;
  if (nl) {
    const inc = 1 / nl.increments;
    L.push(`*STEP${nl.geometry ? ", NLGEOM" : ""}, INC=${Math.max(100, 20 * nl.increments)}`, "*STATIC", `${fmt(inc)}, 1., ${fmt(inc * 1e-4)}, ${fmt(inc)}`);
  } else if (c.analysis === "static") L.push("*STEP", "*STATIC");
  else if (c.analysis === "modal") L.push("*STEP", "*FREQUENCY", String(c.modes));
  else if (c.analysis === "buckling") L.push("*STEP", "*BUCKLE", String(c.modes));
  else L.push("*STEP", "*HEAT TRANSFER, STEADY STATE");
  if (bcs.length) L.push("*BOUNDARY", ...bcs);
  if (c.analysis !== "modal") L.push(...loads);
  if (thermal) L.push("*NODE FILE", "NT");
  else {
    L.push("*NODE FILE", "U");
    if (c.analysis === "static") L.push("*EL FILE", nl?.plasticity ? "S, PEEQ" : "S");
    // reações nos apoios (verificação do equilíbrio)
    if (c.analysis === "static") dofSets.forEach((sets, k) => { if (sets.length) L.push(`*NODE PRINT, NSET=N_R${"XYZ"[k]}, TOTALS=ONLY`, "RF"); });
  }
  L.push("*END STEP");
  if (c.analysis === "static" && !c.loads.some((l) => l.kind === "fixed" || l.kind === "displacement")) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
  return { inp: L.join("\n") + "\n", nodes: used.size, elements: elems.length, groupArea, supportLoad, warnings };
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

/**
 * Valores próprios do `.dat`: frequências (Hz) ou fatores de encurvadura; reações totais de cada
 * conjunto no último tempo e, nas análises incrementais, a soma das reações em cada tempo.
 */
export function parseDat(text: string): { frequencies: number[]; buckling: number[]; reactions: [number, number, number][]; reactionHistory: { time: number; f: [number, number, number] }[] } {
  const lines = text.split(/\r?\n/);
  const frequencies: number[] = [], buckling: number[] = [];
  const sets = new Map<string, Map<number, [number, number, number]>>();
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
      if (!v || v.length < 3 || !v.every(Number.isFinite)) continue;
      const m = /for set (\S+) and time\s+(\S+)/.exec(l);
      const set = (m?.[1] ?? `#${sets.size}`).toUpperCase(), t = Number(m?.[2] ?? 1);
      if (!sets.has(set)) sets.set(set, new Map());
      sets.get(set)!.set(t, [v[0], v[1], v[2]]);
    }
  }
  // componente k da reação: do conjunto N_RX/N_RY/N_RZ (decks deste módulo) ou, noutros decks, a soma dos conjuntos
  const times = [...new Set([...sets.values()].flatMap((x) => [...x.keys()]))].sort((a, b) => a - b);
  const perDof = ["N_RX", "N_RY", "N_RZ"].map((n) => sets.get(n));
  const reactionHistory = times.map((time) => {
    const f: [number, number, number] = [0, 0, 0];
    if (perDof.some(Boolean)) perDof.forEach((st, k) => { f[k] = st?.get(time)?.[k] ?? 0; });
    else for (const st of sets.values()) { const v = st.get(time); if (v) for (let k = 0; k < 3; k++) f[k] += v[k]; }
    return { time, f };
  });
  return { frequencies, buckling, reactions: reactionHistory.length ? [reactionHistory.at(-1)!.f] : [], reactionHistory };
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
  /** Grandezas escalares (para a convergência da malha e comparações). */
  metrics: Metric[];
  /** Estática não linear: por incremento, fração da carga, deslocamento máx. (mm) e reação total (N). */
  history: { time: number; umax: number; reaction: [number, number, number] | null }[];
  hypotheses: string[];
}

/** Junta a malha e os resultados num formato leve para o visualizador e para o relatório. */
export function femResult(c: FemCase, m: Msh, frd: string, dat: string, supportLoad: [number, number, number] = [0, 0, 0]): FemResult {
  const d = parseDat(dat);
  // reação = força interna (RF) − carga aplicada nos graus restringidos (proporcional ao tempo nos incrementais)
  for (const h of d.reactionHistory) for (let k = 0; k < 3; k++) h.f[k] -= supportLoad[k] * h.time;
  if (d.reactionHistory.length) d.reactions = [d.reactionHistory.at(-1)!.f];
  return femResultFrom(c, m, parseFrd(frd).blocks, d);
}

/**
 * Resultado a partir de blocos nodais (DISP, STRESS ou VMIS, PE, NDTEMP — o formato do `.frd`) e dos
 * valores do solver (frequências, fatores, reações): comum ao CalculiX e ao code_aster.
 */
export function femResultFrom(c: FemCase, m: Msh, blocks: FrdBlock[], d: ReturnType<typeof parseDat>): FemResult {
  const r = { blocks };
  // superfície exterior: faces de tetraedro usadas uma só vez
  const vol = solidBlocks(m, c.bodies);
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
  const allDisp = r.blocks.filter((b) => b.name === "DISP");
  // estática (incremental ou não): só o último incremento; modal/encurvadura: um bloco por modo
  const incremental = c.analysis === "static";
  const disp = incremental ? allDisp.slice(-1) : allDisp;
  const lastOf = (name: string) => r.blocks.filter((b) => b.name === name).at(-1);
  const summary: [string, string][] = [];
  const metrics: Metric[] = [];
  const max = (a: number[]) => a.reduce((x, y) => Math.max(x, y), 0);
  if (c.analysis === "thermal") {
    const t = r.blocks.find((b) => b.name === "NDTEMP");
    const T = field(t, (v) => v[0]);
    fields.push({ name: "Temperatura", unit: "°C", values: T });
    const lo = T.reduce((a, b) => Math.min(a, b), Infinity), hi = T.reduce((a, b) => Math.max(a, b), -Infinity);
    summary.push(["Temperatura mín.", `${lo.toFixed(2)} °C`], ["Temperatura máx.", `${hi.toFixed(2)} °C`]);
    metrics.push({ key: "tmin", label: "Temperatura mín.", unit: "°C", value: lo }, { key: "tmax", label: "Temperatura máx.", unit: "°C", value: hi });
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
      const s = lastOf("STRESS"), sv = lastOf("VMIS");
      if (s || sv) {
        const vm = sv ? field(sv, (v) => v[0]) : field(s, (v) => Math.sqrt(0.5 * ((v[0] - v[1]) ** 2 + (v[1] - v[2]) ** 2 + (v[2] - v[0]) ** 2) + 3 * (v[3] ** 2 + v[4] ** 2 + v[5] ** 2)));
        fields.push({ name: "Tensão de von Mises", unit: "MPa", values: vm });
        summary.push(["Tensão de von Mises máx.", `${max(vm).toFixed(2)} MPa`]);
        metrics.push({ key: "vmmax", label: "Tensão de von Mises máx.", unit: "MPa", value: max(vm) });
        if (c.material.yield && !c.nonlinear?.plasticity) summary.push(["Fator de segurança mín. (cedência)", (c.material.yield / Math.max(max(vm), 1e-12)).toFixed(2)]);
      }
      const pe = lastOf("PE");
      if (pe) {
        const peeq = field(pe, (v) => v[0]);
        fields.push({ name: "Deformação plástica equivalente", unit: "—", values: peeq });
        summary.push(["Deformação plástica equiv. máx.", `${(100 * max(peeq)).toFixed(3)} %`]);
        metrics.push({ key: "peeq", label: "Deformação plástica equiv. máx.", unit: "", value: max(peeq) });
        if (max(peeq) > 0) summary.push(["Zona plastificada", "sim — ver o campo da deformação plástica"]);
      }
      summary.unshift(["Deslocamento máx.", `${max(U).toFixed(4)} mm`]);
      metrics.unshift({ key: "umax", label: "Deslocamento máx.", unit: "mm", value: max(U) });
    }
    if (c.analysis === "modal") d.frequencies.slice(0, c.modes).forEach((f, k) => { summary.push([`Frequência ${k + 1}`, `${f.toFixed(2)} Hz`]); metrics.push({ key: `f${k + 1}`, label: `Frequência ${k + 1}`, unit: "Hz", value: f }); });
    if (c.analysis === "buckling") d.buckling.forEach((f, k) => { summary.push([`Fator de encurvadura ${k + 1}`, f.toFixed(3)]); metrics.push({ key: `lambda${k + 1}`, label: `Fator de encurvadura ${k + 1}`, unit: "", value: f }); });
  }
  // sondas: média por área nas faces (nós dos triângulos do grupo) ou nó mais próximo de um ponto
  if (c.probes?.length && (c.analysis === "static" || c.analysis === "thermal")) {
    const dispB = lastOf("DISP"), stB = lastOf("STRESS"), vmB = lastOf("VMIS"), tB = lastOf("NDTEMP");
    const value = (t: number, q: string): number | undefined => {
      if (q === "T") return tB?.data.get(t)?.[0];
      if (q === "vm") {
        const v = vmB?.data.get(t);
        if (v) return v[0];
        const sv = stB?.data.get(t);
        return sv && Math.sqrt(0.5 * ((sv[0] - sv[1]) ** 2 + (sv[1] - sv[2]) ** 2 + (sv[2] - sv[0]) ** 2) + 3 * (sv[3] ** 2 + sv[4] ** 2 + sv[5] ** 2));
      }
      const u = dispB?.data.get(t);
      if (!u) return undefined;
      return q === "u" ? Math.hypot(u[0], u[1], u[2]) : u["xyz".indexOf(q[1])];
    };
    const UNIT: Record<string, string> = { u: "mm", ux: "mm", uy: "mm", uz: "mm", vm: "MPa", T: "°C" };
    for (const pr of c.probes) {
      let v: number | undefined, where = "";
      if (pr.group) {
        let sa = 0, sv = 0, mx = -Infinity;
        for (const b of physicalBlocks(m, pr.group).filter((x) => x.type === 2 || x.type === 9)) {
          const per = b.type === 9 ? 6 : 3;
          for (let k = 0; k < b.conn.length; k += per) {
            const n = b.conn.slice(k, k + 3);
            const [A, B, C] = n.map((t) => m.nodes.get(t)!);
            const u1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], u2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
            const ar = 0.5 * Math.hypot(u1[1] * u2[2] - u1[2] * u2[1], u1[2] * u2[0] - u1[0] * u2[2], u1[0] * u2[1] - u1[1] * u2[0]);
            const vals = n.map((t) => value(t, pr.quantity));
            if (vals.some((x) => x === undefined)) continue;
            sa += ar; sv += (ar * (vals as number[]).reduce((a, b2) => a + b2, 0)) / 3;
            for (const x of vals as number[]) if (Math.abs(x) > Math.abs(mx) || mx === -Infinity) mx = x;
          }
        }
        if (sa > 0) { v = pr.stat === "max" ? mx : sv / sa; where = pr.stat === "max" ? "máximo nos nós da face" : "média na face"; }
      } else if (pr.point) {
        let best = Infinity, tag = -1;
        for (const t of dispB?.data.keys() ?? tB?.data.keys() ?? []) {
          const p = m.nodes.get(t);
          if (!p) continue;
          const d = Math.hypot(p[0] - pr.point[0], p[1] - pr.point[1], p[2] - pr.point[2]);
          if (d < best) { best = d; tag = t; }
        }
        if (tag >= 0) { v = value(tag, pr.quantity); where = `nó a ${best.toFixed(2)} mm do ponto`; }
      }
      if (v === undefined) continue;
      metrics.push({ key: pr.key, label: pr.name, unit: UNIT[pr.quantity], value: v });
      summary.push([`Sonda: ${pr.name}`, `${v.toPrecision(5)} ${UNIT[pr.quantity]} (${where})`]);
    }
  }
  const history: FemResult["history"] = c.nonlinear && incremental ? allDisp.map((b) => ({
    time: b.value,
    umax: [...b.data.values()].reduce((m, v) => Math.max(m, Math.hypot(v[0], v[1], v[2])), 0),
    // o .frd escreve o tempo com 6 algarismos e o .dat com 7
    reaction: d.reactionHistory.find((h) => Math.abs(h.time - b.value) < 1e-5 * Math.max(1, Math.abs(b.value)))?.f ?? null,
  })) : [];
  if (history.length) summary.push(["Incrementos", `${history.length} (até ${(100 * history.at(-1)!.time).toFixed(0)} % da carga)`]);
  if (c.nonlinear && history.length && history.at(-1)!.time < 1 - 1e-6) summary.push(["Aviso", "O cálculo parou antes de aplicar toda a carga"]);
  if (d.reactions.length) {
    const R = d.reactions.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as [number, number, number], [0, 0, 0] as [number, number, number]);
    summary.push(["Reações totais (N)", R.map((x) => x.toFixed(2)).join(" · ")]);
  }
  return { analysis: c.analysis, positions, triangles, fields, displacements, frequencies: d.frequencies, buckling: d.buckling, reactions: d.reactions, summary, metrics, history, hypotheses: c.hypotheses };
}
