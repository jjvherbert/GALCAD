// Rótulo curto de um comando de gesto (HUD e definições). `sk:<ferramenta>` são as ferramentas do esboço,
// `sk:exit` sai do esboço; o resto são comandos da paleta.
import { commandById } from "./commands.ts";
import { TOOLS } from "./sketch-types.ts";

export function gestureLabel(id: string): string {
  if (id === "sk:exit") return "Sair do esboço";
  if (id.startsWith("sk:")) return TOOLS.find((t) => t.id === id.slice(3))?.label ?? "—";
  return commandById.get(id)?.label.replace(/^Vista /, "") ?? "—";
}
