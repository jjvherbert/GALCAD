// Leitor de malhas Gmsh MSH 4.1 (ASCII): nós, elementos por tipo e grupos físicos por nome.
// Puro (sem OCC): é usado na aplicação e no agente local (cad-runner).

export interface MshElementBlock {
  dim: number;
  entity: number;
  /** Tipo Gmsh: 2 = triângulo 3 nós, 9 = triângulo 6 nós, 4 = tetraedro 4 nós, 11 = tetraedro 10 nós. */
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
}

export const NODES_PER: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 4, 8: 3, 9: 6, 11: 10, 15: 1 };

export function parseMsh(text: string): Msh {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const next = () => lines[i++]?.trim() ?? "";
  const nodes = new Map<number, [number, number, number]>();
  const blocks: MshElementBlock[] = [];
  const physicals = new Map<string, { dim: number; tag: number }>();
  const entityPhysicals = new Map<string, number[]>();
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
  return { nodes, blocks, physicals, entityPhysicals };
}

/** Blocos de elementos que pertencem a um grupo físico (por nome). */
export function physicalBlocks(m: Msh, name: string): MshElementBlock[] {
  const p = m.physicals.get(name);
  if (!p) return [];
  return m.blocks.filter((b) => b.dim === p.dim && (m.entityPhysicals.get(`${b.dim}:${b.entity}`) ?? []).includes(p.tag));
}

/** Blocos de tetraedros do caso: o grupo SOLID ou, nas montagens, os grupos dos corpos (B1, B2, …). */
export function solidBlocks(m: Msh, bodies?: { group: string }[]): MshElementBlock[] {
  const names = bodies?.length ? bodies.map((b) => b.group) : ["SOLID"];
  return names.flatMap((n) => physicalBlocks(m, n)).filter((b) => b.type === 4 || b.type === 11);
}
