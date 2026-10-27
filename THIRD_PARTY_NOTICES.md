# Componentes de terceiros

O código deste projeto é proprietário (ver `LICENSE`). Usa as bibliotecas abaixo, que mantêm as suas licenças. Os textos completos estão em `licenses/`.

| Componente | Versão | Licença | Uso | Origem |
|---|---|---|---|---|
| Open CASCADE Technology, compilação WASM `replicad-opencascadejs` | 1.1.0 | LGPL-2.1 (com a exceção da Open CASCADE) | Núcleo geométrico B-rep | https://dev.opencascade.org · https://github.com/sgenoud/replicad |
| PlaneGCS, `@salusoft89/planegcs` (solver do FreeCAD) | 1.3.0 | LGPL-2.0-or-later | Solver de restrições do esboço | https://github.com/Salusoft89/planegcs |
| replicad | 1.2.0 | MIT | Utilitários sobre o OpenCASCADE | https://github.com/sgenoud/replicad |
| three.js | 0.186.1 | MIT | Visualização 3D | https://github.com/mrdoob/three.js |
| Preact | 11.0.2 | MIT | Interface | https://github.com/preactjs/preact |
| Anthropic TypeScript SDK, `@anthropic-ai/sdk` | 1.3.0 | Apache-2.0 | Sugestões de BOM com o Claude (opcional, só com a chave do utilizador) | https://github.com/anthropics/anthropic-sdk-typescript |
| Zod | 4.6.7 | MIT | Esquema da resposta estruturada do assistente | https://github.com/colinhacks/zod |

## Solvers e malhadores externos (não distribuídos)

O pré-processador escreve ficheiros para o Gmsh (GPL-2+), o CalculiX (GPL-2), o OpenFOAM (GPL-3) e o SU2 (LGPL-2.1), e o agente local (`cad-runner.mjs`, código próprio, sem dependências) corre-os como **programas separados** já instalados na máquina do utilizador. Nenhum deles é incluído nem ligado à aplicação. Se um dia forem distribuídos em conjunto (instalador, imagem de servidor), cumprir as respetivas licenças (texto, código-fonte; na AGPL do OpenCourant, também em serviço de rede) — **VALIDAR com aconselhamento jurídico**.

## Obrigações das bibliotecas LGPL num produto fechado

Resumo técnico, que não substitui aconselhamento jurídico:

1. **Ligação substituível.** O OpenCASCADE e o PlaneGCS são carregados como módulos WebAssembly separados (`replicad_single.wasm`, `planegcs.wasm` e o respetivo JS de ligação), não fundidos no código proprietário. O utilizador tem de poder substituí-los por uma versão modificada compatível. **Manter esta separação no empacotamento**: não os inlinar no bundle.
2. **Aviso e textos de licença.** Distribuir este ficheiro e a pasta `licenses/` com o produto, e mostrar a informação na janela "Acerca" quando existir.
3. **Código-fonte das bibliotecas.** Disponibilizar, ou indicar com oferta válida, o código-fonte exato das versões LGPL usadas, incluindo eventuais modificações. As versões usadas não são modificadas.
4. **Termos de utilização.** A licença do produto não pode proibir a modificação das bibliotecas LGPL nem a engenharia reversa necessária para depurar essas modificações (LGPL-2.1, §6).
5. As bibliotecas MIT só exigem que se mantenha o aviso de copyright e a licença.
6. A Apache-2.0 (SDK da Anthropic) exige distribuir o texto da licença e indicar alterações aos ficheiros dela (não há alterações). É compatível com um produto fechado.
