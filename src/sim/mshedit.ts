// Edição de nós e elementos individuais da malha gerada (como o "Edit Mesh" do Abaqus/CAE ou o
// "Modify > Node/Element" do Femap): mover um nó para outra posição e apagar elementos. As edições
// localizam-se por coordenadas (o nó mais próximo, o elemento cujo centro está mais perto), por isso
// sobrevivem a uma regeneração determinística da malha. Puro (sem OCC): corre no agente local antes
// da pré-visualização, da qualidade e dos solvers, que veem todos a malha já editada.
import type { Msh, MshElementBlock } from "./msh.ts";
import { NODES_PER } from "./msh.ts";
import { SOLIDS } from "./elements.ts";
import { elementQuality, triangleQuality } from "./quality.ts";

type P3 = [number, number, number];

export type MeshEdit =
  | { kind: "move"; at: P3; to: P3 }
  | { kind: "delete"; at: P3; radius?: number };

/** Nós de canto por tipo Gmsh (os de meio de lado não contam para a ligação entre elementos). */
const CORNERS: Record<number, number> = { 1: 2, 8: 2, 2: 3, 9: 3, 3: 4, 16: 4, 4: 4, 11: 4, 5: 8, 17: 8, 6: 6, 18: 6, 7: 5, 19: 5, 15: 1 };

const dist = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p: P3) => `(${p.map((v) => +v.toFixed(4)).join(", ")})`;

interface El { block: MshElementBlock; k: number; nodes: number[] }

function elements(blocks: MshElementBlock[]): El[] {
  const out: El[] = [];
  for (const b of blocks) {
    const per = NODES_PER[b.type];
    for (let k = 0; k < b.conn.length / per; k++) out.push({ block: b, k, nodes: b.conn.slice(k * per, (k + 1) * per) });
  }
  return out;
}

/** Aplica as edições pela ordem dada; devolve uma malha nova (a original fica intacta) e notas. */
export function applyMeshEdits(m: Msh, edits: MeshEdit[]): { msh: Msh; notes: string[] } {
  if (!edits.length) return { msh: m, notes: [] };
  const nodes = new Map<number, P3>([...m.nodes].map(([t, p]) => [t, [p[0], p[1], p[2]] as P3]));
  const top = Math.max(...m.blocks.map((b) => b.dim));
  if (!(top >= 2)) throw new Error("Edição da malha: a malha não tem elementos de volume nem de casca");
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of nodes.values()) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const tol = 0.02 * diag;
  const dead = new Set<string>(); // "índice do bloco:k" dos elementos de topo apagados
  const bi = new Map(m.blocks.map((b, i) => [b, i]));
  const id = (e: El) => `${bi.get(e.block)}:${e.k}`;
  const tops = elements(m.blocks.filter((b) => b.dim === top));
  const centre = (e: El): P3 => {
    const c = e.nodes.slice(0, CORNERS[e.block.type]).map((n) => nodes.get(n)!);
    return [0, 1, 2].map((i) => c.reduce((s, p) => s + p[i], 0) / c.length) as P3;
  };
  const notes: string[] = [];
  edits.forEach((ed, i) => {
    const name = `Edição ${i + 1}`;
    if (ed.kind === "move") {
      let best = -1, bd = Infinity;
      for (const [t, p] of nodes) { const d = dist(p, ed.at); if (d < bd) { bd = d; best = t; } }
      if (bd > tol) throw new Error(`${name}: não há nenhum nó perto de ${fmt(ed.at)} (o mais próximo está a ${+bd.toFixed(4)} mm)`);
      const old = nodes.get(best)!;
      nodes.set(best, [...ed.to] as P3);
      for (const e of tops) {
        if (dead.has(id(e)) || !e.nodes.includes(best)) continue;
        const P = e.nodes.slice(0, CORNERS[e.block.type]).map((n) => nodes.get(n)!);
        const st = SOLIDS[e.block.type];
        const ok = st ? elementQuality(st.kind, P).sj > 0 : triangleQuality(P.slice(0, 3)).area > 1e-12 * diag * diag;
        if (!ok) { nodes.set(best, old); throw new Error(`${name}: mover o nó ${best} para ${fmt(ed.to)} inverte ou degenera um elemento`); }
      }
      notes.push(`nó ${best} movido de ${fmt(old)} para ${fmt(ed.to)}`);
    } else {
      const live = tops.filter((e) => !dead.has(id(e)));
      let hit: El[];
      if (ed.radius && ed.radius > 0) hit = live.filter((e) => dist(centre(e), ed.at) <= ed.radius!);
      else {
        let best: El | undefined, bd = Infinity;
        for (const e of live) { const d = dist(centre(e), ed.at); if (d < bd) { bd = d; best = e; } }
        const reach = best ? Math.max(...best.nodes.slice(0, CORNERS[best.block.type]).map((n) => dist(nodes.get(n)!, centre(best!)))) : 0;
        hit = best && bd <= reach ? [best] : [];
      }
      if (!hit.length) throw new Error(`${name}: não há nenhum elemento em ${fmt(ed.at)}${ed.radius ? ` (raio ${ed.radius} mm)` : ""}`);
      hit.forEach((e) => dead.add(id(e)));
      notes.push(`${hit.length} elemento(s) apagado(s) em ${fmt(ed.at)}`);
    }
  });
  if (dead.size === tops.length) throw new Error("Edição da malha: as edições apagam todos os elementos");
  // elementos de dimensão inferior (faces/arestas das cargas e apoios) só ficam se ainda forem
  // fronteira de um elemento de topo que não foi apagado
  const owners = new Map<number, Set<string>>();
  for (const e of tops) {
    if (dead.has(id(e))) continue;
    for (const n of e.nodes.slice(0, CORNERS[e.block.type])) { let s = owners.get(n); if (!s) owners.set(n, (s = new Set())); s.add(id(e)); }
  }
  const keep = (e: El): boolean => {
    if (e.block.dim === top) return !dead.has(id(e));
    if (!dead.size) return true;
    const sets = e.nodes.slice(0, CORNERS[e.block.type]).map((n) => owners.get(n));
    if (sets.some((s) => !s)) return false;
    const [first, ...rest] = sets as Set<string>[];
    for (const x of first) if (rest.every((s) => s.has(x))) return true;
    return false;
  };
  let dropped = 0;
  const blocks: MshElementBlock[] = [];
  for (const b of m.blocks) {
    const conn: number[] = [], tags: number[] = [];
    for (const e of elements([b])) {
      if (keep(e)) { conn.push(...e.nodes); tags.push(b.tags[e.k]); }
      else if (b.dim < top) dropped++;
    }
    if (tags.length) blocks.push({ ...b, conn, tags });
  }
  if (dropped) notes.push(`${dropped} elemento(s) de fronteira retirado(s) dos grupos por deixarem de ser fronteira`);
  const used = new Set<number>();
  for (const b of blocks) b.conn.forEach((n) => used.add(n));
  for (const t of [...nodes.keys()]) if (!used.has(t)) nodes.delete(t);
  return { msh: { ...m, nodes, blocks }, notes };
}
