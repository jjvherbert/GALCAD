// Biblioteca de materiais do utilizador (por browser), ao lado dos materiais de referência do programa.
// Os estudos guardam uma cópia do material: editar ou apagar aqui não altera estudos já criados.
import { SIM_MATERIALS, type SimMaterial } from "../doc/study.ts";

const KEY = "cad-prototipo:materials";
const OPTIONAL = ["alpha", "k", "yield", "tangent"] as const;

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("pt") === b.trim().toLocaleLowerCase("pt");

/** Erros de um material (vazio = válido). `others` são os outros materiais do utilizador (sem este).
 *  `unread` = campos que o formulário não conseguiu ler (já com erro próprio): não são verificados de novo. */
export function validateMaterial(m: SimMaterial, others: readonly SimMaterial[], unread: ReadonlySet<keyof SimMaterial> = new Set()): string[] {
  const e: string[] = [];
  const ok = (k: keyof SimMaterial) => !unread.has(k);
  const name = m.name.trim();
  if (!name) e.push("Indique um nome.");
  else if (SIM_MATERIALS.some((x) => sameName(x.name, name))) e.push("Já existe um material de referência com este nome.");
  else if (others.some((x) => sameName(x.name, name))) e.push("Já existe um material seu com este nome.");
  else if (name === "Personalizado") e.push("«Personalizado» é reservado.");
  if (ok("E") && !(Number.isFinite(m.E) && m.E > 0)) e.push("E tem de ser positivo.");
  if (ok("nu") && !(Number.isFinite(m.nu) && m.nu >= 0 && m.nu < 0.5)) e.push("ν tem de estar entre 0 e 0,5 (exclusive).");
  if (ok("density") && !(Number.isFinite(m.density) && m.density > 0)) e.push("ρ tem de ser positiva.");
  if (ok("alpha") && m.alpha !== undefined && !Number.isFinite(m.alpha)) e.push("α tem de ser um número.");
  if (ok("k") && m.k !== undefined && !(Number.isFinite(m.k) && m.k > 0)) e.push("k tem de ser positivo (ou ficar vazio).");
  if (ok("yield") && m.yield !== undefined && !(Number.isFinite(m.yield) && m.yield > 0)) e.push("A cedência tem de ser positiva (ou ficar vazia).");
  if (ok("tangent") && ok("E") && ok("yield") && m.tangent !== undefined) {
    if (!(Number.isFinite(m.tangent) && m.tangent >= 0 && m.tangent < m.E)) e.push("Et tem de estar entre 0 e E (exclusive).");
    else if (m.yield === undefined) e.push("Et só tem significado com tensão de cedência.");
  }
  return e;
}

/** Normaliza um material vindo de fora: só os campos conhecidos, com os tipos certos. */
function clean(raw: unknown): SimMaterial | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.E !== "number" || typeof r.nu !== "number" || typeof r.density !== "number") return null;
  const m: SimMaterial = { name: r.name.trim(), E: r.E, nu: r.nu, density: r.density };
  for (const k of OPTIONAL) if (typeof r[k] === "number") m[k] = r[k];
  if (typeof r.source === "string" && r.source.trim()) m.source = r.source.trim();
  return m;
}

/** Lista guardada → materiais válidos e sem nomes repetidos (os inválidos são descartados). */
export function sanitizeMaterials(raw: unknown): SimMaterial[] {
  if (!Array.isArray(raw)) return [];
  const out: SimMaterial[] = [];
  for (const x of raw) {
    const m = clean(x);
    if (m && !validateMaterial(m, out).length) out.push(m);
  }
  return out;
}

export function loadMaterials(): SimMaterial[] {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return sanitizeMaterials(JSON.parse(s));
  } catch { /* sem armazenamento local ou lista inválida */ }
  return [];
}

export function saveMaterials(list: readonly SimMaterial[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* sem armazenamento local */ }
}

/** Materiais de referência seguidos dos do utilizador (para os seletores). */
export const allMaterials = (user: readonly SimMaterial[]): SimMaterial[] => [...SIM_MATERIALS, ...user];
