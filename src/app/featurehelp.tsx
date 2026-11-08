// Ajuda animada por feature, como as dicas do SolidWorks: uma figura curta em movimento (o antes e o
// depois), o que a feature faz, como se usa e uma nota. Aparece ao passar o rato na barra e no topo do
// painel de propriedades. As animações são SMIL em SVG; com prefers-reduced-motion mostram só o resultado.
import type { ComponentChildren, JSX } from "preact";
import type { FeatureType } from "../doc/types.ts";
import { type ArtKey, CUT_HELP, FEATURE_HELP, type Help } from "./feature-help.ts";
import { PLUGINS } from "../plugins/meta.ts";

export { type Help, helpForFeature } from "./feature-help.ts";

const MOTION = typeof matchMedia === "function" ? !matchMedia("(prefers-reduced-motion: reduce)").matches : true;

// --- desenho --------------------------------------------------------------------------

type P2 = [number, number];
/** Projeção isométrica para o ecrã de 120 × 84. */
const iso = (x: number, y: number, z: number): P2 => [60 + (x - y) * 0.866, 66 + (x + y) * 0.5 - z];
const pts = (a: P2[]) => a.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const box = (x: number, y: number, z: number, w: number, d: number, h: number) => ({
  top: pts([iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)]),
  right: pts([iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x + w, y, z + h)]),
  left: pts([iso(x, y + d, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x, y + d, z + h)]),
});
const floor = (x: number, y: number, w: number, d: number, z = 0) => pts([iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)]);

/** `<animate>` em ciclo; em movimento reduzido não anima. */
function An({ attr, values, dur = 3.4, keyTimes }: { attr: string; values: string[]; dur?: number; keyTimes?: string }) {
  if (!MOTION) return null;
  return <animate attributeName={attr} values={values.join(";")} dur={`${dur}s`} repeatCount="indefinite" keyTimes={keyTimes} />;
}

/** Polígono que muda de forma: `frames` = [antes, depois, depois, antes]; parado mostra o depois. */
function Morph({ cls, frames }: { cls: string; frames: string[] }) {
  return <polygon class={cls} points={MOTION ? frames[0] : frames[1]}><An attr="points" values={frames} /></polygon>;
}

/** Cresce uma caixa de altura 0 até h (3 faces). */
function Growing({ x, y, z = 0, w, d, h, cls = "new" }: { x: number; y: number; z?: number; w: number; d: number; h: number; cls?: string }) {
  const f = [0.4, h, h, 0.4].map((k) => box(x, y, z, w, d, k));
  return (
    <>
      <Morph cls={`a-left a-${cls}`} frames={f.map((b) => b.left)} />
      <Morph cls={`a-right a-${cls}`} frames={f.map((b) => b.right)} />
      <Morph cls={`a-top a-${cls}`} frames={f.map((b) => b.top)} />
    </>
  );
}

function Solid({ x, y, z = 0, w, d, h, cls = "" }: { x: number; y: number; z?: number; w: number; d: number; h: number; cls?: string }) {
  const b = box(x, y, z, w, d, h);
  return (
    <>
      <polygon class={`a-left ${cls}`} points={b.left} />
      <polygon class={`a-right ${cls}`} points={b.right} />
      <polygon class={`a-top ${cls}`} points={b.top} />
    </>
  );
}

/** Aparece e desaparece com um atraso (0–0.6 do ciclo). */
function Fade({ at = 0.2, children }: { at?: number; children: ComponentChildren }) {
  return (
    <g opacity={MOTION ? 0 : 1}>
      {MOTION && <animate attributeName="opacity" values="0;1;1;0" keyTimes={`0;${at};0.9;1`} dur="3.4s" repeatCount="indefinite" />}
      {children}
    </g>
  );
}

const Svg = ({ children }: { children: ComponentChildren }) => <svg class="art" viewBox="0 0 120 84" aria-hidden="true">{children}</svg>;

// --- figuras --------------------------------------------------------------------------

