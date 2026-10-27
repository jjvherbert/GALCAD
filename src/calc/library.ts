// Biblioteca de cálculos de engenharia (aeronáutica e estruturas leves). Cada cálculo é uma função
// pura com a referência (obra/norma e edição), as entradas com unidades, as hipóteses e limites, e um
// caso de verificação calculado à mão (testado em tests/calc.test.ts). São fórmulas clássicas de
// manual, reimplementadas a partir das referências citadas — apoio ao projeto, nunca certificação.
//
// O escantilhonamento naval NÃO está aqui: vem da galkeel-calculadora (src/galkeel/), sem reimplementar.

export interface CalcInput { key: string; label: string; unit: string; default: number; min?: number; max?: number; options?: { value: number; label: string }[]; help?: string }
export interface CalcOutput { key: string; label: string; unit: string; value: number | string; digits?: number }
export interface CalcResult { outputs: CalcOutput[]; warnings: string[] }
export interface CalcDef {
  id: string;
  domain: "Aeronáutica" | "Estruturas" | "Atmosfera";
  name: string;
  reference: string;
  inputs: CalcInput[];
  hypotheses: string[];
  compute(v: Record<string, number>): CalcResult;
  /** Caso de verificação (entradas e saídas esperadas, com tolerância relativa) calculado à mão. */
  verify: { note: string; inputs: Record<string, number>; expect: Record<string, number>; tol: number };
}

const PI = Math.PI;
const out = (key: string, label: string, unit: string, value: number | string, digits = 4): CalcOutput => ({ key, label, unit, value, digits });

// ---------------------------------------------------------------------------
// Atmosfera padrão (ISO 2533:1975, = ICAO Doc 7488/3; até 32 km)
// ---------------------------------------------------------------------------

export const ISA = { g0: 9.80665, R: 287.05287, T0: 288.15, p0: 101325, rho0: 1.225, gamma: 1.4, r0: 6356766 };
const LAYERS = [
  { h: 0, T: 288.15, L: -0.0065, p: 101325 },
  { h: 11000, T: 216.65, L: 0, p: 22632.06 },
  { h: 20000, T: 216.65, L: 0.001, p: 5474.889 },
  { h: 32000, T: 228.65, L: 0, p: 868.0187 },
];

/** Estado da atmosfera padrão à altitude geopotencial h (m), com desvio de temperatura ΔT (K) opcional. */
export function isa(h: number, dT = 0) {
  if (!(h >= -2000 && h <= 32000)) throw new Error("ISA: altitude entre −2 000 e 32 000 m");
  const b = h < 11000 ? LAYERS[0] : h < 20000 ? LAYERS[1] : LAYERS[2];
  const Ts = b.T + b.L * (h - b.h);
  const p = b.L === 0 ? b.p * Math.exp((-ISA.g0 * (h - b.h)) / (ISA.R * b.T)) : b.p * (Ts / b.T) ** (-ISA.g0 / (ISA.R * b.L));
  const T = Ts + dT; // desvio ISA: mesma pressão, outra temperatura (prática corrente de desempenho)
  const rho = p / (ISA.R * T);
  const a = Math.sqrt(ISA.gamma * ISA.R * T);
  const mu = (1.458e-6 * T ** 1.5) / (T + 110.4); // Sutherland (ISO 2533 §2.9)
  return { T, p, rho, a, mu, nu: mu / rho, sigma: rho / ISA.rho0, delta: p / ISA.p0 };
}

