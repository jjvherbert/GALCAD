// Adaptador code_aster (EDF, GPL-3.0; versões 16–18): malha no formato nativo ASTER a partir da malha
// Gmsh, ficheiro de comandos (.comm) e ficheiro .export do run_aster para estática linear e não linear
// (STAT_NON_LINE: VMIS_ISOT_LINE, GREEN_LAGRANGE/GDEF_LOG) e modal (CALC_MODES); leitura das tabelas de
// resultados (IMPR_TABLE). Puro: corre na aplicação e no agente local.
//
// Documentação: U4.21.01 LIRE_MAILLAGE, U4.51.03 STAT_NON_LINE, U4.52.02 CALC_MODES, U4.44.01
// AFFE_CHAR_MECA (LIAISON_MAIL), U4.81.21 POST_RELEVE_T, U4.91.03 IMPR_TABLE. Verificado com o
// code_aster 18.1 (conda-forge) nos mesmos casos analíticos do CalculiX (tests/aster-solver.test.ts).
// Montagens: um GROUP_MA e um material por corpo; contacto colado por LIAISON_MAIL (nós da face
// escrava presos ao volume do corpo mestre).
// Unidades: mm, N, MPa, t, s (como no CalculiX).
import type { FemCase } from "./case.ts";
import { type Msh, physicalBlocks, solidBlocks } from "./msh.ts";
import { type FemResult, type FrdBlock, femResultFrom } from "./calculix.ts";

/** Gmsh → ASTER/Abaqus: tetraedro de 10 nós com as arestas 2-4 e 3-4 trocadas (como no CalculiX). */
const TET10_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8];
const num = (x: number) => (Number.isInteger(x) ? `${x}.` : x.toPrecision(12).replace(/\.?0+(e|$)/, "$1"));

export interface AsterFiles {
  /** Ficheiros do caso (malha, comandos, export). */
  files: Record<string, string>;
  /** Tags Gmsh dos nós pela ordem em que foram escritos (os nomes N<tag> podem perder-se nas tabelas). */
  nodeOrder: number[];
  warnings: string[];
}

