// Registo de plugins (geometria, só no worker).
import type { PluginBuilders } from "./types.ts";
import { nauticaBuilders } from "./nautica/geometry.ts";

export const PLUGIN_BUILDERS: Record<string, PluginBuilders> = { nautica: nauticaBuilders };
