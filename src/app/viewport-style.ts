// Aspeto do visualizador 3D: temas, paletas de resultados e análises, e materiais de análise de superfície.
import * as THREE from "three";

export interface Theme { bg: number; body: number; sheet: number; curve: number; edge: number; hover: number; sel: number; plane: number; sketch: number; axis: number; feat: number; preview: number }
export const themes: Record<"light" | "dark", Theme> = {
  light: { bg: 0xf3f4f6, body: 0xb9c7d6, sheet: 0xe5c07b, curve: 0xdb2777, edge: 0x1f2937, hover: 0xf59e0b, sel: 0x2563eb, plane: 0x5b8def, sketch: 0x1d4ed8, axis: 0x9ca3af, feat: 0x7dd3fc, preview: 0xfde047 },
  dark: { bg: 0x14181f, body: 0x7f93a8, sheet: 0xb08d3a, curve: 0xf472b6, edge: 0x0b0e13, hover: 0xf59e0b, sel: 0x60a5fa, plane: 0x5b8def, sketch: 0x93c5fd, axis: 0x6b7280, feat: 0x0ea5e9, preview: 0xeab308 },
};

/** Paleta sequencial (tipo viridis) para campos de resultados: t ∈ [0, 1]. */
const VIRIDIS = [0x440154, 0x482878, 0x3e4989, 0x31688e, 0x26828e, 0x1f9e89, 0x35b779, 0x6ece58, 0xb5de2b, 0xfde725];
export function sequentialColor(t: number, out: THREE.Color) {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const a = new THREE.Color(VIRIDIS[i]), b = new THREE.Color(VIRIDIS[i + 1]);
  out.copy(a).lerp(b, x - i);
}

/** Cores das classes de continuidade: folga, G0, G1, G2, G3. */
export const CONTINUITY_COLORS: Record<-1 | 0 | 1 | 2 | 3, number> = { [-1]: 0xdc2626, 0: 0x6b7280, 1: 0xeab308, 2: 0x16a34a, 3: 0x2563eb };

/**
 * Linhas de realce (highlight lines): luzes lineares paralelas ao eixo `e`, empilhadas na direção `s`
 * num plano acima do modelo. Em cada ponto, a reta que passa por ele segundo a normal corta o plano
 * das luzes; a coordenada desse ponto em `s` dá a risca. Ao contrário da zebra, não depende da vista
 * e é sensível ao sinal da curvatura (descontinuidades G1/G2 aparecem como quebras ou cotovelos).
 */
export function highlightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    uniforms: { e: { value: new THREE.Vector3(1, 0, 0) }, sdir: { value: new THREE.Vector3(0, 1, 0) }, h: { value: 100 }, w: { value: 10 } },
    vertexShader: `
      varying vec3 vPos; varying vec3 vN;
      void main() { vPos = (modelMatrix * vec4(position, 1.0)).xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0); }`,
    fragmentShader: `
      uniform vec3 e; uniform vec3 sdir; uniform float h; uniform float w;
      varying vec3 vPos; varying vec3 vN;
      void main() {
        vec3 n = normalize(vN);
        vec3 k = normalize(cross(e, sdir));
        float nk = dot(n, k);
        // normal quase paralela ao plano das luzes: a reta não chega às luzes (zona sem riscas)
        if (abs(nk) < 0.35) { gl_FragColor = vec4(0.82, 0.82, 0.86, 1.0); return; }
        float lam = (h - dot(vPos, k)) / nk;
        float sig = dot(vPos + lam * n, sdir) / w;
        // distância à risca mais próxima (em riscas) e largura de um píxel no mesmo parâmetro:
        // riscas finas com anti-aliasing; onde ficam mais densas do que o píxel, cinzento uniforme
        float f = abs(fract(sig + 0.5) - 0.5);
        float px = fwidth(sig);
        float shade = 0.75 + 0.25 * abs(nk);
        float line = 1.0 - smoothstep(px * 0.6, px * 1.6, f);
        // transição suave para cinzento onde as riscas ficam mais densas do que o píxel
        float dense = smoothstep(0.2, 0.45, px);
        vec3 col = mix(vec3(shade), vec3(0.05, 0.1, 0.35), line);
        gl_FragColor = vec4(mix(col, vec3(0.62, 0.64, 0.72), dense), 1.0);
      }`,
  });
}

/** Textura matcap às riscas: com a normal em coordenadas de vista dá as riscas de zebra (reflexo de luzes em tubo). */
export function zebraTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  for (let y = 0; y < 256; y += 10) { g.fillStyle = (y / 10) % 2 ? "#111" : "#f5f5f5"; g.fillRect(0, y, 256, 10); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Mapa de cores divergente (azul → branco → vermelho) para t ∈ [−1, 1]. */
export function divergingColor(t: number, out: THREE.Color): THREE.Color {
  const x = Math.max(-1, Math.min(1, t));
  return x < 0 ? out.setRGB(1 + x * 0.85, 1 + x * 0.6, 1) : out.setRGB(1, 1 - x * 0.6, 1 - x * 0.85);
}

/** Escala robusta: percentil 95 de |v| (os picos nas arestas não esmagam o resto). */
export function robustScale(values: ArrayLike<number>): number {
  const a = Array.from(values, Math.abs).filter((x) => x > 0).sort((p, q) => p - q);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0;
}
