// Acesso de baixo nível ao OpenCASCADE: reexporta o núcleo, as propriedades e a geometria local.
export { oc, Arena, setArena, T, getArena, hash, explore, listToArray, makeList, downcast, isType, v3, gpPnt, gpVec, gpDir, gpAx1, gpAx2, gpPln } from "./occ-core.ts";
export type { OC, Any, TopoDS_Shape, TopoDS_Face, TopoDS_Edge } from "./occ-core.ts";
export { faceProps, edgeProps, bbox, volume, isValid, makeCompound, vertexAt, isSmoothEdge, distance, makeShell } from "./occ-props.ts";
export type { FaceProps, EdgeProps } from "./occ-props.ts";
export { normalOnFace, sampleEdge, interpolateEdge, makeWire, sampleWire, wireEnd, gridFace, surfaceAt, outwardDir, wireOf, poleRowsFace } from "./occ-geom.ts";
export type { SurfaceLocal } from "./occ-geom.ts";
