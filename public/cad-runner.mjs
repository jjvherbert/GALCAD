import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// src/sim/gmsh.ts
const list = (tags) => `{${tags.join(", ")}}`;
function femGeo(c) {
	const hex = c.mesh.element === "hex";
	const out = [
		`// Gerado pelo CAD protótipo — ${c.title}`,
		`// Unidades: mm. Elementos ${hex ? c.mesh.hexMethod === "subdivision" ? "hexaédricos (subdivisão)" : "hexaédricos estruturados" : "tetraédricos"} de ordem ${c.mesh.order}.`,
		`SetFactory("OpenCASCADE");`,
		`Merge "model.brep";`
	];
	if (c.bodies?.length) c.bodies.forEach((b, k) => out.push(`Physical Volume("${b.group}") = {${k + 1}};`));
	else out.push(`Physical Volume("SOLID") = Volume{:};`);
	for (const [name, tags] of Object.entries(c.groups)) out.push(`Physical Surface("${name}") = ${list(tags)};`);
	out.push(`Mesh.MeshSizeMax = ${c.mesh.size};`, `Mesh.MeshSizeMin = ${c.mesh.minSize};`, `Mesh.MeshSizeFromCurvature = ${c.mesh.curvature};`, `Mesh.ElementOrder = ${c.mesh.order};`, `Mesh.HighOrderOptimize = ${c.mesh.order === 2 && !hex ? 1 : 0};`, `Mesh.Optimize = 1;`, `Mesh.Algorithm3D = 1;`, `Mesh.MshFileVersion = 4.1;`, `Mesh.Binary = 0;`, `Mesh.SaveAll = 0;`);
	for (const l of c.mesh.local) out.push(`MeshSize{ PointsOf{ Surface${list(c.groups[l.group])}; } } = ${l.size};`);
	out.push(...meshControls(c));
	return out.join("\n") + "\n";
}
/**
* Controlos manuais da malha (ao estilo do pré-processador do Femap): seeds nas arestas (n.º de
* elementos e distribuição), superfícies e volumes mapeados (transfinitos) e o tipo de elemento.
*/
function meshControls(c) {
	const m = c.mesh, out = [];
	const hex = m.element === "hex";
	for (const cv of m.curves ?? []) {
		const dist = cv.progression && Math.abs(cv.progression - 1) > 1e-9 ? ` Using Progression ${cv.progression}` : cv.bump && Math.abs(cv.bump - 1) > 1e-9 ? ` Using Bump ${cv.bump}` : "";
		out.push(`Transfinite Curve{${cv.tag}} = ${cv.n + 1}${dist};`);
	}
	if (m.surfaces?.length) {
		out.push(`Transfinite Surface${list(m.surfaces)};`);
		if (hex) out.push(`Recombine Surface${list(m.surfaces)};`);
	}
	if (m.volumes?.length) out.push(`Transfinite Volume${list(m.volumes)};`);
	if (hex) {
		if (m.order === 2) out.push(`Mesh.SecondOrderIncomplete = 1;`);
		if (m.hexMethod === "subdivision") out.push(`Mesh.SubdivisionAlgorithm = 2;`);
	}
	return out;
}
/**
* Malha de volume de fluido para o SU2. Interno: o próprio corpo. Externo: caixa do domínio menos o
* corpo; as faces da caixa ficam "farfield" e as do corpo "body" (identificadas pela caixa envolvente).
*/
function su2Geo(c) {
	const out = [
		`// Gerado pelo CAD protótipo — ${c.title} (SU2)`,
		`SetFactory("OpenCASCADE");`,
		`Merge "model.brep";`
	];
	const s = c.mesh.size;
	if (c.regime === "internal") {
		out.push(`Physical Volume("fluid") = Volume{:};`);
		for (const [name, tags] of Object.entries(c.groups)) out.push(`Physical Surface("${name}") = ${list(tags)};`);
	} else {
		const d = c.domain;
		const e = .001 * Math.max(...d.max.map((x, i) => x - d.min[i]));
		out.push(`box = newv; Box(box) = {${d.min.join(", ")}, ${d.max.map((x, i) => x - d.min[i]).join(", ")}};`, `fluid() = BooleanDifference{ Volume{box}; Delete; }{ Volume{1}; Delete; };`, `inner() = Surface In BoundingBox{${d.min.map((x) => x + e).join(", ")}, ${d.max.map((x) => x - e).join(", ")}};`, `far() = Surface{:};`, `far() -= inner();`, `Physical Volume("fluid") = fluid();`, `Physical Surface("body") = inner();`, `Physical Surface("farfield") = far();`);
	}
	out.push(`Mesh.ScalingFactor = 0.001;`, `Mesh.MeshSizeMax = ${s};`, `Mesh.MeshSizeMin = ${s / 10};`, `Mesh.MeshSizeFromCurvature = 12;`, `Mesh.Algorithm3D = 1;`, `Mesh.ElementOrder = 1;`, `Mesh.SaveAll = 0;`);
	return out.join("\n") + "\n";
}
// src/sim/elements.ts
const id = (n) => Array.from({ length: n }, (_, i) => i);
const HEX20_CCX = [
	0,
	1,
	2,
	3,
	4,
	5,
	6,
	7,
	8,
	11,
	13,
	9,
	16,
	18,
	19,
	17,
	10,
	12,
	14,
	15
];
const HEX20_ASTER = [
	0,
	1,
	2,
	3,
	4,
	5,
	6,
	7,
	8,
	11,
	13,
	9,
	10,
	12,
	14,
	15,
	16,
	18,
	19,
	17
];
const HEX_FACES = [
	[
		0,
		1,
		2,
		3
	],
	[
		4,
		7,
		6,
		5
	],
	[
		0,
		4,
		5,
		1
	],
	[
		1,
		5,
		6,
		2
	],
	[
		2,
		6,
		7,
		3
	],
	[
		3,
		7,
		4,
		0
	]
];
/** Faces do tetraedro (CalculiX): F1 = 1-2-3, F2 = 1-4-2, F3 = 2-4-3, F4 = 3-4-1. */
const TET_FACES = [
	[
		0,
		1,
		2
	],
	[
		0,
		3,
		1
	],
	[
		1,
		3,
		2
	],
	[
		2,
		3,
		0
	]
];
const SOLIDS = {
	4: {
		kind: "tet",
		order: 1,
		gmsh: 4,
		nodes: 4,
		corners: 4,
		toCcx: id(4),
		toAster: id(4),
		aster: "TETRA4",
		faces: TET_FACES
	},
	11: {
		kind: "tet",
		order: 2,
		gmsh: 11,
		nodes: 10,
		corners: 4,
		toCcx: [
			0,
			1,
			2,
			3,
			4,
			5,
			6,
			7,
			9,
			8
		],
		toAster: [
			0,
			1,
			2,
			3,
			4,
			5,
			6,
			7,
			9,
			8
		],
		aster: "TETRA10",
		faces: TET_FACES
	},
	5: {
		kind: "hex",
		order: 1,
		gmsh: 5,
		nodes: 8,
		corners: 8,
		toCcx: id(8),
		toAster: id(8),
		aster: "HEXA8",
		faces: HEX_FACES
	},
	17: {
		kind: "hex",
		order: 2,
		gmsh: 17,
		nodes: 20,
		corners: 8,
		toCcx: HEX20_CCX,
		toAster: HEX20_ASTER,
		aster: "HEXA20",
		faces: HEX_FACES
	}
};
const FACES = {
	2: {
		kind: "tri",
		gmsh: 2,
		nodes: 3,
		corners: 3,
		weights: [
			1 / 3,
			1 / 3,
			1 / 3
		],
		aster: "TRIA3",
		toAster: id(3)
	},
	9: {
		kind: "tri",
		gmsh: 9,
		nodes: 6,
		corners: 3,
		weights: [
			0,
			0,
			0,
			1 / 3,
			1 / 3,
			1 / 3
		],
		aster: "TRIA6",
		toAster: id(6)
	},
	3: {
		kind: "quad",
		gmsh: 3,
		nodes: 4,
		corners: 4,
		weights: [
			1 / 4,
			1 / 4,
			1 / 4,
			1 / 4
		],
		aster: "QUAD4",
		toAster: id(4)
	},
	16: {
		kind: "quad",
		gmsh: 16,
		nodes: 8,
		corners: 4,
		weights: [
			-1 / 12,
			-1 / 12,
			-1 / 12,
			-1 / 12,
			1 / 3,
			1 / 3,
			1 / 3,
			1 / 3
		],
		aster: "QUAD8",
		toAster: id(8)
	}
};
const isSolidType = (t) => t in SOLIDS;
const isFaceType = (t) => t in FACES;
const sub$1 = (a, b) => [
	a[0] - b[0],
	a[1] - b[1],
	a[2] - b[2]
];
const cross$1 = (u, v) => [
	u[1] * v[2] - u[2] * v[1],
	u[2] * v[0] - u[0] * v[2],
	u[0] * v[1] - u[1] * v[0]
];
/** Chave de uma face pelos nós de canto (independente da ordem). */
const faceKey = (nodes) => [...nodes].sort((x, y) => x - y).join(",");
/** Triângulos (cantos) de uma face com a normal para FORA, a partir da ordem de normal para dentro. */
function outwardTriangles(c) {
	return c.length === 3 ? [[
		c[0],
		c[2],
		c[1]
	]] : [[
		c[0],
		c[3],
		c[2]
	], [
		c[0],
		c[2],
		c[1]
	]];
}
/** Funções de forma das faces (numeração Gmsh) em coordenadas naturais (ξ, η). */
function shape(type, x, y) {
	switch (type) {
		case 2: return [
			1 - x - y,
			x,
			y
		];
		case 9: {
			const L = [
				1 - x - y,
				x,
				y
			];
			return [
				L[0] * (2 * L[0] - 1),
				L[1] * (2 * L[1] - 1),
				L[2] * (2 * L[2] - 1),
				4 * L[0] * L[1],
				4 * L[1] * L[2],
				4 * L[2] * L[0]
			];
		}
		case 3: return [
			[-1, -1],
			[1, -1],
			[1, 1],
			[-1, 1]
		].map(([a, b]) => (1 + a * x) * (1 + b * y) / 4);
		case 16: return [
			...[
				[-1, -1],
				[1, -1],
				[1, 1],
				[-1, 1]
			].map(([a, b]) => (1 + a * x) * (1 + b * y) * (a * x + b * y - 1) / 4),
			(1 - x * x) * (1 - y) / 2,
			(1 + x) * (1 - y * y) / 2,
			(1 - x * x) * (1 + y) / 2,
			(1 - x) * (1 - y * y) / 2
		];
	}
	throw new Error(`Face do tipo Gmsh ${type} sem funções de forma`);
}
/** Derivadas das funções de forma em ξ e η (analíticas). */
function dshape(type, x, y) {
	switch (type) {
		case 2: return [[
			-1,
			1,
			0
		], [
			-1,
			0,
			1
		]];
		case 9: {
			const L = [
				1 - x - y,
				x,
				y
			], dx = [
				-1,
				1,
				0
			], dy = [
				-1,
				0,
				1
			];
			const d = (D) => [
				0,
				1,
				2
			].map((i) => (4 * L[i] - 1) * D[i]).concat([
				[0, 1],
				[1, 2],
				[2, 0]
			].map(([i, j]) => 4 * (D[i] * L[j] + L[i] * D[j])));
			return [d(dx), d(dy)];
		}
		case 3: {
			const c = [
				[-1, -1],
				[1, -1],
				[1, 1],
				[-1, 1]
			];
			return [c.map(([a, b]) => a * (1 + b * y) / 4), c.map(([a, b]) => b * (1 + a * x) / 4)];
		}
		case 16: {
			const c = [
				[-1, -1],
				[1, -1],
				[1, 1],
				[-1, 1]
			];
			return [[
				...c.map(([a, b]) => a * (1 + b * y) * (2 * a * x + b * y) / 4),
				-x * (1 - y),
				(1 - y * y) / 2,
				-x * (1 + y),
				-(1 - y * y) / 2
			], [
				...c.map(([a, b]) => b * (1 + a * x) * (a * x + 2 * b * y) / 4),
				-(1 - x * x) / 2,
				-(1 + x) * y,
				(1 - x * x) / 2,
				-(1 - x) * y
			]];
		}
	}
	throw new Error(`Face do tipo Gmsh ${type} sem funções de forma`);
}
const G3 = [
	[-Math.sqrt(.6), 5 / 9],
	[0, 8 / 9],
	[Math.sqrt(.6), 5 / 9]
];
const TA = .445948490915965;
const TB = .091576213509771;
const WA = .223381589678011 / 2;
const WB = .109951743655322 / 2;
/** Regras de Gauss: quadrilátero 3×3 e triângulo de 6 pontos (grau 4), [ξ, η, peso]. */
const GAUSS = {
	quad: G3.flatMap(([a, wa]) => G3.map(([b, wb]) => [
		a,
		b,
		wa * wb
	])),
	tri: [
		[
			TA,
			TA,
			WA
		],
		[
			1 - 2 * TA,
			TA,
			WA
		],
		[
			TA,
			1 - 2 * TA,
			WA
		],
		[
			TB,
			TB,
			WB
		],
		[
			1 - 2 * TB,
			TB,
			WB
		],
		[
			TB,
			1 - 2 * TB,
			WB
		]
	]
};
/**
* Integrais de uma face (nós pela ordem Gmsh): área, área nodal consistente ∫Nᵢ dA (a fração de uma
* tração uniforme que vai para cada nó) e vetor área nodal ∫Nᵢ n dA (pressão), com a normal pela
* regra da mão direita na ordem dos nós. Exato nas faces planas; isoparamétrico nas curvas.
*/
function faceIntegrals(type, pts) {
	const ft = FACES[type];
	if (type === 2) {
		const n = cross$1(sub$1(pts[1], pts[0]), sub$1(pts[2], pts[0])), area = Math.hypot(n[0], n[1], n[2]) / 2;
		const v = [
			n[0] / 6,
			n[1] / 6,
			n[2] / 6
		];
		return {
			area,
			nodal: [
				area / 3,
				area / 3,
				area / 3
			],
			vec: [
				v,
				[...v],
				[...v]
			]
		};
	}
	const nodal = new Array(ft.nodes).fill(0), vec = Array.from({ length: ft.nodes }, () => [
		0,
		0,
		0
	]);
	let area = 0;
	for (const [x, y, w] of GAUSS[ft.kind]) {
		const [Dx, Dy] = dshape(type, x, y);
		const dx = [
			0,
			0,
			0
		], dy = [
			0,
			0,
			0
		];
		pts.forEach((p, i) => {
			for (let k = 0; k < 3; k++) {
				dx[k] += Dx[i] * p[k];
				dy[k] += Dy[i] * p[k];
			}
		});
		const n = cross$1(dx, dy);
		const J = Math.hypot(n[0], n[1], n[2]);
		area += w * J;
		shape(type, x, y).forEach((Ni, i) => {
			nodal[i] += w * Ni * J;
			for (let k = 0; k < 3; k++) vec[i][k] += w * Ni * n[k];
		});
	}
	return {
		area,
		nodal,
		vec
	};
}
// src/sim/msh.ts
const NODES_PER = {
	1: 2,
	2: 3,
	3: 4,
	4: 4,
	5: 8,
	6: 6,
	7: 5,
	8: 3,
	9: 6,
	11: 10,
	15: 1,
	16: 8,
	17: 20,
	18: 15,
	19: 13
};
function parseMsh(text) {
	const lines = text.split(/\r?\n/);
	let i = 0;
	const next = () => lines[i++]?.trim() ?? "";
	const nodes = /* @__PURE__ */ new Map();
	const blocks = [];
	const physicals = /* @__PURE__ */ new Map();
	const entityPhysicals = /* @__PURE__ */ new Map();
	const entityBox = /* @__PURE__ */ new Map();
	while (i < lines.length) {
		const l = next();
		if (l === "$MeshFormat") {
			const [ver, binary] = next().split(/\s+/);
			if (!ver.startsWith("4")) throw new Error(`Formato MSH ${ver} não suportado (usar 4.1 ASCII)`);
			if (binary !== "0") throw new Error("Malha MSH binária: exporte em ASCII");
		} else if (l === "$PhysicalNames") {
			const n = Number(next());
			for (let k = 0; k < n; k++) {
				const m = /^(\d+)\s+(\d+)\s+"(.*)"$/.exec(next());
				if (m) physicals.set(m[3], {
					dim: Number(m[1]),
					tag: Number(m[2])
				});
			}
		} else if (l === "$Entities") {
			const [np, nc, ns, nv] = next().split(/\s+/).map(Number);
			const read = (dim, count) => {
				for (let k = 0; k < count; k++) {
					const v = next().split(/\s+/).map(Number);
					const off = dim === 0 ? 4 : 7;
					const nPhys = v[off];
					entityPhysicals.set(`${dim}:${v[0]}`, v.slice(off + 1, off + 1 + nPhys));
					if (dim) entityBox.set(`${dim}:${v[0]}`, v.slice(1, 7));
				}
			};
			read(0, np);
			read(1, nc);
			read(2, ns);
			read(3, nv);
		} else if (l === "$Nodes") {
			const [nb] = next().split(/\s+/).map(Number);
			for (let b = 0; b < nb; b++) {
				const [, , param, count] = next().split(/\s+/).map(Number);
				if (param) throw new Error("Nós paramétricos não suportados");
				const tags = [];
				for (let k = 0; k < count; k++) tags.push(Number(next()));
				for (let k = 0; k < count; k++) {
					const [x, y, z] = next().split(/\s+/).map(Number);
					nodes.set(tags[k], [
						x,
						y,
						z
					]);
				}
			}
		} else if (l === "$Elements") {
			const [nb] = next().split(/\s+/).map(Number);
			for (let b = 0; b < nb; b++) {
				const [dim, entity, type, count] = next().split(/\s+/).map(Number);
				const per = NODES_PER[type];
				if (!per) throw new Error(`Tipo de elemento Gmsh ${type} não suportado`);
				const conn = [], tags = [];
				for (let k = 0; k < count; k++) {
					const v = next().split(/\s+/).map(Number);
					tags.push(v[0]);
					for (let j = 1; j <= per; j++) conn.push(v[j]);
				}
				blocks.push({
					dim,
					entity,
					type,
					conn,
					tags
				});
			}
		}
	}
	if (!nodes.size) throw new Error("A malha não tem nós");
	return {
		nodes,
		blocks,
		physicals,
		entityPhysicals,
		entityBox
	};
}
/** Blocos de elementos que pertencem a um grupo físico (por nome). */
function physicalBlocks(m, name) {
	const p = m.physicals.get(name);
	if (!p) return [];
	return m.blocks.filter((b) => b.dim === p.dim && (m.entityPhysicals.get(`${b.dim}:${b.entity}`) ?? []).includes(p.tag));
}
/**
* Blocos de elementos de volume do caso (tetraedros e hexaedros): o grupo SOLID ou, nas montagens,
* os grupos dos corpos (B1, B2, …). Prismas e pirâmides dão erro (o mesher não os deve produzir).
*/
function solidBlocks(m, bodies) {
	const all = (bodies?.length ? bodies.map((b) => b.group) : ["SOLID"]).flatMap((n) => physicalBlocks(m, n)).filter((b) => b.dim === 3);
	const other = all.find((b) => !isSolidType(b.type));
	if (other) throw new Error(`A malha tem ${[6, 18].includes(other.type) ? "prismas" : [7, 19].includes(other.type) ? "pirâmides" : `elementos do tipo Gmsh ${other.type}`}: use hexaedros estruturados, subdivisão ou tetraedros`);
	if (new Set(all.map((b) => SOLIDS[b.type].order)).size > 1) throw new Error("A malha mistura elementos lineares e quadráticos");
	return all;
}
/** Blocos de faces de fronteira (triângulos e quadriláteros) de um grupo físico. */
const faceBlocks = (m, name) => physicalBlocks(m, name).filter((b) => isFaceType(b.type));
/** Elementos (nós pela ordem Gmsh) de uma lista de blocos, com o tipo de cada um. */
function* elementsOf(blocks) {
	for (const b of blocks) {
		const per = NODES_PER[b.type];
		for (let k = 0; k < b.conn.length; k += per) yield {
			type: b.type,
			nodes: b.conn.slice(k, k + per)
		};
	}
}
// src/sim/case.ts
/** Fator da amplitude no instante t (interpolação linear; constante fora da tabela). Sem dinâmica: 1. */
function amplitudeAt(c, t) {
	const a = c.dynamic?.amplitude;
	if (!a?.length) return 1;
	if (t <= a[0][0]) return a[0][1];
	for (let i = 1; i < a.length; i++) if (t <= a[i][0]) return a[i - 1][1] + (a[i][1] - a[i - 1][1]) * (t - a[i - 1][0]) / (a[i][0] - a[i - 1][0] || 1);
	return a[a.length - 1][1];
}
// src/sim/quality.ts
const sub = (a, b) => [
	a[0] - b[0],
	a[1] - b[1],
	a[2] - b[2]
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (u, v) => [
	u[1] * v[2] - u[2] * v[1],
	u[2] * v[0] - u[0] * v[2],
	u[0] * v[1] - u[1] * v[0]
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v) || 1)))) * 180 / Math.PI;
/** Vizinhos de cada canto (3 arestas em sentido direto): hexaedro e tetraedro (numeração Gmsh = Abaqus). */
const HEX_CORNERS = [
	[
		1,
		3,
		4
	],
	[
		2,
		0,
		5
	],
	[
		3,
		1,
		6
	],
	[
		0,
		2,
		7
	],
	[
		7,
		5,
		0
	],
	[
		4,
		6,
		1
	],
	[
		5,
		7,
		2
	],
	[
		6,
		4,
		3
	]
];
const TET_CORNERS = [
	[
		1,
		2,
		3
	],
	[
		2,
		0,
		3
	],
	[
		0,
		1,
		3
	],
	[
		2,
		1,
		0
	]
];
const HEX_EDGES = [
	[0, 1],
	[1, 2],
	[2, 3],
	[3, 0],
	[4, 5],
	[5, 6],
	[6, 7],
	[7, 4],
	[0, 4],
	[1, 5],
	[2, 6],
	[3, 7]
];
const TET_EDGES = [
	[0, 1],
	[1, 2],
	[2, 0],
	[0, 3],
	[1, 3],
	[2, 3]
];
/** Limites por omissão: os do Verify Mesh do Abaqus/CAE para ângulos, razão de aspeto e fator de forma; jacobiano e empeno como no Femap/NX. */
const QUALITY_LIMITS = {
	sj: [{
		min: 0,
		level: "error"
	}, {
		min: .2,
		level: "warning"
	}],
	ar: [{
		max: 10,
		level: "warning"
	}],
	minAngle: {
		hex: [{
			min: 10,
			level: "warning"
		}],
		tet: [{
			min: 5,
			level: "warning"
		}]
	},
	maxAngle: {
		hex: [{
			max: 160,
			level: "warning"
		}],
		tet: [{
			max: 170,
			level: "warning"
		}]
	},
	warp: [{
		max: 10,
		level: "warning"
	}],
	shape: [{
		min: 1e-4,
		level: "warning"
	}]
};
/** Medidas de um elemento pelos cantos. */
function elementQuality(kind, P) {
	const hex = kind === "hex";
	const sjs = (hex ? HEX_CORNERS : TET_CORNERS).map((nb, i) => {
		const e = nb.map((j) => sub(P[j], P[i]));
		const d = dot(cross(e[0], e[1]), e[2]) / (len(e[0]) * len(e[1]) * len(e[2]) || 1);
		return hex ? d : Math.min(1, d * Math.SQRT2);
	});
	const sj = Math.min(...sjs);
	const el = (hex ? HEX_EDGES : TET_EDGES).map(([a, b]) => len(sub(P[a], P[b])));
	const faces = SOLIDS[hex ? 5 : 4].faces;
	let minAngle = 180, maxAngle = 0, warp = 0;
	for (const f of faces) {
		const n = f.length;
		for (let i = 0; i < n; i++) {
			const a = angle(sub(P[f[(i + n - 1) % n]], P[f[i]]), sub(P[f[(i + 1) % n]], P[f[i]]));
			minAngle = Math.min(minAngle, a);
			maxAngle = Math.max(maxAngle, a);
		}
		if (n === 4) {
			const w1 = angle(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]])), cross(sub(P[f[2]], P[f[0]]), sub(P[f[3]], P[f[0]])));
			const w2 = angle(cross(sub(P[f[2]], P[f[1]]), sub(P[f[3]], P[f[1]])), cross(sub(P[f[3]], P[f[1]]), sub(P[f[0]], P[f[1]])));
			warp = Math.max(warp, w1, w2);
		}
	}
	if (hex) {
		const volume = [
			[
				0,
				1,
				2,
				6
			],
			[
				0,
				2,
				3,
				6
			],
			[
				0,
				3,
				7,
				6
			],
			[
				0,
				7,
				4,
				6
			],
			[
				0,
				4,
				5,
				6
			],
			[
				0,
				5,
				1,
				6
			]
		].reduce((s, [a, b, c, d]) => s + dot(cross(sub(P[b], P[a]), sub(P[c], P[a])), sub(P[d], P[a])) / 6, 0);
		return {
			sj,
			ar: Math.max(...el) / Math.min(...el),
			minAngle,
			maxAngle,
			warp,
			volume
		};
	}
	const volume = dot(cross(sub(P[1], P[0]), sub(P[2], P[0])), sub(P[3], P[0])) / 6;
	const areas = faces.map((f) => len(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]))) / 2);
	const hmin = 3 * Math.abs(volume) / Math.max(...areas);
	const ar = Math.max(...el) / (hmin || 1e-300) * Math.sqrt(2 / 3);
	const a = sub(P[1], P[0]), b = sub(P[2], P[0]), c = sub(P[3], P[0]);
	const num = [
		cross(b, c),
		cross(c, a),
		cross(a, b)
	].reduce((s, v, k) => [
		s[0] + v[0] * [
			dot(a, a),
			dot(b, b),
			dot(c, c)
		][k],
		s[1] + v[1] * [
			dot(a, a),
			dot(b, b),
			dot(c, c)
		][k],
		s[2] + v[2] * [
			dot(a, a),
			dot(b, b),
			dot(c, c)
		][k]
	], [
		0,
		0,
		0
	]);
	const R = len(num) / (12 * Math.abs(volume) || 1e-300);
	const shape = Math.abs(volume) / (8 * Math.sqrt(3) * R ** 3 / 27);
	return {
		sj,
		ar,
		minAngle,
		maxAngle,
		shape,
		volume
	};
}
const LABELS = {
	sj: [
		"Jacobiano escalado",
		"",
		"all"
	],
	ar: [
		"Razão de aspeto",
		"",
		"all"
	],
	minAngle: [
		"Menor ângulo das faces",
		"°",
		"all"
	],
	maxAngle: [
		"Maior ângulo das faces",
		"°",
		"all"
	],
	warp: [
		"Empeno das faces",
		"°",
		"hex"
	],
	shape: [
		"Fator de forma (tetraedros)",
		"",
		"tet"
	]
};
/** Qualidade de toda a malha de volume do caso (grupos SOLID ou B1, B2, …). */
function meshQuality(m, bodies) {
	const types = {};
	const vals = {
		sj: [],
		ar: [],
		minAngle: [],
		maxAngle: [],
		warp: [],
		shape: []
	};
	const perElement = [];
	const info = [];
	const used = /* @__PURE__ */ new Set();
	let volume = 0;
	for (const e of elementsOf(solidBlocks(m, bodies))) {
		const st = SOLIDS[e.type];
		types[`${st.kind}${st.nodes}`] = (types[`${st.kind}${st.nodes}`] ?? 0) + 1;
		e.nodes.forEach((n) => used.add(n));
		const P = e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n));
		const q = elementQuality(st.kind, P);
		volume += q.volume;
		for (const k of Object.keys(vals)) {
			const v = q[k];
			if (v !== void 0) vals[k].push({
				v,
				kind: st.kind
			});
		}
		perElement.push(q.sj);
		info.push({
			sj: q.sj,
			ar: q.ar,
			center: [
				0,
				1,
				2
			].map((k) => P.reduce((s, p) => s + p[k], 0) / P.length)
		});
	}
	const metrics = [];
	let errors = 0;
	for (const key of Object.keys(vals)) {
		const list = vals[key];
		if (!list.length) continue;
		const [label, unit, applies] = LABELS[key];
		const L = QUALITY_LIMITS[key];
		const limitsOf = (kind) => Array.isArray(L) ? L : L[kind];
		const kinds = [...new Set(list.map((x) => x.kind))];
		const limits = kinds.length === 1 ? limitsOf(kinds[0]) : limitsOf("hex");
		const fail = limits.map((_, i) => list.filter((x) => {
			const l = limitsOf(x.kind)[i];
			return l && (l.min !== void 0 && x.v < l.min || l.max !== void 0 && x.v > l.max);
		}).length);
		limits.forEach((l, i) => {
			if (l.level === "error") errors += fail[i];
		});
		const v = list.map((x) => x.v);
		const min = Math.min(...v), max = Math.max(...v);
		const range = key === "sj" ? [Math.min(0, min), 1] : key === "minAngle" || key === "maxAngle" ? [0, 180] : key === "shape" ? [0, 1] : [Math.min(min, 1), Math.max(max, 1 + 1e-9)];
		const edges = Array.from({ length: 11 }, (_, i) => range[0] + (range[1] - range[0]) * i / 10);
		const counts = new Array(10).fill(0);
		for (const x of v) counts[Math.min(9, Math.max(0, Math.floor((x - range[0]) / (range[1] - range[0] || 1) * 10)))]++;
		metrics.push({
			key,
			label,
			unit,
			applies,
			count: v.length,
			min,
			max,
			mean: v.reduce((a, b) => a + b, 0) / v.length,
			limits,
			fail,
			hist: {
				edges,
				counts
			}
		});
	}
	const worst = info.map((x, i) => ({
		element: i + 1,
		...x
	})).sort((a, b) => a.sj - b.sj).slice(0, 10);
	const notes = [];
	if (errors) notes.push(`${errors} elemento(s) invertido(s) ou degenerado(s) (jacobiano ≤ 0): o cálculo não é fiável — refaça a malha`);
	const warn = metrics.reduce((s, x) => s + x.limits.reduce((t, l, i) => t + (l.level === "warning" ? x.fail[i] : 0), 0), 0);
	if (warn) notes.push(`${warn} assinalamento(s) de qualidade (elementos distorcidos): confirme se estão em zonas que importam para o resultado`);
	return {
		elements: perElement.length,
		nodes: used.size,
		types,
		volume,
		metrics,
		perElement,
		worst,
		ok: errors === 0,
		notes
	};
}
/**
* Passo de tempo estável do explícito (diferenças centrais), com margem: 0,35·Lc/cd, Lc = V/Amáx
* (hexaedros) ou a menor altura 3V/Amáx (tetraedros), metade nos elementos quadráticos; cd =
* √(E(1−ν)/(ρ(1+ν)(1−2ν))) em mm/s (E em MPa, ρ em g/cm³). Abaixo do limite que o CalculiX calcula,
* para não ativar o escalamento seletivo de massa.
*/
function stableIncrement(m, materials) {
	let best = {
		dt: Infinity,
		element: 0,
		lc: 0
	};
	let el = 0;
	for (const mat of materials) {
		const rho = mat.density * 1e-9;
		const cd = Math.sqrt(mat.E * (1 - mat.nu) / (rho * (1 + mat.nu) * (1 - 2 * mat.nu)));
		for (const e of elementsOf(solidBlocks(m, [{ group: mat.group }]))) {
			el++;
			const st = SOLIDS[e.type];
			const P = e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n));
			const V = Math.abs(elementQuality(st.kind, P).volume);
			const Amax = Math.max(...st.faces.map((f) => f.length === 3 ? len(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]))) / 2 : len(cross(sub(P[f[2]], P[f[0]]), sub(P[f[3]], P[f[1]]))) / 2));
			const lc = (st.kind === "tet" ? 3 : 1) * V / (Amax || 1e-300) * (st.order === 2 ? .5 : 1);
			const dt = .35 * lc / cd;
			if (dt < best.dt) best = {
				dt,
				element: el,
				lc
			};
		}
	}
	return best;
}
// src/sim/calculix.ts
/**
* Elemento do CalculiX: tetraedros C3D4/C3D10; hexaedros lineares com modos incompatíveis (C3D8I,
* sem bloqueio por corte em flexão — por omissão), integração completa (C3D8) ou reduzida (C3D8R,
* controlo de hourglass); quadráticos com integração reduzida (C3D20R, por omissão) ou completa
* (C3D20). Na térmica, sempre integração completa.
*/
function ccxElement(st, integration, thermal = false) {
	if (st.kind === "tet") return st.order === 2 ? "C3D10" : "C3D4";
	if (thermal) return st.order === 2 ? "C3D20" : "C3D8";
	if (st.order === 2) return integration === "full" ? "C3D20" : "C3D20R";
	return integration === "full" ? "C3D8" : integration === "reduced" ? "C3D8R" : "C3D8I";
}
const fmt = (x) => Number.isInteger(x) ? String(x) : x.toPrecision(10).replace(/\.?0+(e|$)/, "$1");
function calculixDeck(c, m) {
	const warnings = [];
	const groupsOfBodies = c.bodies?.length ? c.bodies.map((b) => b.group) : ["SOLID"];
	const thermal = c.analysis === "thermal";
	if (!solidBlocks(m, c.bodies).length) throw new Error(`A malha não tem elementos de volume nos grupos ${groupsOfBodies.join(", ")}`);
	const elems = [];
	const bodyRange = [];
	for (const g of groupsOfBodies) {
		const first = elems.length + 1;
		for (const e of elementsOf(solidBlocks(m, [{ group: g }]))) {
			const st = SOLIDS[e.type];
			elems.push({
				type: ccxElement(st, c.mesh.integration, thermal),
				st,
				n: st.toCcx.map((i) => e.nodes[i])
			});
		}
		if (elems.length < first) throw new Error(`O corpo ${g} não tem elementos na malha`);
		bodyRange.push([first, elems.length]);
	}
	const faceOf = /* @__PURE__ */ new Map();
	elems.forEach((e, i) => e.st.faces.forEach((f, j) => faceOf.set(faceKey(f.map((q) => e.n[q])), [i + 1, j + 1])));
	const used = /* @__PURE__ */ new Set();
	for (const e of elems) for (const n of e.n) used.add(n);
	const bfaces = (name) => [...elementsOf(faceBlocks(m, name))].map(({ type, nodes }) => {
		const corners = nodes.slice(0, FACES[type].corners);
		return {
			n: nodes,
			corners,
			...faceIntegrals(type, nodes.map((t) => m.nodes.get(t))),
			face: faceOf.get(faceKey(corners))
		};
	});
	const groupArea = {};
	const tris = {};
	for (const name of Object.keys(c.groups)) {
		tris[name] = bfaces(name);
		groupArea[name] = tris[name].reduce((s, t) => s + t.area, 0);
		if (!tris[name].length) warnings.push(`O grupo ${name} não tem faces na malha`);
		if (tris[name].some((t) => !t.face)) warnings.push(`Grupo ${name}: faces sem face de elemento correspondente`);
	}
	const L = [];
	L.push("*HEADING", `${c.title} — gerado pelo CAD protótipo`);
	for (const h of c.hypotheses) L.push(`** ${h}`);
	L.push("** Unidades: mm, N, MPa, t, s");
	L.push("*NODE, NSET=NALL");
	for (const [t, p] of [...m.nodes].sort((a, b) => a[0] - b[0])) if (used.has(t)) L.push(`${t}, ${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])}`);
	elems.forEach((e, i) => {
		if (i === 0 || elems[i - 1].type !== e.type) L.push(`*ELEMENT, TYPE=${e.type}, ELSET=EALL`);
		L.push(e.n.length > 15 ? `${i + 1}, ${e.n.slice(0, 15).join(", ")},\n${e.n.slice(15).join(", ")}` : `${i + 1}, ${e.n.join(", ")}`);
	});
	for (const [name, list] of Object.entries(tris)) {
		const ns = [...new Set(list.flatMap((t) => t.n))].sort((a, b) => a - b);
		L.push(`*NSET, NSET=N_${name}`);
		for (let k = 0; k < ns.length; k += 12) L.push(ns.slice(k, k + 12).join(", ") + ",");
	}
	const dofSets = [
		0,
		1,
		2
	].map((k) => c.loads.flatMap((ld) => ld.kind === "fixed" || ld.kind === "displacement" && ld.u[k] !== null ? [`N_${ld.group}`] : []));
	if (!thermal) dofSets.forEach((sets, k) => {
		if (sets.length) L.push(`*NSET, NSET=N_R${"XYZ"[k]}`, ...sets.map((x) => `${x},`));
	});
	const material = (name, mat) => {
		L.push(`*MATERIAL, NAME=${name}`, `** ${mat.name}${mat.source ? ` (${mat.source})` : ""}`);
		if (thermal) {
			L.push("*CONDUCTIVITY", fmt(mat.k ?? 50));
			return;
		}
		L.push("*ELASTIC", `${fmt(mat.E)}, ${fmt(mat.nu)}`, "*DENSITY", fmt(mat.density * 1e-9));
		if (c.dynamic && (c.dynamic.alpha || c.dynamic.beta)) L.push(`*DAMPING, ALPHA=${fmt(c.dynamic.alpha)}, BETA=${fmt(c.dynamic.beta)}`);
		if (mat.alpha) L.push("*EXPANSION", fmt(mat.alpha));
		if (c.nonlinear?.plasticity) {
			if (!(mat.yield > 0)) throw new Error(`Plasticidade: o material ${mat.name} não tem tensão de cedência`);
			const Et = mat.tangent ?? 0, Hp = mat.E * Et / (mat.E - Et);
			L.push("*PLASTIC", `${fmt(mat.yield)}, 0.`, `${fmt(mat.yield + Hp)}, 1.`);
		}
	};
	if (c.bodies?.length) c.bodies.forEach((b, k) => {
		L.push(`*ELSET, ELSET=${b.group}, GENERATE`, `${bodyRange[k][0]}, ${bodyRange[k][1]}, 1`);
		material(`MAT_${b.group}`, b.material);
		L.push(`*SOLID SECTION, ELSET=${b.group}, MATERIAL=MAT_${b.group}`);
	});
	else {
		material("MAT", c.material);
		L.push("*SOLID SECTION, ELSET=EALL, MATERIAL=MAT");
	}
	const Emax = Math.max(c.material.E, ...(c.bodies ?? []).map((b) => b.material.E));
	for (const t of c.ties ?? []) {
		const master = tris[t.master].filter((x) => x.face);
		if (!tris[t.slave]?.length || !master.length) {
			warnings.push(`Contacto ${t.name}: faces sem malha`);
			continue;
		}
		if (t.kind === "contact") {
			const slave = tris[t.slave].filter((x) => x.face);
			const K = 20 * Emax;
			L.push(`*SURFACE, NAME=S_${t.slave}, TYPE=ELEMENT`, ...slave.map((x) => `${x.face[0]}, S${x.face[1]}`));
			L.push(`*SURFACE, NAME=S_${t.master}, TYPE=ELEMENT`, ...master.map((x) => `${x.face[0]}, S${x.face[1]}`));
			L.push(`*SURFACE INTERACTION, NAME=SI_${t.name}`, "*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR", `${fmt(K)}`);
			if ((t.mu ?? 0) > 0) L.push("*FRICTION", `${fmt(t.mu)}, ${fmt(K / 100)}`);
			L.push(`*CONTACT PAIR, INTERACTION=SI_${t.name}, TYPE=SURFACE TO SURFACE`, `S_${t.slave}, S_${t.master}`);
			continue;
		}
		L.push(`*SURFACE, NAME=S_${t.slave}, TYPE=NODE`, `N_${t.slave}`);
		L.push(`*SURFACE, NAME=S_${t.master}, TYPE=ELEMENT`, ...master.map((x) => `${x.face[0]}, S${x.face[1]}`));
		L.push(`*TIE, NAME=${t.name}, POSITION TOLERANCE=${fmt(t.tolerance)}`, `S_${t.slave}, S_${t.master}`);
	}
	if (thermal) L.push("*INITIAL CONDITIONS, TYPE=TEMPERATURE", "NALL, 20.");
	const bcs = [], loads = [], bcsAmp = [];
	const cload = /* @__PURE__ */ new Map();
	for (const ld of c.loads) switch (ld.kind) {
		case "fixed":
			bcs.push(`N_${ld.group}, 1, 3`);
			break;
		case "displacement":
			ld.u.forEach((u, k) => {
				if (u !== null) (c.dynamic && u !== 0 ? bcsAmp : bcs).push(`N_${ld.group}, ${k + 1}, ${k + 1}, ${fmt(u)}`);
			});
			break;
		case "temperature":
			bcs.push(`N_${ld.group}, 11, 11, ${fmt(ld.t)}`);
			break;
		case "pointForce": {
			let best = -1, bd = Infinity;
			for (const t of used) {
				const q = m.nodes.get(t);
				if (!q) continue;
				const d = (q[0] - ld.point[0]) ** 2 + (q[1] - ld.point[1]) ** 2 + (q[2] - ld.point[2]) ** 2;
				if (d < bd) {
					bd = d;
					best = t;
				}
			}
			if (best < 0) {
				warnings.push("Força pontual sem nó da malha");
				break;
			}
			const acc = cload.get(best) ?? [
				0,
				0,
				0
			];
			for (let k = 0; k < 3; k++) acc[k] += ld.f[k];
			cload.set(best, acc);
			warnings.push(`Força pontual aplicada no nó ${best}, a ${Math.sqrt(bd).toFixed(2)} mm do ponto pedido: tensões locais irreais, só a resposta global é válida`);
			break;
		}
		case "force": {
			const A = groupArea[ld.group];
			if (!(A > 0)) {
				warnings.push(`Força no grupo ${ld.group} sem área`);
				break;
			}
			for (const t of tris[ld.group]) t.n.forEach((n, i) => {
				if (t.nodal[i] === 0) return;
				const acc = cload.get(n) ?? [
					0,
					0,
					0
				];
				for (let k = 0; k < 3; k++) acc[k] += ld.f[k] * t.nodal[i] / A;
				cload.set(n, acc);
			});
			break;
		}
		case "pressure":
			loads.push("*DLOAD");
			for (const t of tris[ld.group]) if (t.face) loads.push(`${t.face[0]}, P${t.face[1]}, ${fmt(ld.p)}`);
			break;
		case "gravity": {
			const g = Math.hypot(...ld.g);
			if (g > 0) loads.push("*DLOAD", `EALL, GRAV, ${fmt(g)}, ${ld.g.map((x) => fmt(x / g)).join(", ")}`);
			break;
		}
		case "convection":
			loads.push("*FILM");
			for (const t of tris[ld.group]) if (t.face) loads.push(`${t.face[0]}, F${t.face[1]}, ${fmt(ld.tInf)}, ${fmt(ld.h * .001)}`);
			break;
		case "heatFlux":
			loads.push("*DFLUX");
			for (const t of tris[ld.group]) if (t.face) loads.push(`${t.face[0]}, S${t.face[1]}, ${fmt(ld.q * .001)}`);
	}
	const dofNodes = dofSets.map((sets) => new Set(sets.flatMap((n) => tris[n.slice(2)]?.flatMap((t) => t.n) ?? [])));
	const supportLoad = [
		0,
		0,
		0
	];
	for (const [n, f] of cload) for (let k = 0; k < 3; k++) if (dofNodes[k].has(n)) supportLoad[k] += f[k];
	for (const ld of c.loads) {
		if (ld.kind !== "pressure") continue;
		for (const t of tris[ld.group]) {
			if (!t.face) continue;
			const el = elems[t.face[0] - 1];
			const e = el.n.slice(0, el.st.corners).map((x) => m.nodes.get(x));
			const ce = [
				0,
				1,
				2
			].map((q) => e.reduce((s, p) => s + p[q], 0) / e.length);
			const A = m.nodes.get(t.n[0]);
			const nv = t.vec.reduce((s, v) => [
				s[0] + v[0],
				s[1] + v[1],
				s[2] + v[2]
			], [
				0,
				0,
				0
			]);
			const sgn = Math.sign(nv[0] * (A[0] - ce[0]) + nv[1] * (A[1] - ce[1]) + nv[2] * (A[2] - ce[2])) || 1;
			t.n.forEach((nd, i) => {
				for (let k = 0; k < 3; k++) if (dofNodes[k].has(nd)) supportLoad[k] += -ld.p * sgn * t.vec[i][k];
			});
		}
	}
	if (cload.size) {
		loads.push("*CLOAD");
		for (const [n, f] of cload) f.forEach((x, k) => {
			if (Math.abs(x) > 0) loads.push(`${n}, ${k + 1}, ${fmt(x)}`);
		});
	}
	const nl = c.analysis === "static" ? c.nonlinear : void 0;
	const contact = (c.ties ?? []).some((t) => t.kind === "contact");
	let dyn;
	if (c.dynamic) {
		const D = c.dynamic;
		const st = D.dt === void 0 ? stableIncrement(m, c.bodies?.length ? c.bodies.map((b) => ({
			group: b.group,
			...b.material
		})) : [{
			group: "SOLID",
			...c.material
		}]) : void 0;
		const dt = D.dt ?? st.dt;
		const increments = Math.ceil(D.duration / dt - 1e-9);
		if (increments > 2e6) throw new Error(`Dinâmica: ${increments} incrementos — reduza a duração ou aumente os elementos (o passo estável é ${dt.toExponential(2)} s)`);
		dyn = {
			dt,
			increments,
			frequency: Math.max(1, Math.round(increments / D.frames)),
			stable: !!st
		};
		L.push("*AMPLITUDE, NAME=A1");
		for (let k = 0; k < D.amplitude.length; k += 4) L.push(D.amplitude.slice(k, k + 4).flatMap(([t, v]) => [fmt(t), fmt(v)]).join(", "));
		for (let i = 0; i < loads.length; i++) if (/^\*(CLOAD|DLOAD|DFLUX|FILM)$/.test(loads[i])) loads[i] += ", AMPLITUDE=A1";
	}
	if (contact && c.analysis !== "static") throw new Error("Contacto com atrito: só em análises estáticas (use contacto colado nas modais/encurvadura/térmicas)");
	if (dyn) L.push(`*STEP, INC=${dyn.increments + 100}`, c.dynamic.scheme === "explicit" ? "*DYNAMIC, EXPLICIT, DIRECT" : "*DYNAMIC, DIRECT", `${fmt(dyn.dt)}, ${fmt(c.dynamic.duration)}`);
	else if (nl || contact) {
		const n = nl?.increments ?? 10, inc = 1 / n;
		L.push(`*STEP${nl?.geometry ? ", NLGEOM" : ""}, INC=${Math.max(200, 20 * n)}`, "*STATIC", `${fmt(inc)}, 1., ${fmt(inc * 1e-4)}, ${fmt(inc)}`);
	} else if (c.analysis === "static") L.push("*STEP", "*STATIC");
	else if (c.analysis === "modal") L.push("*STEP", "*FREQUENCY", String(c.modes));
	else if (c.analysis === "buckling") L.push("*STEP", "*BUCKLE", String(c.modes));
	else L.push("*STEP", "*HEAT TRANSFER, STEADY STATE");
	if (bcs.length) L.push("*BOUNDARY", ...bcs);
	if (bcsAmp.length) L.push("*BOUNDARY, AMPLITUDE=A1", ...bcsAmp);
	if (c.analysis !== "modal") L.push(...loads);
	if (thermal) L.push("*NODE FILE", "NT");
	else if (dyn) {
		const f = `, FREQUENCY=${dyn.frequency}`;
		L.push(`*NODE FILE${f}`, "U", `*EL FILE${f}`, "S");
		dofSets.forEach((sets, k) => {
			if (sets.length) L.push(`*NODE PRINT, NSET=N_R${"XYZ"[k]}, TOTALS=ONLY${f}`, "RF");
		});
	} else {
		L.push("*NODE FILE", "U");
		if (c.analysis === "static") L.push("*EL FILE", nl?.plasticity ? "S, PEEQ" : "S");
		if (c.analysis === "static") dofSets.forEach((sets, k) => {
			if (sets.length) L.push(`*NODE PRINT, NSET=N_R${"XYZ"[k]}, TOTALS=ONLY`, "RF");
		});
		if (c.analysis === "static") {
			for (const ld of c.loads) if (ld.kind === "fixed" || ld.kind === "displacement") L.push(`*NODE PRINT, NSET=N_${ld.group}, TOTALS=ONLY`, "RF");
		}
	}
	L.push("*END STEP");
	if (c.analysis === "static" && !c.loads.some((l) => l.kind === "fixed" || l.kind === "displacement")) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
	return {
		inp: L.join("\n") + "\n",
		nodes: used.size,
		elements: elems.length,
		groupArea,
		supportLoad,
		warnings,
		dynamic: dyn
	};
}
/** Lê um `.frd` ASCII: coordenadas dos nós e blocos de resultados nodais. */
function parseFrd(text) {
	const lines = text.split(/\r?\n/);
	const nodes = /* @__PURE__ */ new Map();
	const blocks = [];
	const vals = (l, n) => Array.from({ length: n }, (_, k) => Number(l.slice(13 + 12 * k, 25 + 12 * k)));
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (l.startsWith("    2C")) for (i++; i < lines.length && !lines[i].startsWith(" -3"); i++) {
			const r = lines[i];
			if (r.startsWith(" -1")) {
				const v = vals(r, 3);
				nodes.set(Number(r.slice(3, 13)), [
					v[0],
					v[1],
					v[2]
				]);
			}
		}
		else if (l.startsWith("  100C")) {
			const value = Number(l.slice(12, 24));
			let j = i + 1;
			const name = lines[j].trim().split(/\s+/)[1];
			const comps = [];
			for (j++; lines[j]?.startsWith(" -5"); j++) comps.push(lines[j].trim().split(/\s+/)[1]);
			const nv = comps.filter((x) => x !== "ALL").length;
			const data = /* @__PURE__ */ new Map();
			for (; j < lines.length && !lines[j].startsWith(" -3"); j++) {
				const r = lines[j];
				if (r.startsWith(" -1")) data.set(Number(r.slice(3, 13)), vals(r, nv));
			}
			blocks.push({
				name,
				value,
				components: comps.filter((x) => x !== "ALL"),
				data
			});
			i = j;
		}
	}
	return {
		nodes,
		blocks
	};
}
/**
* Valores próprios do `.dat`: frequências (Hz) ou fatores de encurvadura; reações totais de cada
* conjunto no último tempo e, nas análises incrementais, a soma das reações em cada tempo.
*/
function parseDat(text) {
	const lines = text.split(/\r?\n/);
	const frequencies = [], buckling = [];
	const sets = /* @__PURE__ */ new Map();
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (/E I G E N V A L U E\s+O U T P U T/.test(l)) for (let j = i + 1; j < lines.length; j++) {
			const v = lines[j].trim().split(/\s+/).map(Number);
			if (v.length >= 4 && Number.isInteger(v[0]) && v.every((x) => Number.isFinite(x))) frequencies.push(v[3]);
			else if (frequencies.length && lines[j].trim() === "") break;
		}
		else if (/B U C K L I N G\s+F A C T O R\s+O U T P U T/.test(l)) for (let j = i + 1; j < lines.length; j++) {
			const v = lines[j].trim().split(/\s+/).map(Number);
			if (v.length === 2 && Number.isInteger(v[0]) && Number.isFinite(v[1])) buckling.push(v[1]);
			else if (buckling.length && lines[j].trim() === "") break;
		}
		else if (/total force/.test(l)) {
			const v = lines[i + 2]?.trim().split(/\s+/).map(Number);
			if (!v || v.length < 3 || !v.every(Number.isFinite)) continue;
			const m = /for set (\S+) and time\s+(\S+)/.exec(l);
			const set = (m?.[1] ?? `#${sets.size}`).toUpperCase(), t = Number(m?.[2] ?? 1);
			if (!sets.has(set)) sets.set(set, /* @__PURE__ */ new Map());
			sets.get(set).set(t, [
				v[0],
				v[1],
				v[2]
			]);
		}
	}
	const times = [...new Set([...sets.values()].flatMap((x) => [...x.keys()]))].sort((a, b) => a - b);
	const perDof = [
		"N_RX",
		"N_RY",
		"N_RZ"
	].map((n) => sets.get(n));
	const reactionHistory = times.map((time) => {
		const f = [
			0,
			0,
			0
		];
		if (perDof.some(Boolean)) perDof.forEach((st, k) => {
			f[k] = st?.get(time)?.[k] ?? 0;
		});
		else for (const st of sets.values()) {
			const v = st.get(time);
			if (v) for (let k = 0; k < 3; k++) f[k] += v[k];
		}
		return {
			time,
			f
		};
	});
	const setTotals = {};
	for (const [name, st] of sets) {
		const last = [...st.keys()].sort((a, b) => a - b).at(-1);
		if (last !== void 0) setTotals[name] = st.get(last);
	}
	return {
		frequencies,
		buckling,
		reactions: reactionHistory.length ? [reactionHistory.at(-1).f] : [],
		reactionHistory,
		setTotals
	};
}
/**
* Superfície exterior da malha de volume: faces dos elementos (pelos cantos) que só pertencem a um
* elemento, em triângulos com a normal para fora; `index` dá a posição de cada nó em `positions`.
* `edges`: arestas das faces exteriores (pares de índices), sem as diagonais dos quadriláteros.
*/
function exteriorSurface(m, bodies) {
	const count = /* @__PURE__ */ new Map();
	let el = 0;
	for (const e of elementsOf(solidBlocks(m, bodies))) {
		for (const f of SOLIDS[e.type].faces) {
			const n = f.map((q) => e.nodes[q]);
			const key = faceKey(n);
			const x = count.get(key);
			if (x) x.k++;
			else count.set(key, {
				n,
				k: 1,
				element: el
			});
		}
		el++;
	}
	const index = /* @__PURE__ */ new Map();
	const positions = [], triangles = [], edges = [];
	const faces = [];
	const seen = /* @__PURE__ */ new Set();
	const id = (t) => {
		if (!index.has(t)) {
			index.set(t, index.size);
			positions.push(...m.nodes.get(t));
		}
		return index.get(t);
	};
	for (const { n, k, element } of count.values()) {
		if (k !== 1) continue;
		faces.push({
			corners: n,
			element
		});
		for (const tri of outwardTriangles(n)) for (const t of tri) triangles.push(id(t));
		n.forEach((a, i) => {
			const b = n[(i + 1) % n.length], key = a < b ? `${a},${b}` : `${b},${a}`;
			if (!seen.has(key)) {
				seen.add(key);
				edges.push(id(a), id(b));
			}
		});
	}
	return {
		positions,
		triangles,
		index,
		edges,
		faces
	};
}
/** Junta a malha e os resultados num formato leve para o visualizador e para o relatório. */
function femResult(c, m, frd, dat, supportLoad = [
	0,
	0,
	0
]) {
	const d = parseDat(dat);
	for (const h of d.reactionHistory) for (let k = 0; k < 3; k++) h.f[k] -= supportLoad[k] * (c.dynamic ? amplitudeAt(c, h.time) : h.time);
	if (d.reactionHistory.length) d.reactions = [d.reactionHistory.at(-1).f];
	return femResultFrom(c, m, parseFrd(frd).blocks, d);
}
/**
* Resultado a partir de blocos nodais (DISP, STRESS ou VMIS, PE, NDTEMP — o formato do `.frd`) e dos
* valores do solver (frequências, fatores, reações): comum ao CalculiX e ao code_aster.
*/
function femResultFrom(c, m, blocks, d) {
	const r = { blocks };
	const { positions, triangles, index } = exteriorSurface(m, c.bodies);
	const order = [...index.keys()];
	const field = (b, f) => order.map((t) => {
		const v = b?.data.get(t);
		return v ? f(v) : 0;
	});
	const fields = [];
	const displacements = [];
	const allDisp = r.blocks.filter((b) => b.name === "DISP");
	const disp = c.analysis === "static" || c.analysis === "dynamic" ? allDisp.slice(-1) : allDisp;
	const lastOf = (name) => r.blocks.filter((b) => b.name === name).at(-1);
	const summary = [];
	const metrics = [];
	const max = (a) => a.reduce((x, y) => Math.max(x, y), 0);
	const vmOf = (v) => Math.sqrt(.5 * ((v[0] - v[1]) ** 2 + (v[1] - v[2]) ** 2 + (v[2] - v[0]) ** 2) + 3 * (v[3] ** 2 + v[4] ** 2 + v[5] ** 2));
	const sameT = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(Math.abs(a), Math.abs(b), 1e-30);
	const atTime = (name, t) => r.blocks.find((b) => b.name === name && sameT(b.value, t));
	let timeHistory;
	if (c.analysis === "dynamic") {
		const frames = allDisp.filter((b) => b.data.size);
		const times = frames.map((b) => b.value);
		const umaxT = frames.map((b) => [...b.data.values()].reduce((mx, v) => Math.max(mx, Math.hypot(v[0], v[1], v[2])), 0));
		const peak = umaxT.reduce((k, v, i) => v > umaxT[k] ? i : k, 0);
		const env = order.map(() => 0), vmEnv = order.map(() => 0);
		let hasS = false;
		for (const b of frames) {
			order.forEach((t, i) => {
				const v = b.data.get(t);
				if (v) env[i] = Math.max(env[i], Math.hypot(v[0], v[1], v[2]));
			});
			const sB = atTime("STRESS", b.value) ?? atTime("VMIS", b.value);
			if (sB) {
				hasS = true;
				order.forEach((t, i) => {
					const v = sB.data.get(t);
					if (v) vmEnv[i] = Math.max(vmEnv[i], sB.name === "VMIS" ? v[0] : vmOf(v));
				});
			}
		}
		fields.push({
			name: "Deslocamento máx. no tempo",
			unit: "mm",
			values: env
		});
		if (hasS) fields.push({
			name: "Tensão de von Mises máx. no tempo",
			unit: "MPa",
			values: vmEnv
		});
		const pick = [.../* @__PURE__ */ new Set([...Array.from({ length: Math.min(24, frames.length) }, (_, i) => Math.round(i * (frames.length - 1) / Math.max(1, Math.min(24, frames.length) - 1))), peak])].sort((a, b) => a - b);
		for (const i of pick) displacements.push({
			label: `t = ${(times[i] * 1e3).toPrecision(4)} ms${i === peak ? " (pico)" : ""}`,
			values: order.flatMap((t) => frames[i].data.get(t)?.slice(0, 3) ?? [
				0,
				0,
				0
			])
		});
		timeHistory = {
			times,
			series: [{
				key: "umax",
				label: "Deslocamento máx.",
				unit: "mm",
				values: umaxT
			}]
		};
		summary.push(["Deslocamento máx. (pico)", `${umaxT[peak]?.toFixed(4) ?? "—"} mm em t = ${((times[peak] ?? 0) * 1e3).toPrecision(4)} ms`]);
		metrics.push({
			key: "umax",
			label: "Deslocamento máx. (pico)",
			unit: "mm",
			value: umaxT[peak] ?? NaN
		}, {
			key: "tpeak",
			label: "Instante do pico",
			unit: "s",
			value: times[peak] ?? NaN
		});
		if (hasS) {
			summary.push(["Tensão de von Mises máx. no tempo", `${max(vmEnv).toFixed(2)} MPa`]);
			metrics.push({
				key: "vmmax",
				label: "Tensão de von Mises máx. no tempo",
				unit: "MPa",
				value: max(vmEnv)
			});
			if (c.material.yield) summary.push(["Fator de segurança mín. (cedência)", (c.material.yield / Math.max(max(vmEnv), 1e-12)).toFixed(2)]);
		}
		summary.push(["Instantes guardados", `${frames.length} (até ${((times.at(-1) ?? 0) * 1e3).toPrecision(4)} ms)`]);
	} else if (c.analysis === "thermal") {
		const T = field(r.blocks.find((b) => b.name === "NDTEMP"), (v) => v[0]);
		fields.push({
			name: "Temperatura",
			unit: "°C",
			values: T
		});
		const lo = T.reduce((a, b) => Math.min(a, b), Infinity), hi = T.reduce((a, b) => Math.max(a, b), -Infinity);
		summary.push(["Temperatura mín.", `${lo.toFixed(2)} °C`], ["Temperatura máx.", `${hi.toFixed(2)} °C`]);
		metrics.push({
			key: "tmin",
			label: "Temperatura mín.",
			unit: "°C",
			value: lo
		}, {
			key: "tmax",
			label: "Temperatura máx.",
			unit: "°C",
			value: hi
		});
	} else {
		disp.forEach((b, k) => {
			const vals = order.flatMap((t) => b.data.get(t)?.slice(0, 3) ?? [
				0,
				0,
				0
			]);
			const label = c.analysis === "modal" ? `Modo ${k + 1}${d.frequencies[k] !== void 0 ? ` — ${d.frequencies[k].toFixed(2)} Hz` : ""}` : c.analysis === "buckling" ? `Modo ${k + 1}${d.buckling[k] !== void 0 ? ` — fator ${d.buckling[k].toFixed(3)}` : ""}` : "Deformada";
			displacements.push({
				label,
				values: vals
			});
		});
		if (c.analysis === "static" && disp[0]) {
			const U = field(disp[0], (v) => Math.hypot(v[0], v[1], v[2]));
			fields.push({
				name: "Deslocamento",
				unit: "mm",
				values: U
			});
			const s = lastOf("STRESS"), sv = lastOf("VMIS");
			if (s || sv) {
				const vm = sv ? field(sv, (v) => v[0]) : field(s, (v) => Math.sqrt(.5 * ((v[0] - v[1]) ** 2 + (v[1] - v[2]) ** 2 + (v[2] - v[0]) ** 2) + 3 * (v[3] ** 2 + v[4] ** 2 + v[5] ** 2)));
				fields.push({
					name: "Tensão de von Mises",
					unit: "MPa",
					values: vm
				});
				summary.push(["Tensão de von Mises máx.", `${max(vm).toFixed(2)} MPa`]);
				metrics.push({
					key: "vmmax",
					label: "Tensão de von Mises máx.",
					unit: "MPa",
					value: max(vm)
				});
				if (c.material.yield && !c.nonlinear?.plasticity) summary.push(["Fator de segurança mín. (cedência)", (c.material.yield / Math.max(max(vm), 1e-12)).toFixed(2)]);
			}
			const pe = lastOf("PE");
			if (pe) {
				const peeq = field(pe, (v) => v[0]);
				fields.push({
					name: "Deformação plástica equivalente",
					unit: "—",
					values: peeq
				});
				summary.push(["Deformação plástica equiv. máx.", `${(100 * max(peeq)).toFixed(3)} %`]);
				metrics.push({
					key: "peeq",
					label: "Deformação plástica equiv. máx.",
					unit: "",
					value: max(peeq)
				});
				if (max(peeq) > 0) summary.push(["Zona plastificada", "sim — ver o campo da deformação plástica"]);
			}
			summary.unshift(["Deslocamento máx.", `${max(U).toFixed(4)} mm`]);
			metrics.unshift({
				key: "umax",
				label: "Deslocamento máx.",
				unit: "mm",
				value: max(U)
			});
		}
		if (c.analysis === "modal") d.frequencies.slice(0, c.modes).forEach((f, k) => {
			summary.push([`Frequência ${k + 1}`, `${f.toFixed(2)} Hz`]);
			metrics.push({
				key: `f${k + 1}`,
				label: `Frequência ${k + 1}`,
				unit: "Hz",
				value: f
			});
		});
		if (c.analysis === "buckling") d.buckling.forEach((f, k) => {
			summary.push([`Fator de encurvadura ${k + 1}`, f.toFixed(3)]);
			metrics.push({
				key: `lambda${k + 1}`,
				label: `Fator de encurvadura ${k + 1}`,
				unit: "",
				value: f
			});
		});
	}
	if (c.probes?.length && (c.analysis === "static" || c.analysis === "thermal" || c.analysis === "dynamic")) {
		let dispB = lastOf("DISP"), stB = lastOf("STRESS"), vmB = lastOf("VMIS"), tB = lastOf("NDTEMP");
		const value = (t, q) => {
			if (q === "T") return tB?.data.get(t)?.[0];
			if (q === "vm") {
				const v = vmB?.data.get(t);
				if (v) return v[0];
				const sv = stB?.data.get(t);
				return sv && Math.sqrt(.5 * ((sv[0] - sv[1]) ** 2 + (sv[1] - sv[2]) ** 2 + (sv[2] - sv[0]) ** 2) + 3 * (sv[3] ** 2 + sv[4] ** 2 + sv[5] ** 2));
			}
			const u = dispB?.data.get(t);
			if (!u) return void 0;
			return q === "u" ? Math.hypot(u[0], u[1], u[2]) : u["xyz".indexOf(q[1])];
		};
		const UNIT = {
			u: "mm",
			ux: "mm",
			uy: "mm",
			uz: "mm",
			vm: "MPa",
			T: "°C"
		};
		const probeAt = (pr) => {
			let v, where = "";
			if (pr.group) {
				let sa = 0, sv = 0, mx = -Infinity;
				for (const { type, nodes } of elementsOf(faceBlocks(m, pr.group))) {
					const n = nodes.slice(0, FACES[type].corners);
					const ar = faceIntegrals(FACES[type].corners === 3 ? 2 : 3, n.map((t) => m.nodes.get(t))).area;
					const vals = n.map((t) => value(t, pr.quantity));
					if (vals.some((x) => x === void 0)) continue;
					sa += ar;
					sv += ar * vals.reduce((a, b2) => a + b2, 0) / n.length;
					for (const x of vals) if (Math.abs(x) > Math.abs(mx) || mx === -Infinity) mx = x;
				}
				if (sa > 0) {
					v = pr.stat === "max" ? mx : sv / sa;
					where = pr.stat === "max" ? "máximo nos nós da face" : "média na face";
				}
			} else if (pr.point) {
				let best = Infinity, tag = -1;
				for (const t of dispB?.data.keys() ?? tB?.data.keys() ?? []) {
					const p = m.nodes.get(t);
					if (!p) continue;
					const d = Math.hypot(p[0] - pr.point[0], p[1] - pr.point[1], p[2] - pr.point[2]);
					if (d < best) {
						best = d;
						tag = t;
					}
				}
				if (tag >= 0) {
					v = value(tag, pr.quantity);
					where = `nó a ${best.toFixed(2)} mm do ponto`;
				}
			}
			return {
				v,
				where
			};
		};
		for (const pr of c.probes) {
			let { v, where } = probeAt(pr);
			if (c.analysis === "dynamic" && timeHistory) {
				const vals = timeHistory.times.map((t) => {
					dispB = atTime("DISP", t);
					stB = atTime("STRESS", t);
					vmB = atTime("VMIS", t);
					return probeAt(pr).v ?? NaN;
				});
				timeHistory.series.push({
					key: pr.key,
					label: pr.name,
					unit: UNIT[pr.quantity],
					values: vals
				});
				const k = vals.reduce((a, x, i) => Math.abs(x) > Math.abs(vals[a]) || !Number.isFinite(vals[a]) ? i : a, 0);
				v = vals[k];
				where = `pico em t = ${(timeHistory.times[k] * 1e3).toPrecision(4)} ms; ${where}`;
			}
			if (v === void 0 || !Number.isFinite(v)) continue;
			metrics.push({
				key: pr.key,
				label: pr.name,
				unit: UNIT[pr.quantity],
				value: v
			});
			summary.push([`Sonda: ${pr.name}`, `${v.toPrecision(5)} ${UNIT[pr.quantity]} (${where})`]);
		}
	}
	const history = c.nonlinear && c.analysis === "static" ? allDisp.map((b) => ({
		time: b.value,
		umax: [...b.data.values()].reduce((m, v) => Math.max(m, Math.hypot(v[0], v[1], v[2])), 0),
		reaction: d.reactionHistory.find((h) => Math.abs(h.time - b.value) < 1e-5 * Math.max(1, Math.abs(b.value)))?.f ?? null
	})) : [];
	if (history.length) summary.push(["Incrementos", `${history.length} (até ${(100 * history.at(-1).time).toFixed(0)} % da carga)`]);
	if (c.nonlinear && history.length && history.at(-1).time < 1 - 1e-6) summary.push(["Aviso", "O cálculo parou antes de aplicar toda a carga"]);
	if (d.reactions.length) {
		const R = d.reactions.reduce((a, b) => [
			a[0] + b[0],
			a[1] + b[1],
			a[2] + b[2]
		], [
			0,
			0,
			0
		]);
		summary.push([c.dynamic ? "Reações no último instante (N)" : "Reações totais (N)", R.map((x) => x.toFixed(2)).join(" · ")]);
	}
	const groupReactions = [];
	for (const ld of c.loads) {
		if (ld.kind !== "fixed" && ld.kind !== "displacement") continue;
		const v = d.setTotals?.[`N_${ld.group}`.toUpperCase()];
		if (!v) continue;
		const f = [
			0,
			1,
			2
		].map((k) => ld.kind === "fixed" || ld.u[k] !== null ? v[k] : null);
		groupReactions.push({
			group: ld.group,
			f
		});
		f.forEach((x, k) => {
			if (x !== null) metrics.push({
				key: `R_${ld.group}_${"xyz"[k]}`,
				label: `Reação ${ld.group} ${"XYZ"[k]}`,
				unit: "N",
				value: x
			});
		});
	}
	if (groupReactions.length > 1) for (const g of groupReactions) summary.push([`Reação ${g.group} (N)`, g.f.map((x) => x === null ? "—" : x.toFixed(2)).join(" · ")]);
	return {
		analysis: c.analysis,
		positions,
		triangles,
		fields,
		displacements,
		frequencies: d.frequencies,
		buckling: d.buckling,
		reactions: d.reactions,
		groupReactions,
		summary,
		metrics,
		history,
		timeHistory,
		hypotheses: c.hypotheses
	};
}
// src/sim/meshview.ts
function meshPreview(c, m) {
	const quality = meshQuality(m, c.bodies);
	const ar = [];
	for (const e of elementsOf(solidBlocks(m, c.bodies))) {
		const st = SOLIDS[e.type];
		ar.push(elementQuality(st.kind, e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n))).ar);
	}
	const ext = exteriorSurface(m, c.bodies);
	const positions = [], triangles = [], edges = [], sj = [], aspect = [];
	for (const f of ext.faces) {
		const base = positions.length / 3;
		for (const n of f.corners) {
			positions.push(...m.nodes.get(n));
			sj.push(quality.perElement[f.element]);
			aspect.push(ar[f.element]);
		}
		const k = f.corners.length;
		if (k === 3) triangles.push(base, base + 2, base + 1);
		else triangles.push(base, base + 3, base + 2, base, base + 2, base + 1);
		for (let i = 0; i < k; i++) edges.push(base + i, base + (i + 1) % k);
	}
	const view = {
		fields: [{
			name: "Jacobiano escalado",
			unit: ""
		}, {
			name: "Razão de aspeto",
			unit: ""
		}],
		modes: [],
		layers: [{
			name: "Malha",
			visible: true,
			positions,
			triangles,
			values: [sj, aspect],
			edges
		}]
	};
	const types = Object.entries(quality.types).map(([k, n]) => `${n} ${{
		hex8: "hexaedros de 8 nós",
		hex20: "hexaedros de 20 nós",
		tet4: "tetraedros de 4 nós",
		tet10: "tetraedros de 10 nós"
	}[k] ?? k}`).join(" + ");
	const summary = [["Malha", `${quality.nodes} nós · ${types}`], ["Volume da malha", `${quality.volume.toPrecision(6)} mm³`]];
	const flagged = quality.metrics.reduce((s, q) => s + q.fail.reduce((a, b) => a + b, 0), 0);
	summary.push(["Verificação", quality.ok ? flagged ? `${flagged} assinalamento(s) — ver a qualidade` : "todos os elementos dentro dos limites" : "elementos inválidos (jacobiano ≤ 0)"]);
	return {
		quality,
		view,
		summary
	};
}
// src/sim/radioss.ts
const I = (x) => String(Math.round(x)).padStart(10);
const F = (x) => {
	return (Number.isInteger(x) && Math.abs(x) < 0x38d7ea4c68000 ? String(x) : x.toPrecision(12).replace(/\.?0+(e|$)/, "$1")).padStart(20);
};
const title = (s) => s.replace(/[^\x20-\x7e]/g, "_").slice(0, 80);
/** Lista de tags em linhas de 10 inteiros (formato de /GRNOD/NODE). */
const ids = (list) => {
	const out = [];
	for (let k = 0; k < list.length; k += 10) out.push(list.slice(k, k + 10).map(I).join(""));
	return out;
};
function radiossDeck(c, m) {
	if (c.analysis !== "dynamic" || c.dynamic?.scheme !== "explicit") throw new Error("OpenRadioss: só dinâmica explícita (escolha «Dinâmica transitória» e «Explícita»)");
	if ((c.ties ?? []).length) throw new Error("OpenRadioss: montagens com contacto ainda não estão neste adaptador (use uma peça)");
	const warnings = [];
	const D = c.dynamic;
	const name = "galcad";
	const S = ["#RADIOSS STARTER", `# ${title(c.title)} — gerado pelo GALCAD (unidades: kg, mm, ms; força kN, tensão GPa)`];
	for (const h of c.hypotheses) S.push(`# ${title(h)}`);
	S.push("/BEGIN", name, `${I(2019)}${I(0)}`, `${"kg".padStart(20)}${"mm".padStart(20)}${"ms".padStart(20)}`, `${"kg".padStart(20)}${"mm".padStart(20)}${"ms".padStart(20)}`);
	S.push("/TITLE", title(c.title));
	const bodies = c.bodies?.length ? c.bodies.map((b) => ({
		group: b.group,
		mat: b.material
	})) : [{
		group: "SOLID",
		mat: c.material
	}];
	bodies.forEach((b, k) => {
		S.push(`/MAT/ELAST/${k + 1}`, title(b.mat.name), "#        Init. dens.          Ref. dens.", `${F(b.mat.density * 1e-6)}${F(0)}`, "#                  E                  nu", `${F(b.mat.E / 1e3)}${F(b.mat.nu)}`);
	});
	const prop = (id, label, isolid) => S.push(`/PROP/SOLID/${id}`, label, "#   Isolid    Ismstr               Icpre               Inpts    Itetra    Iframe                  dn", `${I(isolid)}${I(0)}${" ".repeat(10)}${I(isolid === 24 ? 1 : 0)}${" ".repeat(10)}${I(0)}${I(0)}${I(0)}${F(0)}`, "#                q_a                 q_b                   h            LAMBDA_V                MU_V", `${F(0)}${F(0)}${F(0)}${F(0)}${F(0)}`, "#             dt_min   istrain      IHKT", `${F(0)}${I(0)}${I(0)}`);
	prop(1, "hexaedros (Isolid 24)", 24);
	prop(2, "tetraedros", 0);
	const used = /* @__PURE__ */ new Set();
	const parts = [];
	let elements = 0;
	bodies.forEach((b, k) => {
		const hex = [], tet = [];
		for (const e of elementsOf(solidBlocks(m, [{ group: b.group }]))) {
			const st = SOLIDS[e.type];
			if (st.order !== 1) throw new Error("OpenRadioss: use elementos lineares (hexaedros de 8 nós ou tetraedros de 4) — os quadráticos não são próprios do explícito");
			(st.kind === "hex" ? hex : tet).push(e.nodes);
			e.nodes.forEach((n) => used.add(n));
		}
		if (hex.length) parts.push({
			id: 10 * (k + 1) + 1,
			kind: "hex",
			body: k,
			els: hex
		});
		if (tet.length) parts.push({
			id: 10 * (k + 1) + 2,
			kind: "tet",
			body: k,
			els: tet
		});
	});
	if (!parts.length) throw new Error("A malha não tem elementos de volume");
	const nodeIds = [...used].sort((a, b) => a - b);
	S.push("/NODE");
	for (const t of nodeIds) {
		const p = m.nodes.get(t);
		S.push(`${I(t)}${F(p[0])}${F(p[1])}${F(p[2])}`);
	}
	let eid = 1;
	for (const pt of parts) {
		S.push(`/PART/${pt.id}`, `${bodies[pt.body].group} ${pt.kind === "hex" ? "hexaedros" : "tetraedros"}`, `${I(pt.kind === "hex" ? 1 : 2)}${I(pt.body + 1)}${I(0)}`);
		S.push(`/${pt.kind === "hex" ? "BRICK" : "TETRA4"}/${pt.id}`);
		for (const e of pt.els) S.push(`${I(eid++)}${e.map(I).join("")}`);
		elements += pt.els.length;
	}
	let gid = 100;
	const group = (label, nodes) => {
		const id = ++gid;
		S.push(`/GRNOD/NODE/${id}`, title(label), ...ids(nodes));
		return id;
	};
	const faceNodes = (g) => [...new Set([...elementsOf(faceBlocks(m, g))].flatMap((e) => e.nodes))].sort((a, b) => a - b);
	S.push("/FUNCT/1", "amplitude", "#                  X                   Y", ...D.amplitude.map(([t, v]) => `${F(t * 1e3)}${F(v)}`));
	let bcs = 0, loads = 0;
	for (const ld of c.loads) {
		if (ld.kind === "pointForce") throw new Error("OpenRadioss: a força pontual ainda não está neste adaptador (use força nas faces)");
		if (ld.kind === "fixed" || ld.kind === "displacement") {
			const fix = ld.kind === "fixed" ? [
				true,
				true,
				true
			] : ld.u.map((u) => u !== null);
			if (ld.kind === "displacement" && ld.u.some((u) => u !== null && u !== 0)) throw new Error("OpenRadioss: deslocamentos impostos não nulos ainda não estão neste adaptador (use forças)");
			const g = group(`apoio ${ld.group}`, faceNodes(ld.group));
			S.push(`/BCS/${++bcs}`, `apoio ${ld.group}`, "#  Tra rot   skew_ID  grnod_ID", `   ${fix.map((x) => x ? "1" : "0").join("")} 000${I(0)}${I(g)}`);
		}
	}
	const nodal = /* @__PURE__ */ new Map();
	const add = (n, f) => {
		const a = nodal.get(n) ?? [
			0,
			0,
			0
		];
		for (let k = 0; k < 3; k++) a[k] += f[k];
		nodal.set(n, a);
	};
	const centers = /* @__PURE__ */ new Map();
	for (const e of elementsOf(solidBlocks(m, c.bodies))) {
		const st = SOLIDS[e.type];
		const P = e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n));
		const ce = [
			0,
			1,
			2
		].map((q) => P.reduce((s, p) => s + p[q], 0) / P.length);
		for (const f of st.faces) centers.set(f.map((i) => e.nodes[i]).sort((a, b) => a - b).join(","), ce);
	}
	for (const ld of c.loads) if (ld.kind === "force") {
		const fs = [...elementsOf(faceBlocks(m, ld.group))].map((e) => ({
			e,
			fi: faceIntegrals(e.type, e.nodes.map((n) => m.nodes.get(n)))
		}));
		const A = fs.reduce((s, x) => s + x.fi.area, 0);
		if (!(A > 0)) {
			warnings.push(`Força no grupo ${ld.group} sem área`);
			continue;
		}
		for (const { e, fi } of fs) e.nodes.forEach((n, i) => add(n, [
			0,
			1,
			2
		].map((k) => ld.f[k] * fi.nodal[i] / A)));
	} else if (ld.kind === "pressure") for (const e of elementsOf(faceBlocks(m, ld.group))) {
		const P = e.nodes.map((n) => m.nodes.get(n));
		const fi = faceIntegrals(e.type, P);
		const corners = e.nodes.slice(0, e.type === 2 || e.type === 9 ? 3 : 4);
		const ce = centers.get([...corners].sort((a, b) => a - b).join(","));
		const nv = fi.vec.reduce((s, v) => [
			s[0] + v[0],
			s[1] + v[1],
			s[2] + v[2]
		], [
			0,
			0,
			0
		]);
		const sgn = ce ? Math.sign(nv[0] * (P[0][0] - ce[0]) + nv[1] * (P[0][1] - ce[1]) + nv[2] * (P[0][2] - ce[2])) || 1 : 1;
		e.nodes.forEach((n, i) => add(n, fi.vec[i].map((v) => -ld.p * sgn * v)));
	}
	else if (ld.kind === "gravity") {
		const all = group("todos os nós", nodeIds);
		ld.g.forEach((g, k) => {
			if (g) S.push(`/GRAV/${++loads}`, "gravidade", "#funct_IDT       Dir   skew_ID sensor_ID  grnod_ID                       Ascalex             Fscaley", `${I(1)}${"XYZ"[k].padStart(10)}${I(0)}${I(0)}${I(all)}${" ".repeat(10)}${F(1)}${F(g * 1e-6)}`);
		});
	} else if (ld.kind !== "fixed" && ld.kind !== "displacement") warnings.push(`OpenRadioss: condição "${ld.kind}" ignorada (térmica)`);
	for (let k = 0; k < 3; k++) {
		const byVal = /* @__PURE__ */ new Map();
		for (const [n, f] of nodal) {
			if (Math.abs(f[k]) < 1e-14) continue;
			const key = f[k].toPrecision(9);
			const x = byVal.get(key) ?? {
				v: f[k],
				nodes: []
			};
			x.nodes.push(n);
			byVal.set(key, x);
		}
		for (const { v, nodes } of byVal.values()) {
			const g = group(`carga ${"XYZ"[k]} ${v.toPrecision(4)} N`, nodes.sort((a, b) => a - b));
			S.push(`/CLOAD/${++loads}`, `forca ${"XYZ"[k]}`, "#funct_IDT       Dir   skew_ID sensor_ID  grnod_ID                       Ascalex             Fscaley", `${I(1)}${"XYZ"[k].padStart(10)}${I(0)}${I(0)}${I(g)}${" ".repeat(10)}${F(1)}${F(v / 1e3)}`);
		}
	}
	if (!bcs) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
	if (D.alpha || D.beta) {
		const all = group("amortecimento", nodeIds);
		S.push("/DAMP/1", "Rayleigh", "#              alpha                beta  grnod_ID   skew_ID              Tstart               Tstop", `${F(D.alpha / 1e3)}${F(D.beta * 1e3)}${I(all)}${I(0)}${F(0)}${F(0)}`);
	}
	S.push("/END");
	const T = D.duration * 1e3;
	const E = [
		"#RADIOSS ENGINE",
		`/RUN/${name}/1`,
		F(T),
		"/ANIM/DT",
		`${F(0)}${F(T / D.frames)}`,
		"/ANIM/VECT/DISP",
		"/ANIM/ELEM/VONM",
		"/PRINT/-1000"
	];
	if (D.dt) warnings.push("OpenRadioss: o passo é o estável calculado pelo Engine (o passo indicado é ignorado)");
	return {
		starter: S.join("\n") + "\n",
		engine: E.join("\n") + "\n",
		name,
		warnings,
		nodes: nodeIds.length,
		elements
	};
}
/** Lê um VTK legado ASCII (UNSTRUCTURED_GRID) do anim_to_vtk. */
function parseVtk(text) {
	const tok = text.split(/\s+/).filter(Boolean);
	let i = 0;
	const f = {
		time: 0,
		nodeIds: [],
		points: [],
		vectors: {},
		cellScalars: {},
		cells: [],
		cellTypes: []
	};
	let section = null, nPts = 0, nCells = 0;
	while (i < tok.length) {
		const t = tok[i++];
		if (t === "TIME" && tok[i] === "1" && tok[i + 1] === "1") {
			i += 3;
			f.time = Number(tok[i++]);
		} else if (t === "POINTS") {
			nPts = Number(tok[i++]);
			i++;
			for (let k = 0; k < 3 * nPts; k++) f.points.push(Number(tok[i++]));
		} else if (t === "CELLS") {
			nCells = Number(tok[i++]);
			i++;
			for (let k = 0; k < nCells; k++) {
				const n = Number(tok[i++]);
				const c = [];
				for (let q = 0; q < n; q++) c.push(Number(tok[i++]));
				f.cells.push(c);
			}
		} else if (t === "CELL_TYPES") {
			const n = Number(tok[i++]);
			for (let k = 0; k < n; k++) f.cellTypes.push(Number(tok[i++]));
		} else if (t === "POINT_DATA") {
			section = "point";
			i++;
		} else if (t === "CELL_DATA") {
			section = "cell";
			i++;
		} else if (t === "SCALARS") {
			const nameParts = [];
			while (i < tok.length && !/^(int|float|double)$/.test(tok[i])) nameParts.push(tok[i++]);
			const name = nameParts.join(" ");
			i++;
			if (/^\d+$/.test(tok[i])) i++;
			if (tok[i] === "LOOKUP_TABLE") i += 2;
			const n = section === "point" ? nPts : nCells;
			const vals = [];
			for (let k = 0; k < n; k++) vals.push(Number(tok[i++]));
			if (section === "point" && name === "NODE_ID") f.nodeIds = vals;
			else if (section === "cell") f.cellScalars[name] = vals;
		} else if (t === "VECTORS") {
			const nameParts = [];
			while (i < tok.length && !/^(int|float|double)$/.test(tok[i])) nameParts.push(tok[i++]);
			i++;
			const vals = [];
			for (let k = 0; k < 3 * nPts; k++) vals.push(Number(tok[i++]));
			f.vectors[nameParts.join(" ")] = vals;
		}
	}
	return f;
}
/**
* Blocos nodais (formato do .frd: DISP em mm, VMIS em MPa, valor = tempo em s) a partir das
* animações: deslocamentos pelo NODE_ID e von Mises por célula, média nos nós dos elementos.
*/
function radiossBlocks(frames) {
	const out = [];
	for (const fr of frames) {
		const t = fr.time / 1e3;
		const dKey = Object.keys(fr.vectors).find((k) => /disp/i.test(k));
		if (dKey) {
			const v = fr.vectors[dKey], data = /* @__PURE__ */ new Map();
			fr.nodeIds.forEach((id, p) => data.set(id, [
				v[3 * p],
				v[3 * p + 1],
				v[3 * p + 2]
			]));
			out.push({
				name: "DISP",
				value: t,
				components: [
					"D1",
					"D2",
					"D3"
				],
				data
			});
		}
		const sKey = Object.keys(fr.cellScalars).find((k) => /mises/i.test(k));
		if (sKey) {
			const s = fr.cellScalars[sKey], sum = /* @__PURE__ */ new Map();
			fr.cells.forEach((c, e) => {
				if (fr.cellTypes[e] !== 10 && fr.cellTypes[e] !== 12) return;
				for (const p of c) {
					const id = fr.nodeIds[p];
					const a = sum.get(id) ?? [0, 0];
					a[0] += s[e] * 1e3;
					a[1]++;
					sum.set(id, a);
				}
			});
			out.push({
				name: "VMIS",
				value: t,
				components: ["VM"],
				data: new Map([...sum].map(([id, [a, n]]) => [id, [a / n]]))
			});
		}
	}
	return out;
}
// src/sim/openfoam.ts
const head = (cls, object, location) => `/*--------------------------------*- C++ -*----------------------------------*\\
  Gerado pelo CAD prototipo (ficheiros ASCII puros, como o OpenFOAM espera)
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};${location ? `\n    location    "${location}";` : ""}
    object      ${object};
}
`;
const vec = (v) => `(${v.map((x) => +x.toPrecision(10)).join(" ")})`;
const m = (v) => v.map((x) => x * .001);
/** Valores de entrada da turbulência (intensidade 5 %, escala 0,07 · comprimento característico). */
function turbulenceInlet(U, refLengthMm) {
	const I = .05, Cmu = .09;
	const l = .07 * refLengthMm * .001;
	const k = 1.5 * (U * I) ** 2;
	return {
		k,
		omega: Math.sqrt(k) / (Cmu ** .25 * l),
		epsilon: Cmu ** .75 * k ** 1.5 / l
	};
}
function openfoamCase(c, stl) {
	const f = {};
	const internal = c.regime === "internal";
	const turb = turbulenceInlet(Math.hypot(...c.velocity), c.refLength);
	const rans = c.turbulence !== "laminar";
	const walls = internal ? ["walls"] : ["body"];
	const surfaces = Object.keys(c.groups);
	for (const [name, text] of Object.entries(stl)) f[`constant/triSurface/${name}.stl`] = text;
	const s = c.mesh.size;
	let min, max;
	if (internal) {
		min = c.bbox.min.map((x) => x - 2 * s);
		max = c.bbox.max.map((x) => x + 2 * s);
	} else ({min, max} = c.domain);
	const n = min.map((x, k) => Math.max(1, Math.ceil((max[k] - x) / s)));
	const v = [
		[
			0,
			0,
			0
		],
		[
			1,
			0,
			0
		],
		[
			1,
			1,
			0
		],
		[
			0,
			1,
			0
		],
		[
			0,
			0,
			1
		],
		[
			1,
			0,
			1
		],
		[
			1,
			1,
			1
		],
		[
			0,
			1,
			1
		]
	].map((b) => b.map((t, k) => t ? max[k] : min[k]));
	const faces = [
		[
			0,
			4,
			7,
			3
		],
		[
			1,
			2,
			6,
			5
		],
		[
			0,
			1,
			5,
			4
		],
		[
			3,
			7,
			6,
			2
		],
		[
			0,
			3,
			2,
			1
		],
		[
			4,
			5,
			6,
			7
		]
	];
	const ax = [
		0,
		1,
		2
	].reduce((a, k) => Math.abs(c.velocity[k]) > Math.abs(c.velocity[a]) ? k : a, 0);
	const up = 2 * ax + (c.velocity[ax] >= 0 ? 0 : 1), down = 2 * ax + (c.velocity[ax] >= 0 ? 1 : 0);
	const patch = (name, type, idx) => `    ${name}\n    {\n        type ${type};\n        faces\n        (\n${idx.map((i) => `            (${faces[i].join(" ")})`).join("\n")}\n        );\n    }`;
	const boundary = internal ? [patch("background", "patch", [
		0,
		1,
		2,
		3,
		4,
		5
	])] : [
		patch("inlet", "patch", [up]),
		patch("outlet", "patch", [down]),
		patch("sides", "patch", [
			0,
			1,
			2,
			3,
			4,
			5
		].filter((i) => i !== up && i !== down))
	];
	f["system/blockMeshDict"] = `${head("dictionary", "blockMeshDict")}
scale   0.001;

vertices
(
${v.map((p) => `    ${vec(p)}`).join("\n")}
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${n.join(" ")}) simpleGrading (1 1 1)
);

boundary
(
${boundary.join("\n")}
);
`;
	const [l0, l1] = c.mesh.surfaceLevel;
	f["system/surfaceFeatureExtractDict"] = `${head("dictionary", "surfaceFeatureExtractDict")}
${surfaces.map((name) => `${name}.stl
{
    extractionMethod    extractFromSurface;
    extractFromSurfaceCoeffs
    {
        includedAngle   150;
    }
    writeObj            no;
}`).join("\n\n")}
`;
	f["system/snappyHexMeshDict"] = `${head("dictionary", "snappyHexMeshDict")}
castellatedMesh true;
snap            true;
addLayers       ${c.mesh.layers > 0 ? "true" : "false"};

geometry
{
${surfaces.map((name) => `    ${name}.stl\n    {\n        type triSurfaceMesh;\n        name ${name};\n    }`).join("\n")}
}

castellatedMeshControls
{
    maxLocalCells       2000000;
    maxGlobalCells      4000000;
    minRefinementCells  0;
    maxLoadUnbalance    0.10;
    nCellsBetweenLevels 3;
    features
    (
${surfaces.map((name) => `        { file "${name}.eMesh"; level ${l1}; }`).join("\n")}
    );
    refinementSurfaces
    {
${surfaces.map((name) => `        ${name}\n        {\n            level (${l0} ${l1});\n            patchInfo { type ${walls.includes(name) ? "wall" : "patch"}; }\n        }`).join("\n")}
    }
    resolveFeatureAngle 30;
    refinementRegions {}
    locationInMesh ${vec(m(c.insidePoint))};
    allowFreeStandingZoneFaces true;
}

snapControls
{
    nSmoothPatch    3;
    tolerance       2.0;
    nSolveIter      50;
    nRelaxIter      5;
    nFeatureSnapIter 10;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}

addLayersControls
{
    relativeSizes   true;
    layers
    {
${walls.map((w) => `        ${w} { nSurfaceLayers ${c.mesh.layers}; }`).join("\n")}
    }
    expansionRatio  1.2;
    finalLayerThickness 0.5;
    minThickness    0.1;
    nGrow           0;
    featureAngle    60;
    slipFeatureAngle 30;
    nRelaxIter      3;
    nSmoothSurfaceNormals 1;
    nSmoothNormals  3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter      50;
}

meshQualityControls
{
    maxNonOrtho     65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave      80;
    minVol          1e-15;
    minTetQuality   1e-15;
    minArea         -1;
    minTwist        0.02;
    minDeterminant  0.001;
    minFaceWeight   0.05;
    minVolRatio     0.01;
    minTriangleTwist -1;
    nSmoothScale    4;
    errorReduction  0.75;
    relaxed
    {
        maxNonOrtho 75;
    }
}

mergeTolerance 1e-6;
`;
	f["constant/transportProperties"] = `${head("dictionary", "transportProperties", "constant")}
transportModel  Newtonian;

nu              [0 2 -1 0 0 0 0] ${c.fluid.nu};

// rho = ${c.fluid.rho} kg/m3 (o simpleFoam usa a pressao cinematica p/rho)
`;
	f["constant/turbulenceProperties"] = `${head("dictionary", "turbulenceProperties", "constant")}
simulationType  ${rans ? "RAS" : "laminar"};
${rans ? `
RAS
{
    RASModel        ${c.turbulence};
    turbulence      on;
    printCoeffs     on;
}
` : ""}`;
	const field = (name, cls, dims, internalValue, bcs) => `${head(cls, name, "0")}
dimensions      ${dims};

internalField   uniform ${internalValue};

boundaryField
{
${Object.entries(bcs).map(([p, b]) => `    ${p}\n    {\n        ${b}\n    }`).join("\n")}
}
`;
	const Uin = vec(c.velocity);
	const zero = internal ? "(0 0 0)" : Uin;
	const pat = internal ? {
		inlet: "",
		outlet: "",
		walls: "",
		background: ""
	} : {
		inlet: "",
		outlet: "",
		sides: "",
		body: ""
	};
	const bcs = (fn) => Object.fromEntries(Object.keys(pat).map((p) => [p, fn(p)]));
	const isWall = (p) => p === "walls" || p === "body";
	f["0/U"] = field("U", "volVectorField", "[0 1 -1 0 0 0 0]", zero, bcs((p) => p === "inlet" ? `type fixedValue;\n        value uniform ${Uin};` : isWall(p) ? "type noSlip;" : p === "sides" ? "type slip;" : p === "outlet" ? `type inletOutlet;\n        inletValue uniform (0 0 0);\n        value uniform ${zero};` : "type zeroGradient;"));
	f["0/p"] = field("p", "volScalarField", "[0 2 -2 0 0 0 0]", "0", bcs((p) => p === "outlet" ? "type fixedValue;\n        value uniform 0;" : p === "sides" ? "type slip;" : "type zeroGradient;"));
	if (rans) {
		const scalar = (name, val, wall) => field(name, "volScalarField", name === "k" ? "[0 2 -2 0 0 0 0]" : name === "omega" ? "[0 0 -1 0 0 0 0]" : "[0 2 -3 0 0 0 0]", String(val), bcs((p) => p === "inlet" ? `type fixedValue;\n        value uniform ${val};` : isWall(p) ? `type ${wall};\n        value uniform ${val};` : p === "sides" ? "type slip;" : p === "outlet" ? `type inletOutlet;\n        inletValue uniform ${val};\n        value uniform ${val};` : "type zeroGradient;"));
		f["0/k"] = scalar("k", turb.k, "kqRWallFunction");
		if (c.turbulence === "kOmegaSST") f["0/omega"] = scalar("omega", turb.omega, "omegaWallFunction");
		else f["0/epsilon"] = scalar("epsilon", turb.epsilon, "epsilonWallFunction");
		f["0/nut"] = field("nut", "volScalarField", "[0 2 -1 0 0 0 0]", "0", bcs((p) => isWall(p) ? "type nutkWallFunction;\n        value uniform 0;" : p === "sides" ? "type slip;" : "type calculated;\n        value uniform 0;"));
	}
	const funcs = [...["inlet", "outlet"].map((p) => `    flux_${p}\n    {\n        type            surfaceFieldValue;\n        libs            ("libfieldFunctionObjects.so");\n        writeControl    timeStep;\n        writeInterval   1;\n        log             true;\n        writeFields     false;\n        regionType      patch;\n        name            ${p};\n        operation       sum;\n        fields          (phi);\n    }\n    pAvg_${p}\n    {\n        type            surfaceFieldValue;\n        libs            ("libfieldFunctionObjects.so");\n        writeControl    timeStep;\n        writeInterval   1;\n        log             false;\n        writeFields     false;\n        regionType      patch;\n        name            ${p};\n        operation       areaAverage;\n        fields          (p);\n    }`), ...internal ? [] : [`    forces_body\n    {\n        type            forces;\n        libs            ("libforces.so");\n        writeControl    timeStep;\n        writeInterval   1;\n        log             false;\n        patches         (body);\n        rho             rhoInf;\n        rhoInf          ${c.fluid.rho};\n        CofR            (0 0 0);\n    }`]];
	f["system/controlDict"] = `${head("dictionary", "controlDict")}
application     simpleFoam;
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         ${c.iterations};
deltaT          1;
writeControl    timeStep;
writeInterval   ${c.iterations};
purgeWrite      1;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{
${funcs.join("\n")}
}
`;
	f["system/fvSchemes"] = `${head("dictionary", "fvSchemes")}
ddtSchemes      { default steadyState; }
gradSchemes     { default Gauss linear; grad(U) cellLimited Gauss linear 1; }
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div(phi,epsilon) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear limited corrected 0.33; }
interpolationSchemes { default linear; }
snGradSchemes   { default limited corrected 0.33; }
wallDist        { method meshWave; }
`;
	f["system/fvSolution"] = `${head("dictionary", "fvSolution")}
solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-7;
        relTol          0.05;
    }
    "(U|k|omega|epsilon)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;
    residualControl
    {
        p               1e-4;
        U               1e-5;
        "(k|omega|epsilon)" 1e-5;
    }
}

relaxationFactors
{
    equations
    {
        U               0.9;
        ".*"            0.8;
    }
}
`;
	f["Allrun"] = `#!/bin/sh
# Gerado pelo CAD prototipo: malha (blockMesh + snappyHexMesh) e simpleFoam.
cd "\${0%/*}" || exit 1
set -e
blockMesh > log.blockMesh 2>&1
surfaceFeatureExtract > log.surfaceFeatureExtract 2>&1
snappyHexMesh -overwrite > log.snappyHexMesh 2>&1
checkMesh > log.checkMesh 2>&1 || true
simpleFoam > log.simpleFoam 2>&1
`;
	return f;
}
// src/sim/foamread.ts
/** Conteúdo entre o primeiro "(" depois do cabeçalho de lista "N (" e o ")" correspondente. */
function listBody(text, from = 0) {
	const re = /(\d+)\s*\(/g;
	re.lastIndex = from;
	const m = re.exec(text);
	if (!m) return null;
	let depth = 1, i = m.index + m[0].length;
	const start = i;
	for (; i < text.length && depth > 0; i++) if (text[i] === "(") depth++;
	else if (text[i] === ")") depth--;
	return {
		n: Number(m[1]),
		body: text.slice(start, i - 1),
		end: i
	};
}
const stripHeader = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/FoamFile\s*\{[\s\S]*?\}/, "");
function readLabels(text) {
	const l = listBody(stripHeader(text));
	return l ? l.body.trim().split(/\s+/).map(Number) : [];
}
function readPoints(text) {
	const l = listBody(stripHeader(text));
	if (!l) return [];
	return [...l.body.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}
function readFaces(text) {
	const l = listBody(stripHeader(text));
	if (!l) return [];
	return [...l.body.matchAll(/\d+\s*\(([^()]+)\)/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}
/** Patches do ficheiro `boundary`: nome → { startFace, nFaces }. */
function readBoundary(text) {
	const out = /* @__PURE__ */ new Map();
	const t = stripHeader(text);
	for (const m of t.matchAll(/(\w+)\s*\{([^{}]*)\}/g)) {
		const n = /nFaces\s+(\d+)/.exec(m[2]), s = /startFace\s+(\d+)/.exec(m[2]);
		if (n && s) out.set(m[1], {
			start: Number(s[1]),
			n: Number(n[1])
		});
	}
	return out;
}
/** Campo escalar: valores internos e, por patch, os valores escritos (ou null se o patch não os escreve). */
function readScalarField(text) {
	const t = stripHeader(text);
	const parse = (s) => {
		const u = /^\s*uniform\s+([-+\deE.]+)/.exec(s);
		if (u) return Number(u[1]);
		const nu = /nonuniform\s+List<scalar>\s*/.exec(s);
		if (nu) {
			const l = listBody(s, nu.index);
			return l ? l.body.trim().split(/\s+/).map(Number) : null;
		}
		return null;
	};
	const im = /internalField\s+([\s\S]*?;)/.exec(t);
	const internal = im ? parse(t.slice(im.index + 13)) ?? 0 : 0;
	const patches = /* @__PURE__ */ new Map();
	const bf = t.indexOf("boundaryField");
	if (bf >= 0) {
		const body = t.slice(bf);
		for (const m of body.matchAll(/(\w+)\s*\{/g)) {
			if (m[1] === "boundaryField") continue;
			let depth = 1, i = m.index + m[0].length;
			const start = i;
			for (; i < body.length && depth > 0; i++) if (body[i] === "{") depth++;
			else if (body[i] === "}") depth--;
			const blk = body.slice(start, i - 1);
			const v = /\bvalue\s+([\s\S]*?;)/.exec(blk);
			patches.set(m[1], v ? parse(blk.slice(v.index + 5)) : null);
		}
	}
	return {
		internal,
		patches
	};
}
const area = (pts, f) => {
	let ax = 0, ay = 0, az = 0;
	const p0 = pts[f[0]];
	for (let k = 1; k + 1 < f.length; k++) {
		const a = pts[f[k]], b = pts[f[k + 1]];
		const u = [
			a[0] - p0[0],
			a[1] - p0[1],
			a[2] - p0[2]
		], v = [
			b[0] - p0[0],
			b[1] - p0[1],
			b[2] - p0[2]
		];
		ax += u[1] * v[2] - u[2] * v[1];
		ay += u[2] * v[0] - u[0] * v[2];
		az += u[0] * v[1] - u[1] * v[0];
	}
	return .5 * Math.hypot(ax, ay, az);
};
/** Soma de phi num patch (m³/s; negativa a entrar). */
function patchFlux(phi, mesh, patch) {
	const v = phi.patches.get(patch);
	const b = mesh.boundary.get(patch);
	if (v === void 0 || v === null || !b) return NaN;
	return typeof v === "number" ? v * b.n : v.reduce((s, x) => s + x, 0);
}
/** Média por área de um campo escalar num patch (valor escrito ou, se não houver, o da célula vizinha). */
function patchAverage(field, mesh, patch) {
	const b = mesh.boundary.get(patch);
	if (!b) return NaN;
	const pv = field.patches.get(patch);
	let sa = 0, s = 0;
	for (let k = 0; k < b.n; k++) {
		const fi = b.start + k;
		const a = area(mesh.points, mesh.faces[fi]);
		const v = pv !== null && pv !== void 0 ? typeof pv === "number" ? pv : pv[k] : typeof field.internal === "number" ? field.internal : field.internal[mesh.owner[fi]];
		sa += a;
		s += a * v;
	}
	return s / sa;
}
/**
* Força de pressão (cinemática × ρ = N) que o fluido exerce num patch: Σ p·S, com S a apontar para
* fora do domínio de fluido (para dentro do corpo). Não inclui a parcela viscosa.
*/
function patchPressureForce(p, mesh, patch, rho) {
	const b = mesh.boundary.get(patch);
	if (!b) return [
		NaN,
		NaN,
		NaN
	];
	const pv = p.patches.get(patch);
	const F = [
		0,
		0,
		0
	];
	for (let k = 0; k < b.n; k++) {
		const fi = b.start + k;
		const f = mesh.faces[fi], pts = mesh.points;
		const S = [
			0,
			0,
			0
		];
		const p0 = pts[f[0]];
		for (let q = 1; q + 1 < f.length; q++) {
			const a = pts[f[q]], c = pts[f[q + 1]];
			const u = [
				a[0] - p0[0],
				a[1] - p0[1],
				a[2] - p0[2]
			], v = [
				c[0] - p0[0],
				c[1] - p0[1],
				c[2] - p0[2]
			];
			S[0] += .5 * (u[1] * v[2] - u[2] * v[1]);
			S[1] += .5 * (u[2] * v[0] - u[0] * v[2]);
			S[2] += .5 * (u[0] * v[1] - u[1] * v[0]);
		}
		const val = pv !== null && pv !== void 0 ? typeof pv === "number" ? pv : pv[k] : typeof p.internal === "number" ? p.internal : p.internal[mesh.owner[fi]];
		for (let q = 0; q < 3; q++) F[q] += rho * val * S[q];
	}
	return F;
}
// src/sim/su2.ts
function su2Config(c) {
	const U = Math.hypot(...c.velocity);
	const dir = c.velocity.map((x) => x / U);
	const rans = c.turbulence !== "laminar";
	const internal = c.regime === "internal";
	const wall = internal ? "walls" : "body";
	const mu = c.fluid.rho * c.fluid.nu;
	return [
		`% Gerado pelo CAD protótipo — ${c.title}`,
		...c.hypotheses.map((h) => `% ${h}`),
		`SOLVER= ${rans ? "INC_RANS" : "INC_NAVIER_STOKES"}`,
		...rans ? [`KIND_TURB_MODEL= ${c.turbulence === "kOmegaSST" ? "SST" : "SA"}`] : [],
		"MATH_PROBLEM= DIRECT",
		"RESTART_SOL= NO",
		"INC_NONDIM= DIMENSIONAL",
		"INC_DENSITY_MODEL= CONSTANT",
		`INC_DENSITY_INIT= ${c.fluid.rho}`,
		`INC_VELOCITY_INIT= ( ${(internal ? [
			0,
			0,
			0
		] : c.velocity).join(", ")} )`,
		"INC_ENERGY_EQUATION= NO",
		"VISCOSITY_MODEL= CONSTANT_VISCOSITY",
		`MU_CONSTANT= ${mu.toExponential(6)}`,
		...rans ? ["FREESTREAM_TURBULENCEINTENSITY= 0.05", "FREESTREAM_TURB2LAMVISCRATIO= 10.0"] : [],
		`MARKER_HEATFLUX= ( ${wall}, 0.0 )`,
		...internal ? [
			"INC_INLET_TYPE= VELOCITY_INLET",
			`MARKER_INLET= ( inlet, 293.15, ${U}, ${dir.join(", ")} )`,
			"INC_OUTLET_TYPE= PRESSURE_OUTLET",
			"MARKER_OUTLET= ( outlet, 0.0 )",
			"MARKER_ANALYZE= ( inlet, outlet )",
			"MARKER_ANALYZE_AVERAGE= AREA"
		] : ["MARKER_FAR= ( farfield )", "MARKER_MONITORING= ( body )"],
		`MARKER_PLOTTING= ( ${wall} )`,
		"NUM_METHOD_GRAD= WEIGHTED_LEAST_SQUARES",
		"CFL_NUMBER= 20.0",
		"CFL_ADAPT= YES",
		"CONV_NUM_METHOD_FLOW= FDS",
		"MUSCL_FLOW= YES",
		"SLOPE_LIMITER_FLOW= NONE",
		...rans ? ["CONV_NUM_METHOD_TURB= SCALAR_UPWIND", "MUSCL_TURB= NO"] : [],
		"LINEAR_SOLVER= FGMRES",
		"LINEAR_SOLVER_PREC= ILU",
		"LINEAR_SOLVER_ERROR= 1E-6",
		"LINEAR_SOLVER_ITER= 10",
		`ITER= ${c.iterations}`,
		"CONV_FIELD= RMS_PRESSURE",
		"CONV_RESIDUAL_MINVAL= -8",
		"MESH_FILENAME= mesh.su2",
		"MESH_FORMAT= SU2",
		"OUTPUT_FILES= ( RESTART, PARAVIEW, SURFACE_PARAVIEW )",
		"SCREEN_OUTPUT= ( INNER_ITER, RMS_PRESSURE, RMS_VELOCITY-X, RMS_VELOCITY-Y, RMS_VELOCITY-Z )",
		`HISTORY_OUTPUT= ( ITER, RMS_RES, ${internal ? "FLOW_COEFF" : "AERO_COEFF"} )`,
		""
	].join("\n");
}
// src/sim/aster.ts
const num$1 = (x) => Number.isInteger(x) ? `${x}.` : x.toPrecision(12).replace(/\.?0+(e|$)/, "$1");
/** Nó da malha mais próximo de cada força pontual (ordem das condições `pointForce`), com a distância ao ponto pedido. */
function pointNodes(c, m, nodes) {
	return c.loads.flatMap((ld) => {
		if (ld.kind !== "pointForce") return [];
		let best = -1, bd = Infinity;
		for (const t of nodes) {
			const q = m.nodes.get(t);
			const d = (q[0] - ld.point[0]) ** 2 + (q[1] - ld.point[1]) ** 2 + (q[2] - ld.point[2]) ** 2;
			if (d < bd) {
				bd = d;
				best = t;
			}
		}
		return [{
			node: best,
			dist: Math.sqrt(bd)
		}];
	});
}
/** Malha ASTER: COOR_3D, elementos de volume e de face, GROUP_MA e GROUP_NO com os nomes dos grupos. */
function asterMesh(c, m) {
	if (!solidBlocks(m, c.bodies).length) throw new Error("A malha não tem elementos de volume nos grupos dos corpos");
	const L = [
		"TITRE",
		` ${c.title.replace(/[^\x20-\x7e]/g, "_").slice(0, 70)}`,
		"FINSF",
		"%"
	];
	const used = /* @__PURE__ */ new Set();
	const cells = [];
	const bodyCells = {};
	for (const g of c.bodies?.length ? c.bodies.map((b) => b.group) : ["SOLID"]) {
		bodyCells[g] = [];
		for (const e of elementsOf(solidBlocks(m, [{ group: g }]))) {
			const st = SOLIDS[e.type];
			const n = st.toAster.map((i) => e.nodes[i]);
			n.forEach((x) => used.add(x));
			cells.push({
				name: `M${cells.length + 1}`,
				type: st.aster,
				nodes: n
			});
			bodyCells[g].push(cells.at(-1).name);
		}
	}
	const nodeOrder = [...used].sort((a, b) => a - b);
	L.push("COOR_3D");
	for (const t of nodeOrder) L.push(`N${t} ${m.nodes.get(t).map(num$1).join(" ")}`);
	L.push("FINSF", "%");
	const section = (list) => {
		for (const type of [...new Set(list.map((x) => x.type))]) {
			L.push(type);
			for (const e of list) if (e.type === type) for (let k = 0; k < e.nodes.length; k += 8) L.push(`${k ? "  " : `${e.name} `}${e.nodes.slice(k, k + 8).map((x) => `N${x}`).join(" ")}`);
			L.push("FINSF", "%");
		}
	};
	section(cells);
	const faceGroups = {};
	const nodeGroups = {};
	const areas = {};
	const faces = [];
	for (const name of Object.keys(c.groups)) {
		faceGroups[name] = [];
		const ns = /* @__PURE__ */ new Set();
		let A = 0;
		for (const { type, nodes } of elementsOf(faceBlocks(m, name))) {
			nodes.forEach((x) => ns.add(x));
			A += faceIntegrals(type, nodes.map((x) => m.nodes.get(x))).area;
			const id = `F${faces.length + 1}`;
			faces.push({
				name: id,
				type: FACES[type].aster,
				nodes: FACES[type].toAster.map((i) => nodes[i])
			});
			faceGroups[name].push(id);
		}
		nodeGroups[name] = [...ns].sort((a, b) => a - b);
		areas[name] = A;
	}
	section(faces);
	const block = (kw, name, ids) => {
		L.push(kw, name);
		for (let k = 0; k < ids.length; k += 10) L.push(ids.slice(k, k + 10).join(" "));
		L.push("FINSF", "%");
	};
	block("GROUP_MA", "SOLID", cells.map((e) => e.name));
	for (const [g, ids] of Object.entries(bodyCells)) if (g !== "SOLID") block("GROUP_MA", g, ids);
	for (const [g, ids] of Object.entries(faceGroups)) if (ids.length) block("GROUP_MA", g, ids);
	pointNodes(c, m, nodeOrder).forEach((n, k) => {
		if (n.node >= 0) nodeGroups[`PF${k + 1}`] = [n.node];
	});
	for (const [g, ns] of Object.entries(nodeGroups)) if (ns.length) block("GROUP_NO", g, ns.map((x) => `N${x}`));
	const supportNodes = new Set(c.loads.flatMap((ld) => ld.kind === "fixed" || ld.kind === "displacement" ? nodeGroups[ld.group] ?? [] : []));
	for (const t of c.ties ?? []) {
		const ns = (nodeGroups[t.slave] ?? []).filter((x) => !supportNodes.has(x));
		if (ns.length) block("GROUP_NO", `${t.slave}_L`, ns.map((x) => `N${x}`));
	}
	block("GROUP_NO", "NALL", nodeOrder.map((x) => `N${x}`));
	L.push("FIN");
	return {
		mail: L.join("\n") + "\n",
		nodeOrder,
		areas
	};
}
/** Ficheiro de comandos (.comm, sintaxe Python do code_aster) e .export para o run_aster. */
function asterCase(c, m) {
	if (c.analysis !== "static" && c.analysis !== "modal" && c.analysis !== "dynamic") throw new Error(`code_aster: análise "${c.analysis}" ainda não suportada neste adaptador (use o CalculiX)`);
	if ((c.ties ?? []).some((t) => t.kind === "contact")) throw new Error("code_aster: o contacto com atrito ainda não está neste adaptador (use o CalculiX ou contacto colado)");
	const { mail, nodeOrder, areas } = asterMesh(c, m);
	const warnings = [];
	const mat = c.material;
	const nl = c.analysis === "static" ? c.nonlinear : void 0;
	const C = [];
	C.push(`# ${c.title.replace(/[^\x20-\x7e]/g, "_")} -- gerado pelo CAD prototipo (unidades: mm, N, MPa, t, s)`);
	for (const h of c.hypotheses) C.push(`# ${h.replace(/[^\x20-\x7e]/g, "_")}`);
	C.push("DEBUT(LANG='FR')", "MA = LIRE_MAILLAGE(FORMAT='ASTER', UNITE=20)");
	const presGroups = c.loads.flatMap((ld) => ld.kind === "pressure" ? [`'${ld.group}'`] : []);
	if (presGroups.length) C.push(`MA = MODI_MAILLAGE(reuse=MA, MAILLAGE=MA, ORIE_PEAU=_F(GROUP_MA_PEAU=(${presGroups.join(", ")},)))`);
	const hex = c.mesh.element === "hex";
	const explicit = c.dynamic?.scheme === "explicit";
	const modelisation = hex && c.mesh.integration === "reduced" && !explicit ? "3D_SI" : "3D";
	if (hex && c.mesh.integration === "reduced" && explicit) warnings.push("code_aster explícito: os hexaedros passam a integração completa (o 3D_SI não tem explícito)");
	if (hex && c.mesh.order === 1 && c.mesh.integration !== "reduced") warnings.push("code_aster: HEXA8 com integração completa (o code_aster não tem modos incompatíveis como o C3D8I) bloqueia em flexão — use hexaedros de 20 nós ou o CalculiX");
	C.push(`MO = AFFE_MODELE(MAILLAGE=MA, AFFE=_F(TOUT='OUI', PHENOMENE='MECANIQUE', MODELISATION='${modelisation}'))`);
	const material = (name, m2) => {
		if (nl?.plasticity && !(m2.yield > 0)) throw new Error(`Plasticidade: o material ${m2.name} não tem tensão de cedência`);
		const plast = nl?.plasticity ? `, ECRO_LINE=_F(D_SIGM_EPSI=${num$1(m2.tangent ?? 0)}, SY=${num$1(m2.yield)})` : "";
		const damp = c.dynamic && (c.dynamic.alpha || c.dynamic.beta) ? `, AMOR_ALPHA=${num$1(c.dynamic.beta)}, AMOR_BETA=${num$1(c.dynamic.alpha)}` : "";
		C.push(`${name} = DEFI_MATERIAU(ELAS=_F(E=${num$1(m2.E)}, NU=${num$1(m2.nu)}, RHO=${num$1(m2.density * 1e-9)}${damp})${plast})`);
	};
	if (c.bodies?.length) {
		c.bodies.forEach((b, k) => material(`MAT${k + 1}`, b.material));
		C.push(`CM = AFFE_MATERIAU(MAILLAGE=MA, AFFE=(${c.bodies.map((b, k) => `_F(GROUP_MA='${b.group}', MATER=MAT${k + 1})`).join(", ")},))`);
	} else {
		material("MAT", mat);
		C.push("CM = AFFE_MATERIAU(MAILLAGE=MA, AFFE=_F(TOUT='OUI', MATER=MAT))");
	}
	const ddl = [], ddlAmp = [], force = [], pres = [], nodal = [];
	let pf = 0;
	let grav = "";
	for (const ld of c.loads) switch (ld.kind) {
		case "fixed":
			ddl.push(`_F(GROUP_NO='${ld.group}', DX=0., DY=0., DZ=0.)`);
			break;
		case "displacement": {
			const comps = ld.u.map((u, k) => u === null ? "" : `D${"XYZ"[k]}=${num$1(u)}`).filter(Boolean);
			if (comps.length) (c.dynamic && ld.u.some((u) => u !== null && u !== 0) ? ddlAmp : ddl).push(`_F(GROUP_NO='${ld.group}', ${comps.join(", ")})`);
			break;
		}
		case "force": {
			const A = areas[ld.group];
			if (!(A > 0)) {
				warnings.push(`Força no grupo ${ld.group} sem área`);
				break;
			}
			force.push(`_F(GROUP_MA='${ld.group}', FX=${num$1(ld.f[0] / A)}, FY=${num$1(ld.f[1] / A)}, FZ=${num$1(ld.f[2] / A)})`);
			break;
		}
		case "pointForce": {
			const pn = pointNodes(c, m, nodeOrder)[pf++];
			if (!pn || pn.node < 0) {
				warnings.push("Força pontual sem nó da malha");
				break;
			}
			nodal.push(`_F(GROUP_NO='PF${pf}', FX=${num$1(ld.f[0])}, FY=${num$1(ld.f[1])}, FZ=${num$1(ld.f[2])})`);
			warnings.push(`Força pontual aplicada no nó ${pn.node}, a ${pn.dist.toFixed(2)} mm do ponto pedido: tensões locais irreais, só a resposta global é válida`);
			break;
		}
		case "pressure":
			pres.push(`_F(GROUP_MA='${ld.group}', PRES=${num$1(ld.p)})`);
			break;
		case "gravity": {
			const g = Math.hypot(...ld.g);
			if (g > 0) grav = `PESANTEUR=_F(GRAVITE=${num$1(g)}, DIRECTION=(${ld.g.map((x) => num$1(x / g)).join(", ")}))`;
			break;
		}
		default: warnings.push(`code_aster: condição "${ld.kind}" ignorada (térmica)`);
	}
	if (!ddl.length) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
	const ties = (c.ties ?? []).filter((t) => t.masterBody).map((t) => `_F(GROUP_MA_MAIT='${t.masterBody}', GROUP_NO_ESCL='${t.slave}_L')`);
	const bcParts = [ddl.length && `DDL_IMPO=(${ddl.join(", ")},)`, ties.length && `LIAISON_MAIL=(${ties.join(", ")},)`].filter(Boolean);
	if (!bcParts.length) throw new Error("code_aster: o estudo não tem apoios nem ligações");
	C.push(`BC = AFFE_CHAR_MECA(MODELE=MO, ${bcParts.join(", ")})`);
	const chParts = [
		force.length && `FORCE_FACE=(${force.join(", ")},)`,
		nodal.length && `FORCE_NODALE=(${nodal.join(", ")},)`,
		pres.length && `PRES_REP=(${pres.join(", ")},)`,
		grav
	].filter(Boolean);
	const hasCh = chParts.length > 0 && (c.analysis === "static" || c.analysis === "dynamic");
	if (hasCh) C.push(`CH = AFFE_CHAR_MECA(MODELE=MO, ${chParts.join(", ")})`);
	if (ddlAmp.length) C.push(`BCA = AFFE_CHAR_MECA(MODELE=MO, DDL_IMPO=(${ddlAmp.join(", ")},))`);
	const supports = c.loads.flatMap((ld) => ld.kind === "fixed" || ld.kind === "displacement" ? [`'${ld.group}'`] : []);
	if (c.dynamic) {
		const D = c.dynamic;
		const dt = D.dt ?? stableIncrement(m, c.bodies?.length ? c.bodies.map((b) => ({
			group: b.group,
			...b.material
		})) : [{
			group: "SOLID",
			...c.material
		}]).dt;
		const n = Math.ceil(D.duration / dt - 1e-9), every = Math.max(1, Math.round(n / D.frames));
		const vale = D.amplitude.flatMap(([t, v]) => [num$1(t), num$1(v)]);
		C.push(`F1 = DEFI_FONCTION(NOM_PARA='INST', VALE=(${vale.join(", ")}), PROL_DROITE='CONSTANT', PROL_GAUCHE='CONSTANT')`);
		C.push(`LR = DEFI_LIST_REEL(DEBUT=0., INTERVALLE=_F(JUSQU_A=${num$1(D.duration)}, NOMBRE=${n}))`);
		const excit = [
			"_F(CHARGE=BC)",
			hasCh && "_F(CHARGE=CH, FONC_MULT=F1)",
			ddlAmp.length && "_F(CHARGE=BCA, FONC_MULT=F1)"
		].filter(Boolean).join(", ");
		const schema = explicit ? "SCHEMA='DIFF_CENT', FORMULATION='ACCELERATION'" : "SCHEMA='NEWMARK', FORMULATION='DEPLACEMENT'";
		C.push(`RES = DYNA_NON_LINE(MODELE=MO, CHAM_MATER=CM,${explicit ? " MASS_DIAG='OUI'," : ""} EXCIT=(${excit},), COMPORTEMENT=_F(RELATION='ELAS', DEFORMATION='PETIT', TOUT='OUI'), INCREMENT=_F(LIST_INST=LR), SCHEMA_TEMPS=_F(${schema}), ARCHIVAGE=_F(PAS_ARCH=${every}))`);
	} else if (c.analysis === "modal") C.push("ASSEMBLAGE(MODELE=MO, CHAM_MATER=CM, CHARGE=BC, NUME_DDL=CO('NU'), MATR_ASSE=(_F(MATRICE=CO('K'), OPTION='RIGI_MECA'), _F(MATRICE=CO('M'), OPTION='MASS_MECA')))", `RES = CALC_MODES(MATR_RIGI=K, MATR_MASS=M, OPTION='PLUS_PETITE', CALC_FREQ=_F(NMAX_FREQ=${c.modes}))`, "TF = RECU_TABLE(CO=RES, NOM_PARA=('FREQ',))", "IMPR_TABLE(TABLE=TF, UNITE=40, FORMAT='TABLEAU')");
	else if (!nl) C.push(`RES = MECA_STATIQUE(MODELE=MO, CHAM_MATER=CM, EXCIT=(_F(CHARGE=BC),${hasCh ? " _F(CHARGE=CH)," : ""}))`);
	else {
		const rel = nl.plasticity ? "VMIS_ISOT_LINE" : "ELAS";
		const def = nl.geometry ? nl.plasticity ? "GDEF_LOG" : "GREEN_LAGRANGE" : "PETIT";
		C.push("RAMPE = DEFI_FONCTION(NOM_PARA='INST', VALE=(0., 0., 1., 1.))", `LR = DEFI_LIST_REEL(DEBUT=0., INTERVALLE=_F(JUSQU_A=1., NOMBRE=${nl.increments}))`, "LINST = DEFI_LIST_INST(DEFI_LIST=_F(LIST_INST=LR), ECHEC=_F(EVENEMENT='ERREUR', ACTION='DECOUPE', SUBD_METHODE='MANUEL', SUBD_PAS=4, SUBD_NIVEAU=5))", `RES = STAT_NON_LINE(MODELE=MO, CHAM_MATER=CM, EXCIT=(_F(CHARGE=BC),${hasCh ? " _F(CHARGE=CH, FONC_MULT=RAMPE)," : ""}), COMPORTEMENT=_F(RELATION='${rel}', DEFORMATION='${def}', TOUT='OUI'), INCREMENT=_F(LIST_INST=LINST), NEWTON=_F(REAC_ITER=1), CONVERGENCE=_F(ITER_GLOB_MAXI=25))`);
	}
	if (c.analysis === "static") C.push(`RES = CALC_CHAMP(reuse=RES, RESULTAT=RES, CONTRAINTE=('SIGM_NOEU',), CRITERES=('SIEQ_NOEU',), FORCE=('REAC_NODA',)${nl?.plasticity ? ", VARI_INTERNE=('VARI_NOEU',)" : ""})`);
	else if (c.dynamic) C.push("RES = CALC_CHAMP(reuse=RES, RESULTAT=RES, CONTRAINTE=('SIGM_NOEU',), CRITERES=('SIEQ_NOEU',))");
	C.push("TU = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='U', RESULTAT=RES, NOM_CHAM='DEPL', GROUP_NO='NALL', NOM_CMP=('DX', 'DY', 'DZ'), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TU, UNITE=38, FORMAT='TABLEAU')");
	if (c.analysis === "static" || c.dynamic) {
		C.push("TS = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='VM', RESULTAT=RES, NOM_CHAM='SIEQ_NOEU', GROUP_NO='NALL', NOM_CMP=('VMIS',), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TS, UNITE=39, FORMAT='TABLEAU')");
		if (supports.length && !c.dynamic) C.push(`TR = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='R', RESULTAT=RES, NOM_CHAM='REAC_NODA', GROUP_NO=(${supports.join(", ")},), RESULTANTE=('DX', 'DY', 'DZ'), TOUT_ORDRE='OUI'))`, "IMPR_TABLE(TABLE=TR, UNITE=41, FORMAT='TABLEAU')");
		if (nl?.plasticity) C.push("TP = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='P', RESULTAT=RES, NOM_CHAM='VARI_NOEU', GROUP_NO='NALL', NOM_CMP=('V1',), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TP, UNITE=42, FORMAT='TABLEAU')");
	}
	C.push("IMPR_RESU(FORMAT='MED', UNITE=80, RESU=_F(RESULTAT=RES))", "FIN()");
	return {
		files: {
			"mesh.mail": mail,
			"job.comm": C.join("\n") + "\n",
			"job.export": [
				"P actions make_etude",
				"P time_limit 1800",
				"P memory_limit 4096",
				"P ncpus 1",
				"P mpi_nbcpu 1",
				"P mode interactif",
				"F comm job.comm D 1",
				"F mail mesh.mail D 20",
				"F mess job.mess R 6",
				"F resu job.resu R 8",
				"F rmed job.rmed R 80",
				"F libr u.tab R 38",
				"F libr vm.tab R 39",
				"F libr freq.tab R 40",
				"F libr reac.tab R 41",
				"F libr peeq.tab R 42"
			].join("\n") + "\n"
		},
		nodeOrder,
		warnings
	};
}
/** Tabela de IMPR_TABLE (FORMAT='TABLEAU'): linhas de comentário com "#", cabeçalho e valores. */
function parseAsterTable(text) {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
	if (!lines.length) return [];
	const head = lines[0].split(/\s+/);
	return lines.slice(1).map((l) => {
		const v = l.split(/\s+/);
		return Object.fromEntries(head.map((h, i) => [h, v[i] ?? ""]));
	}).filter((r) => Object.keys(r).length === head.length);
}
/** Tag Gmsh de um nó da tabela: nome "N<tag>" ou, nas versões que numeram, o índice (1…) na ordem escrita. */
const asterNode = (s, order) => /^N\d+$/.test(s) ? Number(s.slice(1)) : order[Number(s) - 1];
/** Resultado (mesmo formato do CalculiX) a partir das tabelas escritas pelo .comm deste adaptador. */
function asterResult(c, m, t, nodeOrder) {
	const nodal = (text, name, cols) => {
		const byOrder = /* @__PURE__ */ new Map();
		for (const row of parseAsterTable(text ?? "")) {
			const ord = Number(row.NUME_ORDRE ?? 1);
			if (c.nonlinear && c.analysis === "static" && Number(row.INST) === 0) continue;
			let b = byOrder.get(ord);
			if (!b) {
				b = {
					name,
					value: c.analysis === "static" && c.nonlinear || c.dynamic ? Number(row.INST ?? 1) : ord,
					components: cols,
					data: /* @__PURE__ */ new Map()
				};
				byOrder.set(ord, b);
			}
			const tag = asterNode(row.NOEUD ?? "", nodeOrder);
			if (tag !== void 0) b.data.set(tag, cols.map((k) => Number(row[k])));
		}
		return [...byOrder].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
	};
	const blocks = [
		...nodal(t.u, "DISP", [
			"DX",
			"DY",
			"DZ"
		]),
		...nodal(t.vm, "VMIS", ["VMIS"]),
		...nodal(t.peeq, "PE", ["V1"])
	];
	const frequencies = parseAsterTable(t.freq ?? "").map((r) => Number(r.FREQ)).filter(Number.isFinite);
	const reactionHistory = parseAsterTable(t.reac ?? "").map((r) => ({
		time: c.nonlinear ? Number(r.INST ?? 1) : 1,
		f: [
			Number(r.DX),
			Number(r.DY),
			Number(r.DZ)
		]
	})).filter((r) => r.f.every(Number.isFinite) && !(c.nonlinear && r.time === 0));
	const res = femResultFrom(c, m, blocks, {
		frequencies,
		buckling: [],
		reactions: reactionHistory.length ? [reactionHistory.at(-1).f] : [],
		reactionHistory
	});
	return {
		...res,
		hypotheses: [...res.hypotheses, "Calculado com o code_aster (EDF, GPL-3.0); adaptador verificado com o code_aster 18.1 nos casos analíticos de referência (consola, pressão, modal, plasticidade uniaxial, elástica, montagem colada)"]
	};
}
// src/sim/foamfields.ts
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/FoamFile\s*\{[\s\S]*?\}/, "");
/**
* Lê "uniform x", "uniform (x y z)" ou "nonuniform List<scalar|vector> N (…)" a partir do início de
* `s`: uniforme → componentes; não uniforme → componentes de cada elemento.
*/
function parseValue(s) {
	const u = /^\s*uniform\s+(\([^()]*\)|[-+\deE.]+)/.exec(s);
	if (u) return u[1].startsWith("(") ? u[1].slice(1, -1).trim().split(/\s+/).map(Number) : [Number(u[1])];
	const nu = /^\s*nonuniform\s+List<(scalar|vector)>\s*(\d+)\s*\(/.exec(s);
	if (!nu) return null;
	let depth = 1, i = nu.index + nu[0].length;
	const start = i;
	for (; i < s.length && depth > 0; i++) if (s[i] === "(") depth++;
	else if (s[i] === ")") depth--;
	const body = s.slice(start, i - 1);
	if (nu[1] === "scalar") return body.trim().split(/\s+/).map((x) => [Number(x)]);
	return [...body.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}
function readField(text) {
	const t = strip(text);
	const im = /internalField\s+/.exec(t);
	const internal = (im ? parseValue(t.slice(im.index + im[0].length)) : null) ?? [0];
	const patches = /* @__PURE__ */ new Map();
	const bf = t.indexOf("boundaryField");
	if (bf >= 0) {
		const body = t.slice(bf + 13);
		let i = body.indexOf("{") + 1;
		while (i < body.length) {
			const m = /\s*(\w+)\s*\{/y;
			m.lastIndex = i;
			const h = m.exec(body);
			if (!h) break;
			let depth = 1, j = m.lastIndex;
			const start = j;
			for (; j < body.length && depth > 0; j++) if (body[j] === "{") depth++;
			else if (body[j] === "}") depth--;
			const blk = body.slice(start, j - 1);
			const type = /\btype\s+(\w+)\s*;/.exec(blk)?.[1] ?? "";
			const v = /\bvalue\s+/.exec(blk);
			patches.set(h[1], {
				type,
				value: v ? parseValue(blk.slice(v.index + v[0].length)) : null
			});
			i = j;
		}
	}
	return {
		internal,
		patches
	};
}
/** Valor (componentes) da célula `c`. */
const cellValue = (f, c) => Array.isArray(f.internal[0]) ? f.internal[c] : f.internal;
/** Valor (componentes) da face `k` de um patch: o escrito ou, se não houver, o da célula vizinha. */
function faceValue(f, mesh, patch, k, ncomp) {
	const p = f.patches.get(patch);
	const b = mesh.boundary.get(patch);
	if (p?.type === "noSlip") return new Array(ncomp).fill(0);
	const v = p?.value;
	if (v) return Array.isArray(v[0]) ? v[k] : v;
	return cellValue(f, mesh.owner[b.start + k]);
}
/**
* Valores nos pontos da malha: média das células que os contêm; nos patches com valor imposto
* (fixedValue, noSlip, inletOutlet com valor) o ponto fica com a média das faces desse patch.
*/
function pointValues(f, mesh, ncomp) {
	const np = mesh.points.length;
	const sum = new Float64Array(np * ncomp), cnt = new Float64Array(np);
	const add = (pt, v) => {
		cnt[pt]++;
		for (let q = 0; q < ncomp; q++) sum[pt * ncomp + q] += v[q];
	};
	for (let fi = 0; fi < mesh.faces.length; fi++) {
		const o = cellValue(f, mesh.owner[fi]);
		for (const pt of mesh.faces[fi]) add(pt, o);
		if (fi < mesh.neighbour.length) {
			const nb = cellValue(f, mesh.neighbour[fi]);
			for (const pt of mesh.faces[fi]) add(pt, nb);
		}
	}
	for (let i = 0; i < np; i++) if (cnt[i]) for (let q = 0; q < ncomp; q++) sum[i * ncomp + q] /= cnt[i];
	const bsum = new Float64Array(np * ncomp), bcnt = new Float64Array(np);
	for (const [name, b] of mesh.boundary) {
		const p = f.patches.get(name);
		if (!p || !(p.type === "noSlip" || p.type === "fixedValue")) continue;
		for (let k = 0; k < b.n; k++) {
			const v = faceValue(f, mesh, name, k, ncomp);
			for (const pt of mesh.faces[b.start + k]) {
				bcnt[pt]++;
				for (let q = 0; q < ncomp; q++) bsum[pt * ncomp + q] += v[q];
			}
		}
	}
	for (let i = 0; i < np; i++) if (bcnt[i]) for (let q = 0; q < ncomp; q++) sum[i * ncomp + q] = bsum[i * ncomp + q] / bcnt[i];
	return sum;
}
/** Triângulos (em leque) e valores nodais de um patch; posições em mm. */
function patchLayer(name, mesh, patch, fields, visible) {
	const b = mesh.boundary.get(patch);
	if (!b || !b.n) return null;
	const index = /* @__PURE__ */ new Map();
	const positions = [], triangles = [];
	for (let k = 0; k < b.n; k++) {
		const loc = mesh.faces[b.start + k].map((pt) => {
			let i = index.get(pt);
			if (i === void 0) {
				i = index.size;
				index.set(pt, i);
				positions.push(...mesh.points[pt].map((x) => x * 1e3));
			}
			return i;
		});
		for (let q = 1; q + 1 < loc.length; q++) triangles.push(loc[0], loc[q], loc[q + 1]);
	}
	return {
		name,
		visible,
		positions,
		triangles,
		values: fields.map((lf) => {
			if (!lf) return null;
			const s = new Float64Array(index.size), c = new Float64Array(index.size);
			for (let k = 0; k < b.n; k++) {
				const v = lf.map(faceValue(lf.field, mesh, patch, k, lf.ncomp));
				for (const pt of mesh.faces[b.start + k]) {
					const i = index.get(pt);
					s[i] += v;
					c[i]++;
				}
			}
			return [...s].map((x, i) => x / c[i]);
		})
	};
}
/** Corte plano (ponto e normal em metros) com os campos interpolados; posições em mm. */
function sliceLayer(name, mesh, origin, normal, fields, visible) {
	const nn = Math.hypot(normal[0], normal[1], normal[2]);
	const n = normal.map((x) => x / nn);
	const pts = mesh.points;
	const tol = 1e-12;
	const d = pts.map((p) => {
		const s = (p[0] - origin[0]) * n[0] + (p[1] - origin[1]) * n[1] + (p[2] - origin[2]) * n[2];
		return Math.abs(s) < tol ? tol : s;
	});
	const a = Math.abs(n[0]) < .9 ? [
		1,
		0,
		0
	] : [
		0,
		1,
		0
	];
	const u = [
		n[1] * a[2] - n[2] * a[1],
		n[2] * a[0] - n[0] * a[2],
		n[0] * a[1] - n[1] * a[0]
	];
	const ul = Math.hypot(u[0], u[1], u[2]);
	for (let q = 0; q < 3; q++) u[q] /= ul;
	const w = [
		n[1] * u[2] - n[2] * u[1],
		n[2] * u[0] - n[0] * u[2],
		n[0] * u[1] - n[1] * u[0]
	];
	let nCells = 0;
	for (const c of mesh.owner) if (c >= nCells) nCells = c + 1;
	const cellFaces = Array.from({ length: nCells }, () => []);
	mesh.owner.forEach((c, fi) => cellFaces[c].push(fi));
	mesh.neighbour.forEach((c, fi) => cellFaces[c].push(fi));
	const pv = fields.map((lf) => lf ? pointValues(lf.field, mesh, lf.ncomp) : null);
	const edgeIndex = /* @__PURE__ */ new Map();
	const positions = [], triangles = [];
	const values = fields.map(() => []);
	const cut = (i, j) => {
		const key = i < j ? `${i},${j}` : `${j},${i}`;
		let k = edgeIndex.get(key);
		if (k !== void 0) return k;
		k = edgeIndex.size;
		edgeIndex.set(key, k);
		const t = d[i] / (d[i] - d[j]);
		const P = pts[i], Q = pts[j];
		positions.push(...[
			0,
			1,
			2
		].map((q) => (P[q] + t * (Q[q] - P[q])) * 1e3));
		fields.forEach((lf, fi) => {
			const arr = pv[fi];
			if (!lf || !arr) return;
			const vi = Array.from(arr.subarray(i * lf.ncomp, (i + 1) * lf.ncomp)), vj = Array.from(arr.subarray(j * lf.ncomp, (j + 1) * lf.ncomp));
			values[fi].push(lf.map(vi.map((x, q) => x + t * (vj[q] - x))));
		});
		return k;
	};
	for (const faces of cellFaces) {
		const ids = /* @__PURE__ */ new Set();
		for (const fi of faces) {
			const f = mesh.faces[fi];
			for (let q = 0; q < f.length; q++) {
				const i = f[q], j = f[(q + 1) % f.length];
				if (d[i] > 0 !== d[j] > 0) ids.add(cut(i, j));
			}
		}
		if (ids.size < 3) continue;
		const loop = [...ids];
		const c = [
			0,
			1,
			2
		].map((q) => loop.reduce((s, k) => s + positions[k * 3 + q], 0) / loop.length);
		const ang = (k) => {
			const r = [
				0,
				1,
				2
			].map((q) => positions[k * 3 + q] - c[q]);
			return Math.atan2(r[0] * w[0] + r[1] * w[1] + r[2] * w[2], r[0] * u[0] + r[1] * u[1] + r[2] * u[2]);
		};
		loop.sort((x, y) => ang(x) - ang(y));
		for (let q = 1; q + 1 < loop.length; q++) triangles.push(loop[0], loop[q], loop[q + 1]);
	}
	if (!triangles.length) return null;
	return {
		name,
		visible,
		positions,
		triangles,
		values: fields.map((lf, fi) => lf ? values[fi] : null)
	};
}
// src/sim/result.ts
/** Resultado FEM como uma camada única (superfície exterior da malha). */
function femView(r) {
	return {
		fields: r.fields.map((f) => ({
			name: f.name,
			unit: f.unit
		})),
		modes: r.displacements.map((d) => d.label),
		layers: [{
			name: "Peça",
			visible: true,
			positions: r.positions,
			triangles: r.triangles,
			values: r.fields.map((f) => f.values),
			displacements: r.displacements.map((d) => d.values)
		}]
	};
}
// src/sim/convergence.ts
/**
* GCI de três soluções `f` (fina → grossa) com números de células/elementos `n` (fina → grossa).
* `Fs` = 1,25 (fator de segurança recomendado para três malhas).
*/
function gci(n, f, dim = 3, Fs = 1.25) {
	const h = n.map((x) => (1 / x) ** (1 / dim));
	const r21 = h[1] / h[0], r32 = h[2] / h[1];
	const [f1, f2, f3] = f;
	const e21 = f2 - f1, e32 = f3 - f2;
	const notes = [];
	if (r21 < 1.3 || r32 < 1.3) notes.push(`Razões de refinamento ${r21.toFixed(2)} / ${r32.toFixed(2)} abaixo de 1,3 (recomendado ≥ 1,3)`);
	if (e21 === 0 || Math.abs(e21) <= 1e-12 * Math.max(Math.abs(f1), 1e-300)) return {
		r21,
		r32,
		p: NaN,
		extrapolated: f1,
		ea21: 0,
		eext21: 0,
		gciFine: 0,
		asymptotic: NaN,
		behaviour: "converged",
		notes: [...notes, "As duas malhas mais finas dão o mesmo valor"]
	};
	const R = e21 / e32;
	const behaviour = !Number.isFinite(R) ? "divergent" : R < 0 ? "oscillatory" : R > 1 ? "divergent" : "monotonic";
	const s = Math.sign(e32 / e21);
	let p = Math.abs(Math.log(Math.abs(e32 / e21))) / Math.log(r21);
	for (let it = 0; it < 200; it++) {
		const q = Math.log((r21 ** p - s) / (r32 ** p - s));
		const next = Math.abs(Math.log(Math.abs(e32 / e21)) + q) / Math.log(r21);
		if (!Number.isFinite(next)) break;
		if (Math.abs(next - p) < 1e-12) {
			p = next;
			break;
		}
		p = next;
	}
	const rp = r21 ** p;
	const extrapolated = (rp * f1 - f2) / (rp - 1);
	const ea21 = Math.abs((f1 - f2) / f1);
	const eext21 = Math.abs((extrapolated - f1) / extrapolated);
	const gciFine = Fs * ea21 / (rp - 1);
	const asymptotic = Fs * Math.abs((f2 - f3) / f2) / (r32 ** p - 1) / (rp * gciFine);
	if (behaviour === "oscillatory") notes.push("Convergência oscilatória: o GCI é apenas indicativo");
	if (behaviour === "divergent") notes.push("As soluções afastam-se ao refinar: a malha não está na gama assintótica (singularidade, malha demasiado grossa ou erro de modelação)");
	if (behaviour === "monotonic" && Math.abs(asymptotic - 1) > .1) notes.push(`Fora da gama assintótica (razão ${asymptotic.toFixed(2)}; esperado ≈ 1)`);
	if (p > 6 || p < .5) notes.push(`Ordem aparente ${p.toFixed(2)} pouco plausível para o método (esperado ≈ 1–2 em CFD, 2–3 em tetraedros quadráticos)`);
	return {
		r21,
		r32,
		p,
		extrapolated,
		ea21,
		eext21,
		gciFine,
		asymptotic,
		behaviour,
		notes
	};
}
/** As diferenças entre malhas consecutivas mantêm o sinal (sem oscilação) — valores pela ordem do refinamento. */
function isMonotonic(values) {
	const d = values.slice(1).map((v, i) => v - values[i]).filter((x) => Math.abs(x) > 1e-12 * Math.max(1, ...values.map(Math.abs)));
	return d.every((x) => Math.sign(x) === Math.sign(d[0]));
}
/** Junta as métricas das três malhas (fina → grossa) num relatório de convergência. */
function convergenceReport(ratio, meshes) {
	const [a, b, c] = meshes;
	const rows = [];
	for (const m of a.metrics) {
		const v2 = b.metrics.find((x) => x.key === m.key)?.value, v3 = c.metrics.find((x) => x.key === m.key)?.value;
		if (v2 === void 0 || v3 === void 0 || ![
			m.value,
			v2,
			v3
		].every(Number.isFinite)) continue;
		rows.push({
			key: m.key,
			label: m.label,
			unit: m.unit,
			values: [
				m.value,
				v2,
				v3
			],
			gci: gci([
				a.cells,
				b.cells,
				c.cells
			], [
				m.value,
				v2,
				v3
			])
		});
	}
	return {
		ratio,
		meshes: meshes.map((m) => ({
			cells: m.cells,
			size: m.size
		})),
		rows,
		hypotheses: [
			"Incerteza numérica da discretização pelo GCI (Celik et al., J. Fluids Eng. 130, 2008; ASME V&V 20-2009), Fs = 1,25, três malhas refinadas de forma sistemática",
			"h = (1/N)^(1/3) com N células/elementos (domínio igual nas três malhas)",
			"Não inclui erros de modelação (condições de fronteira, material, turbulência) nem de convergência iterativa",
			"Máximos locais junto a singularidades geométricas (cantos vivos, cargas pontuais) não convergem: use valores afastados das singularidades"
		]
	};
}
// src/sim/xfoil.ts
const num = (x, what, lo, hi) => {
	const v = Number(x);
	if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what}: valor inválido (${String(x)}; entre ${lo} e ${hi})`);
	return v;
};
/** Pedido validado (limites físicos e de tamanho); deita fora tudo o que não é número ou código NACA. */
function checkXfoilRequest(r) {
	const a = r?.airfoil;
	let airfoil;
	if (a && typeof a.naca === "string") {
		if (!/^\d{4,5}$/.test(a.naca)) throw new Error("Código NACA inválido (4 ou 5 dígitos)");
		airfoil = { naca: a.naca };
	} else if (a && Array.isArray(a.coords)) {
		const coords = a.coords.map((p, i) => {
			if (!Array.isArray(p) || p.length < 2) throw new Error(`Coordenada ${i + 1} inválida`);
			return [num(p[0], "x/c", -.1, 1.1), num(p[1], "y/c", -.5, .5)];
		});
		if (coords.length < 20 || coords.length > 1e3) throw new Error("O perfil precisa de 20 a 1000 pontos");
		airfoil = {
			name: String(a.name ?? "Perfil").replace(/[^\w .+-]/g, "").slice(0, 40) || "Perfil",
			coords
		};
	} else throw new Error("Perfil em falta (código NACA ou coordenadas)");
	const al = r.alpha ?? {};
	const from = num(al.from, "α inicial", -30, 30), to = num(al.to, "α final", -30, 30);
	const step = Math.abs(num(al.step, "passo de α", .05, 10));
	if (Math.abs(to - from) / step > 200) throw new Error("Demasiados ângulos (máx. 200)");
	return {
		airfoil,
		re: num(r.re, "Reynolds", 1e4, 1e9),
		mach: num(r.mach ?? 0, "Mach", 0, .7),
		ncrit: num(r.ncrit ?? 9, "Ncrit", 1, 14),
		alpha: {
			from,
			to,
			step
		},
		xtrTop: num(r.xtrTop ?? 1, "transição no extradorso", 0, 1),
		xtrBot: num(r.xtrBot ?? 1, "transição no intradorso", 0, 1),
		iter: Math.round(num(r.iter ?? 150, "iterações", 10, 1e3)),
		panels: Math.round(num(r.panels ?? 160, "painéis", 60, 400))
	};
}
/** Ficheiro de coordenadas (formato Selig com nome na primeira linha). */
function airfoilFile(name, coords) {
	return `${name}\n${coords.map(([x, y]) => ` ${x.toFixed(6)}  ${y.toFixed(6)}`).join("\n")}\n`;
}
/**
* Comandos para o XFOIL (stdin). A varredura começa em α = 0 (ou no ângulo mais próximo) e vai para
* cada lado separadamente, com a camada-limite reiniciada, porque o XFOIL converge melhor partindo
* da solução vizinha. Sem gráficos (PLOP G F).
*/
function xfoilCommands(req, polarFile = "polar.txt", airfoilPath = "airfoil.dat") {
	const r = checkXfoilRequest(req);
	const lo = Math.min(r.alpha.from, r.alpha.to), hi = Math.max(r.alpha.from, r.alpha.to), s = r.alpha.step;
	const start = lo > 0 ? lo : hi < 0 ? hi : 0;
	const f = (x) => x.toFixed(3);
	const lines = [
		"PLOP",
		"G F",
		""
	];
	lines.push("naca" in r.airfoil ? `NACA ${r.airfoil.naca}` : `LOAD ${airfoilPath}`);
	lines.push("PPAR", `N ${r.panels}`, "", "");
	lines.push("OPER", "VPAR", `N ${r.ncrit}`, `XTR ${r.xtrTop} ${r.xtrBot}`, "");
	lines.push(`ITER ${r.iter}`, `VISC ${r.re}`, `MACH ${r.mach}`, "PACC", polarFile, "");
	if (hi >= start) lines.push(`ASEQ ${f(start)} ${f(hi)} ${f(s)}`);
	if (lo < start) lines.push("INIT", `ASEQ ${f(start - s)} ${f(lo)} ${f(-s)}`);
	lines.push("PACC", "", "QUIT", "");
	return {
		stdin: lines.join("\n"),
		files: "coords" in r.airfoil ? { [airfoilPath]: airfoilFile(r.airfoil.name, r.airfoil.coords) } : {},
		request: r
	};
}
/**
* Segunda passagem para os ângulos que não convergiram: cada um é aproximado a partir do vizinho
* convergido mais próximo em passos de 0,25° (camada-limite reiniciada), com o dobro das iterações
* e mais 10 painéis.
*/
function xfoilRetryCommands(req, missing, converged, polarFile = "polar2.txt", airfoilPath = "airfoil.dat") {
	const base = xfoilCommands({
		...req,
		iter: Math.min(1e3, (req.iter ?? 150) * 2),
		panels: Math.min(400, (req.panels ?? 160) + 10)
	}, polarFile, airfoilPath);
	const head = base.stdin.split("\n");
	const cut = head.findIndex((l) => l.startsWith("ASEQ") || l === "INIT");
	const lines = head.slice(0, cut);
	const f = (x) => x.toFixed(3);
	missing.forEach((m, k) => {
		const near = converged.length ? converged.reduce((b, a) => Math.abs(a - m) < Math.abs(b - m) ? a : b) : 0;
		const d = m > near ? .25 : -.25;
		if (k > 0) lines.push("INIT");
		lines.push(`ALFA ${f(near)}`);
		if (Math.abs(m - near) > .26) lines.push(`ASEQ ${f(near + d)} ${f(m - d)} ${f(d)}`);
		lines.push(`ALFA ${f(m)}`);
	});
	lines.push("PACC", "", "QUIT", "");
	return {
		stdin: lines.join("\n"),
		files: base.files,
		request: base.request
	};
}
/** Lê a polar do XFOIL (colunas depois da linha de traços), ordenada por α e sem repetidos. */
function parsePolar(text) {
	const lines = text.split(/\r?\n/);
	const i = lines.findIndex((l) => /^\s*-{5,}/.test(l));
	if (i < 0) return [];
	const rows = /* @__PURE__ */ new Map();
	for (const l of lines.slice(i + 1)) {
		const v = l.trim().split(/\s+/).map(Number);
		if (v.length < 7 || v.slice(0, 7).some((x) => !Number.isFinite(x))) continue;
		rows.set(v[0].toFixed(3), {
			alpha: v[0],
			cl: v[1],
			cd: v[2],
			cdp: v[3],
			cm: v[4],
			xtrTop: v[5],
			xtrBot: v[6]
		});
	}
	return [...rows.values()].sort((a, b) => a.alpha - b.alpha);
}
/** Grandezas de projeto da polar: declive e α0 (mínimos quadrados na zona linear), CLmax, CDmin, L/D. */
function polarSummary(polar, req) {
	const missing = [];
	if (req) {
		const lo = Math.min(req.alpha.from, req.alpha.to), hi = Math.max(req.alpha.from, req.alpha.to);
		for (let a = lo; a <= hi + 1e-9; a += Math.abs(req.alpha.step)) if (!polar.some((p) => Math.abs(p.alpha - a) < .001)) missing.push(Math.round(a * 1e3) / 1e3);
	}
	if (!polar.length) return {
		clAlphaDeg: null,
		clAlphaRad: null,
		alpha0: null,
		clMax: null,
		alphaClMax: null,
		cdMin: NaN,
		clAtCdMin: NaN,
		ldMax: NaN,
		alphaLdMax: NaN,
		missing
	};
	const near0 = polar.reduce((b, p) => Math.abs(p.cl) < Math.abs(b.cl) ? p : b);
	const lin = polar.filter((p) => Math.abs(p.alpha - near0.alpha) <= 5);
	let clAlphaDeg = null, alpha0 = null;
	if (lin.length >= 3) {
		const n = lin.length, sx = lin.reduce((s, p) => s + p.alpha, 0), sy = lin.reduce((s, p) => s + p.cl, 0);
		const sxx = lin.reduce((s, p) => s + p.alpha * p.alpha, 0);
		const k = (n * lin.reduce((s, p) => s + p.alpha * p.cl, 0) - sx * sy) / (n * sxx - sx * sx), b = (sy - k * sx) / n;
		clAlphaDeg = k;
		alpha0 = -b / k;
	}
	let iMax = 0;
	polar.forEach((p, i) => {
		if (p.cl > polar[iMax].cl) iMax = i;
	});
	const interior = iMax < polar.length - 1;
	const cdBest = polar.reduce((b, p) => p.cd < b.cd ? p : b);
	const ldBest = polar.reduce((b, p) => p.cl / p.cd > b.cl / b.cd ? p : b);
	return {
		clAlphaDeg,
		clAlphaRad: clAlphaDeg === null ? null : clAlphaDeg * 180 / Math.PI,
		alpha0,
		clMax: interior ? polar[iMax].cl : null,
		alphaClMax: interior ? polar[iMax].alpha : null,
		cdMin: cdBest.cd,
		clAtCdMin: cdBest.cl,
		ldMax: ldBest.cl / ldBest.cd,
		alphaLdMax: ldBest.alpha,
		missing
	};
}
const XFOIL_HYPOTHESES = [
	"Escoamento 2D (perfil de envergadura infinita), subsónico; compressibilidade pela correção de Kármán–Tsien (válida abaixo do Mach crítico).",
	"Camada-limite integral acoplada ao escoamento potencial (método de painéis); transição pelo método e^n com o Ncrit indicado.",
	"Fiável na zona linear e até perto do CLmax; depois da perda (separação extensa) o XFOIL tende a sobrestimar CLmax e subestimar CD — confirmar com dados de túnel ou CFD.",
	"Ângulos que não convergem são omitidos da polar (listados nos avisos).",
	"Para uma asa finita, corrigir o declive pelo alongamento (cálculo «Asa finita») — resultado de apoio ao projeto, não substitui ensaio nem certificação."
];
// tools/cad-runner.ts
const which = (cmd) => {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};
const FOAM_RC = [
	"/usr/lib/openfoam/openfoam2606/etc/bashrc",
	"/usr/lib/openfoam/openfoam2512/etc/bashrc",
	"/usr/lib/openfoam/openfoam2506/etc/bashrc",
	"/opt/openfoam2606/etc/bashrc",
	"/usr/share/openfoam/etc/bashrc"
];
function tools() {
	const gmsh = process.env.CAD_GMSH ?? which("gmsh");
	const ccx = process.env.CAD_CCX ?? which("ccx") ?? which("ccx_2.23") ?? which("ccx_2.22");
	const su2 = process.env.CAD_SU2 ?? which("SU2_CFD");
	const home = process.env.HOME ?? "";
	const condaAster = [
		process.env.CONDA_PREFIX && `${process.env.CONDA_PREFIX}/bin/run_aster`,
		`${home}/micromamba/envs/aster/bin/run_aster`,
		`${home}/miniforge3/envs/aster/bin/run_aster`,
		"/opt/mamba/root/envs/aster/bin/run_aster",
		"/opt/conda/envs/aster/bin/run_aster"
	].find((p) => p && existsSync(p));
	const aster = process.env.CAD_ASTER ?? which("run_aster") ?? which("as_run") ?? condaAster ?? null;
	const xfoil = process.env.CAD_XFOIL ?? which("xfoil");
	const radDir = [
		process.env.CAD_RADIOSS_DIR,
		`${home}/OpenCourant`,
		"/opt/OpenCourant"
	].find((p) => p && existsSync(join(p, "exec")));
	const radExe = radDir ? radiossExecutables(radDir) : null;
	const foamDir = process.env.CAD_FOAM_DIR && existsSync(process.env.CAD_FOAM_DIR) ? process.env.CAD_FOAM_DIR : null;
	const foamBin = foamDir ? (() => {
		const pl = join(foamDir, "platforms");
		const t = existsSync(pl) ? readdirSync(pl).find((d) => existsSync(join(pl, d, "bin"))) : void 0;
		return t ? join(pl, t, "bin") : null;
	})() : null;
	const foamDirect = which("simpleFoam");
	const foamRc = process.env.CAD_FOAM_BASHRC ?? FOAM_RC.find((p) => existsSync(p)) ?? null;
	const version = (cmd, args) => {
		if (!cmd) return null;
		const r = spawnSync(cmd, args, {
			encoding: "utf8",
			timeout: 1e4
		});
		return (r.stdout + r.stderr).trim().split(/\r?\n/)[0]?.slice(0, 80) ?? "";
	};
	return {
		gmsh: gmsh ? {
			path: gmsh,
			version: version(gmsh, ["--version"])
		} : null,
		calculix: ccx ? {
			path: ccx,
			version: version(ccx, ["-v"])
		} : null,
		openfoam: foamDir && foamBin ? {
			path: foamBin,
			version: foamDir.replace(/.*[\\/]/, ""),
			rc: null,
			dir: foamDir,
			bin: foamBin
		} : foamDirect || foamRc ? {
			path: foamDirect ?? foamRc,
			version: foamRc ? foamRc.replace(/\/etc\/bashrc$/, "") : "no PATH",
			rc: foamRc
		} : null,
		su2: su2 ? {
			path: su2,
			version: "SU2_CFD"
		} : null,
		code_aster: aster ? {
			path: aster,
			version: aster.endsWith("as_run") ? "as_run" : "run_aster"
		} : null,
		xfoil: xfoil ? {
			path: xfoil,
			version: "XFOIL 6.9x",
			preload: process.env.CAD_XFOIL_PRELOAD ?? null
		} : null,
		openradioss: radDir && radExe ? {
			path: radExe.engine,
			version: "OpenCourant",
			dir: radDir,
			...radExe
		} : null
	};
}
/** Executáveis da distribuição do OpenCourant: Starter, Engine (sem MPI, dupla precisão) e anim_to_vtk. */
function radiossExecutables(dir) {
	const ex = readdirSync(join(dir, "exec"));
	const pick = (re) => {
		const f = ex.filter((x) => re.test(x) && !/_sp(\.exe)?$|ompi|impi|msmpi/.test(x)).sort((a, b) => a.length - b.length)[0];
		return f ? join(dir, "exec", f) : null;
	};
	const starter = pick(/^starter_/), engine = pick(/^engine_/), animToVtk = pick(/^anim_to_vtk/);
	return starter && engine && animToVtk ? {
		starter,
		engine,
		animToVtk
	} : null;
}
/** Ambiente do processo com variáveis extra; `PATH` junta-se ao existente (no Windows a chave é "Path"). */
function withEnv(extra) {
	const env = { ...process.env };
	if (!extra) return env;
	const { PATH_PREPEND, ...rest } = extra;
	Object.assign(env, rest);
	if (PATH_PREPEND) {
		const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
		env[key] = `${PATH_PREPEND}${process.platform === "win32" ? ";" : ":"}${env[key] ?? ""}`;
	}
	return env;
}
function run(cmd, args, cwd, logFile, log, env) {
	return new Promise((ok, fail) => {
		log(`$ ${[cmd, ...args].join(" ")}`);
		const out = [];
		const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
		if (script && args.some((a) => /["&|<>^%]/.test(a))) {
			fail(/* @__PURE__ */ new Error(`Argumento inválido para ${cmd}`));
			return;
		}
		const p = script ? spawn(`"${cmd}"`, args.map((a) => `"${a}"`), {
			cwd,
			env: withEnv(env),
			shell: true
		}) : spawn(cmd, args, {
			cwd,
			env: withEnv(env)
		});
		const take = (b) => {
			out.push(b.toString());
		};
		p.stdout.on("data", take);
		p.stderr.on("data", take);
		p.on("error", (e) => fail(/* @__PURE__ */ new Error(`${cmd}: ${e.message}`)));
		p.on("close", (code) => {
			writeFileSync(join(cwd, logFile), out.join(""));
			if (code === 0) ok();
			else fail(/* @__PURE__ */ new Error(`${cmd} terminou com o código ${code}:\n${out.join("").split(/\r?\n/).slice(-15).join("\n")}`));
		});
	});
}
/**
* Comandos do OpenFOAM: com o ambiente já carregado (WM_PROJECT_DIR) correm diretamente; senão,
* pelo bashrc da instalação (os executáveis precisam do ambiente para encontrar o diretório etc).
*/
function foam(cmd, args, cwd, log) {
	const t = tools().openfoam;
	if (!t) throw new Error("OpenFOAM não encontrado (instale a versão openfoam.com ou defina CAD_FOAM_BASHRC)");
	if ("dir" in t && t.dir) {
		const version = t.dir.replace(/.*[\\/]OpenFOAM-/, "");
		return run(join(t.bin, `${cmd}.exe`), args, cwd, `log.${cmd}`, log, {
			WM_PROJECT: "OpenFOAM",
			WM_PROJECT_VERSION: version,
			WM_PROJECT_DIR: t.dir,
			FOAM_SIGFPE: "1",
			PATH_PREPEND: t.bin
		});
	}
	if (process.env.WM_PROJECT_DIR || !t.rc) return run(cmd, args, cwd, `log.${cmd}`, log);
	const quoted = [cmd, ...args].map((a) => `'${a.replace(/'/g, "")}'`).join(" ");
	return run("bash", ["-c", `. '${t.rc}' >/dev/null 2>&1; exec ${quoted}`], cwd, `log.${cmd}`, log);
}
/** Confere os grupos da malha com as faces do CAD (centroide médio dos triângulos de cada grupo). */
function checkGroups(c, m) {
	const out = [];
	const diag = Math.hypot(...c.bbox.max.map((x, i) => x - c.bbox.min[i]));
	for (const [name, tags] of Object.entries(c.groups)) {
		const faces = c.faces.filter((f) => tags.includes(f.tag));
		const A = faces.reduce((s, f) => s + f.area, 0);
		const want = [
			0,
			1,
			2
		].map((k) => faces.reduce((s, f) => s + f.center[k] * f.area, 0) / A);
		let a = 0;
		const got = [
			0,
			0,
			0
		];
		for (const { type, nodes } of elementsOf(faceBlocks(m, name))) {
			const P = nodes.map((t) => m.nodes.get(t));
			const fi = faceIntegrals(type, P);
			a += fi.area;
			fi.nodal.forEach((w, i) => {
				for (let q = 0; q < 3; q++) got[q] += w * P[i][q];
			});
		}
		if (!a) {
			out.push(`Grupo ${name}: sem faces na malha`);
			continue;
		}
		const d = Math.hypot(...got.map((x, q) => x / a - want[q]));
		if (d > .02 * diag || Math.abs(a - A) > .05 * A) out.push(`Grupo ${name}: a malha não corresponde às faces do CAD (desvio ${d.toFixed(2)} mm, área ${a.toFixed(1)} vs ${A.toFixed(1)} mm²)`);
	}
	for (const b of c.bodies ?? []) {
		const lo = [
			Infinity,
			Infinity,
			Infinity
		], hi = [
			-Infinity,
			-Infinity,
			-Infinity
		];
		for (const bl of physicalBlocks(m, b.group)) for (const t of bl.conn) {
			const p = m.nodes.get(t);
			for (let q = 0; q < 3; q++) {
				lo[q] = Math.min(lo[q], p[q]);
				hi[q] = Math.max(hi[q], p[q]);
			}
		}
		const dev = Math.max(...[
			0,
			1,
			2
		].map((q) => Math.max(Math.abs(lo[q] - b.bbox.min[q]), Math.abs(hi[q] - b.bbox.max[q]))));
		if (!Number.isFinite(dev) || dev > .02 * diag) out.push(`Corpo ${b.name} (${b.group}): o volume da malha não corresponde ao corpo do CAD`);
	}
	for (const cv of c.mesh.curves ?? []) {
		const box = m.entityBox.get(`1:${cv.tag}`);
		if ((box ? Math.max(...[
			0,
			1,
			2
		].map((q) => Math.max(Math.abs(box[q] - cv.box.min[q]), Math.abs(box[q + 3] - cv.box.max[q])))) : Infinity) > .001 * diag + 1e-6) {
			out.push(`Aresta ${cv.tag}: a curva do Gmsh não corresponde à aresta do CAD (numeração diferente) — as seeds não podem ser aplicadas`);
			break;
		}
	}
	return out;
}
/** Descrição curta dos elementos da malha (resumo). */
const meshKind = (c) => c.mesh.element === "hex" ? `hexaedros ${c.mesh.order === 2 ? "de 20 nós" : "de 8 nós"}${c.mesh.hexMethod === "subdivision" ? " (subdivisão)" : " (estruturados)"}` : `tetraedros de ordem ${c.mesh.order}`;
/** code_aster: mesma malha Gmsh, malha ASTER + .comm gerados aqui, run_aster com o .export. */
async function runAster(c, dir, log, regenerate) {
	const t = tools();
	if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
	if (!t.code_aster) throw new Error("code_aster (run_aster) não encontrado (https://code-aster.org, ou defina CAD_ASTER)");
	if (regenerate || !existsSync(join(dir, "mesh.geo"))) writeFileSync(join(dir, "mesh.geo"), femGeo(c));
	await run(t.gmsh.path, [
		"mesh.geo",
		"-3",
		"-o",
		"mesh.msh",
		"-nt",
		"1"
	], dir, "log.gmsh", log);
	const msh = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
	const warnings = checkGroups(c, msh);
	if (warnings.length) throw new Error(warnings.join("\n"));
	const ac = asterCase(c, msh);
	warnings.push(...ac.warnings);
	for (const [p, text] of Object.entries(ac.files)) writeFileSync(join(dir, p), text);
	await run(t.code_aster.path, ["job.export"], dir, "log.aster", log);
	const rd = (f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : void 0;
	const u = rd("u.tab");
	if (!u) throw new Error(`O code_aster não escreveu os resultados:\n${tail(join(dir, "job.mess"), 30)}`);
	const fem = asterResult(c, msh, {
		u,
		vm: rd("vm.tab"),
		freq: rd("freq.tab"),
		reac: rd("reac.tab"),
		peeq: rd("peeq.tab")
	}, ac.nodeOrder);
	const elements = [...elementsOf(solidBlocks(msh, c.bodies))].length;
	return {
		ok: true,
		physics: "fem",
		solver: "code_aster",
		summary: [["Malha", `${ac.nodeOrder.length} nós · ${elements} ${meshKind(c)}`], ...fem.summary],
		warnings,
		fem,
		view: femView(fem),
		metrics: fem.metrics,
		cells: elements,
		log: tail(join(dir, "job.mess"))
	};
}
/**
* OpenRadioss (OpenCourant): Starter e Engine sobre a malha Gmsh, animações convertidas em VTK pelo
* anim_to_vtk e lidas como blocos nodais (deslocamento, von Mises) para o mesmo resultado dinâmico.
*/
async function runRadioss(c, dir, log, regenerate) {
	const t = tools();
	if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
	const r = t.openradioss;
	if (!r) throw new Error("OpenRadioss/OpenCourant não encontrado (https://github.com/OpenCourant/OpenCourant/releases: descompacte e defina CAD_RADIOSS_DIR)");
	if (regenerate || !existsSync(join(dir, "mesh.geo"))) writeFileSync(join(dir, "mesh.geo"), femGeo(c));
	await run(t.gmsh.path, [
		"mesh.geo",
		"-3",
		"-o",
		"mesh.msh",
		"-nt",
		"1"
	], dir, "log.gmsh", log);
	const msh = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
	const warnings = checkGroups(c, msh);
	if (warnings.length) throw new Error(warnings.join("\n"));
	const deck = radiossDeck(c, msh);
	warnings.push(...deck.warnings);
	writeFileSync(join(dir, `${deck.name}_0000.rad`), deck.starter);
	writeFileSync(join(dir, `${deck.name}_0001.rad`), deck.engine);
	const plat = process.platform === "win32" ? "win64" : "linux64";
	const libs = [
		join(r.dir, "extlib", "hm_reader", plat),
		join(r.dir, "extlib", "h3d", "lib", plat),
		...plat === "win64" ? [join(r.dir, "extlib", "intelOneAPI_runtime", "win64")] : []
	];
	const env = {
		RAD_CFG_PATH: join(r.dir, "hm_cfg_files"),
		RAD_H3D_PATH: libs[1],
		OMP_NUM_THREADS: "1",
		KMP_STACKSIZE: "400m",
		OMP_STACKSIZE: "400m",
		...process.platform === "win32" ? { PATH_PREPEND: libs.join(";") } : { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
	};
	await run(r.starter, [
		"-i",
		`${deck.name}_0000.rad`,
		"-np",
		"1",
		"-nt",
		"1"
	], dir, "log.starter", log, env);
	const out0 = existsSync(join(dir, `${deck.name}_0000.out`)) ? readFileSync(join(dir, `${deck.name}_0000.out`), "utf8") : "";
	const nerr = /(\d+)\s+ERROR\(S\)/.exec(out0);
	if (!/NORMAL TERMINATION/i.test(out0) || !nerr || Number(nerr[1]) > 0) throw new Error(`Starter do OpenRadioss com erros:\n${tail(join(dir, `${deck.name}_0000.out`), 40) || tail(join(dir, "log.starter"), 40)}`);
	await run(r.engine, [
		"-i",
		`${deck.name}_0001.rad`,
		"-nt",
		"1"
	], dir, "log.engine", log, env);
	const out1 = existsSync(join(dir, `${deck.name}_0001.out`)) ? readFileSync(join(dir, `${deck.name}_0001.out`), "utf8") : "";
	if (!/NORMAL TERMINATION/i.test(out1)) throw new Error(`Engine do OpenRadioss não terminou normalmente:\n${tail(join(dir, `${deck.name}_0001.out`), 40)}`);
	const anims = readdirSync(dir).filter((f) => new RegExp(`^${deck.name}A\\d+$`).test(f)).sort();
	if (!anims.length) throw new Error("O OpenRadioss não escreveu animações");
	const frames = [];
	for (const a of anims) {
		const res = spawnSync(r.animToVtk, [a], {
			cwd: dir,
			env: withEnv(env),
			encoding: "utf8",
			maxBuffer: 1 << 30
		});
		if (res.status !== 0 || !res.stdout.includes("UNSTRUCTURED_GRID")) throw new Error(`anim_to_vtk falhou em ${a}: ${(res.stderr || res.stdout).slice(-400)}`);
		frames.push(parseVtk(res.stdout));
	}
	const fem = femResultFrom(c, msh, radiossBlocks(frames), {
		frequencies: [],
		buckling: [],
		reactions: [],
		reactionHistory: []
	});
	const dtm = /TIME STEP\s*[:=]?\s*([\d.Ee+-]+)/.exec(out1) ?? /DT\s*=\s*([\d.Ee+-]+)/.exec(out1);
	return {
		ok: true,
		physics: "fem",
		solver: "OpenRadioss (OpenCourant)",
		summary: [
			["Malha", `${deck.nodes} nós · ${deck.elements} ${meshKind(c)}`],
			["Integração no tempo", `explícita (OpenRadioss), passo estável do Engine${dtm ? ` ≈ ${(Number(dtm[1]) / 1e3).toExponential(3)} s` : ""}, ${frames.length} animações`],
			...fem.summary
		],
		warnings,
		fem,
		view: femView(fem),
		metrics: fem.metrics,
		cells: deck.elements,
		log: tail(join(dir, `${deck.name}_0001.out`))
	};
}
async function runFem(c, dir, log, regenerate) {
	if (c.solver === "code_aster") return runAster(c, dir, log, regenerate);
	if (c.solver === "openradioss") return runRadioss(c, dir, log, regenerate);
	const t = tools();
	if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
	if (!t.calculix) throw new Error("CalculiX (ccx) não encontrado (http://www.calculix.de, ou defina CAD_CCX)");
	if (regenerate || !existsSync(join(dir, "mesh.geo"))) writeFileSync(join(dir, "mesh.geo"), femGeo(c));
	await run(t.gmsh.path, [
		"mesh.geo",
		"-3",
		"-o",
		"mesh.msh",
		"-nt",
		"1"
	], dir, "log.gmsh", log);
	const msh = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
	const warnings = checkGroups(c, msh);
	if (warnings.length) throw new Error(warnings.join("\n"));
	const deck = calculixDeck(c, msh);
	warnings.push(...deck.warnings);
	writeFileSync(join(dir, "job.inp"), deck.inp);
	log(`malha: ${deck.nodes} nós, ${deck.elements} elementos`);
	await run(t.calculix.path, ["-i", "job"], dir, "log.ccx", log, { OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "2" });
	const fem = femResult(c, msh, readFileSync(join(dir, "job.frd"), "utf8"), existsSync(join(dir, "job.dat")) ? readFileSync(join(dir, "job.dat"), "utf8") : "", deck.supportLoad);
	const summary = [["Malha", `${deck.nodes} nós · ${deck.elements} ${meshKind(c)}`], ...fem.summary];
	if (deck.dynamic) {
		summary.splice(1, 0, ["Integração no tempo", `${c.dynamic.scheme === "explicit" ? "explícita" : "implícita"}, passo ${deck.dynamic.dt.toExponential(3)} s${deck.dynamic.stable ? " (estável da malha)" : ""}, ${deck.dynamic.increments} incrementos`]);
		const lg = existsSync(join(dir, "log.ccx")) ? readFileSync(join(dir, "log.ccx"), "utf8") : "";
		const sc = /Scaling factor of time increment:\s*([\d.Ee+-]+)/.exec(lg);
		if (/Selective Mass Scaling is active/.test(lg) || sc && Number(sc[1]) > 1.0001) warnings.push(`O passo pedido passa o limite de estabilidade: o CalculiX escalou a massa (fator ${sc?.[1] ?? "?"} no passo) — os modos altos ficam alterados; deixe o passo em branco para usar o estável`);
	}
	return {
		ok: true,
		physics: "fem",
		solver: `CalculiX ${t.calculix.version ?? ""}`.trim(),
		summary,
		warnings,
		fem,
		view: femView(fem),
		metrics: fem.metrics,
		cells: deck.elements,
		log: tail(join(dir, "log.ccx"))
	};
}
/**
* Camadas do resultado CFD: patches (paredes/corpo, entrada, saída) com a pressão e três cortes
* pelo centro do corpo com a pressão e |U|. Visíveis por omissão: interno — entrada, saída e o corte
* que contém o escoamento; externo — corpo e esse corte.
*/
function cfdView(c, mesh, p, U) {
	const pres = {
		name: "Pressão",
		unit: "Pa",
		field: p,
		ncomp: 1,
		map: (v) => v[0] * c.fluid.rho
	};
	const vel = {
		name: "Velocidade",
		unit: "m/s",
		field: U,
		ncomp: 3,
		map: (v) => Math.hypot(v[0], v[1], v[2])
	};
	const internal = c.regime === "internal";
	const layers = [];
	const add = (l) => {
		if (l) layers.push(l);
	};
	if (internal) {
		add(patchLayer("Paredes", mesh, "walls", [pres, null], false));
		add(patchLayer("Entrada", mesh, "inlet", [pres, vel], true));
		add(patchLayer("Saída", mesh, "outlet", [pres, vel], true));
	} else add(patchLayer("Corpo", mesh, "body", [pres, null], true));
	const show = [
		0,
		1,
		2
	].reduce((m, k) => Math.abs(c.velocity[k]) > Math.abs(c.velocity[m]) ? k : m, 0) === 2 ? 1 : 2;
	const mid = [
		0,
		1,
		2
	].map((k) => (c.bbox.min[k] + c.bbox.max[k]) / 2 * .001);
	for (const k of [
		0,
		1,
		2
	]) {
		const n = [
			0,
			0,
			0
		];
		n[k] = 1;
		add(sliceLayer(`Corte ${"XYZ"[k]} = ${(mid[k] * 1e3).toFixed(1)} mm`, mesh, mid, n, [pres, vel], k === show));
	}
	return {
		fields: [{
			name: pres.name,
			unit: pres.unit
		}, {
			name: vel.name,
			unit: vel.unit
		}],
		modes: [],
		layers
	};
}
/** Diretivas de dicionário do OpenFOAM que executam código (recusadas nos ficheiros recebidos). */
const UNSAFE = /#(codeStream|calc|include|includeEtc|includeFunc|eval)\b|\bcode(Include|Options|Libs)?\s*#?\{/;
async function runOpenfoam(c, dir, log, regenerate) {
	if (regenerate) {
		const stl = {};
		for (const name of Object.keys(c.groups)) stl[name] = readFileSync(join(dir, `constant/triSurface/${name}.stl`), "utf8");
		for (const [p, text] of Object.entries(openfoamCase(c, stl))) {
			mkdirSync(dirname(join(dir, p)), { recursive: true });
			writeFileSync(join(dir, p), text);
		}
	}
	for (const sub of [
		"system",
		"constant",
		"0"
	]) for (const fn of readdirSync(join(dir, sub))) {
		const p = join(dir, sub, fn);
		if (!statSync(p).isFile() || fn.endsWith(".stl")) continue;
		if (UNSAFE.test(readFileSync(p, "utf8"))) throw new Error(`Diretiva não permitida em ${sub}/${fn}`);
	}
	await foam("blockMesh", [], dir, log);
	await foam("surfaceFeatureExtract", [], dir, log);
	await foam("snappyHexMesh", ["-overwrite"], dir, log);
	await foam("checkMesh", [], dir, log).catch(() => log("checkMesh com avisos"));
	const warnings = [];
	try {
		await foam("simpleFoam", [], dir, log);
	} catch (e) {
		if (!/sha1|functionObject|function object/i.test(e.message)) throw e;
		warnings.push("Os function objects falharam nesta instalação do OpenFOAM: cálculo repetido com -noFunctionObjects");
		await foam("simpleFoam", ["-noFunctionObjects"], dir, log);
	}
	const L = readFileSync(join(dir, "log.simpleFoam"), "utf8");
	const conv = /SIMPLE solution converged in (\d+) iterations/.exec(L);
	const iters = [...L.matchAll(/^Time = (\d+)/gm)].length;
	const cells = /cells:\s+(\d+)/.exec(tail(join(dir, "log.checkMesh"), 400))?.[1];
	const summary = [
		["Malha", `${cells ?? "?"} células (snappyHexMesh)`],
		["Iterações", conv ? `${conv[1]} (convergido)` : `${iters} (sem atingir os resíduos pedidos)`],
		["Re", c.reynolds.toExponential(2)]
	];
	if (!conv) warnings.push("O simpleFoam não convergiu para os resíduos pedidos: aumente as iterações ou reveja a malha");
	const metrics = [];
	let view;
	const last = readdirSync(dir).filter((d) => /^\d+(\.\d+)?$/.test(d) && d !== "0").sort((a, b) => Number(a) - Number(b)).at(-1);
	if (last) {
		const pm = join(dir, "constant/polyMesh");
		const mesh = {
			points: readPoints(readFileSync(join(pm, "points"), "utf8")),
			faces: readFaces(readFileSync(join(pm, "faces"), "utf8")),
			owner: readLabels(readFileSync(join(pm, "owner"), "utf8")),
			neighbour: readLabels(readFileSync(join(pm, "neighbour"), "utf8")),
			boundary: readBoundary(readFileSync(join(pm, "boundary"), "utf8"))
		};
		const phi = existsSync(join(dir, last, "phi")) ? readScalarField(readFileSync(join(dir, last, "phi"), "utf8")) : null;
		const pText = readFileSync(join(dir, last, "p"), "utf8");
		const p = readScalarField(pText);
		if (phi && mesh.boundary.has("inlet") && mesh.boundary.has("outlet")) {
			const Qi = -patchFlux(phi, mesh, "inlet");
			const bal = 100 * (patchFlux(phi, mesh, "outlet") - Qi) / Math.max(Math.abs(Qi), 1e-30);
			summary.push(["Caudal de entrada", `${(Qi * 1e3).toPrecision(5)} L/s`], ["Balanço de massa", `${bal.toFixed(3)} %`]);
			metrics.push({
				key: "q",
				label: "Caudal de entrada",
				unit: "L/s",
				value: Qi * 1e3
			});
		}
		if (c.regime === "internal" && mesh.boundary.has("inlet") && mesh.boundary.has("outlet")) {
			const dp = (patchAverage(p, mesh, "inlet") - patchAverage(p, mesh, "outlet")) * c.fluid.rho;
			summary.push(["Queda de pressão", `${dp.toPrecision(5)} Pa`]);
			metrics.push({
				key: "dp",
				label: "Queda de pressão",
				unit: "Pa",
				value: dp
			});
		}
		if (c.regime === "external" && mesh.boundary.has("body")) {
			const F = patchPressureForce(p, mesh, "body", c.fluid.rho);
			const U = Math.hypot(...c.velocity), dir = c.velocity.map((x) => x / U);
			const drag = F[0] * dir[0] + F[1] * dir[1] + F[2] * dir[2];
			const ax = [
				0,
				1,
				2
			].reduce((m, k) => Math.abs(dir[k]) > Math.abs(dir[m]) ? k : m, 0);
			const Aref = [
				0,
				1,
				2
			].map((k) => (c.bbox.max[k] - c.bbox.min[k]) * .001).filter((_, k) => k !== ax).reduce((a, b) => a * b, 1);
			const cd = drag / (.5 * c.fluid.rho * U * U * Aref);
			summary.push(["Força de pressão no corpo (N)", F.map((x) => x.toPrecision(4)).join(" · ")], ["Arrasto de pressão", `${drag.toPrecision(4)} N (Cd ≈ ${cd.toFixed(3)}, área ${(Aref * 1e6).toFixed(0)} mm²)`]);
			metrics.push({
				key: "drag",
				label: "Arrasto de pressão",
				unit: "N",
				value: drag
			}, {
				key: "cd",
				label: "Cd (pressão)",
				unit: "",
				value: cd
			});
			warnings.push("Força calculada só com a pressão: falta a parcela viscosa (use o function object forces/wallShearStress do OpenFOAM)");
		}
		try {
			view = cfdView(c, mesh, readField(pText), readField(readFileSync(join(dir, last, "U"), "utf8")));
		} catch (e) {
			warnings.push(`Campos para o 3D não lidos: ${e.message}`);
		}
	}
	const nCells = Number(cells) || 0;
	return {
		ok: true,
		physics: "cfd",
		solver: "OpenFOAM simpleFoam",
		summary,
		warnings,
		view,
		metrics,
		cells: nCells,
		log: L.split(/\r?\n/).slice(-30).join("\n")
	};
}
async function runSu2(c, dir, log, regenerate) {
	const t = tools();
	if (!t.gmsh) throw new Error("Gmsh não encontrado");
	if (!t.su2) throw new Error("SU2 não encontrado (https://su2code.github.io, ou defina CAD_SU2)");
	if (regenerate) {
		writeFileSync(join(dir, "mesh.geo"), su2Geo(c));
		writeFileSync(join(dir, "case.cfg"), su2Config(c));
	}
	await run(t.gmsh.path, [
		"mesh.geo",
		"-3",
		"-format",
		"su2",
		"-o",
		"mesh.su2"
	], dir, "log.gmsh", log);
	await run(t.su2.path, ["case.cfg"], dir, "log.su2", log);
	const hist = existsSync(join(dir, "history.csv")) ? readFileSync(join(dir, "history.csv"), "utf8").trim().split(/\r?\n/) : [];
	const summary = [["Iterações", String(Math.max(0, hist.length - 1))], ["Re", c.reynolds.toExponential(2)]];
	const metrics = [];
	if (hist.length > 1) {
		const h = hist[0].split(",").map((x) => x.replace(/"/g, "").trim()), v = hist.at(-1).split(",");
		h.forEach((k, i) => {
			if (!/rms\[P\]|^C[DL]$|Press|Massflow|Drop/i.test(k)) return;
			summary.push([k, v[i].trim()]);
			if (/^C[DL]$/i.test(k)) metrics.push({
				key: k.toLowerCase(),
				label: k,
				unit: "",
				value: Number(v[i])
			});
			if (/Pressure_Drop/i.test(k)) metrics.push({
				key: "dp",
				label: "Queda de pressão",
				unit: "Pa",
				value: Math.abs(Number(v[i]))
			});
			if (/Massflow/i.test(k) && !metrics.some((m) => m.key === "mdot")) metrics.push({
				key: "mdot",
				label: "Caudal mássico",
				unit: "kg/s",
				value: Math.abs(Number(v[i]))
			});
		});
		const rms = h.findIndex((k) => /rms\[P\]/i.test(k));
		if (rms >= 0) metrics.push({
			key: "rmsP",
			label: "Resíduo RMS de pressão (log10)",
			unit: "",
			value: Number(v[rms])
		});
	}
	return {
		ok: true,
		physics: "cfd",
		solver: "SU2",
		summary,
		warnings: [],
		metrics,
		cells: Number(/NELEM=\s*(\d+)/.exec(readFileSync(join(dir, "mesh.su2"), "utf8").slice(0, 400))?.[1] ?? 0),
		log: tail(join(dir, "log.su2"))
	};
}
const tail = (p, n = 25) => existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/).slice(-n).join("\n") : "";
async function runOnce(c, dir, log, regenerate) {
	return c.physics === "fem" ? runFem(c, dir, log, regenerate) : c.solver === "openfoam" ? runOpenfoam(c, dir, log, regenerate) : runSu2(c, dir, log, regenerate);
}
/** Caso com a malha engrossada pelo fator `k` (tamanhos × k; refinamento por curvatura ÷ k). */
function coarsened(c, k) {
	if (c.physics === "fem") {
		const curv = c.mesh.curvature > 0 ? Math.max(4, Math.round(c.mesh.curvature / k)) : 0;
		const curves = c.mesh.curves?.map((cv) => {
			const n = Math.max(1, Math.round(cv.n / k));
			const B = cv.progression ? cv.progression ** Math.max(0, cv.n - 1) : 1;
			return {
				...cv,
				n,
				...cv.progression ? { progression: n > 1 ? B ** (1 / (n - 1)) : 1 } : {}
			};
		});
		return {
			...c,
			mesh: {
				...c.mesh,
				size: c.mesh.size * k,
				minSize: c.mesh.minSize * k,
				curvature: curv,
				local: c.mesh.local.map((l) => ({
					...l,
					size: l.size * k
				})),
				...curves ? { curves } : {}
			}
		};
	}
	return {
		...c,
		mesh: {
			...c.mesh,
			size: c.mesh.size * k
		}
	};
}
/**
* Só a malha (pré-visualização, como no Femap antes de exportar): corre o Gmsh no caso FEM de uma
* pasta, confere os grupos e as seeds com o CAD e devolve a qualidade e a superfície da malha.
*/
async function previewMesh(dir, log = () => {}) {
	const t0 = Date.now();
	const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
	if (c.format !== "cadp-sim-case" || c.physics !== "fem") throw new Error("A pré-visualização da malha é para estudos FEM");
	const t = tools();
	if (!t.gmsh) throw new Error("Gmsh não encontrado (https://gmsh.info, ou defina CAD_GMSH)");
	writeFileSync(join(dir, "mesh.geo"), femGeo(c));
	await run(t.gmsh.path, [
		"mesh.geo",
		"-3",
		"-o",
		"mesh.msh",
		"-nt",
		"1"
	], dir, "log.gmsh", log);
	const msh = parseMsh(readFileSync(join(dir, "mesh.msh"), "utf8"));
	const warnings = checkGroups(c, msh);
	const p = meshPreview(c, msh);
	warnings.push(...p.quality.notes);
	return {
		ok: true,
		physics: "fem",
		solver: `Gmsh ${t.gmsh.version ?? ""} — pré-visualização da malha`.trim(),
		summary: p.summary,
		warnings,
		view: p.view,
		quality: p.quality,
		metrics: [],
		cells: p.quality.elements,
		hypotheses: c.hypotheses,
		log: tail(join(dir, "log.gmsh")),
		seconds: (Date.now() - t0) / 1e3
	};
}
/** Corre o caso de uma pasta (case.json + model.brep [+ STL]). `regenerate`: refaz os ficheiros dos solvers a partir do caso. */
async function runCase(dir, log = () => {}, regenerate = false, opts = {}) {
	const t0 = Date.now();
	const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
	if (c.format !== "cadp-sim-case") throw new Error("case.json inválido");
	let r;
	const prepare = (k, name) => {
		const sub = join(dir, name);
		mkdirSync(sub, { recursive: true });
		const ck = coarsened(c, k);
		writeFileSync(join(sub, "case.json"), JSON.stringify(ck));
		writeFileSync(join(sub, "model.brep"), readFileSync(join(dir, "model.brep")));
		if (existsSync(join(dir, "constant/triSurface"))) {
			mkdirSync(join(sub, "constant/triSurface"), { recursive: true });
			for (const fn of readdirSync(join(dir, "constant/triSurface"))) if (fn.endsWith(".stl")) writeFileSync(join(sub, "constant/triSurface", fn), readFileSync(join(dir, "constant/triSurface", fn)));
		}
		return {
			sub,
			ck
		};
	};
	if (opts.convergence?.sweep) {
		const { ratio } = opts.convergence;
		const n = Math.round(opts.convergence.sweep), maxCells = opts.convergence.maxCells ?? 15e5;
		if (!(n >= 1 && n <= 4)) throw new Error("Varrimento: entre 1 e 4 níveis para cada lado");
		if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
		const runs = [];
		const steps = [];
		const all = [];
		let metric = opts.convergence.metric, stop;
		for (let k = n; k >= -n; k--) {
			if (runs.length && runs.at(-1).cells * ratio ** 3 > maxCells) {
				stop = `as malhas abaixo de ${steps.at(-1).size.toPrecision(3)} mm passariam de ${maxCells.toExponential(1)} elementos`;
				break;
			}
			const { sub, ck } = prepare(ratio ** k, `nivel${k >= 0 ? "+" : ""}${k}`);
			log(`— nível ${k > 0 ? "+" : ""}${k} (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
			const tk = Date.now();
			const r1 = await runOnce(ck, sub, log, true);
			runs.push(r1);
			all.push({
				level: k,
				size: ck.mesh.size,
				cells: r1.cells,
				seconds: (Date.now() - tk) / 1e3,
				metrics: r1.metrics
			});
			metric ??= r1.metrics.find((x) => x.key.startsWith("probe"))?.key ?? r1.metrics[0]?.key;
			steps.push({
				level: k,
				size: ck.mesh.size,
				cells: r1.cells,
				value: r1.metrics.find((x) => x.key === metric)?.value ?? NaN
			});
		}
		if (runs.length < 3) throw new Error(`Varrimento: só ${runs.length} malha(s) cabem no limite de ${maxCells.toExponential(1)} elementos — aumente o tamanho pedido`);
		const report = convergenceReport(ratio, runs.slice(-3).reverse().map((x, i) => ({
			cells: x.cells,
			size: steps[steps.length - 1 - i].size,
			metrics: x.metrics
		})));
		const row = report.rows.find((x) => x.key === metric);
		const base = steps.find((x) => x.level === 0).value;
		const values = steps.map((x) => x.value).filter(Number.isFinite);
		report.levels = all;
		report.setup = {
			mode: "sweep",
			ratio,
			levels: n,
			metric
		};
		report.sweep = {
			metric: metric ?? "",
			levels: n,
			steps,
			monotonic: isMonotonic(values),
			base,
			baseError: row && Number.isFinite(row.gci.extrapolated) ? Math.abs((base - row.gci.extrapolated) / row.gci.extrapolated) : void 0,
			stop
		};
		report.hypotheses.push(`Varrimento de ${steps.length} malhas (tamanho h·r^k, k = ${n} … ${steps.at(-1).level}, r = ${ratio}); GCI e extrapolação pelas três mais finas; erro da malha pedida = |f(h) − f extrapolado| / |f extrapolado|`);
		const baseRun = runs[steps.findIndex((x) => x.level === 0)];
		r = {
			...baseRun,
			convergence: report,
			warnings: [
				...baseRun.warnings,
				...stop ? [`Varrimento incompleto: ${stop}`] : [],
				...report.sweep.monotonic ? [] : ["A grandeza não varia de forma monotónica com a malha: veja se o ponto está junto a uma singularidade (canto vivo, apoio, carga)"],
				...(row?.gci.notes ?? []).map((x) => `${row.label}: ${x}`)
			]
		};
	} else if (opts.convergence?.target !== void 0) {
		const { ratio, target } = opts.convergence;
		const maxLevels = Math.min(8, Math.max(3, opts.convergence.maxLevels ?? 5)), maxCells = opts.convergence.maxCells ?? 15e5;
		if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
		if (!(target > 0 && target < 1)) throw new Error("GCI alvo fora de ]0; 1[ (fração, ex. 0,01 = 1 %)");
		const runs = [];
		const steps = [];
		const all = [];
		let metric = opts.convergence.metric;
		let achieved = false, stop = "";
		for (let k = 0; k < maxLevels; k++) {
			const { sub, ck } = prepare(ratio ** -k, `nivel${k + 1}`);
			log(`— nível ${k + 1} (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
			const tk = Date.now();
			const r1 = await runOnce(ck, sub, log, true);
			runs.push(r1);
			all.push({
				level: -k,
				size: ck.mesh.size,
				cells: r1.cells,
				seconds: (Date.now() - tk) / 1e3,
				metrics: r1.metrics
			});
			metric ??= r1.metrics.find((x) => x.key.startsWith("probe"))?.key ?? r1.metrics[0]?.key;
			const val = r1.metrics.find((x) => x.key === metric)?.value ?? NaN;
			let g;
			if (runs.length >= 3) {
				const [f3, f2, f1] = runs.slice(-3).map((x) => x.metrics.find((y) => y.key === metric)?.value ?? NaN);
				const [n3, n2, n1] = runs.slice(-3).map((x) => x.cells);
				g = gci([
					n1,
					n2,
					n3
				], [
					f1,
					f2,
					f3
				]);
			}
			steps.push({
				level: k + 1,
				size: ck.mesh.size,
				cells: r1.cells,
				value: val,
				gci: g?.gciFine,
				behaviour: g?.behaviour
			});
			if (g && g.behaviour === "monotonic" && g.gciFine <= target) {
				achieved = true;
				stop = `GCI ${(100 * g.gciFine).toFixed(2)} % ≤ ${(100 * target).toFixed(2)} %`;
				break;
			}
			if (g?.behaviour === "converged") {
				achieved = true;
				stop = "valores iguais nas duas malhas mais finas";
				break;
			}
			if (r1.cells * ratio ** 3 > maxCells) {
				stop = `a malha seguinte passaria de ${maxCells.toExponential(1)} células`;
				break;
			}
		}
		if (!stop) stop = `atingido o máximo de ${maxLevels} malhas`;
		const last = runs.slice(-3).reverse();
		const report = last.length === 3 ? convergenceReport(ratio, last.map((x) => ({
			cells: x.cells,
			size: NaN,
			metrics: x.metrics
		}))) : {
			ratio,
			meshes: [],
			rows: [],
			hypotheses: []
		};
		report.meshes = last.map((x, i) => ({
			cells: x.cells,
			size: steps[steps.length - 1 - i].size
		}));
		report.levels = all;
		report.setup = {
			mode: "auto",
			ratio,
			target,
			levels: maxLevels,
			metric
		};
		report.auto = {
			target,
			metric: metric ?? "",
			achieved,
			stop,
			steps
		};
		const fine = runs.at(-1);
		r = {
			...fine,
			convergence: report,
			warnings: [
				...fine.warnings,
				...achieved ? [] : [`Convergência não atingida: ${stop}`],
				...report.rows.filter((x) => x.key === metric).flatMap((x) => x.gci.notes.map((n) => `${x.label}: ${n}`))
			]
		};
	} else if (opts.convergence) {
		const ratio = opts.convergence.ratio;
		if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
		const runs = [];
		const all = [];
		for (const lvl of [
			2,
			1,
			0
		]) {
			const { sub, ck } = prepare(ratio ** lvl, `malha${lvl + 1}`);
			log(`— malha ${lvl + 1} de 3 (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
			const tk = Date.now();
			runs[lvl] = await runOnce(ck, sub, log, true);
			all.push({
				level: lvl,
				size: ck.mesh.size,
				cells: runs[lvl].cells,
				seconds: (Date.now() - tk) / 1e3,
				metrics: runs[lvl].metrics
			});
		}
		const report = convergenceReport(ratio, runs.map((x, i) => ({
			cells: x.cells,
			size: c.mesh.size * ratio ** i,
			metrics: x.metrics
		})));
		report.levels = all;
		report.setup = {
			mode: "three",
			ratio
		};
		r = {
			...runs[0],
			convergence: report,
			warnings: [...runs[0].warnings, ...report.rows.flatMap((x) => x.gci.notes.map((n) => `${x.label}: ${n}`))]
		};
	} else r = await runOnce(c, dir, log, regenerate);
	const res = {
		...r,
		summary: [...r.summary],
		hypotheses: c.hypotheses,
		seconds: (Date.now() - t0) / 1e3
	};
	writeFileSync(join(dir, "results.json"), JSON.stringify(res));
	return res;
}
/**
* Polar de um perfil no XFOIL. Os comandos são gerados a partir do pedido validado (só números e
* códigos NACA). Algumas compilações (ex.: Debian/Ubuntu 6.99) ativam exceções de vírgula flutuante e
* abortam no modo viscoso: CAD_XFOIL_PRELOAD aponta para uma biblioteca que as desliga (ver LEIA-ME).
*/
async function runXfoil(req, log = () => {}) {
	const t0 = Date.now();
	const c = xfoilCommands(req);
	const x = tools().xfoil;
	if (!x) throw new Error("XFOIL não encontrado (https://web.mit.edu/drela/Public/web/xfoil/, apt install xfoil, ou defina CAD_XFOIL)");
	const dir = mkdtempSync(join(tmpdir(), "cad-xfoil-"));
	try {
		for (const [p, text] of Object.entries(c.files)) writeFileSync(join(dir, p), text);
		log(`$ ${x.path} < comandos (${c.request.alpha.from}…${c.request.alpha.to}°, Re ${c.request.re})`);
		const env = {
			...process.env,
			...x.preload ? { LD_PRELOAD: x.preload } : {}
		};
		const xf = (stdin, seconds) => new Promise((ok, fail) => {
			const p = spawn(x.path, [], {
				cwd: dir,
				env
			});
			let tailText = "", total = 0, stopped = "";
			const take = (b) => {
				total += b.length;
				tailText = (tailText + b.toString()).slice(-2e4);
				if (total > 5e7 && !stopped) {
					stopped = "saída descontrolada (camada-limite divergente, NaN)";
					p.kill("SIGKILL");
				}
			};
			p.stdout.on("data", take);
			p.stderr.on("data", take);
			const timer = setTimeout(() => {
				stopped = `não terminou em ${seconds} s`;
				p.kill("SIGKILL");
			}, seconds * 1e3);
			p.on("error", (e) => {
				clearTimeout(timer);
				fail(/* @__PURE__ */ new Error(`xfoil: ${e.message}`));
			});
			p.on("close", () => {
				clearTimeout(timer);
				ok(stopped ? `${tailText}\n[XFOIL parado: ${stopped}]` : tailText);
			});
			p.stdin.end(stdin);
		});
		const nA = Math.abs(c.request.alpha.to - c.request.alpha.from) / c.request.alpha.step + 1;
		const limit = Math.round(30 + 3 * nA);
		const out = await xf(c.stdin, limit);
		const file = join(dir, "polar.txt");
		let polar = existsSync(file) ? parsePolar(readFileSync(file, "utf8")) : [];
		let retried = 0;
		const first = polar.length ? polarSummary(polar, c.request).missing : [];
		if (first.length) {
			log(`XFOIL: segunda passagem para α = ${first.join(", ")}°`);
			await xf(xfoilRetryCommands(c.request, first, polar.map((p) => p.alpha)).stdin, Math.round(30 + 6 * first.length));
			const f2 = join(dir, "polar2.txt");
			const extra = existsSync(f2) ? parsePolar(readFileSync(f2, "utf8")).filter((p) => first.some((m) => Math.abs(m - p.alpha) < .001)) : [];
			retried = extra.length;
			polar = [...polar, ...extra].sort((a, b) => a.alpha - b.alpha);
		}
		if (!polar.length) {
			const fpe = /SIGFPE|Floating-point exception/i.test(out);
			throw new Error(fpe ? "O XFOIL abortou com uma exceção de vírgula flutuante (compilação com FPE ativas): defina CAD_XFOIL_PRELOAD (ver LEIA-ME)" : `O XFOIL não produziu nenhum ponto da polar:\n${out.split(/\r?\n/).slice(-12).join("\n")}`);
		}
		const summary = polarSummary(polar, c.request);
		const warnings = [];
		if (retried) warnings.push(`${retried} ângulo(s) obtidos numa segunda passagem (aproximação a partir do vizinho convergido, +10 painéis): confirmar a continuidade da polar`);
		if (summary.missing.length) warnings.push(`Sem convergência em α = ${summary.missing.join(", ")}° (omitidos)`);
		if (summary.clMax === null) warnings.push("CLmax não atingido na gama pedida");
		if (c.request.mach > .5) warnings.push("Mach > 0,5: verificar se há escoamento supersónico local (Cp mínimo)");
		const name = "naca" in c.request.airfoil ? `NACA ${c.request.airfoil.naca}` : c.request.airfoil.name;
		return {
			ok: true,
			solver: x.version,
			airfoil: name,
			re: c.request.re,
			mach: c.request.mach,
			ncrit: c.request.ncrit,
			polar,
			summary,
			warnings,
			hypotheses: XFOIL_HYPOTHESES,
			seconds: (Date.now() - t0) / 1e3,
			log: out.split(/\r?\n/).slice(-20).join("\n")
		};
	} finally {
		if (!process.env.CAD_KEEP) rmSync(dir, {
			recursive: true,
			force: true
		});
	}
}
function serve(port = 8765, token = randomBytes(12).toString("hex")) {
	let busy = false;
	const server = createServer(async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
		res.setHeader("Access-Control-Allow-Headers", "content-type, x-cad-token");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Private-Network", "true");
		res.setHeader("Vary", "Origin");
		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			return;
		}
		const send = (code, body) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.headers["x-cad-token"] !== token) {
			send(401, { error: "Token do agente em falta ou errado" });
			return;
		}
		if (req.method === "GET" && req.url === "/status") {
			send(200, {
				ok: true,
				tools: tools(),
				busy
			});
			return;
		}
		if (req.method !== "POST" || req.url !== "/run" && req.url !== "/xfoil" && req.url !== "/mesh") {
			send(404, { error: "Pedido desconhecido" });
			return;
		}
		if (busy) {
			send(409, { error: "O agente está ocupado com outro cálculo" });
			return;
		}
		const chunks = [];
		let size = 0;
		for await (const ch of req) {
			size += ch.length;
			if (size > 2e8) {
				send(413, { error: "Pedido demasiado grande" });
				return;
			}
			chunks.push(ch);
		}
		busy = true;
		if (req.url === "/xfoil") {
			try {
				send(200, await runXfoil(JSON.parse(Buffer.concat(chunks).toString("utf8")), (s) => console.log(s)));
			} catch (e) {
				send(500, { error: e.message });
			} finally {
				busy = false;
			}
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), "cad-run-"));
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (body.case?.format !== "cadp-sim-case" || typeof body.brep !== "string") throw new Error("Pedido inválido");
			writeFileSync(join(dir, "case.json"), JSON.stringify(body.case));
			writeFileSync(join(dir, "model.brep"), body.brep);
			if (body.stl) {
				mkdirSync(join(dir, "constant/triSurface"), { recursive: true });
				for (const [name, text] of Object.entries(body.stl)) {
					if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Nome de patch inválido: ${name}`);
					writeFileSync(join(dir, `constant/triSurface/${name}.stl`), text);
				}
			}
			const cv = body.convergence;
			const fin = (x) => x === void 0 || x === null ? void 0 : Number.isFinite(Number(x)) ? Number(x) : void 0;
			const conv = cv && Number.isFinite(Number(cv.ratio)) ? {
				ratio: Number(cv.ratio),
				target: fin(cv.target),
				metric: typeof cv.metric === "string" ? cv.metric : void 0,
				maxLevels: fin(cv.maxLevels),
				maxCells: fin(cv.maxCells),
				sweep: fin(cv.sweep)
			} : void 0;
			send(200, req.url === "/mesh" ? await previewMesh(dir, (s) => console.log(s)) : await runCase(dir, (s) => console.log(s), true, { convergence: conv }));
		} catch (e) {
			send(500, {
				error: e.message,
				log: tail(join(dir, "log.ccx")) || tail(join(dir, "log.gmsh"))
			});
		} finally {
			busy = false;
			if (!process.env.CAD_KEEP) rmSync(dir, {
				recursive: true,
				force: true
			});
		}
	});
	server.listen(port, "127.0.0.1");
	return {
		server,
		token,
		port
	};
}
if (process.argv[1] && /cad-runner\.(m?js|ts)$/.test(process.argv[1])) {
	const args = process.argv.slice(2);
	if (args[0] === "--status") console.log(JSON.stringify(tools(), null, 2));
	else if (args[0] === "--serve") {
		const port = Number(args[args.indexOf("--port") + 1]) || 8765;
		const { token } = serve(port, process.env.CAD_TOKEN);
		console.log(`Agente CAD a escutar em http://127.0.0.1:${port}\nToken (copie para a aplicação, Simulação → Agente local): ${token}\nSolvers: ${JSON.stringify(tools())}`);
	} else if (args[0]) {
		const ri = args.indexOf("--convergence");
		runCase(resolve(args[0]), (s) => console.log(s), args.includes("--regenerate"), ri > 0 ? { convergence: { ratio: Number(args[ri + 1]) || 1.5 } } : {}).then((r) => {
			for (const [k, v] of r.summary) console.log(`${k}: ${v}`);
			for (const x of r.convergence?.rows ?? []) console.log(`${x.label}: ${x.values.map((v) => v.toPrecision(5)).join(" / ")} → extrapolado ${x.gci.extrapolated.toPrecision(5)} ${x.unit}, p = ${x.gci.p.toFixed(2)}, GCI = ${(100 * x.gci.gciFine).toFixed(2)} %`);
			for (const w of r.warnings) console.log(`Aviso: ${w}`);
		}).catch((e) => {
			console.error(e.message);
			process.exit(1);
		});
	} else console.log("Uso: node cad-runner.mjs <pasta-do-caso> | --serve [--port 8765] | --status");
}
export { coarsened, previewMesh, runCase, runXfoil, serve, tools };
