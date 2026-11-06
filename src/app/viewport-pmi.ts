// Rótulos PMI no 3D: elementos HTML por cima da tela, com linha de chamada (SVG) até à âncora.
import * as THREE from "three";
import type { Vec3 } from "../doc/types.ts";

/** Item PMI a mostrar: texto, ponto de ancoragem e normal da face, tipo e estado. */
export interface PmiItem { id: string; text: string; anchor: Vec3; normal: Vec3; kind: string; error: boolean; selected: boolean }

export interface PmiLabel { anchor: THREE.Vector3; at: THREE.Vector3; el: HTMLDivElement; line: SVGLineElement; stack: number }

/** Cria os rótulos (texto afastado `L` da âncora pela normal) e as linhas de chamada nas camadas dadas. */
export function buildPmiLabels(items: PmiItem[], layer: HTMLDivElement, svg: SVGSVGElement, L: number, onClick: (id: string) => void): PmiLabel[] {
  const labels: PmiLabel[] = [];
  // rótulos com a mesma âncora e normal empilham-se no ecrã (uma linha cada)
  const seen = new Map<string, number>();
  for (const it of items) {
    const key = `${it.anchor.map((x) => x.toFixed(2))}|${it.normal.map((x) => x.toFixed(2))}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    const anchor = new THREE.Vector3(...it.anchor);
    const at = anchor.clone().addScaledVector(new THREE.Vector3(...it.normal), L);
    const el = Object.assign(document.createElement("div"), { className: `pmi-label pmi-${it.kind}${it.error ? " error" : ""}${it.selected ? " on" : ""}`, textContent: it.text, title: it.error ? "PMI com erros: ver o painel" : it.text });
    el.dataset.id = it.id;
    el.addEventListener("click", () => onClick(it.id));
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    layer.append(el);
    svg.append(line);
    labels.push({ anchor, at, el, line, stack: k });
  }
  return labels;
}

/** Posiciona os rótulos e as linhas de chamada para a câmara atual. */
export function placePmiLabels(labels: PmiLabel[], camera: THREE.Camera, canvas: HTMLCanvasElement) {
  if (!labels.length) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const v = new THREE.Vector3();
  const px = (p: THREE.Vector3) => { v.copy(p).project(camera); return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h]; };
  for (const l of labels) {
    const [ax, ay] = px(l.anchor), [bx, b0] = px(l.at);
    const by = b0 + l.stack * 22;
    l.el.style.transform = `translate(${bx.toFixed(1)}px, ${by.toFixed(1)}px) translate(-50%, -50%)`;
    l.line.setAttribute("x1", ax.toFixed(1)); l.line.setAttribute("y1", ay.toFixed(1));
    l.line.setAttribute("x2", bx.toFixed(1)); l.line.setAttribute("y2", by.toFixed(1));
  }
}
