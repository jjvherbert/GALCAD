// Tema claro/escuro. «Sistema» = sem data-theme em <html> (o CSS segue o SO pela media query);
// «Claro»/«Escuro» = data-theme força-o. O viewport three.js e o resto do JS leem o tema resolvido daqui.
export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const EVENT = "galcad-theme";
const media = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);

export function resolvedTheme(): ResolvedTheme {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return media()?.matches ? "dark" : "light";
}

export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const before = root.dataset.theme;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  if (root.dataset.theme !== before) window.dispatchEvent(new Event(EVENT));
}

/** Chama `cb` sempre que o tema resolvido pode ter mudado (escolha do utilizador ou SO). Devolve o cancelamento. */
export function onThemeChange(cb: () => void): () => void {
  const m = media();
  m?.addEventListener("change", cb);
  window.addEventListener(EVENT, cb);
  return () => { m?.removeEventListener("change", cb); window.removeEventListener(EVENT, cb); };
}
