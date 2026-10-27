// Primitivas → PDF 1.4 vetorial (uma página do tamanho da folha), com Helvetica (WinAnsi).
// O símbolo ⌀ não existe na Helvetica: desenha-se como círculo com traço.
import { FONT_EM, LAYER_STYLE, charWidth, type Prim } from "./prims.ts";
import type { Layout } from "./render.ts";

const PT = 72 / 25.4;
const f = (x: number) => (Math.round(x * PT * 1000) / 1000).toString();

/** Carácter → byte WinAnsi (ou "?"). */
function winAnsi(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c < 128 || (c >= 0xa0 && c <= 0xff)) return c;
  const map: Record<string, number> = { "€": 0x80, "…": 0x85, "•": 0x95, "–": 0x96, "—": 0x97, "−": 0x2d, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94 };
  return map[ch] ?? 0x3f;
}

const pdfString = (s: string) => "(" + [...s].map((ch) => {
  const b = winAnsi(ch);
  if (b === 0x28 || b === 0x29 || b === 0x5c) return "\\" + String.fromCharCode(b);
  return b < 32 || b > 126 ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b);
}).join("") + ")";

/** Arco em curvas de Bézier cúbicas (segmentos ≤ 90°). */
function arcOps(cx: number, cy: number, r: number, a0: number, a1: number, move: boolean): string {
  let sweep = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (sweep < 1e-9) sweep = 2 * Math.PI;
  const n = Math.ceil(sweep / (Math.PI / 2));
  const d = sweep / n;
  const k = (4 / 3) * Math.tan(d / 4) * r;
  let out = move ? `${f(cx + r * Math.cos(a0))} ${f(cy + r * Math.sin(a0))} m\n` : "";
  for (let i = 0; i < n; i++) {
    const t0 = a0 + i * d, t1 = t0 + d;
    const p0 = [cx + r * Math.cos(t0), cy + r * Math.sin(t0)], p3 = [cx + r * Math.cos(t1), cy + r * Math.sin(t1)];
    const p1 = [p0[0] - k * Math.sin(t0), p0[1] + k * Math.cos(t0)], p2 = [p3[0] + k * Math.sin(t1), p3[1] - k * Math.cos(t1)];
    out += `${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])} c\n`;
  }
  return out;
}

function style(p: Prim): string {
  const st = LAYER_STYLE[p.layer];
  const rgb = st.color === "#000000" ? "0 0 0" : [1, 3, 5].map((i) => (parseInt(st.color.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
  return `${f(st.lw)} w ${rgb} RG ${rgb} rg [${(st.dash ?? []).map(f).join(" ")}] 0 d\n`;
}

function textOps(p: Extract<Prim, { t: "text" }>): string {
  const size = p.h * FONT_EM;
  const width = [...p.text].reduce((w, ch) => w + charWidth(ch), 0) / 1000 * size;
  const ang = p.angle ?? 0;
  const c = Math.cos(ang), s = Math.sin(ang);
  let dx = p.align === "middle" ? -width / 2 : p.align === "end" ? -width : 0;
  const dy = p.valign === "middle" ? -p.h / 2 : p.valign === "top" ? -p.h : 0;
  let out = "";
  // corridas de texto normal e símbolos ⌀ desenhados
  for (const run of p.text.split(/(⌀)/)) {
    if (!run) continue;
    const x = p.at[0] + dx * c - dy * s, y = p.at[1] + dx * s + dy * c;
    if (run === "⌀") {
      const w = (charWidth("⌀") / 1000) * size;
      const r = p.h * 0.42;
      const cx = x + (w / 2) * c - (p.h / 2) * s, cy = y + (w / 2) * s + (p.h / 2) * c;
      out += `${f(p.h * 0.09)} w ` + arcOps(cx, cy, r, 0, 2 * Math.PI, true) + "S\n";
      const ex = (r * 1.25) * Math.cos(ang + Math.PI / 3), ey = (r * 1.25) * Math.sin(ang + Math.PI / 3);
      out += `${f(cx - ex)} ${f(cy - ey)} m ${f(cx + ex)} ${f(cy + ey)} l S\n`;
      dx += w;
      continue;
    }
    out += `BT /${p.bold ? "F2" : "F1"} ${f(size)} Tf ${c.toFixed(5)} ${s.toFixed(5)} ${(-s).toFixed(5)} ${c.toFixed(5)} ${f(x)} ${f(y)} Tm ${pdfString(run)} Tj ET\n`;
    dx += [...run].reduce((w, ch) => w + charWidth(ch), 0) / 1000 * size;
  }
  return out;
}

export function toPDF(l: Layout, title = "Desenho"): Uint8Array {
  let content = "1 J 1 j\n";
  for (const p of l.prims) {
    content += style(p);
    switch (p.t) {
      case "line": content += `${f(p.a[0])} ${f(p.a[1])} m ${f(p.b[0])} ${f(p.b[1])} l S\n`; break;
      case "poly": content += p.pts.map((q, i) => `${f(q[0])} ${f(q[1])} ${i ? "l" : "m"}`).join(" ") + (p.closed || p.fill ? " h" : "") + (p.fill ? " f\n" : " S\n"); break;
      case "circle": content += arcOps(p.c[0], p.c[1], p.r, 0, 2 * Math.PI, true) + (p.fill ? "f\n" : "S\n"); break;
      case "arc": content += arcOps(p.c[0], p.c[1], p.r, p.a0, p.a1, true) + "S\n"; break;
      case "text": content += "[] 0 d " + textOps(p); break;
    }
  }
  const W = f(l.w), H = f(l.h);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title ${pdfString(title)} /Producer (CAD prototipo) >>`,
  ];
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // o texto do PDF já está em bytes WinAnsi (um carácter por byte)
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
