// Scripts de automação em lote (simulações automáticas): corre um script `cad.*` sobre uma peça de um
// projeto, com o núcleo em Node e os solvers instalados (como o agente local), e grava os resultados.
//
//   node --experimental-strip-types tools/cad-script.ts projeto.cadp.json script.js
//        [--part "Nome da peça"] [--out resultados.json] [--csv tabela.csv] [--save projeto-novo.cadp.json]
//
// O script vê a API descrita em src/script/api.ts (API_DOC). Útil para varrimentos paramétricos,
// estudos de convergência e verificações repetidas (CI, tarefas agendadas).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { initSolver } from "../src/sketch/solver.ts";
import { KernelService } from "../src/kernel/service.ts";
import { type CadProject, type PartDoc, DEFAULT_DENSITY, parseProject, serializeProject } from "../src/doc/project.ts";
import type { CadDocument } from "../src/doc/types.ts";
import { type ScriptHost, runScript, tableCSV } from "../src/script/api.ts";
import { polarForScript, rebuildSummary, simulationSummary } from "../src/script/summary.ts";
import { runCase, runXfoil } from "./cad-runner.ts";

/** Anfitrião de Node: reconstrói com o núcleo e simula com os solvers locais (pastas temporárias). */
export function nodeHost(project: CadProject, partId: string, log: (s: string) => void = () => {}): ScriptHost {
  const svc = new KernelService();
  const others = () => project.parts.filter((p) => p.id !== partId);
  const asPart = (doc: CadDocument) => ({ ...(project.parts.find((p) => p.id === partId) as PartDoc), ...doc, id: partId }) as PartDoc;
  return {
    async rebuild(doc) {
      const d = asPart(doc);
      return rebuildSummary(await svc.rebuild(d, false, others()), d.properties?.density ?? DEFAULT_DENSITY);
    },
    async simulate(doc, studyId, opts) {
      const r = await svc.studyCase(asPart(doc), others(), studyId);
      const dir = mkdtempSync(join(tmpdir(), "cad-script-"));
      for (const [p, text] of Object.entries(r.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); }
      return simulationSummary(await runCase(dir, log, false, opts));
    },
    async xfoil(req) {
      return polarForScript(await runXfoil(req, log));
    },
  };
}

export async function initNodeKernel() {
  setOC(await (opencascade as unknown as () => Promise<never>)());
  await initSolver();
}

const isMain = process.argv[1] && /cad-script\.(m?js|ts)$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args.length < 2) {
    console.log("Uso: cad-script projeto.cadp.json script.js [--part Nome] [--out resultados.json] [--csv tabela.csv] [--save projeto-novo.cadp.json]");
    process.exit(1);
  }
  const project = parseProject(readFileSync(resolve(args[0]), "utf8"));
  const name = opt("--part");
  const part = name ? project.parts.find((p) => p.name === name || p.id === name) : project.parts[0];
  if (!part) { console.error(`Peça não encontrada: ${name}`); process.exit(1); }
  await initNodeKernel();
  const out = await runScript(readFileSync(resolve(args[1]), "utf8"), part, nodeHost(project, part.id, (s) => console.error(s)));
  for (const l of out.logs) console.log(l);
  for (const t of out.tables) console.log(`\n# ${t.name}\n${tableCSV(t.rows).slice(1)}`);
  if (out.error) console.error(`Erro: ${out.error}`);
  else if (out.value !== undefined) console.log(`\n→ ${JSON.stringify(out.value)}`);
  if (opt("--out")) writeFileSync(resolve(opt("--out")!), JSON.stringify({ ...out, doc: undefined }, null, 1));
  if (opt("--csv") && out.tables[0]) writeFileSync(resolve(opt("--csv")!), tableCSV(out.tables[0].rows));
  if (opt("--save") && out.changed) writeFileSync(resolve(opt("--save")!), serializeProject({ ...project, parts: project.parts.map((p) => (p.id === part.id ? { ...p, ...out.doc } : p)) }));
  process.exit(out.ok ? 0 : 1);
}
