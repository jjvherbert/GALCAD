// Malha ao vivo (C9b): chave do que a malha depende, agendamento com debounce que nunca corre
// duas malhas ao mesmo tempo, cache das últimas malhas e fase do Gmsh lida do registo.
// Puro: não importa o store (os testes correm em node).
import type { FemStudy, SimMesh } from "../doc/study.ts";
import { stableJson } from "./workflow.ts";

/**
 * Chave da malha ao vivo: só existe com a opção ligada, o agente e um estudo FEM ativo. Muda com
 * o documento, o estudo, a geometria (`geom`: `geomRev`), os materiais e as definições da malha.
 */
export function liveMeshKey(k: {
  on: boolean; token: string; doc: string; studyId?: string; geom: string; materials: string; mesh?: SimMesh;
}): string | null {
  return k.on && k.token && k.studyId && k.mesh ? `${k.doc}|${k.studyId}|${k.geom}|${k.materials}|${stableJson(k.mesh)}` : null;
}

/** Impressão dos materiais do estudo (o agente separa os corpos/grupos da malha por material). */
export function materialsRev(s: Pick<FemStudy, "material" | "bodyMaterials" | "sets">): string {
  return stableJson([s.material, s.bodyMaterials ?? {}, (s.sets ?? []).map((x) => x.material ?? null)]);
}

/** Documento a que a chave pertence (primeiro campo). */
export const keyDoc = (key: string) => key.slice(0, key.indexOf("|"));

export type LiveRun = "ok" | "error" | "cancelled";

/**
 * Agendamento da malha ao vivo. `update(key)` a cada alteração: depois de `delay` ms sem mudanças
 * corre `run(key)` para a última chave. Nunca há duas malhas em curso: uma chave nova durante uma
 * malha pede `cancel()` e, quando essa acaba, corre a mais recente. Uma chave que já deu certo
 * (`last`) ou falhou (`failed`) não volta a correr sozinha — falhar não entra em ciclo. `blocked()`
 * (p. ex. um cálculo completo em curso) adia: o próximo `update` com a mesma chave retoma.
 * `null` (opção desligada, fora do FEM…) cancela a malha em curso.
 */
export function liveMeshScheduler(run: (key: string) => Promise<LiveRun>, o: {
  delay?: number; blocked?: () => boolean; cancel?: () => void;
} = {}) {
  const delay = o.delay ?? 800;
  let want: string | null = null, last: string | null = null, failed: string | null = null, running: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(timer); timer = setTimeout(fire, delay); };
  const pending = () => want !== null && want !== last && want !== failed;
  function fire() {
    timer = undefined;
    if (!pending()) return;
    if (running) { if (running !== want) o.cancel?.(); return; }
    if (o.blocked?.()) return;
    const key = want!;
    running = key;
    void run(key).then((r) => r, () => "error" as const).then((r) => {
      if (r === "ok") last = key;
      else if (r === "error") failed = key;
      running = null;
      if (pending() && timer === undefined) fire();
    });
  }
  return function update(key: string | null) {
    if (key !== want) {
      want = key;
      failed = null;
      clearTimeout(timer);
      timer = undefined;
      if (key === null) { if (running) o.cancel?.(); return; }
      arm();
    } else if (key !== null && timer === undefined && !running && pending()) arm();
  };
}

/** Cache LRU pequena (as últimas `n` malhas por chave): voltar atrás numa edição não refaz a malha. */
export function lru<V>(n: number) {
  const m = new Map<string, V>();
  return {
    get(k: string): V | undefined {
      const v = m.get(k);
      if (v !== undefined) { m.delete(k); m.set(k, v); }
      return v;
    },
    set(k: string, v: V) {
      m.delete(k);
      m.set(k, v);
      while (m.size > n) m.delete(m.keys().next().value!);
    },
    get size() { return m.size; },
  };
}

// fases do Gmsh pela ordem, com a fração do total que ocupam
const PHASES: { re: RegExp; label: string; from: number; to: number }[] = [
  { re: /Meshing 1D/i, label: "Malha 1D (arestas)", from: 0, to: 0.1 },
  { re: /Meshing 2D/i, label: "Malha 2D (faces)", from: 0.1, to: 0.4 },
  { re: /Meshing 3D/i, label: "Malha 3D (volumes)", from: 0.4, to: 0.85 },
  { re: /Optimiz|Meshing order/i, label: "A otimizar a malha", from: 0.85, to: 0.95 },
  { re: /Writing /i, label: "A escrever a malha", from: 0.95, to: 1 },
];

/**
 * Fase da malha a partir da cauda do registo do Gmsh: a última linha de fase conhecida dá o
 * rótulo e a faixa; o «[ NN%]» mais recente dentro dessa fase avança dentro da faixa.
 * `null` sem nenhuma linha reconhecida (fica a barra indeterminada).
 */
export function meshPhase(tail: string): { label: string; frac: number } | null {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ph = PHASES.find((p) => p.re.test(lines[i]));
    if (!ph) continue;
    let pct: number | null = null;
    for (let j = lines.length - 1; j > i && pct === null; j--) {
      const m = /\[\s*(\d{1,3})%\]/.exec(lines[j]);
      if (m) pct = Math.min(100, Number(m[1]));
    }
    const m0 = /\[\s*(\d{1,3})%\]/.exec(lines[i]);
    if (pct === null && m0) pct = Math.min(100, Number(m0[1]));
    return { label: ph.label, frac: ph.from + (ph.to - ph.from) * (pct ?? 0) / 100 };
  }
  return null;
}
