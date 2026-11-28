// Contorno tracejado a vermelho das faces sem material válido (C1c): as arestas de fronteira de cada face
// (as que só um triângulo da face usa) num único `LineSegments` com material tracejado.
import * as THREE from "three";
import type { MeshData } from "../kernel/mesh.ts";
import { MISSING_MATERIAL } from "./material-colors.ts";

/** Constrói o contorno das faces `names` em `group`; devolve o número de segmentos. */
export function buildMissingOutline(group: THREE.Group, mesh: MeshData | null, names: readonly string[], size: number): number {
  if (!mesh || !names.length) return 0;
  const want = new Set(names), pos: number[] = [];
  const v = (i: number) => [mesh.vertices[3 * i], mesh.vertices[3 * i + 1], mesh.vertices[3 * i + 2]];
  for (const f of mesh.faces) {
    if (!want.has(f.name)) continue;
    const uses = new Map<string, [number, number, number]>();
    for (let t = f.start; t < f.start + f.count; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = mesh.triangles[t + e], b = mesh.triangles[t + ((e + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const u = uses.get(key);
        if (u) u[2]++; else uses.set(key, [a, b, 1]);
      }
    }
    for (const [a, b, n] of uses.values()) if (n === 1) pos.push(...v(a), ...v(b));
  }
  if (!pos.length) return 0;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const dash = Math.max(size, 1e-6) / 60;
  const line = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: MISSING_MATERIAL, dashSize: dash, gapSize: dash * 0.6 }));
  line.computeLineDistances();
  line.renderOrder = 2;
  line.name = "missing-material";
  group.add(line);
  return pos.length / 6;
}
