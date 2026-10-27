// Copiloto de scripts e de interpretação de resultados com o Claude (opcional). Como no assistente
// de BOM: corre no browser com a chave API que o utilizador escreve (só em memória, nunca guardada),
// o pedido vai diretamente para a API da Anthropic e envia-se só um resumo do modelo (variáveis,
// features, estudos, medidas) — nunca a geometria completa. A resposta é JSON validado; o código
// gerado aparece no editor para a pessoa ler e decidir correr (nunca corre sozinho).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { CadDocument } from "../doc/types.ts";
import { API_DOC } from "../script/api.ts";
import { CLAUDE_MODEL } from "./claude.ts";

/** Resumo do documento para o copiloto: o que o script pode ler e alterar, sem a geometria. */
export function scriptContext(doc: CadDocument, values: Record<string, number> = {}, measures: Record<string, number> = {}) {
  return {
    name: doc.name,
    variables: doc.variables.map((v) => ({ name: v.name, expr: v.expr, value: values[v.name] ?? null, comment: v.comment ?? null })),
    features: doc.features.map((f) => {
      const { id, type, name } = f;
      // parâmetros simples (números/expressões) que um script costuma mudar
      const params = Object.fromEntries(Object.entries(f).filter(([k, v]) => !["id", "type", "name", "entities", "constraints"].includes(k) && (typeof v !== "object" || (v !== null && JSON.stringify(v).length < 200))));
      return { id, type, name, params };
    }),
    studies: (doc.studies ?? []).map((s) => s.physics === "fem"
      ? { id: s.id, name: s.name, physics: s.physics, analysis: s.analysis, material: s.material.name, loads: s.loads.map((l) => l.kind), probes: (s.probes ?? []).map((p, i) => ({ key: `probe${i + 1}`, name: p.name, quantity: p.quantity })) }
      : { id: s.id, name: s.name, physics: s.physics, solver: s.solver, regime: s.regime }),
    measures,
    checks: (doc.checks ?? []).map((c) => ({ name: c.name, expr: c.expr })),
  };
}

const ScriptSchema = z.object({
  explanation: z.string().describe("O que o script faz, em 2–5 frases"),
  code: z.string().describe("Corpo do script (JavaScript, pode usar await e return); só a API cad.*"),
  assumptions: z.array(z.string()).describe("Hipóteses assumidas (nomes de variáveis, estudos, unidades)"),
  warnings: z.array(z.string()).describe("Riscos: tempo de cálculo, número de simulações, limites de validade"),
});
export type CopilotScript = z.infer<typeof ScriptSchema>;

const InterpretSchema = z.object({
  summary: z.string().describe("Leitura dos resultados em linguagem de engenharia, 3–8 frases"),
  findings: z.array(z.string()).describe("Observações concretas com números"),
  caveats: z.array(z.string()).describe("Limites: hipóteses do modelo, malha, convergência, o que falta verificar"),
  next: z.array(z.string()).describe("Próximos passos sugeridos (verificações, mais pontos, estudos)"),
});
export type CopilotInterpretation = z.infer<typeof InterpretSchema>;

const SYSTEM_SCRIPT = `És o copiloto de scripts de uma aplicação CAD paramétrica com FEM/CFD integrado.
Escreves scripts JavaScript (async, com await e return) que só usam esta API:

${API_DOC}

Regras:
- Usa só nomes de variáveis, features, estudos e sondas que existem no contexto; se faltar algo, diz nas hipóteses em vez de inventar.
- Unidades: mm, N, MPa, kg (massa em g/cm³ × volume); temperaturas em °C.
- Cada cad.simulate() corre um solver real (segundos a minutos): mantém o número de simulações razoável e indica-o nos avisos.
- Guarda os resultados numa lista de linhas e mostra-os com cad.table(); devolve no fim um resumo (return).
- Nunca afirmes conformidade, certificação ou aprovação: os scripts produzem apoio à decisão de engenharia.
- Código claro, comentado em português europeu, sem dependências externas.`;

const SYSTEM_INTERPRET = `És um engenheiro que lê resultados de estudos paramétricos e de simulação (FEM/CFD) de uma aplicação CAD.
Recebes o contexto do modelo, o script corrido e as tabelas/resultados. Responde em português europeu, com números concretos e prudência:
- distingue tendências robustas de efeitos que podem ser da malha ou da convergência;
- assinala singularidades (máximos de tensão em cantos vivos e apoios), poucas amostras e extrapolação fora da gama;
- nunca apresentes o resultado como certificação ou decisão de autoridade/organismo notificado.`;

function client(apiKey: string, f?: typeof fetch) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, fetch: f, maxRetries: f ? 0 : 2 });
}

async function ask<T>(apiKey: string, system: string, user: string, schema: z.ZodType<T>, f?: typeof fetch): Promise<T> {
  let response;
  try {
    response = await client(apiKey, f).beta.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Chave API inválida");
    if (e instanceof Anthropic.RateLimitError) throw new Error("Limite de pedidos atingido: tente daqui a pouco");
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Sem ligação à API da Anthropic");
    if (e instanceof Anthropic.APIError) throw new Error(`Erro da API (${e.status}): ${e.message}`);
    throw e;
  }
  if (response.stop_reason === "refusal") throw new Error("O pedido foi recusado pelo modelo");
  if (response.stop_reason === "max_tokens") throw new Error("Resposta cortada (demasiado longa): simplifique o pedido");
  if (!response.parsed_output) throw new Error("Resposta sem JSON válido");
  return response.parsed_output as T;
}

/** Gera (ou corrige, com o código e o erro anteriores) um script a partir de um pedido em linguagem natural. */
export function copilotScript(apiKey: string, request: string, context: ReturnType<typeof scriptContext>, previous?: { code: string; error?: string; logs?: string[] }, f?: typeof fetch): Promise<CopilotScript> {
  const prev = previous ? `\n\nScript anterior:\n\`\`\`js\n${previous.code}\n\`\`\`${previous.error ? `\nErro ao correr: ${previous.error}` : ""}${previous.logs?.length ? `\nÚltimas linhas da consola:\n${previous.logs.slice(-20).join("\n")}` : ""}\nCorrige ou melhora o script conforme o pedido.` : "";
  return ask(apiKey, SYSTEM_SCRIPT, `Contexto do modelo:\n${JSON.stringify(context, null, 1)}\n\nPedido: ${request}${prev}`, ScriptSchema, f);
}

/** Lê os resultados de um script (tabelas, valor devolvido, avisos) e propõe conclusões prudentes. */
export function copilotInterpret(apiKey: string, context: ReturnType<typeof scriptContext>, code: string, output: { value?: unknown; tables: { name: string; rows: Record<string, unknown>[] }[]; logs: string[] }, f?: typeof fetch): Promise<CopilotInterpretation> {
  const tables = output.tables.map((t) => ({ name: t.name, rows: t.rows.slice(0, 200) }));
  return ask(apiKey, SYSTEM_INTERPRET, `Contexto:\n${JSON.stringify(context, null, 1)}\n\nScript:\n\`\`\`js\n${code}\n\`\`\`\n\nResultado devolvido: ${JSON.stringify(output.value ?? null)}\nTabelas:\n${JSON.stringify(tables, null, 1)}\nConsola (últimas linhas):\n${output.logs.slice(-40).join("\n")}`, InterpretSchema, f);
}