const ART: Record<ArtKey, () => JSX.Element> = {
  sketch: () => (
    <Svg>
      <polygon class="a-plane" points={floor(-10, -10, 60, 60)} />
      <polygon class="a-sketch" points={floor(0, 0, 36, 24)} pathLength={1} stroke-dasharray="1" stroke-dashoffset={MOTION ? 1 : 0}>
        <An attr="stroke-dashoffset" values={["1", "0", "0", "1"]} keyTimes="0;0.5;0.9;1" />
      </polygon>
    </Svg>
  ),
  extrude: () => (
    <Svg>
      <polygon class="a-sketch" points={floor(10, 10, 34, 26)} />
      <Growing x={10} y={10} w={34} d={26} h={26} />
    </Svg>
  ),
  cut: () => {
    const H = 26, x0 = 12, x1 = 34, y0 = 10, y1 = 28, T = 10;
    const fl = [H, T, T, H].map((z) => pts([iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z)]));
    const w1 = [H, T, T, H].map((z) => pts([iso(x0, y0, z), iso(x0, y1, z), iso(x0, y1, H), iso(x0, y0, H)]));
    const w2 = [H, T, T, H].map((z) => pts([iso(x0, y0, z), iso(x1, y0, z), iso(x1, y0, H), iso(x0, y0, H)]));
    return (
      <Svg>
        <Solid x={0} y={0} w={46} d={38} h={H} />
        <Morph cls="a-wall" frames={w1} /><Morph cls="a-wall2" frames={w2} /><Morph cls="a-new a-floor" frames={fl} />
      </Svg>
    );
  },
  revolve: () => (
    <Svg>
      <line class="a-axis" x1="60" y1="8" x2="60" y2="76" />
      <rect class="a-sketch" x="60" y="22" width="22" height="42" />
      <g transform="translate(60 0)" opacity={MOTION ? 1 : 1}>
        <g>
          {MOTION && <animateTransform attributeName="transform" type="scale" values="0.04 1;1 1;1 1;0.04 1" keyTimes="0;0.5;0.9;1" dur="3.4s" repeatCount="indefinite" />}
          <path class="a-new a-right" d="M-22,24 L-22,62 A22,6 0 0 0 22,62 L22,24 Z" />
          <ellipse class="a-new a-top" cx="0" cy="24" rx="22" ry="6" />
        </g>
      </g>
    </Svg>
  ),
  fillet: () => {
    const fr = [0.01, 16, 16, 0.01].map((r) => `M24,66 L24,24 L${96 - r},24 Q96,24 96,${24 + r} L96,66 Z`);
    return (
      <Svg>
        <path class="a-right" d={MOTION ? fr[0] : fr[1]}><An attr="d" values={fr} /></path>
        <circle class="a-mark" cx="96" cy="24" r="3"><An attr="opacity" values={["1", "0.2", "0.2", "1"]} /></circle>
      </Svg>
    );
  },
  chamfer: () => {
    const fr = [0.01, 16, 16, 0.01].map((c) => `M24,66 L24,24 L${96 - c},24 L96,${24 + c} L96,66 Z`);
    return (
      <Svg>
        <path class="a-right" d={MOTION ? fr[0] : fr[1]}><An attr="d" values={fr} /></path>
        <circle class="a-mark" cx="96" cy="24" r="3"><An attr="opacity" values={["1", "0.2", "0.2", "1"]} /></circle>
      </Svg>
    );
  },
  shell: () => {
    const H = 28, x0 = 6, x1 = 40, y0 = 6, y1 = 32;
    const fl = [H, 4, 4, H].map((z) => pts([iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z)]));
    const w1 = [H, 4, 4, H].map((z) => pts([iso(x0, y0, z), iso(x0, y1, z), iso(x0, y1, H), iso(x0, y0, H)]));
    const w2 = [H, 4, 4, H].map((z) => pts([iso(x0, y0, z), iso(x1, y0, z), iso(x1, y0, H), iso(x0, y0, H)]));
    return (
      <Svg>
        <Solid x={0} y={0} w={46} d={38} h={H} />
        <Morph cls="a-wall" frames={w1} /><Morph cls="a-wall2" frames={w2} /><Morph cls="a-new a-floor" frames={fl} />
      </Svg>
    );
  },
  hole: () => (
    <Svg>
      <Solid x={4} y={4} w={44} d={36} h={22} />
      <ellipse class="a-wall2" cx="60" cy={iso(26, 22, 22)[1] + 6} rx={MOTION ? 0 : 9} ry={MOTION ? 0 : 5}>
        <An attr="rx" values={["0", "9", "9", "0"]} /><An attr="ry" values={["0", "5", "5", "0"]} />
      </ellipse>
      <ellipse class="a-new a-top" cx="60" cy={iso(26, 22, 22)[1] - 6} rx={MOTION ? 0 : 9} ry={MOTION ? 0 : 5} opacity="0.9">
        <An attr="rx" values={["0", "9", "9", "0"]} /><An attr="ry" values={["0", "5", "5", "0"]} />
      </ellipse>
      <ellipse class="a-wall2" cx="60" cy={iso(26, 22, 22)[1] - 6} rx={MOTION ? 0 : 6} ry={MOTION ? 0 : 3.4}>
        <An attr="rx" values={["0", "6", "6", "0"]} /><An attr="ry" values={["0", "3.4", "3.4", "0"]} />
      </ellipse>
    </Svg>
  ),
  linearPattern: () => (
    <Svg>
      <Solid x={4} y={22} w={14} d={14} h={14} />
      {[1, 2, 3].map((i) => <Fade key={i} at={0.1 + 0.16 * i}><Solid x={4 + 20 * i} y={22} w={14} d={14} h={14} cls="a-new" /></Fade>)}
    </Svg>
  ),
  circularPattern: () => {
    const c = iso(24, 24, 0);
    return (
      <Svg>
        <ellipse class="a-axis" cx={c[0]} cy={c[1]} rx="34" ry="19" fill="none" />
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const a = (i * Math.PI) / 3, x = 24 + 19 * Math.cos(a), y = 24 + 19 * Math.sin(a);
          return i === 0 ? <Solid key={i} x={x - 4} y={y - 4} w={8} d={8} h={10} /> : <Fade key={i} at={0.1 + 0.1 * i}><Solid x={x - 4} y={y - 4} w={8} d={8} h={10} cls="a-new" /></Fade>;
        })}
        <circle class="a-mark" cx={c[0]} cy={c[1]} r="2" />
      </Svg>
    );
  },
  mirror: () => (
    <Svg>
      <line class="a-axis" x1="60" y1="8" x2="60" y2="76" />
      <path class="a-right" d="M20,60 L20,20 L44,20 L44,34 L34,34 L34,60 Z" />
      <g transform="translate(60 0)">
        <g opacity={MOTION ? 0 : 1}>
          {MOTION && <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.3;0.9;1" dur="3.4s" repeatCount="indefinite" />}
          <path class="a-new a-right" d="M40,60 L40,20 L16,20 L16,34 L26,34 L26,60 Z" />
        </g>
      </g>
    </Svg>
  ),
  draft: () => {
    const fr = [0, 8, 8, 0].map((d) => `M26,66 L${26 + d},18 L${94 - d},18 L94,66 Z`);
    return (
      <Svg>
        <path class="a-right" d={MOTION ? fr[0] : fr[1]}><An attr="d" values={fr} /></path>
        <path class="a-mark" fill="none" d="M26,50 A16,16 0 0 1 28,43" />
      </Svg>
    );
  },
  rib: () => (
    <Svg>
      <Solid x={0} y={0} w={50} d={36} h={6} />
      <Growing x={4} y={16} z={6} w={42} d={4} h={22} />
    </Svg>
  ),
  sweep: () => (
    <Svg>
      <path class="a-sketch" fill="none" d="M18,64 C18,24 60,60 100,20" />
      <path class="a-tube" fill="none" d="M18,64 C18,24 60,60 100,20" pathLength={1} stroke-dasharray="1" stroke-dashoffset={MOTION ? 1 : 0}>
        <An attr="stroke-dashoffset" values={["1", "0", "0", "1"]} keyTimes="0;0.55;0.9;1" />
      </path>
      <ellipse class="a-sketch" cx="18" cy="64" rx="7" ry="3" fill="rgba(1,138,138,.25)" />
    </Svg>
  ),
  loft: () => {
    const bot = [iso(8, 8, 0), iso(44, 8, 0), iso(44, 36, 0), iso(8, 36, 0)];
    const top = [iso(18, 14, 34), iso(36, 14, 34), iso(36, 30, 34), iso(18, 30, 34)];
    return (
      <Svg>
        <polygon class="a-sketch" points={pts(bot)} />
        <polygon class="a-sketch" points={pts(top)} />
        <Fade at={0.4}>
          <polygon class="a-new a-left" points={pts([bot[3], bot[2], top[2], top[3]])} />
          <polygon class="a-new a-right" points={pts([bot[1], bot[2], top[2], top[1]])} />
          <polygon class="a-new a-top" points={pts(top)} />
        </Fade>
      </Svg>
    );
  },
  plane: () => (
    <Svg>
      <Solid x={4} y={4} w={40} d={34} h={20} />
      <g>
        {MOTION && <animateTransform attributeName="transform" type="translate" values="0 0;0 -16;0 -16;0 0" keyTimes="0;0.5;0.9;1" dur="3.4s" repeatCount="indefinite" />}
        <polygon class="a-plane" points={floor(-6, -6, 56, 50, 20)} />
      </g>
      <line class="a-axis" x1="94" y1="52" x2="94" y2="36"><An attr="opacity" values={["0", "1", "1", "0"]} /></line>
    </Svg>
  ),
  axis: () => (
    <Svg>
      <Solid x={10} y={10} w={34} d={26} h={22} />
      <line class="a-axisline" x1="60" y1="6" x2="60" y2="78" pathLength={1} stroke-dasharray="1" stroke-dashoffset={MOTION ? 1 : 0}>
        <An attr="stroke-dashoffset" values={["1", "0", "0", "1"]} keyTimes="0;0.5;0.9;1" />
      </line>
    </Svg>
  ),
  csys: () => {
    const o = iso(10, 10, 0), x = iso(40, 10, 0), y = iso(10, 40, 0), z = iso(10, 10, 34);
    const ax = (to: P2, cls: string, at: number) => (
      <line class={`a-arrow ${cls}`} x1={o[0]} y1={o[1]} x2={to[0]} y2={to[1]} pathLength={1} stroke-dasharray="1" stroke-dashoffset={MOTION ? 1 : 0}>
        <An attr="stroke-dashoffset" values={["1", "1", "0", "0", "1"]} keyTimes={`0;${at};${at + 0.2};0.9;1`} />
      </line>
    );
    return <Svg>{ax(x, "ax-x", 0.05)}{ax(y, "ax-y", 0.25)}{ax(z, "ax-z", 0.45)}<circle class="a-mark" cx={o[0]} cy={o[1]} r="2.5" /></Svg>;
  },
};

