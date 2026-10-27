import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// src/sim/gmsh.ts
const list = (tags) => `{${tags.join(", ")}}`;
function femGeo(c) {
	const out = [
		`// Gerado pelo CAD protótipo — ${c.title}`,
		`// Unidades: mm. Elementos tetraédricos de ordem ${c.mesh.order}.`,
		`SetFactory("OpenCASCADE");`,
		`Merge "model.brep";`
	];
	if (c.bodies?.length) c.bodies.forEach((b, k) => out.push(`Physical Volume("${b.group}") = {${k + 1}};`));
	else out.push(`Physical Volume("SOLID") = Volume{:};`);
	for (const [name, tags] of Object.entries(c.groups)) out.push(`Physical Surface("${name}") = ${list(tags)};`);
	out.push(`Mesh.MeshSizeMax = ${c.mesh.size};`, `Mesh.MeshSizeMin = ${c.mesh.minSize};`, `Mesh.MeshSizeFromCurvature = ${c.mesh.curvature};`, `Mesh.ElementOrder = ${c.mesh.order};`, `Mesh.HighOrderOptimize = ${c.mesh.order === 2 ? 1 : 0};`, `Mesh.Optimize = 1;`, `Mesh.Algorithm3D = 1;`, `Mesh.MshFileVersion = 4.1;`, `Mesh.Binary = 0;`, `Mesh.SaveAll = 0;`);
	for (const l of c.mesh.local) out.push(`MeshSize{ PointsOf{ Surface${list(c.groups[l.group])}; } } = ${l.size};`);
	return out.join("\n") + "\n";
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
// src/sim/msh.ts
const NODES_PER = {
	1: 2,
	2: 3,
	3: 4,
	4: 4,
	8: 3,
	9: 6,
	11: 10,
	15: 1
};
function parseMsh(text) {
	const lines = text.split(/\r?\n/);
	let i = 0;
	const next = () => lines[i++]?.trim() ?? "";
	const nodes = /* @__PURE__ */ new Map();
	const blocks = [];
	const physicals = /* @__PURE__ */ new Map();
	const entityPhysicals = /* @__PURE__ */ new Map();
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
		entityPhysicals
	};
}
/** Blocos de elementos que pertencem a um grupo físico (por nome). */
function physicalBlocks(m, name) {
	const p = m.physicals.get(name);
	if (!p) return [];
	return m.blocks.filter((b) => b.dim === p.dim && (m.entityPhysicals.get(`${b.dim}:${b.entity}`) ?? []).includes(p.tag));
}
/** Blocos de tetraedros do caso: o grupo SOLID ou, nas montagens, os grupos dos corpos (B1, B2, …). */
function solidBlocks(m, bodies) {
	return (bodies?.length ? bodies.map((b) => b.group) : ["SOLID"]).flatMap((n) => physicalBlocks(m, n)).filter((b) => b.type === 4 || b.type === 11);
}
// src/sim/calculix.ts
/** Faces de um tetraedro (cantos, base 0) pela numeração do CalculiX: F1 = 1-2-3, F2 = 1-4-2, F3 = 2-4-3, F4 = 3-4-1. */
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
/** Gmsh tet10 → CalculiX C3D10: as arestas 2-4 e 3-4 vêm trocadas (nós 9 e 10). */
const TET10_ORDER$1 = [
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
];
const fmt = (x) => Number.isInteger(x) ? String(x) : x.toPrecision(10).replace(/\.?0+(e|$)/, "$1");
const key3 = (a, b, c) => [
	a,
	b,
	c
].sort((x, y) => x - y).join(",");
function calculixDeck(c, m) {
	const warnings = [];
	const groupsOfBodies = c.bodies?.length ? c.bodies.map((b) => b.group) : ["SOLID"];
	const vol = solidBlocks(m, c.bodies);
	if (!vol.length) throw new Error(`A malha não tem tetraedros nos grupos ${groupsOfBodies.join(", ")}`);
	const quad = vol[0].type === 11;
	const per = quad ? 10 : 4;
	const elems = [];
	const bodyRange = [];
	for (const g of groupsOfBodies) {
		const first = elems.length + 1;
		for (const b of physicalBlocks(m, g).filter((x) => x.type === 4 || x.type === 11)) for (let k = 0; k < b.conn.length; k += per) {
			const e = b.conn.slice(k, k + per);
			elems.push(quad ? TET10_ORDER$1.map((i) => e[i]) : e);
		}
		if (elems.length < first) throw new Error(`O corpo ${g} não tem elementos na malha`);
		bodyRange.push([first, elems.length]);
	}
	const faceOf = /* @__PURE__ */ new Map();
	elems.forEach((e, i) => TET_FACES.forEach((f, j) => faceOf.set(key3(e[f[0]], e[f[1]], e[f[2]]), [i + 1, j + 1])));
	const used = /* @__PURE__ */ new Set();
	for (const e of elems) for (const n of e) used.add(n);
	const tri = (name) => {
		const bl = physicalBlocks(m, name).filter((b) => b.type === 2 || b.type === 9);
		const out = [];
		for (const b of bl) {
			const p = b.type === 9 ? 6 : 3;
			for (let k = 0; k < b.conn.length; k += p) {
				const n = b.conn.slice(k, k + p);
				const [A, B, C] = n.slice(0, 3).map((t) => m.nodes.get(t));
				const u = [
					B[0] - A[0],
					B[1] - A[1],
					B[2] - A[2]
				], v = [
					C[0] - A[0],
					C[1] - A[1],
					C[2] - A[2]
				];
				const area = .5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
				out.push({
					n,
					area,
					face: faceOf.get(key3(n[0], n[1], n[2]))
				});
			}
		}
		return out;
	};
	const groupArea = {};
	const tris = {};
	for (const name of Object.keys(c.groups)) {
		tris[name] = tri(name);
		groupArea[name] = tris[name].reduce((s, t) => s + t.area, 0);
		if (!tris[name].length) warnings.push(`O grupo ${name} não tem triângulos na malha`);
		if (tris[name].some((t) => !t.face)) warnings.push(`Grupo ${name}: triângulos sem face de elemento correspondente`);
	}
	const L = [];
	const thermal = c.analysis === "thermal";
	L.push("*HEADING", `${c.title} — gerado pelo CAD protótipo`);
	for (const h of c.hypotheses) L.push(`** ${h}`);
	L.push("** Unidades: mm, N, MPa, t, s");
	L.push("*NODE, NSET=NALL");
	for (const [t, p] of [...m.nodes].sort((a, b) => a[0] - b[0])) if (used.has(t)) L.push(`${t}, ${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])}`);
	L.push(`*ELEMENT, TYPE=${quad ? "C3D10" : "C3D4"}, ELSET=EALL`);
	elems.forEach((e, i) => {
		L.push(`${i + 1}, ${e.join(", ")}`);
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
	for (const t of c.ties ?? []) {
		const master = tris[t.master].filter((x) => x.face);
		if (!tris[t.slave]?.length || !master.length) {
			warnings.push(`Contacto ${t.name}: faces sem malha`);
			continue;
		}
		L.push(`*SURFACE, NAME=S_${t.slave}, TYPE=NODE`, `N_${t.slave}`);
		L.push(`*SURFACE, NAME=S_${t.master}, TYPE=ELEMENT`, ...master.map((x) => `${x.face[0]}, S${x.face[1]}`));
		L.push(`*TIE, NAME=${t.name}, POSITION TOLERANCE=${fmt(t.tolerance)}`, `S_${t.slave}, S_${t.master}`);
	}
	if (thermal) L.push("*INITIAL CONDITIONS, TYPE=TEMPERATURE", "NALL, 20.");
	const bcs = [], loads = [];
	const cload = /* @__PURE__ */ new Map();
	for (const ld of c.loads) switch (ld.kind) {
		case "fixed":
			bcs.push(`N_${ld.group}, 1, 3`);
			break;
		case "displacement":
			ld.u.forEach((u, k) => {
				if (u !== null) bcs.push(`N_${ld.group}, ${k + 1}, ${k + 1}, ${fmt(u)}`);
			});
			break;
		case "temperature":
			bcs.push(`N_${ld.group}, 11, 11, ${fmt(ld.t)}`);
			break;
		case "force": {
			const A = groupArea[ld.group];
			if (!(A > 0)) {
				warnings.push(`Força no grupo ${ld.group} sem área`);
				break;
			}
			for (const t of tris[ld.group]) {
				const nodes = t.n.length === 6 ? t.n.slice(3) : t.n;
				for (const n of nodes) {
					const acc = cload.get(n) ?? [
						0,
						0,
						0
					];
					for (let k = 0; k < 3; k++) acc[k] += ld.f[k] * t.area / (3 * A);
					cload.set(n, acc);
				}
			}
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
			const [A, B, C] = t.n.slice(0, 3).map((x) => m.nodes.get(x));
			const u = [
				B[0] - A[0],
				B[1] - A[1],
				B[2] - A[2]
			], v = [
				C[0] - A[0],
				C[1] - A[1],
				C[2] - A[2]
			];
			const nrm = [
				u[1] * v[2] - u[2] * v[1],
				u[2] * v[0] - u[0] * v[2],
				u[0] * v[1] - u[1] * v[0]
			];
			const e = elems[t.face[0] - 1].slice(0, 4).map((x) => m.nodes.get(x));
			const ce = [
				0,
				1,
				2
			].map((q) => (e[0][q] + e[1][q] + e[2][q] + e[3][q]) / 4);
			const sgn = Math.sign(nrm[0] * (A[0] - ce[0]) + nrm[1] * (A[1] - ce[1]) + nrm[2] * (A[2] - ce[2])) || 1;
			const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
			const nodes = t.n.length === 6 ? t.n.slice(3) : t.n;
			for (const nd of nodes) for (let k = 0; k < 3; k++) if (dofNodes[k].has(nd)) supportLoad[k] += -ld.p * sgn * nrm[k] / len * (t.area / 3);
		}
	}
	if (cload.size) {
		loads.push("*CLOAD");
		for (const [n, f] of cload) f.forEach((x, k) => {
			if (Math.abs(x) > 0) loads.push(`${n}, ${k + 1}, ${fmt(x)}`);
		});
	}
	const nl = c.analysis === "static" ? c.nonlinear : void 0;
	if (nl) {
		const inc = 1 / nl.increments;
		L.push(`*STEP${nl.geometry ? ", NLGEOM" : ""}, INC=${Math.max(100, 20 * nl.increments)}`, "*STATIC", `${fmt(inc)}, 1., ${fmt(inc * 1e-4)}, ${fmt(inc)}`);
	} else if (c.analysis === "static") L.push("*STEP", "*STATIC");
	else if (c.analysis === "modal") L.push("*STEP", "*FREQUENCY", String(c.modes));
	else if (c.analysis === "buckling") L.push("*STEP", "*BUCKLE", String(c.modes));
	else L.push("*STEP", "*HEAT TRANSFER, STEADY STATE");
	if (bcs.length) L.push("*BOUNDARY", ...bcs);
	if (c.analysis !== "modal") L.push(...loads);
	if (thermal) L.push("*NODE FILE", "NT");
	else {
		L.push("*NODE FILE", "U");
		if (c.analysis === "static") L.push("*EL FILE", nl?.plasticity ? "S, PEEQ" : "S");
		if (c.analysis === "static") dofSets.forEach((sets, k) => {
			if (sets.length) L.push(`*NODE PRINT, NSET=N_R${"XYZ"[k]}, TOTALS=ONLY`, "RF");
		});
	}
	L.push("*END STEP");
	if (c.analysis === "static" && !c.loads.some((l) => l.kind === "fixed" || l.kind === "displacement")) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
	return {
		inp: L.join("\n") + "\n",
		nodes: used.size,
		elements: elems.length,
		groupArea,
		supportLoad,
		warnings
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
	return {
		frequencies,
		buckling,
		reactions: reactionHistory.length ? [reactionHistory.at(-1).f] : [],
		reactionHistory
	};
}
/** Junta a malha e os resultados num formato leve para o visualizador e para o relatório. */
function femResult(c, m, frd, dat, supportLoad = [
	0,
	0,
	0
]) {
	const d = parseDat(dat);
	for (const h of d.reactionHistory) for (let k = 0; k < 3; k++) h.f[k] -= supportLoad[k] * h.time;
	if (d.reactionHistory.length) d.reactions = [d.reactionHistory.at(-1).f];
	return femResultFrom(c, m, parseFrd(frd).blocks, d);
}
/**
* Resultado a partir de blocos nodais (DISP, STRESS ou VMIS, PE, NDTEMP — o formato do `.frd`) e dos
* valores do solver (frequências, fatores, reações): comum ao CalculiX e ao code_aster.
*/
function femResultFrom(c, m, blocks, d) {
	const r = { blocks };
	const vol = solidBlocks(m, c.bodies);
	const count = /* @__PURE__ */ new Map();
	for (const b of vol) {
		const per = b.type === 11 ? 10 : 4;
		for (let k = 0; k < b.conn.length; k += per) {
			const e = b.conn.slice(k, k + 4);
			for (const f of TET_FACES) {
				const tri = [
					e[f[0]],
					e[f[2]],
					e[f[1]]
				];
				const key = key3(tri[0], tri[1], tri[2]);
				const x = count.get(key);
				if (x) x.k++;
				else count.set(key, {
					n: tri,
					k: 1
				});
			}
		}
	}
	const index = /* @__PURE__ */ new Map();
	const positions = [], triangles = [];
	for (const { n, k } of count.values()) {
		if (k !== 1) continue;
		for (const t of n) {
			if (!index.has(t)) {
				index.set(t, index.size);
				positions.push(...m.nodes.get(t));
			}
			triangles.push(index.get(t));
		}
	}
	const order = [...index.keys()];
	const field = (b, f) => order.map((t) => {
		const v = b?.data.get(t);
		return v ? f(v) : 0;
	});
	const fields = [];
	const displacements = [];
	const allDisp = r.blocks.filter((b) => b.name === "DISP");
	const incremental = c.analysis === "static";
	const disp = incremental ? allDisp.slice(-1) : allDisp;
	const lastOf = (name) => r.blocks.filter((b) => b.name === name).at(-1);
	const summary = [];
	const metrics = [];
	const max = (a) => a.reduce((x, y) => Math.max(x, y), 0);
	if (c.analysis === "thermal") {
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
	const history = c.nonlinear && incremental ? allDisp.map((b) => ({
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
		summary.push(["Reações totais (N)", R.map((x) => x.toFixed(2)).join(" · ")]);
	}
	return {
		analysis: c.analysis,
		positions,
		triangles,
		fields,
		displacements,
		frequencies: d.frequencies,
		buckling: d.buckling,
		reactions: d.reactions,
		summary,
		metrics,
		history,
		hypotheses: c.hypotheses
	};
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
			"MARKER_OUTLET= ( outlet, 0.0 )"
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
		"HISTORY_OUTPUT= ( ITER, RMS_RES, AERO_COEFF )",
		""
	].join("\n");
}
// src/sim/aster.ts
/** Gmsh → ASTER/Abaqus: tetraedro de 10 nós com as arestas 2-4 e 3-4 trocadas (como no CalculiX). */
const TET10_ORDER = [
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
];
const num = (x) => Number.isInteger(x) ? `${x}.` : x.toPrecision(12).replace(/\.?0+(e|$)/, "$1");
/** Malha ASTER: COOR_3D, elementos de volume e de face, GROUP_MA e GROUP_NO com os nomes dos grupos. */
function asterMesh(c, m) {
	const vol = physicalBlocks(m, "SOLID").filter((b) => b.type === 4 || b.type === 11);
	if (!vol.length) throw new Error("A malha não tem tetraedros no grupo SOLID");
	const quad = vol[0].type === 11;
	const L = [
		"TITRE",
		` ${c.title.replace(/[^\x20-\x7e]/g, "_").slice(0, 70)}`,
		"FINSF",
		"%"
	];
	const used = /* @__PURE__ */ new Set();
	const cells = [];
	for (const b of vol) for (let k = 0; k < b.conn.length; k += quad ? 10 : 4) {
		const e = b.conn.slice(k, k + (quad ? 10 : 4));
		const n = quad ? TET10_ORDER.map((i) => e[i]) : e;
		n.forEach((x) => used.add(x));
		cells.push({
			name: `M${cells.length + 1}`,
			nodes: n
		});
	}
	const nodeOrder = [...used].sort((a, b) => a - b);
	L.push("COOR_3D");
	for (const t of nodeOrder) L.push(`N${t} ${m.nodes.get(t).map(num).join(" ")}`);
	L.push("FINSF", "%", quad ? "TETRA10" : "TETRA4");
	for (const e of cells) L.push(`${e.name} ${e.nodes.map((x) => `N${x}`).join(" ")}`);
	L.push("FINSF", "%");
	const faceGroups = {};
	const nodeGroups = {};
	const areas = {};
	const faces = [];
	for (const name of Object.keys(c.groups)) {
		const bl = physicalBlocks(m, name).filter((b) => b.type === 2 || b.type === 9);
		faceGroups[name] = [];
		const ns = /* @__PURE__ */ new Set();
		let A = 0;
		for (const b of bl) {
			const per = b.type === 9 ? 6 : 3;
			for (let k = 0; k < b.conn.length; k += per) {
				const n = b.conn.slice(k, k + per);
				n.forEach((x) => ns.add(x));
				const [P, Q, R] = n.slice(0, 3).map((x) => m.nodes.get(x));
				const u = [
					Q[0] - P[0],
					Q[1] - P[1],
					Q[2] - P[2]
				], v = [
					R[0] - P[0],
					R[1] - P[1],
					R[2] - P[2]
				];
				A += .5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
				const id = `F${faces.length + 1}`;
				faces.push(`${id} ${n.map((x) => `N${x}`).join(" ")}`);
				faceGroups[name].push(id);
			}
		}
		nodeGroups[name] = [...ns].sort((a, b) => a - b);
		areas[name] = A;
	}
	if (faces.length) L.push(quad ? "TRIA6" : "TRIA3", ...faces, "FINSF", "%");
	const block = (kw, name, ids) => {
		L.push(kw, name);
		for (let k = 0; k < ids.length; k += 10) L.push(ids.slice(k, k + 10).join(" "));
		L.push("FINSF", "%");
	};
	block("GROUP_MA", "SOLID", cells.map((e) => e.name));
	for (const [g, ids] of Object.entries(faceGroups)) if (ids.length) block("GROUP_MA", g, ids);
	for (const [g, ns] of Object.entries(nodeGroups)) if (ns.length) block("GROUP_NO", g, ns.map((x) => `N${x}`));
	L.push("FIN");
	return {
		mail: L.join("\n") + "\n",
		nodeOrder,
		areas
	};
}
/** Ficheiro de comandos (.comm, sintaxe Python do code_aster) e .export para o run_aster. */
function asterCase(c, m) {
	if (c.bodies?.length) throw new Error("code_aster: os estudos de montagem (vários corpos, contacto colado) ainda só correm no CalculiX");
	if (c.analysis !== "static" && c.analysis !== "modal") throw new Error(`code_aster: análise "${c.analysis}" ainda não suportada neste adaptador (use o CalculiX)`);
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
	C.push("MO = AFFE_MODELE(MAILLAGE=MA, AFFE=_F(TOUT='OUI', PHENOMENE='MECANIQUE', MODELISATION='3D'))");
	const plast = nl?.plasticity ? `, ECRO_LINE=_F(D_SIGM_EPSI=${num(mat.tangent ?? 0)}, SY=${num(mat.yield)})` : "";
	C.push(`MAT = DEFI_MATERIAU(ELAS=_F(E=${num(mat.E)}, NU=${num(mat.nu)}, RHO=${num(mat.density * 1e-9)})${plast})`, "CM = AFFE_MATERIAU(MAILLAGE=MA, AFFE=_F(TOUT='OUI', MATER=MAT))");
	const ddl = [], force = [], pres = [];
	let grav = "";
	for (const ld of c.loads) switch (ld.kind) {
		case "fixed":
			ddl.push(`_F(GROUP_NO='${ld.group}', DX=0., DY=0., DZ=0.)`);
			break;
		case "displacement": {
			const comps = ld.u.map((u, k) => u === null ? "" : `D${"XYZ"[k]}=${num(u)}`).filter(Boolean);
			if (comps.length) ddl.push(`_F(GROUP_NO='${ld.group}', ${comps.join(", ")})`);
			break;
		}
		case "force": {
			const A = areas[ld.group];
			if (!(A > 0)) {
				warnings.push(`Força no grupo ${ld.group} sem área`);
				break;
			}
			force.push(`_F(GROUP_MA='${ld.group}', FX=${num(ld.f[0] / A)}, FY=${num(ld.f[1] / A)}, FZ=${num(ld.f[2] / A)})`);
			break;
		}
		case "pressure":
			pres.push(`_F(GROUP_MA='${ld.group}', PRES=${num(ld.p)})`);
			break;
		case "gravity": {
			const g = Math.hypot(...ld.g);
			if (g > 0) grav = `PESANTEUR=_F(GRAVITE=${num(g)}, DIRECTION=(${ld.g.map((x) => num(x / g)).join(", ")}))`;
			break;
		}
		default: warnings.push(`code_aster: condição "${ld.kind}" ignorada (térmica)`);
	}
	if (!ddl.length) warnings.push("Sem apoios: o modelo pode ter movimento de corpo rígido");
	C.push(`BC = AFFE_CHAR_MECA(MODELE=MO, DDL_IMPO=(${ddl.join(", ")},))`);
	const chParts = [
		force.length && `FORCE_FACE=(${force.join(", ")},)`,
		pres.length && `PRES_REP=(${pres.join(", ")},)`,
		grav
	].filter(Boolean);
	const hasCh = chParts.length > 0 && c.analysis === "static";
	if (hasCh) C.push(`CH = AFFE_CHAR_MECA(MODELE=MO, ${chParts.join(", ")})`);
	const supports = c.loads.flatMap((ld) => ld.kind === "fixed" || ld.kind === "displacement" ? [`'${ld.group}'`] : []);
	if (c.analysis === "modal") C.push("ASSEMBLAGE(MODELE=MO, CHAM_MATER=CM, CHARGE=BC, NUME_DDL=CO('NU'), MATR_ASSE=(_F(MATRICE=CO('K'), OPTION='RIGI_MECA'), _F(MATRICE=CO('M'), OPTION='MASS_MECA')))", `RES = CALC_MODES(MATR_RIGI=K, MATR_MASS=M, OPTION='PLUS_PETITE', CALC_FREQ=_F(NMAX_FREQ=${c.modes}))`, "TF = RECU_TABLE(CO=RES, NOM_PARA=('FREQ',))", "IMPR_TABLE(TABLE=TF, UNITE=40, FORMAT='TABLEAU')");
	else if (!nl) C.push(`RES = MECA_STATIQUE(MODELE=MO, CHAM_MATER=CM, EXCIT=(_F(CHARGE=BC),${hasCh ? " _F(CHARGE=CH)," : ""}))`);
	else {
		const rel = nl.plasticity ? "VMIS_ISOT_LINE" : "ELAS";
		const def = nl.geometry ? nl.plasticity ? "GDEF_LOG" : "GROT_GDEP" : "PETIT";
		C.push("RAMPE = DEFI_FONCTION(NOM_PARA='INST', VALE=(0., 0., 1., 1.))", `LR = DEFI_LIST_REEL(DEBUT=0., INTERVALLE=_F(JUSQU_A=1., NOMBRE=${nl.increments}))`, "LINST = DEFI_LIST_INST(DEFI_LIST=_F(LIST_INST=LR), ECHEC=_F(EVENEMENT='ERREUR', ACTION='DECOUPE', SUBD_METHODE='MANUEL', SUBD_PAS=4, SUBD_NIVEAU=5))", `RES = STAT_NON_LINE(MODELE=MO, CHAM_MATER=CM, EXCIT=(_F(CHARGE=BC),${hasCh ? " _F(CHARGE=CH, FONC_MULT=RAMPE)," : ""}), COMPORTEMENT=_F(RELATION='${rel}', DEFORMATION='${def}', TOUT='OUI'), INCREMENT=_F(LIST_INST=LINST), NEWTON=_F(REAC_ITER=1), CONVERGENCE=_F(ITER_GLOB_MAXI=25))`);
	}
	if (c.analysis === "static") C.push(`RES = CALC_CHAMP(reuse=RES, RESULTAT=RES, CONTRAINTE=('SIGM_NOEU',), CRITERES=('SIEQ_NOEU',), FORCE=('REAC_NODA',)${nl?.plasticity ? ", VARI_INTERNE=('VARI_NOEU',)" : ""})`);
	C.push("TU = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='U', RESULTAT=RES, NOM_CHAM='DEPL', TOUT='OUI', NOM_CMP=('DX', 'DY', 'DZ'), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TU, UNITE=38, FORMAT='TABLEAU')");
	if (c.analysis === "static") {
		C.push("TS = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='VM', RESULTAT=RES, NOM_CHAM='SIEQ_NOEU', TOUT='OUI', NOM_CMP=('VMIS',), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TS, UNITE=39, FORMAT='TABLEAU')");
		if (supports.length) C.push(`TR = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='R', RESULTAT=RES, NOM_CHAM='REAC_NODA', GROUP_NO=(${supports.join(", ")},), RESULTANTE=('DX', 'DY', 'DZ'), TOUT_ORDRE='OUI'))`, "IMPR_TABLE(TABLE=TR, UNITE=41, FORMAT='TABLEAU')");
		if (nl?.plasticity) C.push("TP = POST_RELEVE_T(ACTION=_F(OPERATION='EXTRACTION', INTITULE='P', RESULTAT=RES, NOM_CHAM='VARI_NOEU', TOUT='OUI', NOM_CMP=('V1',), TOUT_ORDRE='OUI'))", "IMPR_TABLE(TABLE=TP, UNITE=42, FORMAT='TABLEAU')");
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
			let b = byOrder.get(ord);
			if (!b) {
				b = {
					name,
					value: c.analysis === "static" && c.nonlinear ? Number(row.INST ?? 1) : ord,
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
	})).filter((r) => r.f.every(Number.isFinite));
	const res = femResultFrom(c, m, blocks, {
		frequencies,
		buckling: [],
		reactions: reactionHistory.length ? [reactionHistory.at(-1).f] : [],
		reactionHistory
	});
	return {
		...res,
		hypotheses: [...res.hypotheses, "Calculado com o code_aster: adaptador ainda não verificado contra os casos analíticos nesta instalação"]
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
	const aster = process.env.CAD_ASTER ?? which("run_aster") ?? which("as_run");
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
		openfoam: foamDirect || foamRc ? {
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
		} : null
	};
}
function run(cmd, args, cwd, logFile, log, env) {
	return new Promise((ok, fail) => {
		log(`$ ${[cmd, ...args].join(" ")}`);
		const out = [];
		const p = spawn(cmd, args, {
			cwd,
			env: {
				...process.env,
				...env
			}
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
		for (const b of physicalBlocks(m, name)) {
			const per = b.type === 9 ? 6 : 3;
			for (let k = 0; k < b.conn.length; k += per) {
				const [P, Q, R] = b.conn.slice(k, k + 3).map((t) => m.nodes.get(t));
				const u = [
					Q[0] - P[0],
					Q[1] - P[1],
					Q[2] - P[2]
				], v = [
					R[0] - P[0],
					R[1] - P[1],
					R[2] - P[2]
				];
				const ar = .5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
				a += ar;
				for (let q = 0; q < 3; q++) got[q] += (P[q] + Q[q] + R[q]) / 3 * ar;
			}
		}
		if (!a) {
			out.push(`Grupo ${name}: sem triângulos na malha`);
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
	return out;
}
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
	const elements = solidBlocks(msh, c.bodies).reduce((n, b) => n + b.conn.length / (b.type === 11 ? 10 : 4), 0);
	return {
		ok: true,
		physics: "fem",
		solver: "code_aster",
		summary: [["Malha", `${ac.nodeOrder.length} nós · ${elements} tetraedros de ordem ${c.mesh.order}`], ...fem.summary],
		warnings: [...warnings, "Adaptador do code_aster ainda não verificado contra os casos analíticos: compare com o CalculiX"],
		fem,
		view: femView(fem),
		metrics: fem.metrics,
		cells: elements,
		log: tail(join(dir, "job.mess"))
	};
}
async function runFem(c, dir, log, regenerate) {
	if (c.solver === "code_aster") return runAster(c, dir, log, regenerate);
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
	const summary = [["Malha", `${deck.nodes} nós · ${deck.elements} tetraedros de ordem ${c.mesh.order}`], ...fem.summary];
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
			if (!/rms\[P\]|CD|CL/i.test(k)) return;
			summary.push([k, v[i].trim()]);
			if (/^C[DL]$/i.test(k)) metrics.push({
				key: k.toLowerCase(),
				label: k,
				unit: "",
				value: Number(v[i])
			});
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
				}))
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
/** Corre o caso de uma pasta (case.json + model.brep [+ STL]). `regenerate`: refaz os ficheiros dos solvers a partir do caso. */
async function runCase(dir, log = () => {}, regenerate = false, opts = {}) {
	const t0 = Date.now();
	const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
	if (c.format !== "cadp-sim-case") throw new Error("case.json inválido");
	let r;
	if (opts.convergence) {
		const ratio = opts.convergence.ratio;
		if (!(ratio >= 1.1 && ratio <= 3)) throw new Error("Razão de refinamento fora de [1,1; 3]");
		const runs = [];
		for (const lvl of [
			2,
			1,
			0
		]) {
			const sub = join(dir, `malha${lvl + 1}`);
			mkdirSync(sub, { recursive: true });
			const ck = coarsened(c, ratio ** lvl);
			writeFileSync(join(sub, "case.json"), JSON.stringify(ck));
			writeFileSync(join(sub, "model.brep"), readFileSync(join(dir, "model.brep")));
			if (existsSync(join(dir, "constant/triSurface"))) {
				mkdirSync(join(sub, "constant/triSurface"), { recursive: true });
				for (const fn of readdirSync(join(dir, "constant/triSurface"))) if (fn.endsWith(".stl")) writeFileSync(join(sub, "constant/triSurface", fn), readFileSync(join(dir, "constant/triSurface", fn)));
			}
			log(`— malha ${lvl + 1} de 3 (tamanho ${ck.mesh.size.toPrecision(3)} mm)`);
			runs[lvl] = await runOnce(ck, sub, log, true);
		}
		const report = convergenceReport(ratio, runs.map((x, i) => ({
			cells: x.cells,
			size: c.mesh.size * ratio ** i,
			metrics: x.metrics
		})));
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
		if (req.method !== "POST" || req.url !== "/run") {
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
			send(200, await runCase(dir, (s) => console.log(s), true, { convergence: body.convergence && Number.isFinite(Number(body.convergence.ratio)) ? { ratio: Number(body.convergence.ratio) } : void 0 }));
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
export { coarsened, runCase, serve, tools };
