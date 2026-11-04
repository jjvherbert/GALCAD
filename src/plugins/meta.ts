// Registo de plugins (metadados para a UI e validação de parâmetros no núcleo).
import type { PluginKind, PluginMeta } from "./types.ts";
import { nauticaMeta } from "./nautica/meta.ts";

/** Plugins instalados, por id (a chave tem de ser igual a `meta.id`; ver tests/plugins.test.ts). */
export const PLUGIN_METAS = { nautica: nauticaMeta } satisfies Record<string, PluginMeta>;

export type PluginId = keyof typeof PLUGIN_METAS;

export const PLUGINS: PluginMeta[] = Object.values(PLUGIN_METAS);

/** Metadados de um tipo de feature de plugin (indefinido se o plugin não estiver instalado). */
export function pluginKind(plugin: string, kind: string): PluginKind | undefined {
  const kinds = PLUGINS.find((p) => p.id === plugin)?.kinds;
  return kinds && Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
}
