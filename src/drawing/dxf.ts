// Primitivas → DXF R12 (AC1009, ASCII), em mm, com camadas e tipos de linha ISO. Abre em qualquer
// CAD (LibreCAD, QCAD, FreeCAD, AutoCAD, DraftSight…). O DWG é um formato fechado e não é escrito;
// pode converter-se o DXF com ferramentas externas.
import { LAYER_STYLE, type Layer, type Prim } from "./prims.ts";
import type { Layout } from "./render.ts";

const n = (x: number) => (Math.round(x * 1e4) / 1e4).toString();
const deg = (a: number) => n((((a * 180) / Math.PI) % 360 + 360) % 360);

/** Texto em ANSI 1252 com os códigos de controlo DXF para ⌀, ° e ±. */
const dxfText = (s: string) => s.replace(/⌀/g, "%%c").replace(/°/g, "%%d").replace(/±/g, "%%p").replace(/[−–—]/g, "-");

function pairs(...kv: (string | number)[]): string {
  let s = "";
  for (let i = 0; i < kv.length; i += 2) s += `${kv[i]}\n${kv[i + 1]}\n`;
  return s;
}

const LTYPES = [
  { name: "CONTINUOUS", desc: "Solid line", pattern: [] as number[] },
  { name: "DASHED", desc: "__ __ __", pattern: [3, -1.5] },
  { name: "CENTER", desc: "____ _ ____", pattern: [8, -1.5, 1, -1.5] },
];

export function toDXF(l: Layout): Uint8Array {
  const layers = [...new Set(l.prims.map((p) => p.layer))] as Layer[];
  let s = pairs(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 9, "$DWGCODEPAGE", 3, "ANSI_1252", 9, "$INSUNITS", 70, 4,
    9, "$EXTMIN", 10, 0, 20, 0, 9, "$EXTMAX", 10, n(l.w), 20, n(l.h), 9, "$LTSCALE", 40, 1, 0, "ENDSEC");
  s += pairs(0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "LTYPE", 70, LTYPES.length);
  for (const t of LTYPES) {
    s += pairs(0, "LTYPE", 2, t.name, 70, 0, 3, t.desc, 72, 65, 73, t.pattern.length, 40, n(t.pattern.reduce((a, b) => a + Math.abs(b), 0)));
    for (const d of t.pattern) s += pairs(49, n(d));
  }
  s += pairs(0, "ENDTAB", 0, "TABLE", 2, "LAYER", 70, layers.length);
  for (const ly of layers) s += pairs(0, "LAYER", 2, ly.toUpperCase(), 70, 0, 62, LAYER_STYLE[ly].dxfColor, 6, LAYER_STYLE[ly].dxfLtype);
  s += pairs(0, "ENDTAB", 0, "TABLE", 2, "STYLE", 70, 1, 0, "STYLE", 2, "STANDARD", 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, 2.5, 3, "txt", 4, "", 0, "ENDTAB", 0, "ENDSEC");
  s += pairs(0, "SECTION", 2, "ENTITIES");
  for (const p of l.prims) s += entity(p);
  s += pairs(0, "ENDSEC", 0, "EOF");
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i] = c < 256 ? c : 0x3f; }
  return out;
}

function entity(p: Prim): string {
  const L = p.layer.toUpperCase();
  switch (p.t) {
    case "line": return pairs(0, "LINE", 8, L, 10, n(p.a[0]), 20, n(p.a[1]), 30, 0, 11, n(p.b[0]), 21, n(p.b[1]), 31, 0);
    case "circle":
      if (p.fill) return pairs(0, "CIRCLE", 8, L, 10, n(p.c[0]), 20, n(p.c[1]), 30, 0, 40, n(p.r)) + pairs(0, "CIRCLE", 8, L, 10, n(p.c[0]), 20, n(p.c[1]), 30, 0, 40, n(p.r / 2));
      return pairs(0, "CIRCLE", 8, L, 10, n(p.c[0]), 20, n(p.c[1]), 30, 0, 40, n(p.r));
    case "arc": return pairs(0, "ARC", 8, L, 10, n(p.c[0]), 20, n(p.c[1]), 30, 0, 40, n(p.r), 50, deg(p.a0), 51, deg(p.a1));
    case "poly": {
      if (p.fill && p.pts.length === 3) {
        const [a, b, c] = p.pts;
        return pairs(0, "SOLID", 8, L, 10, n(a[0]), 20, n(a[1]), 30, 0, 11, n(b[0]), 21, n(b[1]), 31, 0, 12, n(c[0]), 22, n(c[1]), 32, 0, 13, n(c[0]), 23, n(c[1]), 33, 0);
      }
      let s = pairs(0, "POLYLINE", 8, L, 66, 1, 70, p.closed || p.fill ? 1 : 0, 10, 0, 20, 0, 30, 0);
      for (const q of p.pts) s += pairs(0, "VERTEX", 8, L, 10, n(q[0]), 20, n(q[1]), 30, 0);
      return s + pairs(0, "SEQEND", 8, L);
    }
    case "text": {
      const h = p.h;
      const ang = p.angle ?? 0;
      const hal = p.align === "middle" ? 1 : p.align === "end" ? 2 : 0;
      const val = p.valign === "middle" ? 2 : p.valign === "top" ? 3 : 0;
      const base = pairs(0, "TEXT", 8, L, 10, n(p.at[0]), 20, n(p.at[1]), 30, 0, 40, n(h), 1, dxfText(p.text), 50, deg(ang));
      if (!hal && !val) return base;
      return base + pairs(72, hal, 73, val, 11, n(p.at[0]), 21, n(p.at[1]), 31, 0);
    }
  }
}
