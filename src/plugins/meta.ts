// Registo de plugins (metadados para a UI e validação de parâmetros no núcleo).
import type { PluginKind, PluginMeta } from "./types.ts";
import { nauticaMeta } from "./nautica/meta.ts";
import { knownPlugin, registerPlugin } from "./registry.ts";

/** Plugins instalados, por id (a chave tem de ser igual a `meta.id`; ver tests/plugins.test.ts). */
export const PLUGIN_METAS = { nautica: nauticaMeta } satisfies Record<string, PluginMeta>;

export type PluginId = keyof typeof PLUGIN_METAS;

registerPlugin({ meta: nauticaMeta, flag: "galkeelHull" });

/** Metadados de um tipo de feature de plugin CONHECIDO, ligado ou não (a opção só decide o que se mostra/cria; indefinido se o plugin não existir). */
export function pluginKind(plugin: string, kind: string): PluginKind | undefined {
  const kinds = knownPlugin(plugin)?.kinds;
  return kinds && Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
}
