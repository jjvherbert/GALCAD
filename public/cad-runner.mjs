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
		`Merge "model.brep";`,
		`Physical Volume("SOLID") = Volume{:};`
	];
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
const fmt = (x) => Number.isInteger(x) ? String(x) : x.toPrecision(10).replace(/\.?0+(e|$)/, "$1");
const key3 = (a, b, c) => [
	a,
	b,
	c
].sort((x, y) => x - y).join(",");
function calculixDeck(c, m) {
	const warnings = [];
	const vol = physicalBlocks(m, "SOLID").filter((b) => b.type === 4 || b.type === 11);
	if (!vol.length) throw new Error("A malha não tem tetraedros no grupo SOLID");
	const quad = vol[0].type === 11;
	const per = quad ? 10 : 4;
	const elems = [];
	for (const b of vol) for (let k = 0; k < b.conn.length; k += per) {
		const e = b.conn.slice(k, k + per);
		elems.push(quad ? TET10_ORDER.map((i) => e[i]) : e);
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
	const mat = c.material;
	L.push("*MATERIAL, NAME=MAT", `** ${mat.name}${mat.source ? ` (${mat.source})` : ""}`);
	if (thermal) L.push("*CONDUCTIVITY", fmt(mat.k ?? 50));
	else {
		L.push("*ELASTIC", `${fmt(mat.E)}, ${fmt(mat.nu)}`, "*DENSITY", fmt(mat.density * 1e-9));
		if (mat.alpha) L.push("*EXPANSION", fmt(mat.alpha));
	}
	L.push("*SOLID SECTION, ELSET=EALL, MATERIAL=MAT");
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
	if (cload.size) {
		loads.push("*CLOAD");
		for (const [n, f] of cload) f.forEach((x, k) => {
			if (Math.abs(x) > 0) loads.push(`${n}, ${k + 1}, ${fmt(x)}`);
		});
	}
	L.push("*STEP");
	if (c.analysis === "static") L.push("*STATIC");
	else if (c.analysis === "modal") L.push("*FREQUENCY", String(c.modes));
	else if (c.analysis === "buckling") L.push("*BUCKLE", String(c.modes));
	else L.push("*HEAT TRANSFER, STEADY STATE");
	if (bcs.length) L.push("*BOUNDARY", ...bcs);
	if (c.analysis !== "modal") L.push(...loads);
	if (thermal) L.push("*NODE FILE", "NT");
	else {
		L.push("*NODE FILE", "U");
		if (c.analysis === "static") L.push("*EL FILE", "S");
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
/** Valores próprios do `.dat`: frequências (Hz) ou fatores de encurvadura; e reações totais. */
function parseDat(text) {
	const lines = text.split(/\r?\n/);
	const frequencies = [], buckling = [], reactions = [];
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
			if (v && v.length >= 3 && v.every(Number.isFinite)) reactions.push([
				v[0],
				v[1],
				v[2]
			]);
		}
	}
	return {
		frequencies,
		buckling,
		reactions
	};
}
/** Junta a malha e os resultados num formato leve para o visualizador e para o relatório. */
function femResult(c, m, frd, dat) {
	const r = parseFrd(frd);
	const d = parseDat(dat);
	const vol = physicalBlocks(m, "SOLID").filter((b) => b.type === 4 || b.type === 11);
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
	const disp = r.blocks.filter((b) => b.name === "DISP");
	const summary = [];
	const max = (a) => a.reduce((x, y) => Math.max(x, y), 0);
	if (c.analysis === "thermal") {
		const T = field(r.blocks.find((b) => b.name === "NDTEMP"), (v) => v[0]);
		fields.push({
			name: "Temperatura",
			unit: "°C",
			values: T
		});
		summary.push(["Temperatura mín.", `${Math.min(...T).toFixed(2)} °C`], ["Temperatura máx.", `${Math.max(...T).toFixed(2)} °C`]);
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
			const s = r.blocks.find((b) => b.name === "STRESS");
			if (s) {
				const vm = field(s, (v) => Math.sqrt(.5 * ((v[0] - v[1]) ** 2 + (v[1] - v[2]) ** 2 + (v[2] - v[0]) ** 2) + 3 * (v[3] ** 2 + v[4] ** 2 + v[5] ** 2)));
				fields.push({
					name: "Tensão de von Mises",
					unit: "MPa",
					values: vm
				});
				summary.push(["Tensão de von Mises máx.", `${max(vm).toFixed(2)} MPa`]);
				if (c.material.yield) summary.push(["Fator de segurança mín. (cedência)", (c.material.yield / Math.max(max(vm), 1e-12)).toFixed(2)]);
			}
			summary.unshift(["Deslocamento máx.", `${max(U).toFixed(4)} mm`]);
		}
		if (c.analysis === "modal") d.frequencies.slice(0, c.modes).forEach((f, k) => summary.push([`Frequência ${k + 1}`, `${f.toFixed(2)} Hz`]));
		if (c.analysis === "buckling") d.buckling.forEach((f, k) => summary.push([`Fator de encurvadura ${k + 1}`, f.toFixed(3)]));
	}
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
	return out;
}
async function runFem(c, dir, log, regenerate) {
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
	const fem = femResult(c, msh, readFileSync(join(dir, "job.frd"), "utf8"), existsSync(join(dir, "job.dat")) ? readFileSync(join(dir, "job.dat"), "utf8") : "");
	const summary = [["Malha", `${deck.nodes} nós · ${deck.elements} tetraedros de ordem ${c.mesh.order}`], ...fem.summary];
	return {
		ok: true,
		physics: "fem",
		solver: `CalculiX ${t.calculix.version ?? ""}`.trim(),
		summary,
		warnings,
		fem,
		log: tail(join(dir, "log.ccx"))
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
	const summary = [
		["Malha", `${/cells:\s+(\d+)/.exec(tail(join(dir, "log.checkMesh"), 400))?.[1] ?? "?"} células (snappyHexMesh)`],
		["Iterações", conv ? `${conv[1]} (convergido)` : `${iters} (sem atingir os resíduos pedidos)`],
		["Re", c.reynolds.toExponential(2)]
	];
	if (!conv) warnings.push("O simpleFoam não convergiu para os resíduos pedidos: aumente as iterações ou reveja a malha");
	const last = readdirSync(dir).filter((d) => /^\d+(\.\d+)?$/.test(d) && d !== "0").sort((a, b) => Number(a) - Number(b)).at(-1);
	if (last) {
		const pm = join(dir, "constant/polyMesh");
		const mesh = {
			points: readPoints(readFileSync(join(pm, "points"), "utf8")),
			faces: readFaces(readFileSync(join(pm, "faces"), "utf8")),
			owner: readLabels(readFileSync(join(pm, "owner"), "utf8")),
			boundary: readBoundary(readFileSync(join(pm, "boundary"), "utf8"))
		};
		const phi = existsSync(join(dir, last, "phi")) ? readScalarField(readFileSync(join(dir, last, "phi"), "utf8")) : null;
		const p = readScalarField(readFileSync(join(dir, last, "p"), "utf8"));
		if (phi && mesh.boundary.has("inlet") && mesh.boundary.has("outlet")) {
			const Qi = -patchFlux(phi, mesh, "inlet"), Qo = patchFlux(phi, mesh, "outlet");
			summary.push(["Caudal de entrada", `${(Qi * 1e3).toPrecision(5)} L/s`], ["Balanço de massa", `${(100 * (Qo - Qi) / Math.max(Math.abs(Qi), 1e-30)).toFixed(3)} %`]);
		}
		if (c.regime === "internal" && mesh.boundary.has("inlet") && mesh.boundary.has("outlet")) summary.push(["Queda de pressão", `${((patchAverage(p, mesh, "inlet") - patchAverage(p, mesh, "outlet")) * c.fluid.rho).toPrecision(5)} Pa`]);
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
			summary.push(["Força de pressão no corpo (N)", F.map((x) => x.toPrecision(4)).join(" · ")], ["Arrasto de pressão", `${drag.toPrecision(4)} N (Cd ≈ ${(drag / (.5 * c.fluid.rho * U * U * Aref)).toFixed(3)}, área ${(Aref * 1e6).toFixed(0)} mm²)`]);
			warnings.push("Força calculada só com a pressão: falta a parcela viscosa (use o function object forces/wallShearStress do OpenFOAM)");
		}
	}
	return {
		ok: true,
		physics: "cfd",
		solver: "OpenFOAM simpleFoam",
		summary,
		warnings,
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
	if (hist.length > 1) {
		const h = hist[0].split(",").map((x) => x.replace(/"/g, "").trim()), v = hist.at(-1).split(",");
		h.forEach((k, i) => {
			if (/rms\[P\]|CD|CL/i.test(k)) summary.push([k, v[i].trim()]);
		});
	}
	return {
		ok: true,
		physics: "cfd",
		solver: "SU2",
		summary,
		warnings: [],
		log: tail(join(dir, "log.su2"))
	};
}
const tail = (p, n = 25) => existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/).slice(-n).join("\n") : "";
/** Corre o caso de uma pasta (case.json + model.brep [+ STL]). `regenerate`: refaz os ficheiros dos solvers a partir do caso. */
async function runCase(dir, log = () => {}, regenerate = false) {
	const t0 = Date.now();
	const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
	if (c.format !== "cadp-sim-case") throw new Error("case.json inválido");
	const r = c.physics === "fem" ? await runFem(c, dir, log, regenerate) : c.solver === "openfoam" ? await runOpenfoam(c, dir, log, regenerate) : await runSu2(c, dir, log, regenerate);
	const res = {
		...r,
		summary: [...r.summary],
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
			send(200, await runCase(dir, (s) => console.log(s), true));
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
	} else if (args[0]) runCase(resolve(args[0]), (s) => console.log(s), args.includes("--regenerate")).then((r) => {
		for (const [k, v] of r.summary) console.log(`${k}: ${v}`);
		for (const w of r.warnings) console.log(`Aviso: ${w}`);
	}).catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
	else console.log("Uso: node cad-runner.mjs <pasta-do-caso> | --serve [--port 8765] | --status");
}
export { runCase, serve, tools };
