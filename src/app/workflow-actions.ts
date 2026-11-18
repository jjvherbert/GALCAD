// Ações do fluxo guiado (C1a) ligadas ao store: escolher o tipo de estudo, concluir um passo e
// seguir para o próximo, ir para um passo. A lógica pura está em `workflow.ts`.
import { type FemStudy, newFemStudy } from "../doc/study.ts";
import { store } from "./store.ts";
import { activeStudy, addStudy, currentGeom, markStepsDone, updateStudy } from "./sim-actions.ts";
import { type StepId, type StepInfo, type StudyTypeId, STEP_SECTION, STUDY_TYPES, diffTypeChange, firstOpenStep, nextStep, sectionStep, stepStates, studyTypeLabel, studyTypePatch } from "./workflow.ts";

/** O estudo FEM ativo (ou nada). */
function fem(): FemStudy | undefined {
  const s = activeStudy("fem");
  return s?.physics === "fem" ? s : undefined;
}

/** Abrir a secção do passo. */
export function goToStep(step: StepId) {
  store.set({ simSection: STEP_SECTION[step] });
}

/** O estado de todos os passos do estudo ativo, com a geometria do documento aberto. */
export function activeStepStates(s: FemStudy): StepInfo[] {
  return stepStates(s, currentGeom(), !!store.activeAssembly());
}

/** O primeiro passo por fazer do estudo (onde entrar no espaço FEM). */
export function firstOpenSection(s: FemStudy) {
  return STEP_SECTION[firstOpenStep(s, currentGeom(), !!store.activeAssembly())];
}

/**
 * Escolher o tipo de estudo: cria o estudo se ainda não há nenhum; senão aplica o patch do tipo,
 * a pedir confirmação quando muda o solver, a ordem da malha ou remove condições. Conclui o passo
 * «Estudo» e segue para o Material.
 */
export function chooseStudyType(type: StudyTypeId): boolean {
  const t = STUDY_TYPES.find((x) => x.id === type);
  if (!t || t.disabled) return false;
  let s = fem();
  if (!s) {
    const id = addStudy("fem", studyTypePatch(newFemStudy("tmp", 0), type));
    if (!id) return false;
    s = fem();
  } else {
    const { patch, changes, destructive } = diffTypeChange(s, type);
    if (destructive && !confirm(`Mudar o estudo para «${studyTypeLabel(type)}»?\n\n${changes.map((c) => `• ${c}`).join("\n")}`)) return false;
    if (Object.keys(patch).length) updateStudy(s.id, patch);
  }
  if (!s) return false;
  markStepsDone(s.id, ["estudo"], "Tipo de estudo");
  goToStep(nextStep("estudo", !!store.activeAssembly()));
  return true;
}

/** Concluir o passo da secção aberta e seguir para o próximo passo. */
export function completeAndNext() {
  const s = fem();
  if (!s) return;
  const step = sectionStep(store.state.simSection);
  markStepsDone(s.id, [step]);
  goToStep(nextStep(step, !!store.activeAssembly()));
}
