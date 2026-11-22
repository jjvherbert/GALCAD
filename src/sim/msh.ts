// Leitor de malhas Gmsh MSH 4.1 (ASCII ou binário): nós, elementos por tipo e grupos físicos por nome.
// Puro (sem OCC): é usado na aplicação e no agente local (cad-runner).
import { SOLIDS, isFaceType, isLineType, isSolidType } from "./elements.ts";

export interface MshElementBlock {
  dim: number;
  entity: number;
  /**
   * Tipo Gmsh: 2/9 = triângulo de 3/6 nós, 3/16 = quadrilátero de 4/8 nós, 4/11 = tetraedro de 4/10
   * nós, 5/17 = hexaedro de 8/20 nós (ver `elements.ts`).
   */
  type: number;
  /** Ligações (tags de nós), `nodesPer` por elemento. */
  conn: number[];
  tags: number[];
}

export interface Msh {
  /** Coordenadas (x, y, z) por tag de nó. */
  nodes: Map<number, [number, number, number]>;
  blocks: MshElementBlock[];
  /** Grupos físicos: nome → { dim, tag }. */
  physicals: Map<string, { dim: number; tag: number }>;
  /** Entidade (dim, tag) → tags físicos. */
  entityPhysicals: Map<string, number[]>;
  /** Entidade (dim ≥ 1, tag) → caixa envolvente [minX, minY, minZ, maxX, maxY, maxZ]. */
  entityBox: Map<string, number[]>;
}

// 6/18 e 7/19 (prismas e pirâmides) só aparecem em malhas mistas e são lidos para dar um erro claro
export const NODES_PER: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 4, 5: 8, 6: 6, 7: 5, 8: 3, 9: 6, 11: 10, 15: 1, 16: 8, 17: 20, 18: 15, 19: 13 };

/**
 * Lê uma malha MSH 4.1. Texto: ASCII. Bytes: ASCII ou binário (a malha ao vivo pede binário ao
 * Gmsh — escreve-se e lê-se em metade do tempo).
 */
export function parseMsh(src: string | Uint8Array): Msh {
  if (typeof src !== "string") {
    const head = new TextDecoder().decode(src.subarray(0, 64));
    const fmt = /\$MeshFormat\r?\n(\S+)\s+(\S+)/.exec(head);
    if (fmt && fmt[1].startsWith("4") && fmt[2] === "1") return parseMshBinary(src);
    src = new TextDecoder().decode(src);
  }
  const text = src;
  const lines = text.split(/\r?\n/);
  let i = 0;
  const next = () => lines[i++]?.trim() ?? "";
  const nodes = new Map<number, [number, number, number]>();
  const blocks: MshElementBlock[] = [];
  const physicals = new Map<string, { dim: number; tag: number }>();
  const entityPhysicals = new Map<string, number[]>();
  const entityBox = new Map<string, number[]>();
  while (i < lines.length) {
    const l = next();
    if (l === "$MeshFormat") {
      const [ver, binary] = next().split(/\s+/);
      if (!ver.startsWith("4")) throw new Error(`Formato MSH ${ver} não suportado (usar 4.1 ASCII)`);
      if (binary !== "0") throw new Error("Malha MSH binária: exporte em ASCII");
    } else if (l === "$PhysicalNames") {
      const n = Number(next());
      for (let k = 0; k < n; k++) {
        const m = /^(\d+)\s+(\d+)\s+"(.*)"$/.exec(next());
        if (m) physicals.set(m[3], { dim: Number(m[1]), tag: Number(m[2]) });
      }
    } else if (l === "$Entities") {
      const [np, nc, ns, nv] = next().split(/\s+/).map(Number);
      const read = (dim: number, count: number) => {
        for (let k = 0; k < count; k++) {
          const v = next().split(/\s+/).map(Number);
          // ponto: tag x y z nPhys tags… ; curva/sup./volume: tag minX minY minZ maxX maxY maxZ nPhys tags… nBound …
          const off = dim === 0 ? 4 : 7;
          const nPhys = v[off];
          entityPhysicals.set(`${dim}:${v[0]}`, v.slice(off + 1, off + 1 + nPhys));
          if (dim) entityBox.set(`${dim}:${v[0]}`, v.slice(1, 7));
        }
      };
      read(0, np); read(1, nc); read(2, ns); read(3, nv);
    } else if (l === "$Nodes") {
      const [nb] = next().split(/\s+/).map(Number);
      for (let b = 0; b < nb; b++) {
        const [, , param, count] = next().split(/\s+/).map(Number);
        if (param) throw new Error("Nós paramétricos não suportados");
        const tags: number[] = [];
        for (let k = 0; k < count; k++) tags.push(Number(next()));
        for (let k = 0; k < count; k++) {
          const [x, y, z] = next().split(/\s+/).map(Number);
          nodes.set(tags[k], [x, y, z]);
        }
      }
    } else if (l === "$Elements") {
      const [nb] = next().split(/\s+/).map(Number);
      for (let b = 0; b < nb; b++) {
        const [dim, entity, type, count] = next().split(/\s+/).map(Number);
        const per = NODES_PER[type];
        if (!per) throw new Error(`Tipo de elemento Gmsh ${type} não suportado`);
        const conn: number[] = [], tags: number[] = [];
        for (let k = 0; k < count; k++) {
          const v = next().split(/\s+/).map(Number);
          tags.push(v[0]);
          for (let j = 1; j <= per; j++) conn.push(v[j]);
        }
        blocks.push({ dim, entity, type, conn, tags });
      }
    }
  }
  if (!nodes.size) throw new Error("A malha não tem nós");
  return { nodes, blocks, physicals, entityPhysicals, entityBox };
}