// --- textos ---------------------------------------------------------------------------

// Os textos das features vêm de `FEATURE_HELP` (obrigatório por tipo); aqui ficam com o id do comando.
const featureCommands = (Object.keys(FEATURE_HELP) as FeatureType[]).filter((t) => t !== "sketch").map((t) => [`feature.${t}`, FEATURE_HELP[t]] as const);
// Cada tipo de feature de plugin traz a sua ajuda (obrigatória em `PluginKind`).
const pluginCommands = PLUGINS.flatMap((p) => Object.entries(p.kinds).map(([k, kind]) => [`plugin.${p.id}.${k}`, kind.help] as const));

export const HELP: Record<string, Help> = {
  "sketch.new": FEATURE_HELP.sketch,
  ...Object.fromEntries(featureCommands),
  ...Object.fromEntries(pluginCommands),
  "feature.cut": CUT_HELP,
  // simulação (sem figura)
  "sim.add.fixed": { title: "Encastramento", what: "Impede todos os deslocamentos nas faces escolhidas: o apoio rígido ideal.", steps: ["Escolha as faces de apoio no 3D.", "Confirme."], tip: "Um apoio sobre uma face muito pequena cria tensões artificialmente altas." },
  "sim.add.displacement": { title: "Deslocamento imposto", what: "Impõe um deslocamento (ou o impede) por direção nas faces escolhidas. Deixe em branco a direção que fica livre.", steps: ["Escolha as faces.", "Indique ux, uy, uz (0 impede, vazio deixa livre)."] },
  "sim.add.symmetry": { title: "Simetria", what: "Modela só uma parte de uma peça simétrica: impede o deslocamento normal ao plano de simetria e deixa deslizar no plano. Poupa elementos e tempo.", steps: ["Escolha as faces planas no plano de simetria (alinhadas com X, Y ou Z).", "Aplique as cargas da parte modelada: metade da total no plano de simetria."], tip: "Só vale se a geometria, os apoios e as cargas forem simétricos; os resultados só valem na parte modelada." },
  "sim.section.check": { title: "Verificação do modelo", what: "Confere os dados antes do solver: condições sem faces, material impossível, apoios em falta, análises que o solver não faz. Mostra também o que cada solver suporta.", steps: ["Abra a verificação.", "Clique num item para ir à secção onde se corrige.", "Escolha um solver compatível na matriz, se precisar."], tip: "Erros bloqueiam o cálculo; avisos não." },
  "sim.add.force": { title: "Força", what: "Aplica uma força total distribuída de forma uniforme pela área das faces escolhidas.", steps: ["Escolha as faces.", "Indique Fx, Fy, Fz em newtons."], tip: "A reação nos apoios tem de igualar a força: confira nos resultados." },
  "sim.add.pointForce": { title: "Força pontual", what: "Força concentrada no nó da malha mais próximo de um ponto que escolhe no modelo. Para cargas de parafusos, cabos e ganchos.", steps: ["Clique no modelo para escolher o ponto (ou escreva as coordenadas).", "Indique Fx, Fy, Fz em newtons."], tip: "Junto ao ponto as tensões são irreais (singularidade): confie nas flechas e reações, não nas tensões locais." },
  "sim.add.pressure": { title: "Pressão", what: "Aplica uma pressão normal à face (positiva a empurrar para dentro).", steps: ["Escolha as faces.", "Indique a pressão em MPa."] },
  "sim.add.mass": { title: "Massa pontual", what: "Junta ao modelo uma massa concentrada (motor, lastro, equipamento) ligada às faces ou arestas, sem modelar a sua geometria.", steps: ["Escolha as faces ou arestas onde a massa assenta.", "Indique a massa total em kg."], tip: "A massa é repartida pelos nós segundo a área (ou comprimento). Não dá rigidez: conta na gravidade, nas frequências próprias e na dinâmica." },
  "sim.add.gravity": { title: "Gravidade", what: "Aplica o peso próprio a todo o modelo, com a aceleração em mm/s².", steps: ["Confirme ou ajuste g (por omissão 9810 mm/s² para -Z)."] },
  "sim.add.spring": { title: "Mola à terra", what: "Liga as faces (ou arestas) à terra por molas lineares: um apoio elástico, como uma fundação ou um calço de borracha.", steps: ["Escolha as faces ou arestas.", "Indique a rigidez total kx, ky, kz em N/mm (direções globais)."], tip: "A rigidez é repartida pelos nós segundo a área (ou comprimento); com só molas o modelo fica apoiado sem encastramento." },
  "sim.add.temperature": { title: "Temperatura imposta", what: "Fixa a temperatura nas faces escolhidas (estudos térmicos).", steps: ["Escolha as faces.", "Indique a temperatura em °C."] },
  "sim.add.convection": { title: "Convecção", what: "Troca de calor com um fluido: coeficiente h e temperatura do fluido (estudos térmicos).", steps: ["Escolha as faces.", "Indique h em W/(m²·K) e a temperatura do fluido."] },
  "sim.add.heatFlux": { title: "Fluxo de calor", what: "Fluxo de calor a entrar nas faces, em W/m² (estudos térmicos).", steps: ["Escolha as faces.", "Indique o fluxo."] },
  "sim.add.probe": { title: "Sonda", what: "Mede uma grandeza num ponto ou na média de faces. É o que se segue nos estudos de convergência, porque os máximos junto a cantos vivos não convergem.", steps: ["Escolha as faces ou um ponto no 3D.", "Escolha a grandeza (deslocamento, von Mises, temperatura)."] },
  "sim.mesh.preview": { title: "Gerar a malha", what: "Gera a malha no agente local sem calcular, para ver a qualidade dos elementos (jacobiano, aspeto, ângulos, empeno) e a malha no 3D.", steps: ["Escolha o tipo e o tamanho dos elementos.", "Gere a malha e confira os piores elementos."], tip: "Confira a malha antes de calcular: elementos maus dão resultados maus." },
  "sim.section.convergence": { title: "Convergência da malha", what: "Configura o estudo de convergência (3 malhas, varrimento ±n níveis ou refinamento automático até ao GCI alvo), corre-o com o cálculo e guarda-o no estudo, com tabelas e gráficos para extrair (CSV, XLSX, SVG/PNG, relatório).", steps: ["Escolha o modo, a razão e a grandeza seguida (de preferência uma sonda).", "Corra a convergência (ou F5, com ela ligada).", "Veja os gráficos e extraia as tabelas e o relatório."], tip: "Use sondas: os máximos junto a cantos vivos e apoios não convergem." },
  "sim.convergence.run": { title: "Correr convergência", what: "Liga o estudo de convergência neste estudo e corre todas as malhas previstas no agente local; o resultado fica guardado no estudo.", steps: ["Confira os tamanhos previstos na secção Convergência.", "Corra e espere pelas malhas (as mais finas demoram mais)."], tip: "Cada malha fina custa ≈ r³ vezes a anterior." },
  "sim.run": { title: "Calcular", what: "Corre o estudo no solver escolhido, no agente local, e traz os resultados para o 3D.", steps: ["Confirme apoios, cargas e material.", "Calcule (F5).", "Veja os resultados e o fator de segurança."], tip: "Valide com um caso simples (consola, placa) antes de confiar no modelo." },
};