const isaCalc: CalcDef = {
  id: "isa",
  domain: "Atmosfera",
  name: "Atmosfera padrão, Reynolds e Mach",
  reference: "ISO 2533:1975 (Standard Atmosphere, = ICAO Doc 7488/3), camadas até 32 km; viscosidade de Sutherland",
  inputs: [
    { key: "h", label: "Altitude geopotencial", unit: "m", default: 0, min: -2000, max: 32000 },
    { key: "dT", label: "Desvio de temperatura (ISA + ΔT)", unit: "K", default: 0, min: -60, max: 60 },
    { key: "V", label: "Velocidade verdadeira", unit: "m/s", default: 50, min: 0 },
    { key: "L", label: "Comprimento de referência (corda)", unit: "m", default: 1, min: 0 },
  ],
  hypotheses: [
    "Ar seco, gás perfeito (R = 287,05287 J/(kg·K), γ = 1,4), aceleração da gravidade constante g0 = 9,80665 m/s².",
    "Altitude geopotencial (não geométrica): a diferença é < 0,3 % até 20 km.",
    "Com ΔT ≠ 0 mantém-se a pressão da altitude-pressão e muda-se a temperatura (convenção de desempenho de aeronaves).",
  ],
  compute: (v) => {
    const s = isa(v.h, v.dT);
    const re = (s.rho * v.V * v.L) / s.mu, M = v.V / s.a;
    const warnings: string[] = [];
    if (M > 0.3) warnings.push(`Mach ${M.toFixed(2)} > 0,3: efeitos de compressibilidade não desprezáveis`);
    if (M >= 0.7) warnings.push("Mach ≥ 0,7: provável escoamento transónico local — usar métodos compressíveis");
    return {
      outputs: [
        out("T", "Temperatura", "K", s.T, 5), out("p", "Pressão", "Pa", s.p, 6), out("rho", "Massa volúmica", "kg/m³", s.rho, 5),
        out("a", "Velocidade do som", "m/s", s.a, 5), out("mu", "Viscosidade dinâmica", "Pa·s", s.mu, 4), out("nu", "Viscosidade cinemática", "m²/s", s.nu, 4),
        out("sigma", "Razão de massa volúmica σ", "—", s.sigma, 4), out("q", "Pressão dinâmica ½ρV²", "Pa", 0.5 * s.rho * v.V * v.V, 5),
        out("Re", "Número de Reynolds", "—", re, 4), out("M", "Número de Mach", "—", M, 4),
      ],
      warnings,
    };
  },
  verify: {
    note: "ISO 2533 tabela: 0 m → 288,15 K, 101 325 Pa, 1,2250 kg/m³, a = 340,29 m/s, μ = 1,7894e-5 Pa·s; 11 000 m → 216,65 K, 22 632 Pa, 0,36392 kg/m³",
    inputs: { h: 11000, dT: 0, V: 0, L: 1 },
    expect: { T: 216.65, p: 22632.06, rho: 0.36392, a: 295.07 },
    tol: 5e-4,
  },
};

// ---------------------------------------------------------------------------
// Colunas: Euler e parábola de Johnson
// ---------------------------------------------------------------------------

const columnCalc: CalcDef = {
  id: "column",
  domain: "Estruturas",
  name: "Coluna à compressão (Euler–Johnson)",
  reference: "Bruhn, Analysis and Design of Flight Vehicle Structures (1973), C2.6–C2.8; Niu, Airframe Stress Analysis and Sizing (1997), §10.2",
  inputs: [
    { key: "L", label: "Comprimento entre apoios", unit: "mm", default: 1000, min: 0 },
    { key: "c", label: "Fixação dos extremos (c)", unit: "—", default: 1, options: [
      { value: 1, label: "Articulada–articulada (c = 1)" }, { value: 4, label: "Encastrada–encastrada (c = 4)" },
      { value: 2.046, label: "Encastrada–articulada (c = 2,05)" }, { value: 0.25, label: "Encastrada–livre (c = 0,25)" },
    ], help: "Coeficiente de fixação: comprimento efetivo L' = L/√c" },
    { key: "A", label: "Área da secção", unit: "mm²", default: 200, min: 0 },
    { key: "I", label: "Momento de inércia mínimo", unit: "mm⁴", default: 20000, min: 0 },
    { key: "E", label: "Módulo de elasticidade", unit: "MPa", default: 71000, min: 0 },
    { key: "fcy", label: "Tensão de cedência à compressão", unit: "MPa", default: 280, min: 0 },
  ],
  hypotheses: [
    "Coluna reta, carga axial centrada, secção constante, material homogéneo; sem encurvadura local nem torção (verificar à parte em perfis abertos de parede fina).",
    "Euler (elástica) para L'/ρ ≥ (L'/ρ)crit = π·√(2E/fcy); abaixo, parábola de Johnson σ = fcy·[1 − fcy·(L'/ρ)²/(4π²E)].",
    "A parábola de Johnson é uma aproximação da curva com módulo tangente; para ligas com curva de Ramberg–Osgood conhecida usar o módulo tangente.",
    "Sem coeficientes de segurança nem de material: comparar σcr com a tensão de cálculo segundo o regulamento aplicável.",
  ],
  compute: (v) => {
    const Le = v.L / Math.sqrt(v.c), rho = Math.sqrt(v.I / v.A), sl = Le / rho;
    const crit = PI * Math.sqrt((2 * v.E) / v.fcy);
    const euler = (PI * PI * v.E) / (sl * sl);
    const johnson = v.fcy * (1 - (v.fcy * sl * sl) / (4 * PI * PI * v.E));
    const elastic = sl >= crit;
    const s = elastic ? euler : johnson;
    return {
      outputs: [
        out("Le", "Comprimento efetivo L'", "mm", Le), out("rho", "Raio de giração ρ", "mm", rho), out("slender", "Esbelteza L'/ρ", "—", sl),
        out("crit", "Esbelteza de transição", "—", crit), out("mode", "Regime", "", elastic ? "Euler (elástico)" : "Johnson (inelástico)"),
        out("sigma", "Tensão crítica σcr", "MPa", s), out("P", "Carga crítica Pcr", "N", s * v.A, 5),
      ],
      warnings: sl < 10 ? ["Coluna muito curta (L'/ρ < 10): a rotura é por compressão do material, não por encurvadura"] : [],
    };
  },
  verify: {
    note: "Tubo de alumínio articulado, L = 1000 mm, A = 200 mm², I = 20 000 mm⁴ → ρ = 10 mm, L'/ρ = 100 > π·√(2·71 000/280) = 70,748; σ = π²·71 000/100² = 70,074 MPa, P = 14 015 N",
    inputs: { L: 1000, c: 1, A: 200, I: 20000, E: 71000, fcy: 280 },
    expect: { slender: 100, crit: 70.7481, sigma: 70.0742, P: 14014.84 },
    tol: 1e-4,
  },
};

