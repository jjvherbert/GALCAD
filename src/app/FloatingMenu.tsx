// Menu flutuante ancorado a um botão: vai para o <body> (um portal), em posição fixa, para não
// ficar cortado por painéis com scroll (`overflow: auto`) nem preso a antecessores animados com
// `transform` (que passam a ser o bloco de contenção do `position: fixed`). Encosta-se à direita
// do botão, fica dentro do ecrã e abre para cima quando não há espaço em baixo (sem espaço em
// nenhum lado, ganha scroll). Fecha ao escolher uma opção, com Esc, ao clicar fora, ao fazer
// scroll fora dele ou ao redimensionar a janela.
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { type Anchor, anchorOf, placeMenu } from "./place-menu.ts";

export type { Anchor };
export { anchorOf, placeMenu };

export function FloatingMenu({ anchor, onClose, class: cls = "", label, children }: {
  anchor: Anchor; onClose: () => void; class?: string; label?: string; children: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = placeMenu(anchor, el.offsetWidth, el.offsetHeight, innerWidth, innerHeight);
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.style.maxHeight = p.maxHeight === undefined ? "" : `${p.maxHeight}px`;
    el.style.transformOrigin = p.up ? "bottom right" : "top right";
    el.style.visibility = "visible";
  }, [anchor]);

  useEffect(() => {
    const out = (e: Event) => {
      const t = e.target as Node | null;
      if (t && ref.current?.contains(t)) return;
      // o botão que abriu o menu trata do próprio clique (alterna)
      if (t instanceof Element && t.closest("[data-menu-anchor]")) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    const gone = () => close.current();
    // o scroll do próprio menu (quando não cabe) não o fecha
    const scrolled = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) close.current(); };
    document.addEventListener("pointerdown", out, true);
    document.addEventListener("keydown", key);
    addEventListener("resize", gone);
    addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", out, true);
      document.removeEventListener("keydown", key);
      removeEventListener("resize", gone);
      removeEventListener("scroll", scrolled, true);
    };
  }, []);

  return createPortal(
    <div ref={ref} class={`menu floating ${cls}`} role="menu" aria-label={label}
      onClick={() => close.current()}>
      {children}
    </div>,
    document.body,
  );
}
