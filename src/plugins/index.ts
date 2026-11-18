// Ponto de entrada dos plugins para a app: importar `meta.ts` regista os plugins instalados.
import "./meta.ts";
export { activePlugins, ALL_PLUGIN_FLAGS, knownPlugin, type PluginFlags } from "./registry.ts";
