# Handoff — Fases 1 e 2

## Atualização: Fase 2, superfícies (núcleo, interface e análises)

**Alterações**
- `src/doc/types.ts`: 10 features novas (`surfaceExtrude`, `surfaceRevolve`, `surfaceSweep`, `surfaceLoft`, `fill`, `offsetSurface`, `knit`, `thicken`, `trimSurface`, `deleteFace`). `features.ts`: rótulos, ícones (agora centralizados em `FEATURE_ICONS`), dependências, `SURFACE_TYPES`, `SHEET_SOURCES`.
- `src/kernel/context.ts`: `Ctx.sheets` (corpos de superfície por id da feature criadora); `faces()`/`edges()` resolvem no sólido e em todas as superfícies (`pool`); `faceOwner`, `sheetOf`.
- `src/kernel/features/surface.ts`: as 10 features. Histórico OCC usado na nomeação: `Generated` nas arestas (extrusão/revolução/sweep/loft), `ModifiedSubShape` na costura, `Generated` no desvio simples (`f3:off{nome}`), paredes do espessar `fN:wallK`. Uma feature só altera `ctx.sheets` depois de ter sucesso (uma costura falhada não consome as entradas).
- `src/kernel/analysis.ts`: curvatura por vértice (`GeomAPI_ProjectPointOnSurf` → `BRepAdaptor_Surface.D2` → formas fundamentais).
- `service.ts`/`protocol.ts`/`worker.ts`: cena = sólido + superfícies (malha com `body` por face, exportação, `sheets` na resposta), pedido `curvature`. **Bug corrigido:** o worker transferia os buffers da malha e a cópia do núcleo ficava vazia (afetava também OBJ/3MF/GLB); o serviço guarda agora uma cópia.
- UI: separador Superfícies, painéis de propriedades, `SheetList` (lista ou clique numa face do corpo), `PointList` (partes a manter; durante a escolha o aparar é suprimido para se ver a superfície inteira), cor âmbar das superfícies, `AnalysisPanel` com legenda, entradas no menu de contexto. Nomes por defeito legíveis (`Superfície-revolução1`).

**Testes:** 49 em Node (9 novos em `tests/surface.test.ts`: áreas e volumes analíticos, caixa costurada em sólido, espessar nos 3 lados, aparar por plano/esboço, revolução + desvio, loft e sweep, cúpula tangente, apagar face + preencher + costurar) e 3 suites e2e (`tests/e2e/surfaces.e2e.cjs`: espessar com volume analítico, zebra, curvatura média = 1/(2r), inclinação). Todos a passar.

**Bloqueios / limitações:** ver README (preenchimento tangente com faces quase perpendiculares; boundary surface, curvas 3D e substituir face por fazer).

**Próxima ação:** curvas 3D e boundary surface (fecham a Fase 2), ou desenhos 2D + BOM (Fase 3), conforme a prioridade de Juan. Sem push: o repositório remoto ainda não existe.

---


## Atualização: seleção de regiões

- `src/kernel/regions.ts`: o plano do esboço é dividido por todas as curvas com o `BRepAlgoAPI_Splitter`. As regiões ficam com uma assinatura do tipo entidade + lado (`c2+` = dentro / à esquerda), um ponto interior e os triângulos para a UI. São calculadas no passo do esboço, para pertencerem à arena desse passo.
- `RegionRef` em `ExtrudeFeature` e `RevolveFeature`. A resolução tenta, por esta ordem: assinatura → ponto interior → semelhança. Sem escolha, mantém-se o caminho anterior (contornos fechados), com os mesmos nomes topológicos.
- UI: campo "Regiões" no painel. As regiões aparecem a roxo no 3D e escolhem-se com um clique; o campo ativa-se sozinho quando os contornos se sobrepõem.
- Testes: 41 em Node e e2e (lente com volume analítico), todos a passar.
- Próximo passo: Fase 2 (superfícies).

---

## Atualização: navegação e comandos ao estilo do SolidWorks; licença

- `src/app/viewport.ts`: controlador de câmara próprio, sem OrbitControls.
  - Rato: meio, Ctrl/Shift/Alt+meio, roda no cursor, duplo meio, centro de rotação.
  - Seleção: caixa janela/cruzamento, gestos, menu de contexto, duplo clique.
  - Vista: histórico de vistas, estilos de visualização.
