// Desenho em janela própria: a janela nova abre a mesma aplicação com `?drawing=<id>` e partilha o projeto
// pelo armazenamento local (autosave), que as janelas sincronizam entre si.
import type { CadProject } from "../doc/project.ts";

/** Desenho pedido no endereço (`?drawing=<id>`), se existir no projeto. */
export function drawingFromUrl(project: CadProject, search: string): string | null {
  const id = new URLSearchParams(search).get("drawing");
  return id && project.drawings.some((d) => d.id === id) ? id : null;
}

/** Endereço da janela própria de um desenho, na mesma página da aplicação. */
export function drawingWindowUrl(pathname: string, id: string): string {
  return `${pathname}?drawing=${encodeURIComponent(id)}`;
}
