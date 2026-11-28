// Atenuação das camadas que não pertencem ao passo atual da simulação (C1c). Só mexe na opacidade dos
// materiais que já existem: trocar de secção não cria geometrias nem materiais novos.
import * as THREE from "three";

type Base = { opacity: number; transparent: boolean; depthWrite: boolean };

/** Esbate (k = 0..1, fração da opacidade original) ou repõe (k = null) todos os materiais do grupo. */
export function dimGroup(g: THREE.Object3D, k: number | null) {
  g.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      const base = (m.userData.secBase ??= { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite }) as Base;
      const opacity = k == null ? base.opacity : base.opacity * k;
      const transparent = k == null ? base.transparent : true;
      const depthWrite = k == null ? base.depthWrite : false;
      if (m.opacity === opacity && m.transparent === transparent && m.depthWrite === depthWrite) continue;
      const recompile = m.transparent !== transparent;
      m.opacity = opacity;
      m.transparent = transparent;
      m.depthWrite = depthWrite;
      if (recompile) m.needsUpdate = true;
    }
  });
}

