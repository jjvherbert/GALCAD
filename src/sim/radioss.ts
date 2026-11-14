// Adaptador OpenRadioss (OpenCourant, continuação aberta do OpenRadioss; AGPL-3.0): dinâmica explícita
// de impacto e choque com os sólidos lineares da malha Gmsh. Escreve o Starter (`galcad_0000.rad`,
// formato bloco 2019: colunas de 10/20 carateres) e o Engine (`galcad_0001.rad`), e lê as animações
// convertidas pelo `anim_to_vtk` (VTK ASCII). Puro: corre na aplicação e no agente local.
//
// Unidades do deck: kg, mm, ms → força kN, tensão GPa, energia J. Conversões a partir do caso
// (mm, N, MPa, t, s): E/1000, ρ (g/cm³)·1e-6, F/1000, t·1000, g (mm/s²)·1e-6.
// Elementos: /BRICK (hexaedro de 8 nós, Isolid = 24: integração reduzida com estabilização física
// do hourglass, a formulação recomendada para flexão) e /TETRA4. Carga: forças nodais consistentes
// (as das faces, como no CalculiX) por /CLOAD com a amplitude em /FUNCT; apoios por /BCS e deslocamentos
// impostos não nulos por /IMPDISP (com a mesma amplitude);
// gravidade por /GRAV; Rayleigh por /DAMP. Plasticidade (encruamento isotrópico, von Mises):
// bilinear por /MAT/PLAS_JOHNS (LAW2, σ = a + b·εp) e curva multilinear por /MAT/PLAS_TAB (LAW36)
// com a curva σ(εp) em /FUNCT; a deformação plástica equivalente vem da animação EPSP.
import { type FemCase } from "./case.ts";
import { type Msh, elementsOf, faceBlocks, solidBlocks } from "./msh.ts";
import { SOLIDS, faceIntegrals } from "./elements.ts";
import type { FrdBlock } from "./calculix.ts";

export interface RadiossFiles { starter: string; engine: string; name: string; warnings: string[]; nodes: number; elements: number }

const I = (x: number) => String(Math.round(x)).padStart(10);
const F = (x: number) => {
  const s = Number.isInteger(x) && Math.abs(x) < 1e15 ? String(x) : x.toPrecision(12).replace(/\.?0+(e|$)/, "$1");
  return s.padStart(20);
};
const title = (s: string) => s.replace(/[^\x20-\x7e]/g, "_").slice(0, 80);
/** Lista de tags em linhas de 10 inteiros (formato de /GRNOD/NODE). */
const ids = (list: number[]) => { const out: string[] = []; for (let k = 0; k < list.length; k += 10) out.push(list.slice(k, k + 10).map(I).join("")); return out; };

