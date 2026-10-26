# Roadmap

Produto: CAD geral de sólidos e superfícies. Os módulos de domínio (náutica, FEA, …) são plugins por cima de um núcleo genérico, e o núcleo nunca depende de um plugin.

## Fase 0: protótipo ✅
OpenCASCADE/WASM num worker, visualizador Three.js, exportação STEP/STL, primeiro sistema de plugins.

## Fase 1: modelação de peças (nível SolidWorks, núcleo) ✅ (com as limitações listadas)
- ✅ Esboço 2D: linhas, retângulos, círculos, arcos, splines, pontos, construção; relações e cotas com o PlaneGCS; graus de liberdade, conflitos, arrasto
- ✅ Árvore de features editável: editar, suprimir, apagar com dependentes, reordenar com validação, rollback
- ✅ Extrusão e corte (cega, simétrica, através de tudo, até à face, 2.ª direção, saída), revolução, varrimento, loft, nervura
- ✅ Furos ISO: passagem (273), roscado (broca D − P, rosca cosmética), rebaixo, escareado, cego ou passante
- ✅ Filete, chanfro, casca, inclinação
- ✅ Padrões linear e circular, espelho (de features ou do corpo)
- ✅ Planos, eixos e sistemas de coordenadas de referência
- ✅ Variáveis globais e equações
- ✅ Nomeação topológica estável pelo histórico do OCC (`Generated`/`Modified`), com recurso por nome-base e por posição
- ✅ Formato de projeto aberto (JSON), importação STEP, desfazer e refazer, cache incremental
- ✅ Exportação STEP, STL, 3MF, OBJ e glTF; propriedades de massa

**Pendentes da Fase 1** (a fazer antes ou em paralelo com a Fase 2):
- Corte e extensão no esboço (trim/extend), filete e chanfro de esboço, deslocamento (offset) de entidades
- Converter e projetar arestas do modelo para o esboço (referências externas com nomes estáveis)
- Seleção de regiões em esboços com contornos sobrepostos
- Feature fina (*thin*), "até ao próximo", "até ao vértice", "até à face" com faces curvas
- Tabela de configurações (famílias de peças) a partir das variáveis
- Gestão de multi-corpo (listar, ocultar, combinar)

## Fase 2: superfícies (nível SolidWorks Surfacing)
- Extrusão, revolução, sweep, loft e boundary surface, com controlo de tangência e curvatura nos limites
- Fill surface (remendo N-lados), offset, ruled surface
- Trim e untrim, knit (costura), thicken (superfície → sólido), substituir face
- Curvas 3D: spline por pontos, projeção, interseção, curva composta, hélice
- Análises: zebra, mapa de curvatura, desvio, draft

## Fase 3: montagens e desenhos
- Montagens com mates (coincidente, concêntrico, distância, ângulo) e solver de restrições 3D
- Peças em contexto e deteção de interferências
- Desenhos técnicos: vistas projetadas com HLR, cortes, cotas e tolerâncias, exportação DXF e PDF

## Fase 4: funcionalidades inspiradas no CATIA
- Wireframe e superfícies ao estilo do GSD: multi-section com guias e spine, blend, sweeps avançados, extrapolação, junção e cura de geometria
- Continuidade G2/G3 controlada e análise de superfícies de classe A (reflexão, highlight lines, porcupine)
- Superfícies de forma livre: controlo direto de polos NURBS
- Knowledgeware: regras, fórmulas, tabelas de configurações e templates reutilizáveis (estilo PowerCopy/UDF)
- Publicação de geometria entre peças e montagens (referências externas controladas)
- Exportação STEP AP242 com PMI

## Módulos (plugins), desenvolvidos em paralelo quando o núcleo o permitir
- **nautica** (já existe um casco paramétrico simples com hidrostática de conceção):
  - linhas e fairing do casco, tabelas de offsets;
  - hidrostática e curva GZ (ISO 12217 via `galkeel-calculadora`, sem reimplementar);
  - estrutura e laminados de PRFV, apêndices com perfis NACA;
  - planificação de chapas.
- **fea:** Gmsh para a malha, CalculiX ou Code_Aster para o cálculo, resultados no visualizador. Casos náuticos, como as pressões da ISO 12215-5, vivem no plugin `nautica`.
- **cam / fabrico** (opcional): exportação para impressão 3D (3MF, já existe) e corte (DXF).

## API de plugins (evolução)
- Hoje: features de plugin que geram um sólido e um painel de resultados.
- A seguir: registar features novas com parâmetros e referências, comandos e painéis, importadores e exportadores, análises.
- Os plugins correm no worker e acedem à geometria apenas pela API do núcleo.