/** Malha ASTER: COOR_3D, elementos de volume e de face, GROUP_MA e GROUP_NO com os nomes dos grupos. */
export function asterMesh(c: FemCase, m: Msh): { mail: string; nodeOrder: number[]; areas: Record<string, number> } {
  const vol = solidBlocks(m, c.bodies);
  if (!vol.length) throw new Error("A malha não tem tetraedros nos grupos dos corpos");
  const quad = vol[0].type === 11;
  const L: string[] = ["TITRE", ` ${c.title.replace(/[^\x20-\x7e]/g, "_").slice(0, 70)}`, "FINSF", "%"];
  const used = new Set<number>();
  const cells: { name: string; nodes: number[] }[] = [];
  // células por corpo (montagens: B1, B2, …; peça: SOLID)
  const bodyCells: Record<string, string[]> = {};
  for (const g of c.bodies?.length ? c.bodies.map((b) => b.group) : ["SOLID"]) {
    bodyCells[g] = [];
    for (const b of physicalBlocks(m, g).filter((x) => x.type === 4 || x.type === 11)) for (let k = 0; k < b.conn.length; k += quad ? 10 : 4) {
      const e = b.conn.slice(k, k + (quad ? 10 : 4));
      const n = quad ? TET10_ORDER.map((i) => e[i]) : e;
      n.forEach((x) => used.add(x));
      cells.push({ name: `M${cells.length + 1}`, nodes: n });
      bodyCells[g].push(cells.at(-1)!.name);
    }
  }
  const nodeOrder = [...used].sort((a, b) => a - b);
  L.push("COOR_3D");
  for (const t of nodeOrder) L.push(`N${t} ${m.nodes.get(t)!.map(num).join(" ")}`);
  L.push("FINSF", "%", quad ? "TETRA10" : "TETRA4");
  for (const e of cells) L.push(`${e.name} ${e.nodes.map((x) => `N${x}`).join(" ")}`);
  L.push("FINSF", "%");
  const faceGroups: Record<string, string[]> = {};
  const nodeGroups: Record<string, number[]> = {};
  const areas: Record<string, number> = {};
  const faces: string[] = [];
  for (const name of Object.keys(c.groups)) {
    const bl = physicalBlocks(m, name).filter((b) => b.type === 2 || b.type === 9);
    faceGroups[name] = [];
    const ns = new Set<number>();
    let A = 0;
    for (const b of bl) {
      const per = b.type === 9 ? 6 : 3;
      for (let k = 0; k < b.conn.length; k += per) {
        const n = b.conn.slice(k, k + per);
        n.forEach((x) => ns.add(x));
        const [P, Q, R] = n.slice(0, 3).map((x) => m.nodes.get(x)!);
        const u = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]], v = [R[0] - P[0], R[1] - P[1], R[2] - P[2]];
        A += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        const id = `F${faces.length + 1}`;
        faces.push(`${id} ${n.map((x) => `N${x}`).join(" ")}`);
        faceGroups[name].push(id);
      }
    }
    nodeGroups[name] = [...ns].sort((a, b) => a - b);
    areas[name] = A;
  }
  if (faces.length) L.push(quad ? "TRIA6" : "TRIA3", ...faces, "FINSF", "%");
  const block = (kw: string, name: string, ids: string[]) => {
    L.push(kw, name);
    for (let k = 0; k < ids.length; k += 10) L.push(ids.slice(k, k + 10).join(" "));
    L.push("FINSF", "%");
  };
  block("GROUP_MA", "SOLID", cells.map((e) => e.name));
  for (const [g, ids] of Object.entries(bodyCells)) if (g !== "SOLID") block("GROUP_MA", g, ids);
  for (const [g, ids] of Object.entries(faceGroups)) if (ids.length) block("GROUP_MA", g, ids);
  for (const [g, ns] of Object.entries(nodeGroups)) if (ns.length) block("GROUP_NO", g, ns.map((x) => `N${x}`));
  // contacto colado: nós escravos sem os dos apoios (o code_aster não aceita relações redundantes
  // entre um grau imposto e a ligação; nesses poucos nós da aresta comum fica só o apoio)
  const supportNodes = new Set(c.loads.flatMap((ld) => (ld.kind === "fixed" || ld.kind === "displacement" ? nodeGroups[ld.group] ?? [] : [])));
  for (const t of c.ties ?? []) {
    const ns = (nodeGroups[t.slave] ?? []).filter((x) => !supportNodes.has(x));
    if (ns.length) block("GROUP_NO", `${t.slave}_L`, ns.map((x) => `N${x}`));
  }
  // todos os nós (o POST_RELEVE_T de extração pede GROUP_NO)
  block("GROUP_NO", "NALL", nodeOrder.map((x) => `N${x}`));
  L.push("FIN");
  return { mail: L.join("\n") + "\n", nodeOrder, areas };
}

