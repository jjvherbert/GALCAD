// Onde pôr um menu flutuante junto ao botão que o abre (lógica pura do FloatingMenu, testável).
export interface Anchor { top: number; bottom: number; left: number; right: number }

const GAP = 2;
const MARGIN = 4;

/** O retângulo do botão que abre o menu (copiado: o elemento pode ser re-renderizado). */
export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

/**
 * Onde pôr um menu w×h junto à âncora, numa janela vw×vh (pura, para testar). Abre por baixo; se
 * não couber, para cima; se não couber em nenhum lado, no lado com mais espaço e com `maxHeight`
 * (o menu passa a ter scroll) — nunca por cima do próprio botão.
 */
export function placeMenu(a: Anchor, w: number, h: number, vw: number, vh: number): { top: number; left: number; up: boolean; maxHeight?: number } {
  const left = Math.max(MARGIN, Math.min(a.right - w, vw - w - MARGIN));
  const below = a.bottom + GAP;
  const roomBelow = vh - MARGIN - below;
  const roomAbove = a.top - GAP - MARGIN;
  if (h <= roomBelow) return { top: below, left, up: false };
  if (h <= roomAbove) return { top: a.top - GAP - h, left, up: true };
  if (roomBelow >= roomAbove) return { top: below, left, up: false, maxHeight: Math.max(0, roomBelow) };
  return { top: MARGIN, left, up: true, maxHeight: roomAbove };
}