/** MSH 4.1 binário (Gmsh, little-endian, size_t de 8 bytes); `$PhysicalNames` vem em texto. */
function parseMshBinary(buf: Uint8Array): Msh {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const line = () => {
    let e = p;
    while (e < buf.length && buf[e] !== 10) e++;
    const s = new TextDecoder().decode(buf.subarray(p, e)).trim();
    p = e + 1;
    return s;
  };
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  // size_t: os valores cabem em 2^53 (tags e contagens)
  const sz = () => { const v = dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296; p += 8; return v; };
  const f64 = () => { const v = dv.getFloat64(p, true); p += 8; return v; };
  const nodes = new Map<number, [number, number, number]>();
  const blocks: MshElementBlock[] = [];
  const physicals = new Map<string, { dim: number; tag: number }>();
  const entityPhysicals = new Map<string, number[]>();
  const entityBox = new Map<string, number[]>();
  while (p < buf.length) {
    const l = line();
    if (l === "$MeshFormat") {
      const [, , size] = line().split(/\s+/);
      if (size !== "8") throw new Error(`Malha MSH binária com size_t de ${size} bytes não suportada`);
      if (i32() !== 1) throw new Error("Malha MSH binária big-endian não suportada");
    } else if (l === "$PhysicalNames") {
      const n = Number(line());
      for (let k = 0; k < n; k++) {
        const m = /^(\d+)\s+(\d+)\s+"(.*)"$/.exec(line());
        if (m) physicals.set(m[3], { dim: Number(m[1]), tag: Number(m[2]) });
      }
    } else if (l === "$Entities") {
      const counts = [sz(), sz(), sz(), sz()];
      for (let dim = 0; dim < 4; dim++) {
        for (let k = 0; k < counts[dim]; k++) {
          const tag = i32();
          const box = dim === 0 ? [f64(), f64(), f64()] : [f64(), f64(), f64(), f64(), f64(), f64()];
          const phys: number[] = [];
          for (let n = sz(); n > 0; n--) phys.push(i32());
          entityPhysicals.set(`${dim}:${tag}`, phys);
          if (dim) { entityBox.set(`${dim}:${tag}`, box); const nb = sz(); p += nb * 4; }
        }
      }
    } else if (l === "$Nodes") {
      const nb = sz(); p += 24;
      for (let b = 0; b < nb; b++) {
        i32(); i32();
        const param = i32(), count = sz();
        if (param) throw new Error("Nós paramétricos não suportados");
        const t0 = p;
        p += count * 8;
        for (let k = 0; k < count; k++) {
          const tag = dv.getUint32(t0 + k * 8, true) + dv.getUint32(t0 + k * 8 + 4, true) * 4294967296;
          nodes.set(tag, [f64(), f64(), f64()]);
        }
      }
    } else if (l === "$Elements") {
      const nb = sz(); p += 24;
      for (let b = 0; b < nb; b++) {
        const dim = i32(), entity = i32(), type = i32(), count = sz();
        const per = NODES_PER[type];
        if (!per) throw new Error(`Tipo de elemento Gmsh ${type} não suportado`);
        const conn: number[] = new Array(count * per), tags: number[] = new Array(count);
        for (let k = 0, c = 0; k < count; k++) {
          tags[k] = sz();
          for (let j = 0; j < per; j++) conn[c++] = sz();
        }
        blocks.push({ dim, entity, type, conn, tags });
      }
    } else if (l.startsWith("$") && !l.startsWith("$End")) {
      // secção desconhecida: salta até ao seu fim
      const end = new TextEncoder().encode(`$End${l.slice(1)}`);
      let q = p;
      outer: for (; q <= buf.length - end.length; q++) {
        for (let j = 0; j < end.length; j++) if (buf[q + j] !== end[j]) continue outer;
        break;
      }
      p = q;
    }
  }
  if (!nodes.size) throw new Error("A malha não tem nós");
  return { nodes, blocks, physicals, entityPhysicals, entityBox };
}

