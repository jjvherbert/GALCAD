// Exportação de malhas para formatos abertos: 3MF, OBJ e glTF binário (.glb). Puro JS.

export interface ExportMesh {
  vertices: Float32Array; // xyz
  triangles: Uint32Array;
  normals?: Float32Array;
}

// --- OBJ -------------------------------------------------------------------

export function toOBJ(m: ExportMesh, name = "peca"): string {
  const out: string[] = [`# Exportado pelo CAD protótipo (mm)`, `o ${name}`];
  for (let i = 0; i < m.vertices.length; i += 3) out.push(`v ${m.vertices[i]} ${m.vertices[i + 1]} ${m.vertices[i + 2]}`);
  for (let i = 0; i < m.triangles.length; i += 3) out.push(`f ${m.triangles[i] + 1} ${m.triangles[i + 1] + 1} ${m.triangles[i + 2] + 1}`);
  return out.join("\n") + "\n";
}

// --- 3MF (ZIP sem compressão) ------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP mínimo (método "stored"), suficiente para 3MF. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

export function to3MF(m: ExportMesh, name = "peca"): Uint8Array {
  const enc = new TextEncoder();
  const v: string[] = [];
  for (let i = 0; i < m.vertices.length; i += 3) v.push(`<vertex x="${m.vertices[i]}" y="${m.vertices[i + 1]}" z="${m.vertices[i + 2]}"/>`);
  const t: string[] = [];
  for (let i = 0; i < m.triangles.length; i += 3) t.push(`<triangle v1="${m.triangles[i]}" v2="${m.triangles[i + 1]}" v3="${m.triangles[i + 2]}"/>`);
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="pt-PT" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${name.replace(/[<&"]/g, "")}</metadata>
<resources><object id="1" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object></resources>
<build><item objectid="1"/></build>
</model>`;
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`) },
    { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`) },
    { name: "3D/3dmodel.model", data: enc.encode(model) },
  ]);
}

// --- glTF binário ------------------------------------------------------------

/** GLB com posições, normais e índices. glTF usa metros e Y para cima: converte de mm/Z-up. */
export function toGLB(m: ExportMesh): Uint8Array {
  const n = m.vertices.length / 3;
  const pos = new Float32Array(m.vertices.length);
  const nor = new Float32Array(m.vertices.length);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = m.vertices[3 * i] / 1000, y = m.vertices[3 * i + 1] / 1000, z = m.vertices[3 * i + 2] / 1000;
    const p = [x, z, -y]; // Z-up → Y-up
    pos.set(p, 3 * i);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    if (m.normals) nor.set([m.normals[3 * i], m.normals[3 * i + 2], -m.normals[3 * i + 1]], 3 * i);
  }
  const idx = new Uint32Array(m.triangles);
  const pad4 = (x: number) => (x + 3) & ~3;
  const bin = new Uint8Array(pad4(pos.byteLength) + pad4(nor.byteLength) + pad4(idx.byteLength));
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nor.buffer), pad4(pos.byteLength));
  bin.set(new Uint8Array(idx.buffer), pad4(pos.byteLength) + pad4(nor.byteLength));
  const json = {
    asset: { version: "2.0", generator: "CAD protótipo" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(m.normals ? { NORMAL: 1 } : {}) }, indices: 2 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pad4(pos.byteLength), byteLength: nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pad4(pos.byteLength) + pad4(nor.byteLength), byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: n, type: "VEC3" },
      { bufferView: 2, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = pad4(jsonBytes.length);
  if (jpad !== jsonBytes.length) {
    const p = new Uint8Array(jpad).fill(0x20);
    p.set(jsonBytes);
    jsonBytes = p;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  dv.setUint32(20 + jsonBytes.length, bin.length, true);
  dv.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  out.set(bin, 28 + jsonBytes.length);
  return out;
}
