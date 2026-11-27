// Concordância de número nos textos da interface: «1 aresta», «3 arestas» em vez de «3 aresta(s)».
// As duas formas são explícitas (português tem demasiadas exceções para uma regra automática).

/** `n` seguido da forma certa: singular só para 1 (0 e 2+ levam plural, como em português). */
export function pl(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
