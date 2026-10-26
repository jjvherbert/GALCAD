import { draw, makeBox, measureShapeVolumeProperties, type Shape3D, type Sketch } from "replicad";

// Casco simétrico por loft de secções transversais (planos YZ ao longo de X).
// Unidades: mm. Origem: popa (x=0), linha de água (z=0), plano de mediania (y=0).
export interface HullParams { L: number; B: number; D: number; T: number; stations: number }

export function buildHull({ L, B, D, T, stations }: HullParams): Shape3D {
  const sections: Sketch[] = [];
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);                 // 0 popa → 1 proa
    const beamFactor = Math.max(0.06, Math.sin(Math.PI * (0.35 + 0.65 * t)) ** 0.7 * (t < 0.35 ? 0.85 + 0.15 * t / 0.35 : 1));
    const draftFactor = Math.max(0.15, 1 - 0.75 * t ** 2.5);
    const b = (B / 2) * beamFactor;
    const tk = T * draftFactor;
    const x = L * t;
    const s = draw([-b, D])
      .lineTo([-b * 0.95, 0])
      .cubicBezierCurveTo([0, -tk], [-b * 0.95, -tk * 0.6], [-b * 0.4, -tk])
      .cubicBezierCurveTo([b * 0.95, 0], [b * 0.4, -tk], [b * 0.95, -tk * 0.6])
      .lineTo([b, D])
      .close()
      .sketchOnPlane("YZ", x) as Sketch;
    sections.push(s);
  }
  const [first, ...rest] = sections;
  return first.loftWith(rest, { ruled: false });
}

// Hidrostática simplificada: volume imerso abaixo de z=0 e centro de carena (resultados em m).
export function hydrostatics(hull: Shape3D, { L, B, T }: HullParams, rho = 1025) {
  const below = makeBox([-1, -B, -T * 3], [L + 1, B, 0]);
  const submerged = hull.clone().intersect(below);
  const props = measureShapeVolumeProperties(submerged);
  const vol = props.volume / 1e9;
  const [lcb, , vcb] = props.centerOfMass.map((v: number) => v / 1000);
  props.delete?.();
  return { volume: vol, displacementKg: vol * rho, lcb, vcb };
}
