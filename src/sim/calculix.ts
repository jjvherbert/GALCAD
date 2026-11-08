// Adaptador CalculiX (ccx): deck `.inp` (formato tipo Abaqus) a partir do caso e da malha Gmsh, e
// leitura dos resultados (`.frd` ASCII e `.dat`). Puro: corre na aplicação e no agente local.
//
// Unidades do deck: mm, N, MPa, t (tonelada), s. Massa volúmica g/cm³ → t/mm³ (× 1e-9); térmica:
// k em W/(m·K) = N/(s·K) (igual), h em W/(m²·K) → N/(mm·s·K) (× 1e-3), q em W/m² → N/(mm·s) (× 1e-3).
import type { FemCase } from "./case.ts";
import { type Msh, edgeBlocks, elementsOf, faceBlocks, solidBlocks } from "./msh.ts";
import { FACES, SOLIDS, type SolidType, faceIntegrals, faceKey, lineIntegrals } from "./elements.ts";
import { stableIncrement } from "./quality.ts";

/**
 * Elemento do CalculiX: tetraedros C3D4/C3D10; hexaedros lineares com modos incompatíveis (C3D8I,
 * sem bloqueio por corte em flexão — por omissão), integração completa (C3D8) ou reduzida (C3D8R,
 * controlo de hourglass); quadráticos com integração reduzida (C3D20R, por omissão) ou completa
 * (C3D20). Na térmica, sempre integração completa.
 */
export function ccxElement(st: SolidType, integration: FemCase["mesh"]["integration"], thermal = false): string {
  if (st.kind === "tet") return st.order === 2 ? "C3D10" : "C3D4";
  if (thermal) return st.order === 2 ? "C3D20" : "C3D8";
  if (st.order === 2) return integration === "full" ? "C3D20" : "C3D20R";
  return integration === "full" ? "C3D8" : integration === "reduced" ? "C3D8R" : "C3D8I";
}

/** Faces de fronteira de um grupo: nós (Gmsh), cantos, integrais (área, nodais) e face do elemento. */
interface BFace { n: number[]; corners: number[]; area: number; nodal: number[]; vec: [number, number, number][]; face?: [number, number] }

export interface Deck {
  inp: string;
  /** Número de nós e de elementos de volume. */
  nodes: number;
  elements: number;
  /** Área de cada grupo de faces (mm²) medida na malha (para conferir com o CAD). */
  groupArea: Record<string, number>;
  /** Comprimento de cada grupo de arestas (mm) medido na malha. */
  groupLength: Record<string, number>;
  /**
   * Cargas aplicadas diretamente nos graus de liberdade restringidos (N), com a carga total: o RF do
   * CalculiX é a força interna, e a reação verdadeira é RF − esta parcela (f_int = f_ext + R).
   */
  supportLoad: [number, number, number];
  warnings: string[];
  /** Dinâmica: passo (s), n.º de incrementos, de quantos em quantos se guarda, e se o passo é o estável da malha. */
  dynamic?: { dt: number; increments: number; frequency: number; stable: boolean };
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toPrecision(10).replace(/\.?0+(e|$)/, "$1"));