export function radiossDeck(c: FemCase, m: Msh): RadiossFiles {
  if (c.analysis !== "dynamic" || c.dynamic?.scheme !== "explicit") throw new Error("OpenRadioss: só dinâmica explícita (escolha «Dinâmica transitória» e «Explícita»)");
  if (Object.keys(c.edgeGroups ?? {}).length) throw new Error("OpenRadioss: condições em arestas ainda não estão neste adaptador (escolha faces)");
  const warnings: string[] = [];
  const D = c.dynamic;
  const name = "galcad";
  const S: string[] = ["#RADIOSS STARTER", `# ${title(c.title)} — gerado pelo GALCAD (unidades: kg, mm, ms; força kN, tensão GPa)`];
  for (const h of c.hypotheses) S.push(`# ${title(h)}`);
  S.push("/BEGIN", name, `${I(2019)}${I(0)}`, `${"kg".padStart(20)}${"mm".padStart(20)}${"ms".padStart(20)}`, `${"kg".padStart(20)}${"mm".padStart(20)}${"ms".padStart(20)}`);
  S.push("/TITLE", title(c.title));

  // material (um por corpo) e propriedades por tipo de elemento
  const bodies = c.bodies?.length ? c.bodies.map((b) => ({ group: b.group, mat: b.material })) : [{ group: "SOLID", mat: c.material }];
  const plastic = !!c.nonlinear?.plasticity;
  const curves: string[] = [];
  bodies.forEach((b, k) => {
    const m = b.mat, rho = `${F(m.density * 1e-6)}${F(0)}`;
    if (!plastic) {
      S.push(`/MAT/ELAST/${k + 1}`, title(m.name), "#        Init. dens.          Ref. dens.", rho, "#                  E                  nu", `${F(m.E / 1000)}${F(m.nu)}`);
      return;
    }
    if (!(m.yield! > 0)) throw new Error(`Plasticidade: o material ${m.name} não tem tensão de cedência`);
    if (m.plasticCurve?.length) {
      // LAW36: σ(εp) tabelada (GPa); depois do último ponto, plástico perfeito (como no CalculiX)
      const fid = 100 + k, pts = m.plasticCurve.map(([sg, ep]) => [ep, sg / 1000]);
      const last = pts.at(-1)!;
      pts.push([Math.max(10, last[0] * 10 + 1), last[1]]);
      S.push(`/MAT/PLAS_TAB/${k + 1}`, title(m.name), "#        Init. dens.          Ref. dens.", rho,
        "#                  E                  Nu           Eps_p_max               Eps_t               Eps_m", `${F(m.E / 1000)}${F(m.nu)}${F(0)}${F(0)}${F(0)}`,
        "#  N_funct  F_smooth              C_hard               F_cut               Eps_f        VP", `${I(1)}${I(0)}${F(0)}${F(0)}${F(0)}${I(0)}`,
        "#  fct_IDp              Fscale   Fct_IDE                Einf                  CE", `${I(0)}${F(0)}${I(0)}${F(0)}${F(0)}`,
        "#  fct_ID1", I(fid), "#            Fscale1", F(1), "#           EPS_dot1", F(0));
      curves.push(`/FUNCT/${fid}`, `curva plastica ${title(m.name)}`.slice(0, 80), "#                  X                   Y", ...pts.map(([x, y]) => `${F(x)}${F(y)}`));
      return;
    }
    // LAW2 (Johnson-Cook sem taxa nem temperatura): σ = a + b·εp^n com n = 1, b = Hp = E·Et/(E − Et)
    const Et = m.tangent ?? 0, Hp = (m.E * Et) / (m.E - Et);
    S.push(`/MAT/PLAS_JOHNS/${k + 1}`, title(m.name), "#        Init. dens.          Ref. dens.", rho,
      "#                  E                  nu     Iflag", `${F(m.E / 1000)}${F(m.nu)}${I(0)}`,
      "#                  a                   b                   n           EPS_p_max            SIG_max0", `${F(m.yield! / 1000)}${F(Hp / 1000)}${F(1)}${F(0)}${F(0)}`,
      "#                  c           EPS_DOT_0       ICC   Fsmooth               F_cut               Chard", `${F(0)}${F(0)}${I(0)}${I(0)}${F(0)}${F(0)}`,
      "#                  m              T_melt              rhoC_p                 T_r", `${F(0)}${F(0)}${F(0)}${F(0)}`);
  });
  S.push(...curves);
  // /PROP/SOLID: 1 = hexaedros (Isolid 24), 2 = tetraedros (formulação por omissão)
  const prop = (id: number, label: string, isolid: number) => S.push(
    `/PROP/SOLID/${id}`, label,
    "#   Isolid    Ismstr               Icpre               Inpts    Itetra    Iframe                  dn",
    `${I(isolid)}${I(0)}${" ".repeat(10)}${I(isolid === 24 ? 1 : 0)}${" ".repeat(10)}${I(0)}${I(0)}${I(0)}${F(0)}`,
    "#                q_a                 q_b                   h            LAMBDA_V                MU_V",
    `${F(0)}${F(0)}${F(0)}${F(0)}${F(0)}`,
    "#             dt_min   istrain      IHKT",
    `${F(0)}${I(0)}${I(0)}`,
  );
  prop(1, "hexaedros (Isolid 24)", 24);
  prop(2, "tetraedros", 0);

  // nós usados e elementos por corpo e tipo (uma parte por corpo e tipo)
  const used = new Set<number>();
  const parts: { id: number; kind: "hex" | "tet"; body: number; els: number[][] }[] = [];
  let elements = 0;
  bodies.forEach((b, k) => {
    const hex: number[][] = [], tet: number[][] = [];
    for (const e of elementsOf(solidBlocks(m, [{ group: b.group }]))) {
      const st = SOLIDS[e.type];
      if (st.order !== 1) throw new Error("OpenRadioss: use elementos lineares (hexaedros de 8 nós ou tetraedros de 4) — os quadráticos não são próprios do explícito");
      (st.kind === "hex" ? hex : tet).push(e.nodes);
      e.nodes.forEach((n) => used.add(n));
    }
    if (hex.length) parts.push({ id: 10 * (k + 1) + 1, kind: "hex", body: k, els: hex });
    if (tet.length) parts.push({ id: 10 * (k + 1) + 2, kind: "tet", body: k, els: tet });
  });
  if (!parts.length) throw new Error("A malha não tem elementos de volume");
  const nodeIds = [...used].sort((a, b) => a - b);
  S.push("/NODE");
  for (const t of nodeIds) { const p = m.nodes.get(t)!; S.push(`${I(t)}${F(p[0])}${F(p[1])}${F(p[2])}`); }
  let eid = 1;
  for (const pt of parts) {
    S.push(`/PART/${pt.id}`, `${bodies[pt.body].group} ${pt.kind === "hex" ? "hexaedros" : "tetraedros"}`, `${I(pt.kind === "hex" ? 1 : 2)}${I(pt.body + 1)}${I(0)}`);
    S.push(`/${pt.kind === "hex" ? "BRICK" : "TETRA4"}/${pt.id}`);
    // a ordem dos nós do hexaedro e do tetraedro do Gmsh é a do Radioss (face 1-2-3-4, 5 sobre 1)
    for (const e of pt.els) S.push(`${I(eid++)}${e.map(I).join("")}`);
    elements += pt.els.length;
  }

  // grupos de nós (ids sequenciais) e cargas
  let gid = 100;
  const group = (label: string, nodes: number[]) => { const id = ++gid; S.push(`/GRNOD/NODE/${id}`, title(label), ...ids(nodes)); return id; };
  const faceNodes = (g: string) => [...new Set([...elementsOf(faceBlocks(m, g))].flatMap((e) => e.nodes))].sort((a, b) => a - b);

  // contacto entre corpos: superfície mestra por segmentos (triângulo: 4.º nó = 3.º), nós escravos por grupo.
  // Colado → /INTER/TYPE2 (nós escravos presos cinematicamente aos segmentos); com atrito → /INTER/TYPE7
  // (penalidade nó-segmento, Coulomb μ, separa-se), Inacti = 5 (folga reduzida à distância inicial) porque as faces são coincidentes.
  let sid = 0, inter = 0;
  for (const t of c.ties ?? []) {
    const segs = [...elementsOf(faceBlocks(m, t.master))];
    const slave = faceNodes(t.slave);
    if (!segs.length || !slave.length) { warnings.push(`Contacto ${t.name}: faces sem malha`); continue; }
    const surf = ++sid;
    S.push(`/SURF/SEG/${surf}`, title(`mestra ${t.master}`), "#  seg_ID  node_ID1  node_ID2  node_ID3  node_ID4",
      ...segs.map((e, k) => { const n = e.nodes.slice(0, e.nodes.length >= 8 || e.nodes.length === 4 ? 4 : 3); return `${I(k + 1)}${[...n, n[n.length === 4 ? 3 : 2]].slice(0, 4).map(I).join("")}`; }));
    const g = group(`escrava ${t.slave}`, slave);
    if (t.kind === "contact") {
      S.push(`/INTER/TYPE7/${++inter}`, title(`contacto ${t.name}`),
        "#grnd_IDs  surf_IDm      Istf      Ithe      Igap                Ibag      Idel     Icurv      Iadm",
        `${I(g)}${I(surf)}${I(0)}${I(0)}${I(0)}${"".padStart(10)}${I(0)}${I(0)}${I(0)}${I(0)}`,
        "#          Fscalegap             GAP_MAX             Fpenmax",
        `${F(0)}${F(0)}${F(0)}`,
        "#              Stmin               Stmax          %mesh_size               dtmin  Irem_gap",
        `${F(0)}${F(0)}${F(0)}${F(0)}${I(0)}`,
        "#              Stfac                Fric              Gapmin              Tstart               Tstop",
        `${F(1)}${F(t.mu ?? 0)}${F(0)}${F(0)}${F(0)}`,
        "#      IBC                        Inacti               VIS_S               VIS_F              Bumult",
        `${"000".padStart(10)}${"".padStart(20)}${I(5)}${F(0)}${F(0)}${F(0)}`,
        "#    Ifric    Ifiltr               Xfreq     Iform   sens_ID",
        `${I(0)}${I(0)}${F(0)}${I(0)}${I(0)}`);
    } else {
      S.push(`/INTER/TYPE2/${++inter}`, title(`colado ${t.name}`),
        "#grnd_IDs  surf_IDm    Ignore  Spotflag     Level   Isearch     Idel2                        dsearch",
        `${I(g)}${I(surf)}${I(1)}${I(0)}${I(0)}${I(0)}${I(0)}${"".padStart(10)}${F(Math.max(t.tolerance, 1e-3))}`);
    }
  }

  // amplitude no tempo (ms) — função 1
  S.push("/FUNCT/1", "amplitude", "#                  X                   Y", ...D.amplitude.map(([t, v]) => `${F(t * 1000)}${F(v)}`));

  let bcs = 0, loads = 0, imps = 0, impv = 0;
  for (const ld of c.loads) {
    if (ld.kind === "spring") throw new Error("OpenRadioss: as molas ainda não estão neste adaptador (use o CalculiX)");
    if (ld.kind === "coupling") throw new Error("OpenRadioss: os acoplamentos (RBE2/RBE3) ainda não estão neste adaptador (use o CalculiX)");
    if (ld.kind === "displacement" && ld.csys) throw new Error("OpenRadioss: os deslocamentos em referencial local ainda não estão neste adaptador (use o CalculiX)");
    if (ld.kind === "mass") throw new Error("OpenRadioss: as massas pontuais ainda não estão neste adaptador (use o CalculiX)");
    if (ld.kind === "pointForce") throw new Error("OpenRadioss: a força pontual ainda não está neste adaptador (use força nas faces)");
    if (ld.kind === "fixed" || ld.kind === "displacement") {
      // direções presas (u = 0) por /BCS; deslocamentos não nulos por /IMPDISP com a amplitude
      const fix = ld.kind === "fixed" ? [true, true, true] : ld.u.map((u) => u === 0);
      const g = group(`apoio ${ld.group}`, faceNodes(ld.group));
      if (fix.some(Boolean)) S.push(`/BCS/${++bcs}`, `apoio ${ld.group}`, "#  Tra rot   skew_ID  grnod_ID", `   ${fix.map((x) => (x ? "1" : "0")).join("")} 000${I(0)}${I(g)}`);
      if (ld.kind === "displacement") ld.u.forEach((u, k) => {
        if (u === null || u === 0) return;
        // velocidade imposta: /IMPVEL (m/s = mm/ms, o valor passa igual); deslocamento: /IMPDISP (mm)
        S.push(ld.velocity ? `/IMPVEL/${++impv}` : `/IMPDISP/${++imps}`, `${ld.velocity ? "velocidade" : "deslocamento"} ${"XYZ"[k]} ${ld.group}`,
          "#funct_IDT       Dir   skew_ID sensor_ID  grnod_ID  frame_ID     Icoor",
          `${I(1)}${"XYZ"[k].padStart(10)}${I(0)}${I(0)}${I(g)}${I(0)}${I(0)}`,
          "#           Ascale_x            Fscale_Y              Tstart               Tstop",
          `${F(1)}${F(u)}${F(0)}${F(0)}`);
      });
    }
  }
  // forças nodais consistentes das faces (força total uniforme e pressão), agrupadas por valor
  const nodal = new Map<number, [number, number, number]>();
  const add = (n: number, f: [number, number, number]) => { const a = nodal.get(n) ?? [0, 0, 0]; for (let k = 0; k < 3; k++) a[k] += f[k]; nodal.set(n, a); };
  // centro de cada elemento com faces de fronteira, para orientar a pressão para dentro
  const centers = new Map<string, [number, number, number]>();
  for (const e of elementsOf(solidBlocks(m, c.bodies))) {
    const st = SOLIDS[e.type];
    const P = e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n)!);
    const ce = [0, 1, 2].map((q) => P.reduce((s, p) => s + p[q], 0) / P.length) as [number, number, number];
    for (const f of st.faces) centers.set(f.map((i) => e.nodes[i]).sort((a, b) => a - b).join(","), ce);
  }
  for (const ld of c.loads) {
    if (ld.kind === "force") {
      const fs = [...elementsOf(faceBlocks(m, ld.group))].map((e) => ({ e, fi: faceIntegrals(e.type, e.nodes.map((n) => m.nodes.get(n)!)) }));
      const A = fs.reduce((s, x) => s + x.fi.area, 0);
      if (!(A > 0)) { warnings.push(`Força no grupo ${ld.group} sem área`); continue; }
      for (const { e, fi } of fs) e.nodes.forEach((n, i) => add(n, [0, 1, 2].map((k) => (ld.f[k] * fi.nodal[i]) / A) as [number, number, number]));
    } else if (ld.kind === "pressure") {
      for (const e of elementsOf(faceBlocks(m, ld.group))) {
        const P = e.nodes.map((n) => m.nodes.get(n)!);
        const fi = faceIntegrals(e.type, P);
        const corners = e.nodes.slice(0, e.type === 2 || e.type === 9 ? 3 : 4);
        const ce = centers.get([...corners].sort((a, b) => a - b).join(","));
        const nv = fi.vec.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
        const sgn = ce ? Math.sign(nv[0] * (P[0][0] - ce[0]) + nv[1] * (P[0][1] - ce[1]) + nv[2] * (P[0][2] - ce[2])) || 1 : 1;
        // pressão positiva empurra contra a face (para dentro do sólido)
        e.nodes.forEach((n, i) => add(n, fi.vec[i].map((v) => -ld.p * sgn * v) as [number, number, number]));
      }
    } else if (ld.kind === "gravity") {
      const all = group("todos os nós", nodeIds);
      ld.g.forEach((g, k) => { if (g) S.push(`/GRAV/${++loads}`, "gravidade", "#funct_IDT       Dir   skew_ID sensor_ID  grnod_ID                       Ascalex             Fscaley", `${I(1)}${"XYZ"[k].padStart(10)}${I(0)}${I(0)}${I(all)}${" ".repeat(10)}${F(1)}${F(g * 1e-6)}`); });
    } else if (ld.kind !== "fixed" && ld.kind !== "displacement") warnings.push(`OpenRadioss: condição "${ld.kind}" ignorada (térmica)`);
  }
  // /CLOAD por direção e valor (kN): os nós com a mesma força partilham um grupo
  for (let k = 0; k < 3; k++) {
    const byVal = new Map<string, { v: number; nodes: number[] }>();
    for (const [n, f] of nodal) {
      if (Math.abs(f[k]) < 1e-14) continue;
      const key = f[k].toPrecision(9);
      const x = byVal.get(key) ?? { v: f[k], nodes: [] };
      x.nodes.push(n);
      byVal.set(key, x);
    }
    for (const { v, nodes } of byVal.values()) {
      const g = group(`carga ${"XYZ"[k]} ${v.toPrecision(4)} N`, nodes.sort((a, b) => a - b));
      S.push(`/CLOAD/${++loads}`, `forca ${"XYZ"[k]}`, "#funct_IDT       Dir   skew_ID sensor_ID  grnod_ID                       Ascalex             Fscaley", `${I(1)}${"XYZ"[k].padStart(10)}${I(0)}${I(0)}${I(g)}${" ".repeat(10)}${F(1)}${F(v / 1000)}`);
    }
  }
  if (!bcs) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
  // Rayleigh C = α·M + β·K: α em 1/ms, β em ms
  if (D.alpha || D.beta) {
    const all = group("amortecimento", nodeIds);
    S.push("/DAMP/1", "Rayleigh", "#              alpha                beta  grnod_ID   skew_ID              Tstart               Tstop", `${F(D.alpha / 1000)}${F(D.beta * 1000)}${I(all)}${I(0)}${F(0)}${F(0)}`);
  }
  // velocidade inicial de todos os nós (m/s = mm/ms); os /BCS anulam-na nas direções presas
  if (D.v0) {
    const all = group("velocidade inicial", nodeIds);
    S.push("/INIVEL/TRA/1", "velocidade inicial", "#                 Vx                  Vy                  Vz  grnod_ID   skew_ID", `${F(D.v0[0])}${F(D.v0[1])}${F(D.v0[2])}${I(all)}${I(0)}`);
  }
  S.push("/END");

  // Engine: duração, animações (deslocamentos e von Mises) a D.frames instantes; passo estável do próprio Radioss
  const T = D.duration * 1000;
  const E = [
    // o Engine pára em T antes de escrever a animação de T: corre meio intervalo a mais para a incluir
    "#RADIOSS ENGINE", `/RUN/${name}/1`, F(T + T / D.frames / 2),
    "/ANIM/DT", `${F(0)}${F(T / D.frames)}`,
    "/ANIM/VECT/DISP", "/ANIM/ELEM/VONM", ...(c.nonlinear?.plasticity ? ["/ANIM/ELEM/EPSP"] : []),
    "/PRINT/-1000",
  ];
  if (D.dt) warnings.push("OpenRadioss: o passo é o estável calculado pelo Engine (o passo indicado é ignorado)");
  return { starter: S.join("\n") + "\n", engine: E.join("\n") + "\n", name, warnings, nodes: nodeIds.length, elements };
}

