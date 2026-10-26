# Roadmap

Produto: CAD geral de sólidos e superfícies. Os módulos de domínio (náutica, FEA, …) são plugins por cima de um núcleo genérico, e o núcleo nunca depende de um plugin.

## Fase 0: protótipo (feito)
- Núcleo OpenCASCADE/WASM num worker, visualizador Three.js
- Sistema de plugins com descoberta automática (`base`, `nautica`)
- Exemplos: sólido com fillet, shell, superfície aberta por loft, casco
- Exportação STEP e STL em mm; teste headless de todos os modelos

## Fase 1: modelação de peças (nível SolidWorks, núcleo)
- Esboço 2D: linhas, arcos, splines, cotas e restrições geométricas (solver: PlaneGCS ou o do SolveSpace)
- Árvore de features editável e reordenável: extrusão e corte (cego, passante, até superfície), revolução, sweep, loft, furos (passante/cego, roscado), fillet, chamfer, shell, draft, rib, padrões e espelho
- Planos, eixos e sistemas de coordenadas de referência
- Equações e variáveis globais (parâmetros ligados entre features)
- Nomeação topológica estável: referências a faces e arestas que sobrevivem a edições a montante
- Formato de projeto aberto (JSON do histórico de features); importação STEP/IGES; desfazer e refazer

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
- **nautica:**
  - linhas e fairing do casco, tabelas de offsets;
  - hidrostática e curva GZ (ISO 12217 via `galkeel-calculadora`, sem reimplementar);
  - estrutura e laminados de PRFV, apêndices com perfis NACA;
  - planificação de chapas.
- **fea:** Gmsh para a malha, CalculiX ou Code_Aster para o cálculo, resultados no visualizador. Casos náuticos, como as pressões da ISO 12215-5, vivem no plugin `nautica`.
- **cam / fabrico** (opcional): exportação para impressão 3D (3MF) e corte (DXF).

## API de plugins (evolução)
- Hoje: modelos paramétricos, mais um painel de resultados.
- A seguir: registar features novas na árvore, comandos e painéis, importadores e exportadores, análises.
- Os plugins correm no worker e acedem à geometria apenas pela API do núcleo.
