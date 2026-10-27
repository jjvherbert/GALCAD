// Avaliador de expressões seguro (sem eval). Comprimentos em mm, ângulos em graus.
//
// Sintaxe: números (com sufixo de unidade opcional: mm, cm, m, in, deg, rad), variáveis,
// + - * / % ^ (potência, associativa à direita), parênteses e funções.
// Comparações (< <= > >= == !=) e lógica (and/&&, or/||, not/!) dão 1 ou 0, para regras e
// verificações: if(L > 100 and t < 3, 5, 3). Trigonometria em graus: sin(30) = 0.5, asin(0.5) = 30.

export class ExprError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

type Node =
  | { k: "num"; v: number }
  | { k: "var"; name: string; pos: number }
  | { k: "neg"; a: Node }
  | { k: "not"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[]; pos: number };

const UNITS: Record<string, number> = {
  mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8,
  deg: 1, rad: 180 / Math.PI,
};

const D2R = Math.PI / 180;
const FUNCS: Record<string, { n: [number, number]; f: (...a: number[]) => number }> = {
  sin: { n: [1, 1], f: (a) => Math.sin(a * D2R) },
  cos: { n: [1, 1], f: (a) => Math.cos(a * D2R) },
  tan: { n: [1, 1], f: (a) => Math.tan(a * D2R) },
  asin: { n: [1, 1], f: (a) => Math.asin(a) / D2R },
  acos: { n: [1, 1], f: (a) => Math.acos(a) / D2R },
  atan: { n: [1, 1], f: (a) => Math.atan(a) / D2R },
  atan2: { n: [2, 2], f: (y, x) => Math.atan2(y, x) / D2R },
  sqrt: { n: [1, 1], f: Math.sqrt },
  abs: { n: [1, 1], f: Math.abs },
  exp: { n: [1, 1], f: Math.exp },
  ln: { n: [1, 1], f: Math.log },
  log: { n: [1, 1], f: Math.log10 },
  pow: { n: [2, 2], f: Math.pow },
  round: { n: [1, 1], f: Math.round },
  floor: { n: [1, 1], f: Math.floor },
  ceil: { n: [1, 1], f: Math.ceil },
  min: { n: [1, 64], f: Math.min },
  max: { n: [1, 64], f: Math.max },
  if: { n: [3, 3], f: (c, a, b) => (c ? a : b) }, // if(cond, sim, não): cond ≠ 0
  clamp: { n: [3, 3], f: (x, a, b) => Math.min(Math.max(x, a), b) },
  sign: { n: [1, 1], f: Math.sign },
};
/** Palavras reservadas dos operadores lógicos. */
const WORD_OPS: Record<string, string> = { and: "&&", or: "||", not: "!" };
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { t: "num" | "id" | "op" | "end"; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`Número inválido`, i);
      toks.push({ t: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[\p{L}_]/u.test(ch)) {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i))!;
      toks.push(m[0] in WORD_OPS ? { t: "op", v: WORD_OPS[m[0]], pos: i } : { t: "id", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) { toks.push({ t: "op", v: two, pos: i }); i += 2; continue; }
    if ("+-*/%^(),<>!".includes(ch)) { toks.push({ t: "op", v: ch, pos: i }); i++; continue; }
    throw new ExprError(`Carácter inesperado "${ch}"`, i);
  }
  toks.push({ t: "end", v: "", pos: src.length });
  return toks;
}

