// Partições da malha na árvore de simulação (como as features na árvore do SolidWorks): cada uma tem
// um rótulo curto (partition-label.ts), pode ser suprimida/retomada ou apagada sem abrir o painel, e um clique leva à sua
// linha no editor da malha. Suprimir e apagar têm passo de desfazer próprio.
import type { SimMesh, Study } from "../doc/study.ts";
import { store } from "./store.ts";
import { updateStudy } from "./sim-actions.ts";

type Partition = NonNullable<SimMesh["partitions"]>[number];

function patchPartitions(s: Study, f: (p: Partition[]) => Partition[], label: string) {
  if (s.physics !== "fem") return;
  const p = f(s.mesh.partitions ?? []);
  updateStudy(s.id, { mesh: { ...s.mesh, partitions: p.length ? p : undefined } }, label);
}

/** Suprime ou retoma a partição `i` (fica na lista com o mesmo número, mas deixa de cortar). */
export function setPartitionSuppressed(s: Study, i: number, suppressed: boolean) {
  patchPartitions(s, (p) => p.map((x, k) => (k === i ? { ...x, suppressed: suppressed || undefined } : x)), suppressed ? "Suprimir partição" : "Retomar partição");
}

/** Apaga a partição `i` (as seguintes passam a ter o número anterior). */
export function deletePartition(s: Study, i: number) {
  patchPartitions(s, (p) => p.filter((_, k) => k !== i), "Apagar partição");
}

/** Abre a secção da malha e leva à linha da partição `i` no editor. */
export function focusPartition(s: Study, i: number) {
  store.set({ simStudy: s.id, simSection: "mesh", pickTarget: null, simFocus: { index: i, n: (store.state.simFocus?.n ?? 0) + 1, kind: "partition" } });
}
