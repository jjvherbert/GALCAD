// Superfícies: corpos de superfície (folhas) criados a partir de esboços, preenchimentos e desvios,
// e as operações que os ligam aos sólidos (costurar, espessar, aparar, apagar faces).
// Cada corpo de superfície fica em ctx.sheets com a chave do id da feature que o criou; aparar mantém
// a chave, costurar/espessar consomem os corpos de entrada.
export { surfaceExtrude, surfaceRevolve, surfaceSweep, surfaceLoft } from "./surface-sketch.ts";
export { boundary, fill, ruled } from "./surface-fill.ts";
export { offsetSurface, replaceFace, untrim } from "./surface-edit.ts";
export { knit, thicken } from "./surface-solid.ts";
export { deleteFace, trimSurface } from "./surface-trim.ts";
