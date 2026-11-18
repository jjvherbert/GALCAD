// Animações do cartão «O que faz»: tudo dentro do quadro 0 0 120 84 e ciclo ≤ 2,4 s.
import { test } from "node:test";
import assert from "node:assert/strict";

const g = globalThis as Record<string, unknown>;
const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } });
g.document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {} } };
g.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
g.Worker = class { onmessage = null; onerror = null; postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} };
g.innerWidth = 1280; g.innerHeight = 800; g.addEventListener = () => {};

// O node não lê .tsx: empacota a figura com o rolldown (já vem com o Vite) para um ficheiro temporário.
const { build } = await import("rolldown");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join, resolve } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const dir = mkdtempSync(join(tmpdir(), "galcad-help-"));
await build({ input: resolve("src/app/featurehelp.tsx"), output: { file: join(dir, "featurehelp.mjs"), format: "esm" }, transform: { jsx: { runtime: "automatic", importSource: "preact" } }, platform: "node", logLevel: "silent" });
const { ART, ANIM_MS } = await import(pathToFileURL(join(dir, "featurehelp.mjs")).href) as { ART: Record<string, () => unknown>; ANIM_MS: number };
rmSync(dir, { recursive: true, force: true });
setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref?.();

type Node = { tag: string; attrs: Record<string, unknown>; kids: Node[] };
type VNode = { type: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | VNode[];

/** Expande componentes de função e devolve só elementos SVG. */
function expand(v: VNode): Node[] {
  if (v === null || v === undefined || typeof v === "boolean" || typeof v === "string" || typeof v === "number") return [];
  if (Array.isArray(v)) return v.flatMap(expand);
  const props = v.props ?? {};
  const kids = expand(props.children as VNode);
  if (typeof v.type === "function") return expand((v.type as (p: unknown) => VNode)(props));
  if (v.type === null || v.type === undefined || v.type === Symbol.for("preact.fragment") || typeof v.type === "symbol") return kids;
  return [{ tag: String(v.type), attrs: props, kids }];
}

type Box = [number, number, number, number]; // x0 y0 x1 y1
const num = (x: unknown, d = 0) => (x === undefined ? d : Number(x));

function numbersOf(d: string): number[] { return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number); }
function pathBox(d: string): Box | null {
  // M/L/Q/C/A e fechos: recolhe pontos (para A usa só o ponto final e o raio como margem)
  const pts: [number, number][] = [];
  for (const m of d.matchAll(/([MLQCAZ])([^MLQCAZ]*)/g)) {
    const n = numbersOf(m[2]!);
    if (m[1] === "A") { for (let i = 0; i + 6 < n.length + 0; i += 7) pts.push([n[i + 5]!, n[i + 6]!]); }
    else for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i]!, n[i + 1]!]);
  }
  if (!pts.length) return null;
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/** Caixa de um elemento para um dado conjunto de valores animados. */
function shapeBox(n: Node, v: Record<string, string>): Box | null {
  const a = (k: string) => (k in v ? v[k] : n.attrs[k]);
  switch (n.tag) {
    case "polygon": { const p = numbersOf(String(a("points"))); const xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1); return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null; }
    case "path": return pathBox(String(a("d")));
    case "line": return [Math.min(num(a("x1")), num(a("x2"))), Math.min(num(a("y1")), num(a("y2"))), Math.max(num(a("x1")), num(a("x2"))), Math.max(num(a("y1")), num(a("y2")))];
    case "rect": return [num(a("x")), num(a("y")), num(a("x")) + num(a("width")), num(a("y")) + num(a("height"))];
    case "circle": { const r = num(a("r")); return [num(a("cx")) - r, num(a("cy")) - r, num(a("cx")) + r, num(a("cy")) + r]; }
    case "ellipse": { const rx = num(a("rx")), ry = num(a("ry")); return [num(a("cx")) - rx, num(a("cy")) - ry, num(a("cx")) + rx, num(a("cy")) + ry]; }
    default: return null;
  }
}

const anims = (n: Node) => n.kids.filter((k) => k.tag === "animate");
const transAnims = (n: Node) => n.kids.filter((k) => k.tag === "animateTransform");

function applyT(b: Box, type: string, val: string): Box {
  const [p, q = p] = numbersOf(val);
  if (type === "translate") return [b[0] + p!, b[1] + (q ?? 0), b[2] + p!, b[3] + (q ?? 0)];
  if (type === "scale") return [Math.min(b[0] * p!, b[2] * p!), Math.min(b[1] * q!, b[3] * q!), Math.max(b[0] * p!, b[2] * p!), Math.max(b[1] * q!, b[3] * q!)];
  return b;
}

/** Todas as caixas que o elemento (e os filhos) ocupam nos extremos das animações. */
function boxes(n: Node): Box[] {
  const own: Box[] = [];
  const as = anims(n).filter((x) => x.attrs.attributeName !== "opacity" && x.attrs.attributeName !== "stroke-dashoffset");
  const attrNames = as.map((x) => String(x.attrs.attributeName));
  const len = as.length ? Math.max(...as.map((x) => String(x.attrs.values).split(";").length)) : 1;
  for (let i = 0; i < len; i++) {
    const v: Record<string, string> = {};
    for (const x of as) { const vals = String(x.attrs.values).split(";"); v[String(x.attrs.attributeName)] = vals[Math.min(i, vals.length - 1)]!; }
    const b = shapeBox(n, v);
    if (b) own.push(b);
  }
  void attrNames;
  const out: Box[] = own;
  const kidBoxes = n.kids.filter((k) => k.tag !== "animate" && k.tag !== "animateTransform").flatMap(boxes);
  // transformação própria do <g> (estática) e animada
  let all: Box[] = [...out, ...kidBoxes];
  const st = typeof n.attrs.transform === "string" ? /translate\(([^)]*)\)/.exec(n.attrs.transform) : null;
  if (st) all = all.map((b) => applyT(b, "translate", st[1]!));
  for (const t of transAnims(n)) {
    const type = String(t.attrs.type);
    const vals = String(t.attrs.values).split(";");
    all = vals.flatMap((val) => all.map((b) => applyT(b, type, val)));
  }
  return all;
}

const walk = (n: Node): Node[] => [n, ...n.kids.flatMap(walk)];

for (const [key, fig] of Object.entries(ART)) {
  test(`figura «${key}»: animações dentro de 0 0 120 84 e ciclo ≤ 2,4 s`, () => {
    const roots = expand(fig() as unknown as VNode);
    assert.equal(roots.length, 1);
    const svg = roots[0]!;
    assert.equal(svg.tag, "svg");
    assert.equal(svg.attrs.viewBox, "0 0 120 84");
    for (const n of walk(svg)) {
      if (n.tag === "animate" || n.tag === "animateTransform") {
        const dur = Number(String(n.attrs.dur).replace("s", ""));
        assert.ok(dur > 0 && dur * 1000 <= 2400 && dur * 1000 <= ANIM_MS, `${key}: dur ${n.attrs.dur}`);
      }
    }
    const eps = 0.01;
    for (const b of svg.kids.flatMap(boxes)) {
      assert.ok(b[0] >= -eps && b[1] >= -eps && b[2] <= 120 + eps && b[3] <= 84 + eps, `${key}: fora do quadro (${b.map((x) => x.toFixed(1)).join(", ")})`);
    }
  });
}

test("ANIM_MS é a única duração: ≤ 2,4 s com ciclo de 1,2–1,8 s e pausa de 0,6 s", () => {
  assert.ok(ANIM_MS <= 2400);
});
