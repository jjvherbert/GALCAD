# CAD protótipo

CAD paramétrico open source, no browser, para modelação de sólidos (e, a seguir, superfícies), com fluxos de trabalho ao estilo do SolidWorks: esboços com restrições, árvore de features editável, variáveis e equações. Os domínios específicos, como o boat design, são **plugins** opcionais por cima de um núcleo genérico.

**Estado:** Fase 1 (modelação de peças) implementada. Ver [ROADMAP.md](ROADMAP.md) e [HANDOFF.md](HANDOFF.md).

## Correr

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 39 testes (Node): documento, solver, perfis, modificação, motor, nomes, serviço
npm run typecheck    # TypeScript estrito
npm run build && npm run test:e2e   # 9 fluxos de ponta a ponta no Chromium (Playwright)
```

## O que faz

**Esboço 2D** (solver de restrições [PlaneGCS](https://github.com/Salusoft89/planegcs), o do FreeCAD):
- Entidades: linha, retângulo, círculo, arco, spline interpolada, ponto e linhas de construção.
- Relações: coincidente, ponto em, ponto médio, horizontal, vertical, paralela, perpendicular, colinear, tangente, igual, concêntrica, simétrica, fixar. As relações horizontal e vertical são inferidas ao desenhar.
- Cota inteligente: distância, horizontal/vertical, raio, diâmetro e ângulo, com valores por expressão (`W/2`). Uma cota que sobre-define o esboço passa a cota de referência.
- Estado de definição: azul quando sub-definido e preto quando totalmente definido, com os graus de liberdade e os conflitos identificados. Os pontos podem ser arrastados com o solver ativo.
- As arestas do modelo aparecem como referência quando se esboça numa face.
- Modificar: **aparar** até às interseções mais próximas, **estender** até à primeira entidade, **filete de canto** (arco tangente) e **deslocar** (offset de cadeias com os cantos ligados, preso à original por paralelismo e distância).
- **Converter arestas** do modelo, uma a uma ou o contorno inteiro no plano. As entidades ficam ligadas à aresta pelo nome topológico e são reprojetadas a cada reconstrução, por isso o esboço acompanha o modelo. Aparecem a roxo no editor.

**Features:**

| Grupo | Features |
|---|---|
| Sólidos | Extrusão e corte: cega, simétrica, através de tudo, até à face, segunda direção, ângulo de saída. Revolução, varrimento, loft, nervura |
| Furos | Simples, de passagem (ISO 273: fino, médio, largo) e roscado (broca D − P, rosca cosmética). Rebaixo ou escareado; cego (com ponta) ou passante |
| Acabamento | Filete, chanfro (simétrico ou assimétrico), casca, inclinação |
| Padrões | Linear (1 ou 2 direções), circular, espelho: de features ou do corpo inteiro |
| Referências | Planos (desvio e ângulo), eixos, sistemas de coordenadas |
| Outros | Importação STEP; plugins (módulo náutico: casco paramétrico e hidrostática de conceção) |

**Modelo paramétrico:**
- **Variáveis globais e equações**, com dependências e deteção de ciclos. O avaliador de expressões é seguro: unidades, trigonometria em graus e `if`.
- **Árvore de features**: editar, renomear, suprimir, apagar (com aviso dos dependentes), reordenar (arrastar ou menu, com validação) e **barra de rollback**.
- **Nomeação topológica estável**: as faces e arestas têm nomes derivados do histórico do OpenCASCADE, por exemplo `f2:side:l5` (a face lateral gerada pela linha l5 da extrusão f2) ou `{f2:end:l5&f2:side:l5}` (a aresta entre duas faces). Por isso, um filete continua na aresta certa depois de se mudar uma cota ou de um corte a montante dividir a face.
- Reconstrução **incremental** com cache: editar a feature k só reconstrói de k em diante.
- Desfazer e refazer; propriedades de massa com massa volúmica configurável.

**Ficheiros:**
- Projeto em JSON aberto e legível (`.cadp.json`).
- Exportação para **STEP** (sólido exato), **STL**, **3MF**, **OBJ** e **glTF (.glb)**, sempre em milímetros.

## Arquitetura

```
src/
  doc/      modelo de documento (JSON), expressões, variáveis, histórico, tabelas de furos — sem núcleo geométrico
  sketch/   geometria 2D, solver PlaneGCS, deteção de perfis, operações de edição (puras)
  kernel/   OpenCASCADE: nomeação topológica, motor de reconstrução, features, malha, worker
  io/       exportação de malhas (3MF, OBJ, glTF)
  plugins/  módulos de domínio (metadados para a UI + geometria para o worker)
  app/      interface Preact + Three.js: árvore, painel de propriedades, editor de esboço, visualizador
tests/      testes Node (node:test) e e2e (Playwright)
```

- O núcleo geométrico (OpenCASCADE, LGPL-2.1) corre num **Web Worker**, por isso a interface não bloqueia.
- O solver de esboço corre na thread da interface, para o arrasto ser interativo, e também no worker durante a reconstrução.
- A UI e o worker comunicam por mensagens (`src/kernel/protocol.ts`). Malhas e ficheiros viajam como buffers transferíveis.

**Plugins:** cada pasta em `src/plugins/<id>/` tem dois ficheiros:
- `meta.ts`: parâmetros (UI);
- `geometry.ts`: construtores que devolvem um sólido e, opcionalmente, informação `{ title, rows, note }`.

Registam-se em `src/plugins/meta.ts` e `src/plugins/geometry.ts`. Qualquer resultado técnico deve indicar as hipóteses e os limites no `note`.

## Limitações conhecidas (Fase 1)

- Aparar não trata splines (apaga-as) e as entidades convertidas não se aparam. O deslocamento assume que a cadeia tem uma orientação coerente.
- Regiões de esboço: contornos que se intersetam ou se ramificam dão erro; não há seleção de regiões individuais.
- Feature fina (*thin*) e "até ao próximo" ainda não existem. "Até à face" só aceita faces planas.
- O furo usa os pontos isolados do esboço, sem o assistente de posicionamento do SolidWorks. A rosca é cosmética, não modelada.
- Multi-corpo simples: "corpo separado" junta sem fundir; não há gestão de corpos.
- Importação só em STEP: o IGES não está disponível nesta compilação WASM do OpenCASCADE.
- O nome de uma face dividida pode mudar de sufixo (`~0`, `~1`) se a ordem geométrica das partes mudar. As referências por nome-base e por posição cobrem a maioria dos casos e deixam um aviso.

## Propriedade intelectual

As funcionalidades inspiram-se no que o SolidWorks e o CATIA fazem bem, mas a implementação é independente (*clean-room*). Não usa código, binários nem formatos nativos proprietários. A interoperabilidade faz-se por formatos abertos.

Licença: provisoriamente LGPL-2.1-or-later, compatível com OpenCASCADE e PlaneGCS; está por decidir.