// ---------------------------------------------------------------------------
// Encurvadura de placas planas (compressão e corte)
// ---------------------------------------------------------------------------

/** k de compressão de uma placa simplesmente apoiada nos 4 bordos: mínimo em m semi-ondas. */
export function kCompressionSS(aspect: number) {
  let k = Infinity;
  for (let m = 1; m <= 50; m++) k = Math.min(k, (m / aspect + aspect / m) ** 2);
  return k;
}

const plateCalc: CalcDef = {
  id: "plate",
  domain: "Estruturas",
  name: "Encurvadura de placa plana (compressão e corte)",
  reference: "Timoshenko & Gere, Theory of Elastic Stability, 2.ª ed. (1961), §9.2 e §9.7; Bruhn (1973), C5.2–C5.7",
  inputs: [
    { key: "a", label: "Comprimento a (na direção da carga)", unit: "mm", default: 500, min: 0 },
    { key: "b", label: "Largura b (carregada)", unit: "mm", default: 200, min: 0 },
    { key: "t", label: "Espessura", unit: "mm", default: 2, min: 0 },
    { key: "E", label: "Módulo de elasticidade", unit: "MPa", default: 71000, min: 0 },
    { key: "nu", label: "Coeficiente de Poisson", unit: "—", default: 0.33, min: 0, max: 0.5 },
    { key: "edge", label: "Bordos", unit: "—", default: 0, options: [{ value: 0, label: "Simplesmente apoiados" }, { value: 1, label: "Encastrados (placa longa)" }] },
    { key: "fp", label: "Limite de proporcionalidade (aviso)", unit: "MPa", default: 250, min: 0 },
  ],
  hypotheses: [
    "Placa plana, isotrópica, elástica, de espessura constante, sem imperfeições; carga uniforme nos bordos b (compressão) ou corte uniforme nos quatro bordos.",
    "σcr = k·π²E/(12(1−ν²))·(t/b)². Compressão, apoiada: k = min_m (m·b/a + a/(m·b))² (→ 4 em placas longas); encastrada: k = 6,98 (placa longa, a/b ≥ 3).",
    "Corte, apoiada: ks = 5,35 + 4(b/a)²; encastrada: ks = 8,98 + 5,6(b/a)² (a ≥ b, b é o lado curto).",
    "Sem correção de plasticidade: acima do limite de proporcionalidade o valor elástico sobrestima a tensão crítica. Não inclui resistência pós-encurvadura (largura efetiva).",
  ],
  compute: (v) => {
    const D = (PI * PI * v.E) / (12 * (1 - v.nu * v.nu)) * (v.t / v.b) ** 2;
    const r = v.a / v.b, clamped = v.edge === 1;
    const kc = clamped ? 6.98 : kCompressionSS(r);
    const short = Math.min(v.a, v.b), long = Math.max(v.a, v.b);
    const Ds = (PI * PI * v.E) / (12 * (1 - v.nu * v.nu)) * (v.t / short) ** 2;
    const ks = clamped ? 8.98 + 5.6 * (short / long) ** 2 : 5.35 + 4 * (short / long) ** 2;
    const sc = kc * D, tc = ks * Ds;
    const warnings: string[] = [];
    if (clamped && r < 3) warnings.push("k = 6,98 de placa encastrada é para placas longas (a/b ≥ 3); placas curtas têm k maior (resultado conservador)");
    if (sc > v.fp) warnings.push(`σcr = ${sc.toFixed(0)} MPa acima do limite de proporcionalidade: aplicar correção de plasticidade`);
    if (tc > v.fp / Math.sqrt(3)) warnings.push("τcr acima do limite de proporcionalidade ao corte (≈ fp/√3): aplicar correção de plasticidade");
    return {
      outputs: [
        out("ratio", "Razão a/b", "—", r), out("kc", "Coeficiente k (compressão)", "—", kc), out("sigma", "σcr compressão", "MPa", sc),
        out("Ncr", "Carga crítica por unidade de largura", "N/mm", sc * v.t), out("ks", "Coeficiente ks (corte)", "—", ks), out("tau", "τcr corte", "MPa", tc),
      ],
      warnings,
    };
  },
  verify: {
    note: "Placa apoiada 500×200×2 mm de alumínio (E = 71 000, ν = 0,33): a/b = 2,5 → k = min(m=2: 4,2025; m=3: (1,2 + 0,8333)² = 4,1344); π²E/(12(1−ν²))·(t/b)² = 6,5532 MPa; σcr = 27,094 MPa; ks = 5,35 + 4·0,4² = 5,99, τcr = 39,253 MPa",
    inputs: { a: 500, b: 200, t: 2, E: 71000, nu: 0.33, edge: 0, fp: 250 },
    expect: { kc: 4.13444, sigma: 27.0937, ks: 5.99, tau: 39.2534 },
    tol: 2e-4,
  },
};