// ---------------------------------------------------------------------------
// Resultados: VTK ASCII escrito pelo anim_to_vtk (uma animação por instante)
// ---------------------------------------------------------------------------

export interface VtkFrame {
  /** Tempo (unidade do modelo: ms). */
  time: number;
  nodeIds: number[];
  points: number[];
  /** Vetores nodais por nome (ex.: "Displacement"). */
  vectors: Record<string, number[]>;
  /** Escalares por célula por nome (ex.: "Von Mises"), com o ELEMENT_ID e as ligações (índices de pontos). */
  cellScalars: Record<string, number[]>;
  cells: number[][];
  cellTypes: number[];
}

/** Lê um VTK legado ASCII (UNSTRUCTURED_GRID) do anim_to_vtk. */
export function parseVtk(text: string): VtkFrame {
  const tok = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const f: VtkFrame = { time: 0, nodeIds: [], points: [], vectors: {}, cellScalars: {}, cells: [], cellTypes: [] };
  let section: "point" | "cell" | null = null, nPts = 0, nCells = 0;
  while (i < tok.length) {
    const t = tok[i++];
    if (t === "TIME" && tok[i] === "1" && tok[i + 1] === "1") { i += 3; f.time = Number(tok[i++]); }
    else if (t === "POINTS") { nPts = Number(tok[i++]); i++; for (let k = 0; k < 3 * nPts; k++) f.points.push(Number(tok[i++])); }
    else if (t === "CELLS") {
      nCells = Number(tok[i++]); i++;
      for (let k = 0; k < nCells; k++) { const n = Number(tok[i++]); const c: number[] = []; for (let q = 0; q < n; q++) c.push(Number(tok[i++])); f.cells.push(c); }
    } else if (t === "CELL_TYPES") { const n = Number(tok[i++]); for (let k = 0; k < n; k++) f.cellTypes.push(Number(tok[i++])); }
    else if (t === "POINT_DATA") { section = "point"; i++; }
    else if (t === "CELL_DATA") { section = "cell"; i++; }
    else if (t === "SCALARS") {
      // o nome pode ter espaços: lê até ao tipo (int/float/double)
      const nameParts: string[] = [];
      while (i < tok.length && !/^(int|float|double)$/.test(tok[i])) nameParts.push(tok[i++]);
      const name = nameParts.join(" ");
      i++; // tipo
      if (/^\d+$/.test(tok[i])) i++; // n.º de componentes
      if (tok[i] === "LOOKUP_TABLE") i += 2;
      const n = section === "point" ? nPts : nCells;
      const vals: number[] = [];
      for (let k = 0; k < n; k++) vals.push(Number(tok[i++]));
      if (section === "point" && name === "NODE_ID") f.nodeIds = vals;
      else if (section === "cell") f.cellScalars[name] = vals;
    } else if (t === "VECTORS") {
      const nameParts: string[] = [];
      while (i < tok.length && !/^(int|float|double)$/.test(tok[i])) nameParts.push(tok[i++]);
      i++;
      const vals: number[] = [];
      for (let k = 0; k < 3 * nPts; k++) vals.push(Number(tok[i++]));
      f.vectors[nameParts.join(" ")] = vals;
    }
  }
  return f;
}

