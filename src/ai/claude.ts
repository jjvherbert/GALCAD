// Sugestões de BOM com o Claude (opcional). Corre no browser com a chave API que o utilizador
// escreve: a chave fica só em memória (nunca é guardada nem enviada para outro lado) e o pedido vai
// diretamente para a API da Anthropic. Envia-se só a BOM (nomes, propriedades, quantidades) e um
// resumo da geometria — nunca os ficheiros do modelo. A resposta é JSON validado (saídas estruturadas);
// cada sugestão é para o utilizador aceitar ou ignorar.
import { splitPartKey } from "../doc/knowledge.ts";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { CadProject } from "../doc/project.ts";
import type { PartSignature } from "../kernel/signature.ts";
import { computeBom } from "../assembly/bom.ts";
import { type Suggestion, classify } from "./bom-assistant.ts";

export const CLAUDE_MODEL = "claude-opus-5-5";

const SuggestionSchema = z.object({
  part: z.string().describe("Id da peça (p1, p2, …) ou vazio para o projeto"),
  kind: z.enum(["standard", "description", "process", "material", "duplicate", "missing", "consistency", "supplier"]),
  title: z.string(),
  detail: z.string().describe("Justificação curta, com as hipóteses e o que falta confirmar"),
  confidence: z.number().describe("0 a 1"),
  patch: z.object({
    number: z.string().nullable(),
    description: z.string().nullable(),
    material: z.string().nullable(),
    finish: z.string().nullable(),
    process: z.string().nullable(),
  }).nullable().describe("Valores a escrever nas propriedades se o utilizador aceitar; null nos campos que não mudam"),
});
const ResponseSchema = z.object({ suggestions: z.array(SuggestionSchema) });

const SYSTEM = `És um assistente de engenharia que revê listas de materiais (BOM) de montagens mecânicas.
Recebes, em JSON, as peças de um projeto CAD: propriedades atuais, quantidades e um resumo da geometria (dimensões, cilindros, sextavados, chapa, classificação local por heurística).

Propõe sugestões úteis e verificáveis, em português europeu:
- descrições normalizadas e consistentes entre peças ("Tipo — dimensões principais");
- peças que parecem normalizadas (parafusos, porcas, anilhas, cavilhas, rolamentos), com a designação ISO/DIN só quando as medidas a suportam; diz que medidas usaste;
- processo provável e categoria de fornecedor (tipo de oficina ou distribuidor, nunca nomes de empresas);
- material só como ponto de partida justificado, sempre "a confirmar";
- incoerências: números repetidos, descrições ambíguas, material/massa volúmica incoerentes, peças quase iguais.

Regras: não inventes dados que não estão na entrada (fornecedores, preços, normas não suportadas pela geometria). Se não tiveres base, não sugiras. Confiança entre 0 e 1, honesta. São sugestões para uma pessoa validar, não decisões.`;

/** Resumo compacto da BOM para o pedido. */
export function bomPayload(project: CadProject, asmId: string, sigs: Record<string, PartSignature | { error: string }>) {
  const rows = computeBom(project, asmId, "parts", {});
  return rows.map((r) => {
    const s = sigs[r.id];
    const geo = s && !("error" in s) ? {
      box_mm: s.box.map((x) => Math.round(x * 100) / 100),
      volume_cm3: Math.round(s.volume / 10) / 100,
      faces: s.faces,
      cylinders: s.cylinders.slice(0, 8).map((c) => ({ d_mm: Math.round(c.r * 200) / 100, len_mm: Math.round(c.len * 100) / 100, outer: c.outer })),
      hex_across_flats_mm: s.hex ? Math.round(s.hex.across * 100) / 100 : null,
      plate_t_mm: s.plate ? Math.round(s.plate.t * 100) / 100 : null,
      revolution: !!s.revolution,
      local_guess: classify(s).description,
    } : null;
    const p = project.parts.find((x) => x.id === splitPartKey(r.id).id);
    return { part: r.id, name: r.name, qty: r.qty, properties: p?.properties ?? {}, geometry: geo };
  });
}

/** Pede sugestões ao Claude. Lança erros com mensagens para mostrar ao utilizador. */
export async function claudeSuggestions(apiKey: string, project: CadProject, asmId: string, sigs: Record<string, PartSignature | { error: string }>, opts: { fetch?: typeof fetch } = {}): Promise<Suggestion[]> {
  // pedido direto do browser com a chave do utilizador (sem servidor intermédio)
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, fetch: opts.fetch, maxRetries: opts.fetch ? 0 : 2 });
  const payload = bomPayload(project, asmId, sigs);
  let response;
  try {
    response = await client.beta.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      // se um classificador de segurança recusar, a API tenta outro modelo dentro do mesmo pedido
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(ResponseSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: `Projeto "${project.name}". BOM (só peças) da montagem:\n${JSON.stringify(payload, null, 1)}` }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Chave API inválida");
    if (e instanceof Anthropic.RateLimitError) throw new Error("Limite de pedidos atingido: tente daqui a pouco");
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Sem ligação à API da Anthropic");
    if (e instanceof Anthropic.APIError) throw new Error(`Erro da API (${e.status}): ${e.message}`);
    throw e;
  }
  if (response.stop_reason === "refusal") throw new Error("O pedido foi recusado pelo modelo");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Resposta sem JSON válido");
  return parsed.suggestions.map((s, i) => {
    const part = project.parts.find((p) => p.id === s.part);
    const props = part?.properties ?? {};
    const pt = s.patch;
    const patch = pt && part ? {
      ...props,
      ...(pt.number ? { number: pt.number } : {}),
      ...(pt.description ? { description: pt.description } : {}),
      ...(pt.material ? { material: pt.material } : {}),
      ...(pt.finish ? { finish: pt.finish } : {}),
      ...(pt.process ? { custom: { ...props.custom, Processo: pt.process } } : {}),
    } : undefined;
    return { id: `c${i + 1}`, part: part ? s.part : "", kind: s.kind, title: s.title, detail: s.detail, confidence: Math.max(0, Math.min(1, s.confidence)), patch, source: "claude" as const };
  });
}