export function calculixDeck(c: FemCase, m: Msh): Deck {
  const warnings: string[] = [];
  const groupsOfBodies = c.bodies?.length ? c.bodies.map((b) => b.group) : ["SOLID"];
  const thermal = c.analysis === "thermal";
  if (!solidBlocks(m, c.bodies).length) throw new Error(`A malha não tem elementos de volume nos grupos ${groupsOfBodies.join(", ")}`);
  // elementos de volume (numeração sequencial, corpo a corpo; nós pela ordem do CalculiX) e mapa
  // face (cantos) → (elemento, n.º da face)
  const elems: { type: string; st: SolidType; n: number[] }[] = [];
  const bodyRange: [number, number][] = [];
  for (const g of groupsOfBodies) {
    const first = elems.length + 1;
    for (const e of elementsOf(solidBlocks(m, [{ group: g }]))) {
      const st = SOLIDS[e.type];
      elems.push({ type: ccxElement(st, c.mesh.integration, thermal), st, n: st.toCcx.map((i) => e.nodes[i]) });
    }
    if (elems.length < first) throw new Error(`O corpo ${g} não tem elementos na malha`);
    bodyRange.push([first, elems.length]);
  }
  const faceOf = new Map<string, [number, number]>();
  elems.forEach((e, i) => e.st.faces.forEach((f, j) => faceOf.set(faceKey(f.map((q) => e.n[q])), [i + 1, j + 1])));
  const used = new Set<number>();
  for (const e of elems) for (const n of e.n) used.add(n);

  // faces de fronteira de cada grupo (triângulos ou quadriláteros), com as integrais para as cargas consistentes
  const bfaces = (name: string): BFace[] => [...elementsOf(faceBlocks(m, name))].map(({ type, nodes }) => {
    const corners = nodes.slice(0, FACES[type].corners);
    const fi = faceIntegrals(type, nodes.map((t) => m.nodes.get(t)!));
    return { n: nodes, corners, ...fi, face: faceOf.get(faceKey(corners)) };
  });
  const groupArea: Record<string, number> = {};
  const tris: Record<string, BFace[]> = {};
  for (const name of Object.keys(c.groups)) {
    tris[name] = bfaces(name);
    groupArea[name] = tris[name].reduce((s, t) => s + t.area, 0);
    if (!tris[name].length) warnings.push(`O grupo ${name} não tem faces na malha`);
    if (tris[name].some((t) => !t.face)) warnings.push(`Grupo ${name}: faces sem face de elemento correspondente`);
  }
  // linhas (line2/line3) dos grupos de arestas, com as integrais para as forças consistentes
  const lines: Record<string, { n: number[]; length: number; nodal: number[] }[]> = {};
  const groupLength: Record<string, number> = {};
  for (const name of Object.keys(c.edgeGroups ?? {})) {
    lines[name] = [...elementsOf(edgeBlocks(m, name))].map(({ type, nodes }) => ({ n: nodes, ...lineIntegrals(type, nodes.map((t) => m.nodes.get(t)!)) }));
    groupLength[name] = lines[name].reduce((s, l) => s + l.length, 0);
    if (!lines[name].length) warnings.push(`O grupo ${name} não tem linhas na malha`);
    if (lines[name].some((l) => l.n.some((x) => !used.has(x)))) warnings.push(`Grupo ${name}: nós das arestas fora dos elementos de volume`);
  }

  const L: string[] = [];
  L.push("*HEADING", `${c.title} — gerado pelo CAD protótipo`);
  for (const h of c.hypotheses) L.push(`** ${h}`);
  L.push("** Unidades: mm, N, MPa, t, s");
  L.push("*NODE, NSET=NALL");
  for (const [t, p] of [...m.nodes].sort((a, b) => a[0] - b[0])) if (used.has(t)) L.push(`${t}, ${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])}`);
  elems.forEach((e, i) => {
    // um cartão *ELEMENT por cada série de elementos do mesmo tipo (numeração contínua)
    if (i === 0 || elems[i - 1].type !== e.type) L.push(`*ELEMENT, TYPE=${e.type}, ELSET=EALL`);
    // o CalculiX aceita até 16 entradas por linha: o C3D20 continua na linha seguinte
    L.push(e.n.length > 15 ? `${i + 1}, ${e.n.slice(0, 15).join(", ")},\n${e.n.slice(15).join(", ")}` : `${i + 1}, ${e.n.join(", ")}`);
  });
  for (const [name, list] of Object.entries<{ n: number[] }[]>({ ...tris, ...lines })) {
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
      if (!(mat.k! > 0)) throw new Error(`Térmico: o material ${mat.name} não tem condutividade térmica k`);
      L.push("*CONDUCTIVITY", fmt(mat.k!));
      return;
    }
    L.push("*ELASTIC", `${fmt(mat.E)}, ${fmt(mat.nu)}`, "*DENSITY", fmt(mat.density * 1e-9));
    // amortecimento de Rayleigh C = α·M + β·K (integração direta)
    if (c.dynamic && (c.dynamic.alpha || c.dynamic.beta)) L.push(`*DAMPING, ALPHA=${fmt(c.dynamic.alpha)}, BETA=${fmt(c.dynamic.beta)}`);
    if (mat.alpha) L.push("*EXPANSION", fmt(mat.alpha));
    if (c.nonlinear?.plasticity) {
      if (!(mat.yield! > 0)) throw new Error(`Plasticidade: o material ${mat.name} não tem tensão de cedência`);
      // multilinear: os pontos (σ, εp) tal como estão; depois do último, plástico perfeito
      if (mat.plasticCurve?.length) {
        L.push("*PLASTIC", ...mat.plasticCurve.map(([s, ep]) => `${fmt(s)}, ${fmt(ep)}`));
        return;
      }
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
  // contacto colado: nós da face escrava presos (por MPC) às faces dos elementos da face mestra.
  // Contacto com atrito: penalidade face a face (pressão linear com a interpenetração, rigidez
  // K = 20·E por mm, como recomenda o manual do CalculiX) e Coulomb com declive de aderência K/100.
  // numa montagem cada corpo tem o seu material (o do estudo só conta sem corpos)
  const Emax = c.bodies?.length ? Math.max(...c.bodies.map((b) => b.material.E)) : c.material.E;
  for (const t of c.ties ?? []) {
    const master = tris[t.master].filter((x) => x.face);
    if (!tris[t.slave]?.length || !master.length) { warnings.push(`Contacto ${t.name}: faces sem malha`); continue; }
    if (t.kind === "contact") {
      const slave = tris[t.slave].filter((x) => x.face);
      const K = 20 * Emax;
      L.push(`*SURFACE, NAME=S_${t.slave}, TYPE=ELEMENT`, ...slave.map((x) => `${x.face![0]}, S${x.face![1]}`));
      L.push(`*SURFACE, NAME=S_${t.master}, TYPE=ELEMENT`, ...master.map((x) => `${x.face![0]}, S${x.face![1]}`));
      L.push(`*SURFACE INTERACTION, NAME=SI_${t.name}`, "*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR", `${fmt(K)}`);
      if ((t.mu ?? 0) > 0) L.push("*FRICTION", `${fmt(t.mu!)}, ${fmt(K / 100)}`);
      L.push(`*CONTACT PAIR, INTERACTION=SI_${t.name}, TYPE=SURFACE TO SURFACE`, `S_${t.slave}, S_${t.master}`);
      continue;
    }
    L.push(`*SURFACE, NAME=S_${t.slave}, TYPE=NODE`, `N_${t.slave}`);
    L.push(`*SURFACE, NAME=S_${t.master}, TYPE=ELEMENT`, ...master.map((x) => `${x.face![0]}, S${x.face![1]}`));
    L.push(`*TIE, NAME=${t.name}, POSITION TOLERANCE=${fmt(t.tolerance)}`, `S_${t.slave}, S_${t.master}`);
  }
  if (thermal) L.push("*INITIAL CONDITIONS, TYPE=TEMPERATURE", "NALL, 20.");

  const bcs: string[] = [], loads: string[] = [], bcsAmp: string[] = [];
  const cload = new Map<number, [number, number, number]>();
  for (const ld of c.loads) {
    switch (ld.kind) {
      case "fixed": bcs.push(`N_${ld.group}, 1, 3`); break;
      // na dinâmica, os deslocamentos impostos não nulos seguem a amplitude
      case "displacement": ld.u.forEach((u, k) => { if (u !== null) (c.dynamic && u !== 0 ? bcsAmp : bcs).push(`N_${ld.group}, ${k + 1}, ${k + 1}, ${fmt(u)}`); }); break;
      case "temperature": bcs.push(`N_${ld.group}, 11, 11, ${fmt(ld.t)}`); break;
      case "pointForce": {
        // nó da malha mais próximo do ponto (só nós que pertencem a elementos)
        let best = -1, bd = Infinity;
        for (const t of used) { const q = m.nodes.get(t); if (!q) continue; const d = (q[0] - ld.point[0]) ** 2 + (q[1] - ld.point[1]) ** 2 + (q[2] - ld.point[2]) ** 2; if (d < bd) { bd = d; best = t; } }
        if (best < 0) { warnings.push("Força pontual sem nó da malha"); break; }
        const acc = cload.get(best) ?? [0, 0, 0];
        for (let k = 0; k < 3; k++) acc[k] += ld.f[k];
        cload.set(best, acc);
        warnings.push(`Força pontual aplicada no nó ${best}, a ${Math.sqrt(bd).toFixed(2)} mm do ponto pedido: tensões locais irreais, só a resposta global é válida`);
        break;
      }
      case "force": {
        // tração uniforme t = F/A → forças nodais consistentes ∫Nᵢ t dA (tri3: A/3 por canto; tri6:
        // A/3 por nó intermédio; quad8: −A/12 nos cantos e A/3 nos intermédios)
        // em arestas: carga por unidade de comprimento F/L (line2: L/2 por nó; line3: L/6 nas pontas e 2L/3 no meio)
        const edge = !!lines[ld.group];
        const A = edge ? groupLength[ld.group] : groupArea[ld.group];
        if (!(A > 0)) { warnings.push(`Força no grupo ${ld.group} sem ${edge ? "comprimento" : "área"}`); break; }
        for (const t of edge ? lines[ld.group] : tris[ld.group]) t.n.forEach((n, i) => {
          if (t.nodal[i] === 0) return;
          const acc = cload.get(n) ?? [0, 0, 0];
          for (let k = 0; k < 3; k++) acc[k] += (ld.f[k] * t.nodal[i]) / A;
          cload.set(n, acc);
        });
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
  const dofNodes = dofSets.map((sets) => new Set(sets.flatMap((n) => (tris[n.slice(2)] ?? lines[n.slice(2)])?.flatMap((t) => t.n) ?? [])));
  const supportLoad: [number, number, number] = [0, 0, 0];
  for (const [n, f] of cload) for (let k = 0; k < 3; k++) if (dofNodes[k].has(n)) supportLoad[k] += f[k];
  for (const ld of c.loads) {
    if (ld.kind !== "pressure") continue;
    for (const t of tris[ld.group]) {
      if (!t.face) continue;
      // normal para fora do elemento (afastada do centro dos cantos)
      const el = elems[t.face[0] - 1];
      const e = el.n.slice(0, el.st.corners).map((x) => m.nodes.get(x)!);
      const ce = [0, 1, 2].map((q) => e.reduce((s, p) => s + p[q], 0) / e.length);
      const A = m.nodes.get(t.n[0])!;
      const nv = t.vec.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
      const sgn = Math.sign(nv[0] * (A[0] - ce[0]) + nv[1] * (A[1] - ce[1]) + nv[2] * (A[2] - ce[2])) || 1;
      t.n.forEach((nd, i) => { for (let k = 0; k < 3; k++) if (dofNodes[k].has(nd)) supportLoad[k] += -ld.p * sgn * t.vec[i][k]; });
    }
  }
  if (cload.size) {
    loads.push("*CLOAD");
    for (const [n, f] of cload) f.forEach((x, k) => { if (Math.abs(x) > 0) loads.push(`${n}, ${k + 1}, ${fmt(x)}`); });
  }

  const nl = c.analysis === "static" ? c.nonlinear : undefined;
  const contact = (c.ties ?? []).some((t) => t.kind === "contact");
  // dinâmica: amplitude das cargas (dados do modelo), passo e frequência de saída
  let dyn: Deck["dynamic"];
  if (c.dynamic) {
    const D = c.dynamic;
    const st = D.dt === undefined ? stableIncrement(m, c.bodies?.length ? c.bodies.map((b) => ({ group: b.group, ...b.material })) : [{ group: "SOLID", ...c.material }]) : undefined;
    const dt = D.dt ?? st!.dt;
    const increments = Math.ceil(D.duration / dt - 1e-9);
    if (increments > 2e6) throw new Error(`Dinâmica: ${increments} incrementos — reduza a duração ou aumente os elementos (o passo estável é ${dt.toExponential(2)} s)`);
    dyn = { dt, increments, frequency: Math.max(1, Math.round(increments / D.frames)), stable: !!st };
    L.push("*AMPLITUDE, NAME=A1");
    for (let k = 0; k < D.amplitude.length; k += 4) L.push(D.amplitude.slice(k, k + 4).flatMap(([t, v]) => [fmt(t), fmt(v)]).join(", "));
    for (let i = 0; i < loads.length; i++) if (/^\*(CLOAD|DLOAD|DFLUX|FILM)$/.test(loads[i])) loads[i] += ", AMPLITUDE=A1";
  }
  if (contact && c.analysis !== "static") throw new Error("Contacto com atrito: só em análises estáticas (use contacto colado nas modais/encurvadura/térmicas)");
  if (dyn) {
    L.push(`*STEP, INC=${dyn.increments + 100}`, c.dynamic!.scheme === "explicit" ? "*DYNAMIC, EXPLICIT, DIRECT" : "*DYNAMIC, DIRECT", `${fmt(dyn.dt)}, ${fmt(c.dynamic!.duration)}`);
  } else if (nl || contact) {
    const n = nl?.increments ?? 10, inc = 1 / n;
    L.push(`*STEP${nl?.geometry ? ", NLGEOM" : ""}, INC=${Math.max(200, 20 * n)}`, "*STATIC", `${fmt(inc)}, 1., ${fmt(inc * 1e-4)}, ${fmt(inc)}`);
  } else if (c.analysis === "static") L.push("*STEP", "*STATIC");
  else if (c.analysis === "modal") L.push("*STEP", "*FREQUENCY", String(c.modes));
  else if (c.analysis === "buckling") L.push("*STEP", "*BUCKLE", String(c.modes));
  else L.push("*STEP", "*HEAT TRANSFER, STEADY STATE");
  if (bcs.length) L.push("*BOUNDARY", ...bcs);
  if (bcsAmp.length) L.push("*BOUNDARY, AMPLITUDE=A1", ...bcsAmp);
  if (c.analysis !== "modal") L.push(...loads);
  if (thermal) L.push("*NODE FILE", "NT");
  else if (dyn) {
    // instantes guardados (o CalculiX usa a mesma frequência em todos os ficheiros)
    const f = `, FREQUENCY=${dyn.frequency}`;
    L.push(`*NODE FILE${f}`, "U", `*EL FILE${f}`, "S");
    dofSets.forEach((sets, k) => { if (sets.length) L.push(`*NODE PRINT, NSET=N_R${"XYZ"[k]}, TOTALS=ONLY${f}`, "RF"); });
  } else {
    L.push("*NODE FILE", "U");
    if (c.analysis === "static") L.push("*EL FILE", nl?.plasticity ? "S, PEEQ" : "S");
    // reações nos apoios (verificação do equilíbrio)
    if (c.analysis === "static") dofSets.forEach((sets, k) => { if (sets.length) L.push(`*NODE PRINT, NSET=N_R${"XYZ"[k]}, TOTALS=ONLY`, "RF"); });
    // reações por apoio (ex.: força de atrito transmitida a uma face com deslocamento imposto)
    if (c.analysis === "static") for (const ld of c.loads) if (ld.kind === "fixed" || ld.kind === "displacement") L.push(`*NODE PRINT, NSET=N_${ld.group}, TOTALS=ONLY`, "RF");
  }
  L.push("*END STEP");
  if (c.analysis === "static" && !c.loads.some((l) => l.kind === "fixed" || l.kind === "displacement")) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
  return { inp: L.join("\n") + "\n", nodes: used.size, elements: elems.length, groupArea, groupLength, supportLoad, warnings, dynamic: dyn };
}

// Resultados: em calculix-result.ts
export { type FrdBlock, type FemResult, parseFrd, parseDat, exteriorSurface, femResult, femResultFrom } from "./calculix-result.ts";