/** Blocos de elementos que pertencem a um grupo físico (por nome). */
export function physicalBlocks(m: Msh, name: string): MshElementBlock[] {
  const p = m.physicals.get(name);
  if (!p) return [];
  return m.blocks.filter((b) => b.dim === p.dim && (m.entityPhysicals.get(`${b.dim}:${b.entity}`) ?? []).includes(p.tag));
}

/**
 * Blocos de elementos de volume do caso (tetraedros e hexaedros): o grupo SOLID ou, nas montagens,
 * os grupos dos corpos (B1, B2, …). Prismas e pirâmides dão erro (o mesher não os deve produzir).
 */
export function solidBlocks(m: Msh, bodies?: { group: string }[]): MshElementBlock[] {
  const names = bodies?.length ? bodies.map((b) => b.group) : ["SOLID"];
  const all = names.flatMap((n) => physicalBlocks(m, n)).filter((b) => b.dim === 3);
  const other = all.find((b) => !isSolidType(b.type));
  if (other) throw new Error(`A malha tem ${[6, 18].includes(other.type) ? "prismas" : [7, 19].includes(other.type) ? "pirâmides" : `elementos do tipo Gmsh ${other.type}`}: use hexaedros estruturados, subdivisão ou tetraedros`);
  const orders = new Set(all.map((b) => SOLIDS[b.type].order));
  if (orders.size > 1) throw new Error("A malha mistura elementos lineares e quadráticos");
  return all;
}

/** Casca: blocos 2D do grupo SHELL (só triângulos, tri3/tri6 → S3/S6, sem misturar ordens). */
export function shellBlocks(m: Msh): MshElementBlock[] {
  const all = physicalBlocks(m, "SHELL").filter((b) => b.dim === 2);
  if (all.some((b) => b.type !== 2 && b.type !== 9)) throw new Error("A malha de casca tem quadriláteros: só são suportados triângulos (S3/S6)");
  if (new Set(all.map((b) => b.type)).size > 1) throw new Error("A malha de casca mistura elementos lineares e quadráticos");
  return all;
}

/** Blocos de faces de fronteira (triângulos e quadriláteros) de um grupo físico. */
export const faceBlocks = (m: Msh, name: string): MshElementBlock[] => physicalBlocks(m, name).filter((b) => isFaceType(b.type));

/** Blocos de linhas (line2/line3) de um grupo físico de arestas. */
export const edgeBlocks = (m: Msh, name: string): MshElementBlock[] => physicalBlocks(m, name).filter((b) => isLineType(b.type));

/** Elementos (nós pela ordem Gmsh) de uma lista de blocos, com o tipo de cada um. */
export function* elementsOf(blocks: MshElementBlock[]): Generator<{ type: number; nodes: number[] }> {
  for (const b of blocks) {
    const per = NODES_PER[b.type];
    for (let k = 0; k < b.conn.length; k += per) yield { type: b.type, nodes: b.conn.slice(k, k + per) };
  }
}
