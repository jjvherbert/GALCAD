// Malha ao vivo: com as seeds em edição e a opção ligada, a malha completa (elementos, pelo Gmsh do agente)
// volta a ser gerada depois de uma pausa nas alterações; um pedido de malha anterior ainda em curso é parado.
import type { SimMesh } from "../doc/study.ts";

/** Chave das definições que mudam a malha; `null` quando a malha ao vivo não se aplica. */
export function liveMeshKey(on: boolean, token: string, editingSeed: boolean, studyId: string | undefined, mesh: SimMesh | undefined): string | null {
  return on && token && editingSeed && studyId && mesh ? `${studyId}|${JSON.stringify(mesh)}` : null;
}

/** Agenda a malha: só quando a chave muda; `run` recebe a chave e corre depois de `delay` ms sem alterações. */
export function liveMeshScheduler(run: () => void, delay = 800) {
  let last: string | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  return (key: string | null) => {
    if (key === last) return;
    last = key;
    clearTimeout(timer);
    if (key) timer = setTimeout(run, delay);
  };
}