/**
 * Blocos nodais (formato do .frd: DISP em mm, VMIS em MPa, valor = tempo em s) a partir das
 * animações: deslocamentos pelo NODE_ID e von Mises por célula, média nos nós dos elementos.
 */
export function radiossBlocks(frames: VtkFrame[]): FrdBlock[] {
  const out: FrdBlock[] = [];
  for (const fr of frames) {
    const t = fr.time / 1000;
    const dKey = Object.keys(fr.vectors).find((k) => /disp/i.test(k));
    if (dKey) {
      const v = fr.vectors[dKey], data = new Map<number, number[]>();
      fr.nodeIds.forEach((id, p) => data.set(id, [v[3 * p], v[3 * p + 1], v[3 * p + 2]]));
      out.push({ name: "DISP", value: t, components: ["D1", "D2", "D3"], data });
    }
    const sKey = Object.keys(fr.cellScalars).find((k) => /mises/i.test(k));
    if (sKey) {
      const s = fr.cellScalars[sKey], sum = new Map<number, [number, number]>();
      fr.cells.forEach((c, e) => {
        // só sólidos (VTK 10 = tetraedro, 12 = hexaedro); GPa → MPa
        if (fr.cellTypes[e] !== 10 && fr.cellTypes[e] !== 12) return;
        for (const p of c) { const id = fr.nodeIds[p]; const a = sum.get(id) ?? [0, 0]; a[0] += s[e] * 1000; a[1]++; sum.set(id, a); }
      });
      out.push({ name: "VMIS", value: t, components: ["VM"], data: new Map([...sum].map(([id, [a, n]]) => [id, [a / n]])) });
    }
    // deformação plástica equivalente (adimensional), média nos nós dos sólidos
    const pKey = Object.keys(fr.cellScalars).find((k) => /plastic|epsp/i.test(k));
    if (pKey) {
      const s = fr.cellScalars[pKey], sum = new Map<number, [number, number]>();
      fr.cells.forEach((c, e) => {
        if (fr.cellTypes[e] !== 10 && fr.cellTypes[e] !== 12) return;
        for (const p of c) { const id = fr.nodeIds[p]; const a = sum.get(id) ?? [0, 0]; a[0] += s[e]; a[1]++; sum.set(id, a); }
      });
      out.push({ name: "PE", value: t, components: ["PE"], data: new Map([...sum].map(([id, [a, n]]) => [id, [a / n]])) });
    }
  }
  return out;
}