// ---------------------------------------------------------------------------
// Asa finita: declive da curva de sustentação (Helmbold/DATCOM) e arrasto induzido
// ---------------------------------------------------------------------------

const wingCalc: CalcDef = {
  id: "wing",
  domain: "Aeronáutica",
  name: "Asa finita: declive CLα e arrasto induzido",
  reference: "USAF DATCOM (1978), §4.1.3.2 (fórmula de Helmbold–Diederich); Anderson, Fundamentals of Aerodynamics, 6.ª ed. (2017), §5.3",
  inputs: [
    { key: "a0", label: "Declive do perfil 2D (ex.: polar XFOIL)", unit: "1/°", default: 0.108, min: 0 },
    { key: "AR", label: "Alongamento b²/S", unit: "—", default: 8, min: 0.5 },
    { key: "sweep", label: "Flecha a meia corda Λc/2", unit: "°", default: 0, min: -60, max: 60 },
    { key: "M", label: "Mach", unit: "—", default: 0.2, min: 0, max: 0.8 },
    { key: "e", label: "Fator de Oswald e", unit: "—", default: 0.8, min: 0.3, max: 1 },
    { key: "CL", label: "CL de cruzeiro (para CDi)", unit: "—", default: 0.5 },
  ],
  hypotheses: [
    "CLα = 2πA / (2 + √(A²β²/κ²·(1 + tan²Λc/2/β²) + 4)), β = √(1 − M²), κ = a0/(2π) com a0 por radiano (DATCOM 4.1.3.2-a).",
    "Asa plana sem torção, escoamento ligado, subsónico abaixo do Mach crítico; sem efeitos de fuselagem, nacelas nem superfícies de cauda.",
    "Arrasto induzido CDi = CL²/(π·A·e); e (Oswald) depende da planta e da distribuição de sustentação — valor de entrada.",
  ],
  compute: (v) => {
    const a0r = (v.a0 * 180) / PI, kap = a0r / (2 * PI), beta = Math.sqrt(1 - v.M * v.M), tl = Math.tan((v.sweep * PI) / 180);
    const cla = (2 * PI * v.AR) / (2 + Math.sqrt(((v.AR * v.AR * beta * beta) / (kap * kap)) * (1 + (tl * tl) / (beta * beta)) + 4));
    const cdi = (v.CL * v.CL) / (PI * v.AR * v.e);
    return {
      outputs: [
        out("claRad", "CLα da asa", "1/rad", cla), out("claDeg", "CLα da asa", "1/°", (cla * PI) / 180),
        out("ratio", "Razão asa/perfil", "—", cla / a0r), out("CDi", "Arrasto induzido CDi", "—", cdi), out("k", "Fator k = 1/(πAe)", "—", 1 / (PI * v.AR * v.e)),
      ],
      warnings: v.AR < 3 ? ["Alongamento < 3: a teoria de linha sustentadora deixa de ser adequada (usar método de superfície/VLM)"] : [],
    };
  },
  verify: {
    note: "a0 = 2π/rad (0,10966/°), A = 8, Λ = 0, M = 0: κ = 1, CLα = 16π/(2 + √68) = 4,9058/rad (Helmbold); com e = 0,8, CL = 0,5: CDi = 0,25/(π·8·0,8) = 0,012434",
    inputs: { a0: (2 * PI * PI) / 180, AR: 8, sweep: 0, M: 0, e: 0.8, CL: 0.5 },
    expect: { claRad: 4.90576, CDi: 0.0124340 },
    tol: 1e-4,
  },
};