/** Ficheiro de comandos (.comm, sintaxe Python do code_aster) e .export para o run_aster. */
export function asterCase(c: FemCase, m: Msh): AsterFiles {
  if (c.analysis !== "static" && c.analysis !== "modal") throw new Error(`code_aster: análise "${c.analysis}" ainda não suportada neste adaptador (use o CalculiX)`);
  if ((c.ties ?? []).some((t) => t.kind === "contact")) throw new Error("code_aster: o contacto com atrito ainda não está neste adaptador (use o CalculiX ou contacto colado)");
  const { mail, nodeOrder, areas } = asterMesh(c, m);
  const warnings: string[] = [];
  const mat = c.material;
  const nl = c.analysis === "static" ? c.nonlinear : undefined;
  const C: string[] = [];
  C.push(`# ${c.title.replace(/[^\x20-\x7e]/g, "_")} -- gerado pelo CAD prototipo (unidades: mm, N, MPa, t, s)`);
  for (const h of c.hypotheses) C.push(`# ${h.replace(/[^\x20-\x7e]/g, "_")}`);
  C.push("DEBUT(LANG='FR')", "MA = LIRE_MAILLAGE(FORMAT='ASTER', UNITE=20)");
  // a pressão segue a normal dos elementos de face: orientá-los para fora do volume
  const presGroups = c.loads.flatMap((ld) => (ld.kind === "pressure" ? [`'${ld.group}'`] : []));
  if (presGroups.length) C.push(`MA = MODI_MAILLAGE(reuse=MA, MAILLAGE=MA, ORIE_PEAU=_F(GROUP_MA_PEAU=(${presGroups.join(", ")},)))`);
  C.push("MO = AFFE_MODELE(MAILLAGE=MA, AFFE=_F(TOUT='OUI', PHENOMENE='MECANIQUE', MODELISATION='3D'))");
  const material = (name: string, m2: FemCase["material"]) => {
    if (nl?.plasticity && !(m2.yield! > 0)) throw new Error(`Plasticidade: o material ${m2.name} não tem tensão de cedência`);
    const plast = nl?.plasticity ? `, ECRO_LINE=_F(D_SIGM_EPSI=${num(m2.tangent ?? 0)}, SY=${num(m2.yield!)})` : "";
    C.push(`${name} = DEFI_MATERIAU(ELAS=_F(E=${num(m2.E)}, NU=${num(m2.nu)}, RHO=${num(m2.density * 1e-9)})${plast})`);
  };
  if (c.bodies?.length) {
    c.bodies.forEach((b, k) => material(`MAT${k + 1}`, b.material));
    C.push(`CM = AFFE_MATERIAU(MAILLAGE=MA, AFFE=(${c.bodies.map((b, k) => `_F(GROUP_MA='${b.group}', MATER=MAT${k + 1})`).join(", ")},))`);
  } else {
    material("MAT", mat);
    C.push("CM = AFFE_MATERIAU(MAILLAGE=MA, AFFE=_F(TOUT='OUI', MATER=MAT))");
  }
  // apoios (BC) e cargas (CH) em cargas separadas: nos não lineares só as cargas sobem em rampa
  const ddl: string[] = [], force: string[] = [], pres: string[] = [];
  let grav = "";
  for (const ld of c.loads) {
    switch (ld.kind) {
      case "fixed": ddl.push(`_F(GROUP_NO='${ld.group}', DX=0., DY=0., DZ=0.)`); break;
      case "displacement": {
        const comps = ld.u.map((u, k) => (u === null ? "" : `D${"XYZ"[k]}=${num(u)}`)).filter(Boolean);
        if (comps.length) ddl.push(`_F(GROUP_NO='${ld.group}', ${comps.join(", ")})`);
        break;
      }
      case "force": {
        const A = areas[ld.group];
        if (!(A > 0)) { warnings.push(`Força no grupo ${ld.group} sem área`); break; }
        force.push(`_F(GROUP_MA='${ld.group}', FX=${num(ld.f[0] / A)}, FY=${num(ld.f[1] / A)}, FZ=${num(ld.f[2] / A)})`);
        break;
      }
      case "pressure": pres.push(`_F(GROUP_MA='${ld.group}', PRES=${num(ld.p)})`); break;
      case "gravity": {
        const g = Math.hypot(...ld.g);
        if (g > 0) grav = `PESANTEUR=_F(GRAVITE=${num(g)}, DIRECTION=(${ld.g.map((x) => num(x / g)).join(", ")}))`;
        break;
      }
      default: warnings.push(`code_aster: condição "${ld.kind}" ignorada (térmica)`);
    }
  }
  if (!ddl.length) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
  // contacto colado: nós da face escrava ligados ao volume do corpo mestre
  const ties = (c.ties ?? []).filter((t) => t.masterBody).map((t) => `_F(GROUP_MA_MAIT='${t.masterBody}', GROUP_NO_ESCL='${t.slave}_L')`);
  const bcParts = [ddl.length && `DDL_IMPO=(${ddl.join(", ")},)`, ties.length && `LIAISON_MAIL=(${ties.join(", ")},)`].filter(Boolean);
  if (!bcParts.length) throw new Error("code_aster: o estudo não tem apoios nem ligações");
  C.push(`BC = AFFE_CHAR_MECA(MODELE=MO, ${bcParts.join(", ")})`);
  const chParts = [force.length && `FORCE_FACE=(${force.join(", ")},)`, pres.length && `PRES_REP=(${pres.join(", ")},)`, grav].filter(Boolean);
  const hasCh = chParts.length > 0 && c.analysis === "static";
  if (hasCh) C.push(`CH = AFFE_CHAR_MECA(MODELE=MO, ${chParts.join(", ")})`);
  const supports = c.loads.flatMap((ld) => (ld.kind === "fixed" || ld.kind === "displacement" ? [`'${ld.group}'`] : []));

  if (c.analysis === "modal") {
    C.push(
      "ASSEMBLAGE(MODELE=MO, CHAM_MATER=CM, CHARGE=BC, NUME_DDL=CO('NU'), MATR_ASSE=(_F(MATRICE=CO('K'), OPTION='RIGI_MECA'), _F(MATRICE=CO('M'), OPTION='MASS_MECA')))",
      `RES = CALC_MODES(MATR_RIGI=K, MATR_MASS=M, OPTION='PLUS_PETITE', CALC_FREQ=_F(NMAX_FREQ=${c.modes}))`,
      "TF = RECU_TABLE(CO=RES, NOM_PARA=('FREQ',))",
      "IMPR_TABLE(TABLE=TF, UNITE=40, FORMAT='TABLEAU')",
    );
  } else if (!nl) {
    C.push(`RES = MECA_STATIQUE(MODELE=MO, CHAM_MATER=CM, EXCIT=(_F(CHARGE=BC),${hasCh ? " _F(CHARGE=CH)," : ""}))`);
  } else {
    const rel = nl.plasticity ? "VMIS_ISOT_LINE" : "ELAS";
    // grandes deslocamentos: GREEN_LAGRANGE em elasticidade (o GROT_GDEP não aceita TETRA10), GDEF_LOG com plasticidade
    const def = nl.geometry ? (nl.plasticity ? "GDEF_LOG" : "GREEN_LAGRANGE") : "PETIT";
    C.push(
      "RAMPE = DEFI_FONCTION(NOM_PARA='INST', VALE=(0., 0., 1., 1.))",
      `LR = DEFI_LIST_REEL(DEBUT=0., INTERVALLE=_F(JUSQU_A=1., NOMBRE=${nl.increments}))`,
      "LINST = DEFI_LIST_INST(DEFI_LIST=_F(LIST_INST=LR), ECHEC=_F(EVENEMENT='ERREUR', ACTION='DECOUPE', SUBD_METHODE='MANUEL', SUBD_PAS=4, SUBD_NIVEAU=5))",
      `RES = STAT_NON_LINE(MODELE=MO, CHAM_MATER=CM, EXCIT=(_F(CHARGE=BC),${hasCh ? " _F(CHARGE=CH, FONC_MULT=RAMPE)," : ""}), COMPORTEMENT=_F(RELATION='${rel}', DEFORMATION='${def}', TOUT='OUI'), INCREMENT=_F(LIST_INST=LINST), NEWTON=_F(REAC_ITER=1), CONVERGENCE=_F(ITER_GLOB_MAXI=25))`,
    );
  }
  // resultados: deslocamentos em todos os nós e, na estática, von Mises, plasticidade e reações
  if (c.analysis === "static") {
    C.push(`RES = CALC_CHAMP(reuse=RES, RESULTAT=RES, CONTRAINTE=('SIGM_NOEU',), CRITERES=('SIEQ_NOEU',), FORCE=('REAC_NODA',)${nl?.plasticity ? ", VARI_INTERNE=('VARI_NOEU',)" : ""})`);
  }
  C.push("TU = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='U', RESULTAT=RES, NOM_CHAM='DEPL', GROUP_NO='NALL', NOM_CMP=('DX', 'DY', 'DZ'), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TU, UNITE=38, FORMAT='TABLEAU')");
  if (c.analysis === "static") {
    C.push("TS = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='VM', RESULTAT=RES, NOM_CHAM='SIEQ_NOEU', GROUP_NO='NALL', NOM_CMP=('VMIS',), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TS, UNITE=39, FORMAT='TABLEAU')");
    if (supports.length) C.push(`TR = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='R', RESULTAT=RES, NOM_CHAM='REAC_NODA', GROUP_NO=(${supports.join(", ")},), RESULTANTE=('DX', 'DY', 'DZ'), TOUT_ORDRE='OUI'))`, "IMPR_TABLE(TABLE=TR, UNITE=41, FORMAT='TABLEAU')");
    if (nl?.plasticity) C.push("TP = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='P', RESULTAT=RES, NOM_CHAM='VARI_NOEU', GROUP_NO='NALL', NOM_CMP=('V1',), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TP, UNITE=42, FORMAT='TABLEAU')");
  }
  C.push("IMPR_RESU(FORMAT='MED', UNITE=80, RESU=_F(RESULTAT=RES))", "FIN()");
  const exp = [
    "P actions make_etude", "P time_limit 1800", "P memory_limit 4096", "P ncpus 1", "P mpi_nbcpu 1", "P mode interactif",
    "F comm job.comm D 1", "F mail mesh.mail D 20", "F mess job.mess R 6", "F resu job.resu R 8", "F rmed job.rmed R 80",
    "F libr u.tab R 38", "F libr vm.tab R 39", "F libr freq.tab R 40", "F libr reac.tab R 41", "F libr peeq.tab R 42",
  ];
  return { files: { "mesh.mail": mail, "job.comm": C.join("\n") + "\n", "job.export": exp.join("\n") + "\n" }, nodeOrder, warnings };
}