- `src/app/commands.ts`: registo único de comandos e atalhos (Ctrl+1…8, F, Z, setas, Ctrl+B/Q, Enter, S, Espaço…).
- `src/app/Overlays.tsx`: menu de contexto, barra de contexto, barra de atalhos (S), orientação, guia de gestos e barra de vista.
- `src/app/settings.ts`: preferências (roda invertida, passo das setas, gestos, estilo, planos).
- `Toolbar.tsx`: separadores ao estilo do CommandManager. `fileio.ts`: ficheiros.
- Ctrl+Q força a reconstrução completa (o worker limpa a cache).
- Licença: proprietária (`LICENSE`), com `THIRD_PARTY_NOTICES.md` e `licenses/`. **Manter o OCC e o PlaneGCS como WASM separados**, por causa da LGPL.
- Visão (moldes, compósitos, PMI/tags, ROM-FEM) registada no `ROADMAP.md`.
- Testes: 39 em Node, 9 fluxos de aplicação e 23 verificações de navegação (`tests/e2e/navigation.e2e.cjs`), todos a passar.

---

## Atualização: ferramentas de esboço

- `src/sketch/modify.ts`: aparar, estender, filete de canto e deslocar, com interseções entre linhas, arcos, círculos e splines. Testes em `tests/modify.test.ts`.
- Entidades convertidas (`ext: TopoRef` em linhas, arcos e círculos): o núcleo reprojeta-as a cada reconstrução (`projectExternal` em `src/kernel/features/datum.ts`). As dependências do esboço passam a incluir as features referidas.
- Bug corrigido: os contornos interiores no mesmo esboço eram somados em vez de furados. A orientação dos furos é agora corrigida com `addHolesInFace` / `ShapeFix_Face`. Há teste de regressão em `kernel.test.ts`.
- Testes: 39 em Node e 9 fluxos e2e, todos a passar.
- Próximo passo: seleção de regiões e depois a Fase 2 (superfícies).

---

## Alterações

- Projeto migrado para TypeScript estrito, com Preact na UI e Vite.
- **Documento** (`src/doc/`):
  - tipos de todas as features;
  - avaliador de expressões seguro;
  - variáveis com ordem de dependências;
  - histórico de desfazer;
  - I/O do formato `.cadp.json`;
  - dependências e validação de ordem;
  - tabelas ISO de furos.
- **Esboço** (`src/sketch/`):
  - ligação ao PlaneGCS: restrições, cotas, DOF, conflitos, arrasto;
  - deteção de perfis (regiões com furos, cadeias abertas, pontos isolados);
  - operações de edição puras.
- **Núcleo** (`src/kernel/`):
  - nomeação topológica por histórico do OCC;
  - motor com cache incremental e arenas de memória WASM;
  - todas as features da Fase 1;
  - malha com nomes; serviço e worker.
- **UI** (`src/app/`):
  - barra de comandos, árvore de features com rollback e reordenação, painel de propriedades por feature;
  - campos de expressão e de seleção 3D;
  - editor de esboço SVG;
  - variáveis, informação de massa, exportações.
- O módulo náutico passou a plugin TypeScript em mm (`src/plugins/nautica/`).

## Testes (todos a passar)

- `npm run typecheck`: sem erros.
- `npm test`: 31 testes Node, incluindo peças completas com volumes verificados analiticamente (furos, revolução por Pappus, casca, inclinação, padrões) e estabilidade dos nomes depois de editar cotas e de dividir faces.
- `npm run build && npm run test:e2e`: 8 fluxos no Chromium:
  - variáveis;
  - esboço totalmente definido;
  - extrusão, furos M8 e filete;
  - mudança de variável com tudo válido;
  - desfazer e refazer;
  - exportar STEP, guardar e reabrir;
  - importar STEP, casco, rollback e apagar.

## Bugs encontrados e corrigidos durante os testes

- O corte extrudido numa face ia para fora do material; agora vai para dentro, como no SolidWorks.
- A revolução não devolvia histórico para faces planas. Recurso geométrico: cada aresta do perfil está contida na face que gera.
- `gp_Cone` não existe nesta compilação WASM: as faces cónicas (pontas de furos) faziam falhar a reconstrução.
- A barra de relações do esboço deslocava o desenho ao aparecer; agora flutua.
- Um clique numa aresta sobre o eixo X do esboço escolhia o eixo em vez da linha.
- Os nomes de ficheiro com acentos eram rejeitados nos downloads; agora são normalizados.
- Filete numa face com concordâncias: as arestas tangentes são ignoradas, com mensagem clara.

## Bloqueios e decisões pendentes

- **Repositório:** o trabalho só existe neste contentor (commits locais). É preciso criar um repositório e autorizar o push.
- **Licença:** provisoriamente LGPL-2.1-or-later (está no `package.json`, sem ficheiro LICENSE).
- IGES indisponível nesta compilação WASM do OpenCASCADE (só STEP).

## Próxima ação recomendada

Fechar os pendentes da Fase 1 que mais afetam o uso real:
1. Trim/extend e offset no esboço.
2. Converter arestas do modelo para o esboço, com nomes estáveis.
3. Seleção de regiões.

Depois, Fase 2 (superfícies).