// ---------------------------------------------------------------------------
// Perfil NACA de 4 dígitos: propriedades geométricas
// ---------------------------------------------------------------------------

const nacaCalc: CalcDef = {
  id: "naca4",
  domain: "Aeronáutica",
  name: "Perfil NACA de 4 dígitos (geometria)",
  reference: "Abbott & von Doenhoff, Theory of Wing Sections (1959), §6.4, eq. 6.2–6.4",
  inputs: [
    { key: "m", label: "Curvatura máxima m (1.º dígito)", unit: "% c", default: 2, min: 0, max: 9 },
    { key: "p", label: "Posição da curvatura (2.º dígito)", unit: "10 % c", default: 4, min: 0, max: 9 },
    { key: "t", label: "Espessura (3.º–4.º dígitos)", unit: "% c", default: 12, min: 1, max: 40 },
    { key: "c", label: "Corda", unit: "mm", default: 1000, min: 0 },
  ],
  hypotheses: [
    "yt = 5t(0,2969√x − 0,1260x − 0,3516x² + 0,2843x³ − 0,1015x⁴) (bordo de fuga aberto, espessura 0,252 % c); espessura perpendicular à linha média.",
    "Raio do bordo de ataque rLE = 1,1019·t²·c; área da secção ≈ 0,685·t·c² (integração numérica do contorno).",
    "No painel «Perfis e XFOIL» gera-se o esboço do perfil e corre-se a polar no agente.",
  ],
  compute: (v) => {
    const code = `${Math.round(v.m)}${Math.round(v.p)}${String(Math.round(v.t)).padStart(2, "0")}`;
    const t = v.t / 100, c = v.c;
    const yt = (x: number) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    // área e posição da espessura máxima por integração (Simpson em s = √x para resolver a raiz)
    let area = 0, xm = 0, ym = 0;
    const n = 2000;
    for (let i = 0; i <= n; i++) {
      const s = i / n, x = s * s, w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
      area += w * 2 * yt(x) * 2 * s;
      if (yt(x) > ym) { ym = yt(x); xm = x; }
    }
    area *= 1 / (3 * n);
    return {
      outputs: [
        out("code", "Designação", "", `NACA ${code}`), out("tmax", "Espessura máxima", "mm", 2 * ym * c), out("xt", "Posição da espessura máxima", "% c", 100 * xm, 3),
        out("rle", "Raio do bordo de ataque", "mm", 1.1019 * t * t * c), out("A", "Área da secção", "mm²", area * c * c, 5), out("te", "Espessura no bordo de fuga", "mm", 2 * yt(1) * c),
      ],
      warnings: v.m > 0 && v.p === 0 ? ["Curvatura com posição 0: usa-se perfil simétrico"] : [],
    };
  },
  verify: {
    note: "NACA 0012, c = 1000 mm: tmax = 120,03 mm a x ≈ 30 % c (Abbott tabela: yt = 0,06002 em x = 0,30); área = 0,6851·t·c² = 82 210 mm²; rLE = 1,1019·0,0144·1000 = 15,867 mm; TE = 2,52 mm",
    inputs: { m: 0, p: 0, t: 12, c: 1000 },
    expect: { tmax: 120.03, rle: 15.867, te: 2.52, A: 82212 },
    tol: 2e-3,
  },
};

