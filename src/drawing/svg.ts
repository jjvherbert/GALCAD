// Primitivas → SVG (visualização na aplicação e exportação). Unidades em mm; y invertido.
import { FONT_EM, LAYER_STYLE, type Prim } from "./prims.ts";
import type { Layout } from "./render.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (x: number) => Math.round(x * 1000) / 1000;

function arcPath(c: [number, number], r: number, a0: number, a1: number, H: number): string {
  let sweep = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (sweep < 1e-9) sweep = 2 * Math.PI;
  const p0 = [c[0] + r * Math.cos(a0), H - (c[1] + r * Math.sin(a0))];
  const p1 = [c[0] + r * Math.cos(a0 + sweep), H - (c[1] + r * Math.sin(a0 + sweep))];
  if (sweep > 2 * Math.PI - 1e-6) {
    const pm = [c[0] - r * Math.cos(a0), H - (c[1] - r * Math.sin(a0))];
    return `M${n(p0[0])} ${n(p0[1])}A${n(r)} ${n(r)} 0 0 0 ${n(pm[0])} ${n(pm[1])}A${n(r)} ${n(r)} 0 0 0 ${n(p0[0])} ${n(p0[1])}`;
  }
  // y invertido: o sentido anti-horário passa a sweep-flag 0
  return `M${n(p0[0])} ${n(p0[1])}A${n(r)} ${n(r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${n(p1[0])} ${n(p1[1])}`;
}

export function primToSvg(p: Prim, H: number, extra = ""): string {
  const st = LAYER_STYLE[p.layer];
  const stroke = `stroke="${st.color}" stroke-width="${st.lw}"${st.dash ? ` stroke-dasharray="${st.dash.join(" ")}"` : ""} stroke-linecap="round" stroke-linejoin="round"`;
  const data = p.ref ? ` data-ref="${esc(p.ref)}"` : "";
  switch (p.t) {
    case "line": return `<line x1="${n(p.a[0])}" y1="${n(H - p.a[1])}" x2="${n(p.b[0])}" y2="${n(H - p.b[1])}" ${stroke}${data}${extra}/>`;
    case "poly": {
      const pts = p.pts.map((q) => `${n(q[0])},${n(H - q[1])}`).join(" ");
      const tag = p.closed || p.fill ? "polygon" : "polyline";
      return `<${tag} points="${pts}" ${p.fill ? `fill="${st.color}" stroke="${st.color}" stroke-width="0.05"` : `fill="none" ${stroke}`}${data}${extra}/>`;
    }
    case "circle": return `<circle cx="${n(p.c[0])}" cy="${n(H - p.c[1])}" r="${n(p.r)}" ${p.fill ? `fill="${st.color}"` : `fill="none" ${stroke}`}${data}${extra}/>`;
    case "arc": return `<path d="${arcPath(p.c, p.r, p.a0, p.a1, H)}" fill="none" ${stroke}${data}${extra}/>`;
    case "text": {
      const anchor = p.align === "middle" ? "middle" : p.align === "end" ? "end" : "start";
      const base = p.valign === "middle" ? "central" : p.valign === "top" ? "hanging" : "alphabetic";
      const rot = p.angle ? ` transform="rotate(${n((-p.angle * 180) / Math.PI)} ${n(p.at[0])} ${n(H - p.at[1])})"` : "";
      return `<text x="${n(p.at[0])}" y="${n(H - p.at[1])}" font-size="${n(p.h * FONT_EM)}" font-family="Helvetica, Arial, sans-serif"${p.bold ? ' font-weight="bold"' : ""} text-anchor="${anchor}" dominant-baseline="${base}" fill="${st.color}"${rot}${data}${extra}>${esc(p.text)}</text>`;
    }
  }
}

/** Documento SVG completo da folha (tamanho real em mm). */
export function toSVG(l: Layout, title = "Desenho"): string {
  const body = l.prims.map((p) => primToSvg(p, l.h)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${l.w}mm" height="${l.h}mm" viewBox="0 0 ${l.w} ${l.h}">
<title>${esc(title)}</title>
<rect width="${l.w}" height="${l.h}" fill="#ffffff"/>
${body}
</svg>
`;
}