/** Tabela de IMPR_TABLE (FORMAT='TABLEAU'): linhas de comentário com "#", cabeçalho e valores. */
export function parseAsterTable(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return [];
  const head = lines[0].split(/\s+/);
  return lines.slice(1).map((l) => {
    const v = l.split(/\s+/);
    return Object.fromEntries(head.map((h, i) => [h, v[i] ?? ""]));
  }).filter((r) => Object.keys(r).length === head.length);
}

/** Tag Gmsh de um nó da tabela: nome "N<tag>" ou, nas versões que numeram, o índice (1…) na ordem escrita. */
export const asterNode = (s: string, order: number[]) => (/^N\d+$/.test(s) ? Number(s.slice(1)) : order[Number(s) - 1]);

export interface AsterTables { u: string; vm?: string; freq?: string; reac?: string; peeq?: string }

/** Resultado (mesmo formato do CalculiX) a partir das tabelas escritas pelo .comm deste adaptador. */
export function asterResult(c: FemCase, m: Msh, t: AsterTables, nodeOrder: number[]): FemResult {
  const nodal = (text: string | undefined, name: string, cols: string[]): FrdBlock[] => {
    const byOrder = new Map<number, FrdBlock>();
    for (const row of parseAsterTable(text ?? "")) {
      const ord = Number(row.NUME_ORDRE ?? 1);
      // o STAT_NON_LINE arquiva também o estado inicial (INST 0)
      if (c.nonlinear && c.analysis === "static" && Number(row.INST) === 0) continue;
      let b = byOrder.get(ord);
      if (!b) { b = { name, value: c.analysis === "static" && c.nonlinear ? Number(row.INST ?? 1) : ord, components: cols, data: new Map() }; byOrder.set(ord, b); }
      const tag = asterNode(row.NOEUD ?? "", nodeOrder);
      if (tag !== undefined) b.data.set(tag, cols.map((k) => Number(row[k])));
    }
    return [...byOrder].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  };
  const blocks = [...nodal(t.u, "DISP", ["DX", "DY", "DZ"]), ...nodal(t.vm, "VMIS", ["VMIS"]), ...nodal(t.peeq, "PE", ["V1"])];
  const frequencies = parseAsterTable(t.freq ?? "").map((r) => Number(r.FREQ)).filter(Number.isFinite);
  const reactionHistory = parseAsterTable(t.reac ?? "").map((r) => ({ time: c.nonlinear ? Number(r.INST ?? 1) : 1, f: [Number(r.DX), Number(r.DY), Number(r.DZ)] as [number, number, number] }))
    .filter((r) => r.f.every(Number.isFinite) && !(c.nonlinear && r.time === 0));
  // REAC_NODA = FORC_NODA − cargas = reação dos apoios sobre a peça (já sem a parcela das cargas nos apoios)
  const res = femResultFrom(c, m, blocks, { frequencies, buckling: [], reactions: reactionHistory.length ? [reactionHistory.at(-1)!.f] : [], reactionHistory });
  return { ...res, hypotheses: [...res.hypotheses, "Calculado com o code_aster (EDF, GPL-3.0); adaptador verificado com o code_aster 18.1 nos casos analíticos de referência (consola, pressão, modal, plasticidade uniaxial, elástica, montagem colada)"] };
}