// --- apresentação ---------------------------------------------------------------------

export function HelpArt({ art }: { art?: ArtKey }) {
  const A = art ? ART[art] : undefined;
  return A ? <div class="help-art">{A()}</div> : null;
}

function HelpBody({ h, steps = true }: { h: Help; steps?: boolean }) {
  return (
    <div class="help-body">
      {h.title && <b class="help-title">{h.title}</b>}
      <p>{h.what}</p>
      {steps && h.steps.length > 0 && <ol>{h.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      {h.tip && <p class="help-tip">{h.tip}</p>}
    </div>
  );
}

/** Dica flutuante junto ao botão da barra (atraso curto, desaparece ao sair). */
export function FeatureTip({ h, x, y }: { h: Help; x: number; y: number }) {
  const left = Math.max(8, Math.min(x, (typeof innerWidth === "number" ? innerWidth : 1200) - 340));
  return (
    <div class="feature-tip" role="tooltip" style={{ left: `${left}px`, top: `${y}px` }}>
      <HelpArt art={h.art} />
      <HelpBody h={h} />
    </div>
  );
}

const KEY = "galcad:help-open";
const wasOpen = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };

/** Cartão «O que faz» no topo do painel de propriedades (recolhível; lembra a escolha). */
export function HelpCard({ h }: { h: Help }) {
  return (
    <details class="help-card" open={wasOpen()} onToggle={(e) => { try { localStorage.setItem(KEY, (e.currentTarget as HTMLDetailsElement).open ? "1" : "0"); } catch { /* sem armazenamento */ } }}>
      <summary>O que faz «{h.title}»</summary>
      <div class="help-row">
        <HelpArt art={h.art} />
        <HelpBody h={{ ...h, title: "" }} steps={false} />
      </div>
    </details>
  );
}