export const CALCS: CalcDef[] = [isaCalc, wingCalc, nacaCalc, columnCalc, plateCalc];

export function calcById(id: string) {
  const c = CALCS.find((x) => x.id === id);
  if (!c) throw new Error(`Cálculo inexistente: ${id} (disponíveis: ${CALCS.map((x) => x.id).join(", ")})`);
  return c;
}

/** Corre um cálculo com valores por defeito para as entradas em falta; valida números e limites. */
export function runCalc(id: string, inputs: Record<string, number> = {}): CalcResult & { id: string; name: string; reference: string; inputs: Record<string, number>; hypotheses: string[] } {
  const c = calcById(id);
  const v: Record<string, number> = {};
  for (const i of c.inputs) {
    const x = inputs[i.key] ?? i.default;
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${c.name}: «${i.label}» não é um número`);
    if ((i.min !== undefined && x < i.min) || (i.max !== undefined && x > i.max)) throw new Error(`${c.name}: «${i.label}» fora dos limites (${i.min ?? "−∞"} a ${i.max ?? "∞"} ${i.unit})`);
    v[i.key] = x;
  }
  for (const k of Object.keys(inputs)) if (!c.inputs.some((i) => i.key === k)) throw new Error(`${c.name}: entrada desconhecida «${k}»`);
  return { id: c.id, name: c.name, reference: c.reference, inputs: v, hypotheses: c.hypotheses, ...c.compute(v) };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const fmtv = (o: CalcOutput) => {
  if (typeof o.value !== "number") return o.value;
  const v = o.value, d = o.digits ?? 4;
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e7 || (Math.abs(v) < 1e-3 && v !== 0)) return v.toExponential(d - 1).replace(".", ",");
  return v.toLocaleString("pt-PT", { maximumSignificantDigits: d });
};
export const formatOutput = fmtv;

/** Relatório HTML de um cálculo (entradas, resultados, referência, hipóteses e limites). */
export function calcReport(r: ReturnType<typeof runCalc>, project = "") {
  const c = calcById(r.id);
  const rows = (xs: [string, string, string][]) => xs.map(([a, b, u]) => `<tr><td>${esc(a)}</td><td style="text-align:right">${esc(b)}</td><td>${esc(u)}</td></tr>`).join("");
  return `<!doctype html><html lang="pt"><meta charset="utf-8"><title>${esc(r.name)}</title>
<style>body{font:14px system-ui,sans-serif;max-width:820px;margin:2em auto;color:#111}table{border-collapse:collapse;width:100%;margin:.5em 0 1.2em}td,th{border-bottom:1px solid #ddd;padding:4px 8px}h1{font-size:20px}.box{border:1px solid #c80;background:#fff8e8;padding:8px 12px}</style>
<h1>${esc(r.name)}</h1><p>${esc(project)} · ${new Date().toISOString().slice(0, 10)}</p>
<p><b>Referência:</b> ${esc(r.reference)}</p>
<h2>Entradas</h2><table>${rows(c.inputs.map((i) => [i.label, String(r.inputs[i.key]), i.unit]))}</table>
<h2>Resultados</h2><table>${rows(r.outputs.map((o) => [o.label, String(fmtv(o)), o.unit]))}</table>
${r.warnings.length ? `<h2>Avisos</h2><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
<h2>Hipóteses e limites</h2><ul>${r.hypotheses.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
<p class="box">Cálculo de apoio ao projeto por fórmulas de manual. Não é certificação nem aprovação de autoridade ou organismo notificado; a verificação regulamentar exige os coeficientes, dados de material e métodos do regulamento aplicável e revisão por técnico habilitado.</p>
<p style="color:#666">Verificação da implementação: ${esc(c.verify.note)}</p></html>`;
}
