// Superfícies ao estilo do CATIA GSD (Fase 4): multi-secção com guias/spine/tangência, concordância
// (blend) G0/G1/G2, varrimento circular, extrapolação, cura (healing) e as opções avançadas de
// varrimento (binormal, suporte, guia, lei de escala).
// As superfícies construídas por amostragem são interpoladas por uma B-spline bicúbica (gridFace);
// a tangência pedida é sempre medida no fim e reportada (nunca é assumida).
export { multiSection } from "./gsd-section.ts";
export { blend, circleSweep, setupPipe } from "./gsd-blend.ts";
export { extrapolate, sewFaces, simplifyBody, seamDeviations, connectedParts, heal } from "./gsd-heal.ts";