/** Converte texto numa árvore. Lança ExprError com a posição do erro. */
export function parse(src: string): Node {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const eat = (v?: string) => {
    const t = toks[i];
    if (v !== undefined && t.v !== v) throw new ExprError(t.t === "end" ? `Falta "${v}"` : `Esperava "${v}"`, t.pos);
    i++;
    return t;
  };

  const isOp = (...v: string[]) => peek().t === "op" && v.includes(peek().v);
  // expr := and ("||" and)* ; and := cmp ("&&" cmp)* ; cmp := sum (("<"|"<="|…) sum)?
  const expr = (): Node => {
    let a = and();
    while (isOp("||")) { eat(); a = { k: "bin", op: "||", a, b: and() }; }
    return a;
  };
  const and = (): Node => {
    let a = cmp();
    while (isOp("&&")) { eat(); a = { k: "bin", op: "&&", a, b: cmp() }; }
    return a;
  };
  const cmp = (): Node => {
    const a = sum();
    if (isOp("<", "<=", ">", ">=", "==", "!=")) { const op = eat().v; return { k: "bin", op, a, b: sum() }; }
    return a;
  };
  // sum := term (("+"|"-") term)*
  const sum = (): Node => {
    let a = term();
    while (peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = eat().v;
      a = { k: "bin", op, a, b: term() };
    }
    return a;
  };
  // term := unary (("*"|"/"|"%") unary)*
  const term = (): Node => {
    let a = unary();
    while (peek().t === "op" && "*/%".includes(peek().v)) {
      const op = eat().v;
      a = { k: "bin", op, a, b: unary() };
    }
    return a;
  };
  // unary := ("-"|"+") unary | power
  const unary = (): Node => {
    if (peek().t === "op" && peek().v === "!") { eat(); return { k: "not", a: unary() }; }
    if (peek().t === "op" && peek().v === "-") { eat(); return { k: "neg", a: unary() }; }
    if (peek().t === "op" && peek().v === "+") { eat(); return unary(); }
    return power();
  };
  // power := atom ("^" unary)?
  const power = (): Node => {
    const a = atom();
    if (peek().t === "op" && peek().v === "^") { eat(); return { k: "bin", op: "^", a, b: unary() }; }
    return a;
  };
  const atom = (): Node => {
    const t = peek();
    if (t.t === "num") {
      eat();
      let v = parseFloat(t.v);
      // sufixo de unidade colado ou separado por espaço: "10mm", "30 deg"
      const u = peek();
      if (u.t === "id" && u.v in UNITS && !(toks[i + 1]?.v === "(")) { eat(); v *= UNITS[u.v]; }
      return { k: "num", v };
    }
    if (t.t === "id") {
      eat();
      if (peek().v === "(") {
        eat("(");
        const args: Node[] = [];
        if (peek().v !== ")") {
          args.push(expr());
          while (peek().v === ",") { eat(","); args.push(expr()); }
        }
        eat(")");
        const fn = FUNCS[t.v];
        if (!fn) throw new ExprError(`Função desconhecida "${t.v}"`, t.pos);
        if (args.length < fn.n[0] || args.length > fn.n[1]) throw new ExprError(`"${t.v}" espera ${fn.n[0] === fn.n[1] ? fn.n[0] : `${fn.n[0]}–${fn.n[1]}`} argumento(s)`, t.pos);
        return { k: "call", fn: t.v, args, pos: t.pos };
      }
      return { k: "var", name: t.v, pos: t.pos };
    }
    if (t.v === "(") { eat("("); const e = expr(); eat(")"); return e; }
    throw new ExprError(t.t === "end" ? "Expressão incompleta" : `Inesperado "${t.v}"`, t.pos);
  };

  const root = expr();
  if (peek().t !== "end") throw new ExprError(`Inesperado "${peek().v}"`, peek().pos);
  return root;
}

export type Scope = (name: string) => number | undefined;
const EQ_TOL = 1e-9;

export function evaluate(node: Node, scope: Scope): number {
  switch (node.k) {
    case "num": return node.v;
    case "neg": return -evaluate(node.a, scope);
    case "not": return evaluate(node.a, scope) ? 0 : 1;
    case "var": {
      if (node.name in CONSTS) return CONSTS[node.name];
      const v = scope(node.name);
      if (v === undefined) throw new ExprError(`Variável desconhecida "${node.name}"`, node.pos);
      return v;
    }
    case "call": return FUNCS[node.fn].f(...node.args.map((a) => evaluate(a, scope)));
    case "bin": {
      const a = evaluate(node.a, scope), b = evaluate(node.b, scope);
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return a % b;
        case "^": return Math.pow(a, b);
        // comparações com tolerância relativa na igualdade (os comprimentos vêm de contas em vírgula flutuante)
        case "<": return a < b ? 1 : 0;
        case "<=": return a <= b + EQ_TOL * Math.max(1, Math.abs(b)) ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case ">=": return a >= b - EQ_TOL * Math.max(1, Math.abs(b)) ? 1 : 0;
        case "==": return Math.abs(a - b) <= EQ_TOL * Math.max(1, Math.abs(a), Math.abs(b)) ? 1 : 0;
        case "!=": return Math.abs(a - b) > EQ_TOL * Math.max(1, Math.abs(a), Math.abs(b)) ? 1 : 0;
        case "&&": return a && b ? 1 : 0;
        case "||": return a || b ? 1 : 0;
      }
    }
  }
  throw new Error("nó inválido");
}

/** Nomes de variáveis referidos (sem constantes nem funções). */
export function identifiers(node: Node, out = new Set<string>()): Set<string> {
  if (node.k === "var" && !(node.name in CONSTS)) out.add(node.name);
  else if (node.k === "neg" || node.k === "not") identifiers(node.a, out);
  else if (node.k === "bin") { identifiers(node.a, out); identifiers(node.b, out); }
  else if (node.k === "call") node.args.forEach((a) => identifiers(a, out));
  return out;
}

const cache = new Map<string, Node>();
function parseCached(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = parse(src);
    if (cache.size > 2000) cache.clear();
    cache.set(src, n);
  }
  return n;
}

/** Avalia um número ou texto de expressão. Lança ExprError. */
export function evalExpr(value: number | string, scope: Scope = () => undefined): number {
  if (typeof value === "number") return value;
  const v = evaluate(parseCached(value), scope);
  if (!Number.isFinite(v)) throw new ExprError(`Resultado não finito (${v})`, 0);
  return v;
}

export function exprIdentifiers(value: number | string): Set<string> {
  return typeof value === "number" ? new Set() : identifiers(parseCached(value));
}

export const isValidName = (s: string) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(s) && !(s in CONSTS) && !(s in FUNCS) && !(s in UNITS) && !(s in WORD_OPS);
