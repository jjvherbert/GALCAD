# Handoff — Fase 1

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
