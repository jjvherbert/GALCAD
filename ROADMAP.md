# Roadmap

Produto: CAD geral de sólidos e superfícies. Os módulos de domínio (náutica, FEA, …) são plugins por cima de um núcleo genérico, e o núcleo nunca depende de um plugin.

## Visão do produto

CAD paramétrico completo, com **paridade com o SolidWorks** na modelação, nos comandos, nos atalhos de rato e de teclado e na navegação. A isto juntam-se:
- o melhor do **CATIA**: superfícies GSD, classe A, knowledgeware, publicação;
- as **tags/atributos e o PMI** do **Siemens NX**;
- outras boas ideias, para um produto completo.

Os domínios de engenharia entram como módulos:
- **moldes:** saída e análise de inclinação, linha de partição, superfícies de fecho, núcleo/cavidade, contração;
- **compósitos:** plies, zonas, rosetas, sequência de laminação, planificação, exportação para corte;
- **náutica.**

**Ligação ao cálculo.** Um adaptador ajusta automaticamente o esboço (e as cotas que o comandam) a partir de um **modelo FEM de ordem reduzida (ROM)**. O ROM avalia rapidamente o desempenho, por exemplo tensão, rigidez ou deslocamento, em função dos parâmetros. Um otimizador move as variáveis e as cotas do esboço até cumprir os objetivos e restrições, e o resultado é verificado com o FEM completo.

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
- ✅ Aparar, estender, filete de canto e deslocar no esboço
- ✅ Converter arestas do modelo para o esboço, ligadas pelo nome topológico (acompanham o modelo)
- Chanfro de esboço; aparar splines; espelhar e repetir entidades no esboço
- ✅ Seleção de regiões (contornos selecionados) em esboços com curvas que se cruzam ou sobrepõem
- Feature fina (*thin*), "até ao próximo", "até ao vértice", "até à face" com faces curvas
- Tabela de configurações (famílias de peças) a partir das variáveis
- Gestão de multi-corpo (listar, ocultar, combinar)

## Fase 2: superfícies (nível SolidWorks Surfacing) — em curso
Feito:
- ✅ Corpos de superfície no motor (chave = feature criadora), resolução de referências em sólido + superfícies, malha/exportação conjunta
- ✅ Extrusão, revolução, sweep e loft de superfície (contornos abertos ou fechados)
- ✅ Fill surface (remendo N-lados) com contacto, tangência ou curvatura; offset
- ✅ Trim (plano, superfície ou esboço, partes a manter por ponto), knit (com sólido opcional e operação), thicken (frente/trás/simétrico), apagar face
- ✅ Análises: zebra, curvatura (gaussiana/média, exata por vértice), draft
- ✅ UI: separador Superfícies, painéis, escolha de corpos no 3D, menu de contexto; testes Node e e2e

Pendente:
- Boundary surface e loft com controlo de tangência/curvatura nos limites; ruled surface
- Untrim, substituir face, apagar e reparar (*delete and heal*), aparar mútuo
- Curvas 3D: spline por pontos, projeção, interseção, curva composta, hélice
- Análise de desvio (entre superfícies, ou entre arestas de faces adjacentes) e verificação automática de G1 no preenchimento
- Padrões e espelho de corpos de superfície; registo da dependência a jusante de um aparar

## Fase 3: montagens, desenhos 2D e BOM
- Montagens com mates (coincidente, concêntrico, distância, ângulo) e solver de restrições 3D
- Peças em contexto e deteção de interferências
- **Desenhos técnicos 2D**, associativos (atualizam com o modelo):
  - folhas e formatos ISO/ASME com legenda e carimbo;
  - vistas padrão, projetadas (1.º/3.º diedro), isométricas, de corte, de detalhe e auxiliares, com linhas ocultas por HLR;
  - cotas importadas do modelo e cotas de desenho;
  - tolerâncias e GD&T (ISO 1101), símbolos de rugosidade e de soldadura;
  - notas e balões;
  - exportação DXF/DWG e PDF.
- **Lista de materiais (BOM)**:
  - por peça e por montagem (níveis, quantidades, propriedades personalizadas);
  - tabela no desenho com balões ligados;
  - exportação CSV/Excel.
- **BOM com IA** (sempre sugestões para o utilizador validar, nunca alterações automáticas):
  - classificação das peças e descrições normalizadas;
  - reconhecimento de peças normalizadas (parafusos, porcas, rolamentos, com designação ISO/DIN) a partir da geometria;
  - sugestão de material e processo;
  - deteção de duplicados e de quase-duplicados no catálogo;
  - estimativa de custo e de prazo, e sugestão de fornecedores;
  - verificação de coerência entre a BOM, o desenho e o modelo.

## Fase 4: funcionalidades inspiradas no CATIA
- Wireframe e superfícies ao estilo do GSD: multi-section com guias e spine, blend, sweeps avançados, extrapolação, junção e cura de geometria
- Continuidade G2/G3 controlada e análise de superfícies de classe A (reflexão, highlight lines, porcupine)
- Superfícies de forma livre: controlo direto de polos NURBS
- Knowledgeware: regras, fórmulas, tabelas de configurações e templates reutilizáveis (estilo PowerCopy/UDF)
- Publicação de geometria entre peças e montagens (referências externas controladas)
- Exportação STEP AP242 com PMI

## Fase 5: PMI, tags e produção (inspirado no Siemens NX)
- PMI 3D semântico: cotas, tolerâncias geométricas (GD&T, ISO 1101), referências (datums), acabamentos e notas ligadas às faces pelo nome topológico
- Tags e atributos em features, faces e corpos (material, processo, fornecedor, requisitos), pesquisáveis e exportáveis
- Exportação STEP AP242 com PMI semântico; vistas de modelo (Model Views) para MBD

## Módulos (plugins), desenvolvidos em paralelo quando o núcleo o permitir
- **nautica** (já existe um casco paramétrico simples com hidrostática de conceção):
  - linhas e fairing do casco, tabelas de offsets;
  - hidrostática e curva GZ (ISO 12217 via `galkeel-calculadora`, sem reimplementar);
  - estrutura e laminados de PRFV, apêndices com perfis NACA;
  - planificação de chapas.
- **fea:** Gmsh para a malha, CalculiX ou Code_Aster para o cálculo, resultados no visualizador. Casos náuticos, como as pressões da ISO 12215-5, vivem no plugin `nautica`.
- **rom-fea (esboço adaptativo):**
  - amostragem do espaço de parâmetros (variáveis e cotas) com o FEM completo;
  - modelo de ordem reduzida (POD/RBF ou PGD, com estimativa de erro);
  - otimização sobre o ROM com restrições geométricas, aplicada às cotas do esboço pelo próprio motor paramétrico;
  - verificação final com o FEM completo, mostrando sempre as hipóteses e os limites de validade do ROM.
- **moldes:**
  - análise de inclinação por cores;
  - linha e superfície de partição;
  - fecho de furos;
  - núcleo e cavidade;
  - fator de contração;
  - machos e postiços;
  - canais e arrefecimento (mais tarde).
- **compósitos:**
  - definição de plies e zonas sobre superfícies;
  - rosetas e orientação;
  - drapeamento e planificação, com previsão de enrugamento;
  - tabelas de laminação;
  - exportação para corte e laser de posicionamento;
  - ligação ao FEA de cascas laminadas.
- **cam / fabrico** (opcional): exportação para impressão 3D (3MF, já existe) e corte (DXF).

## API de plugins (evolução)
- Hoje: features de plugin que geram um sólido e um painel de resultados.
- A seguir: registar features novas com parâmetros e referências, comandos e painéis, importadores e exportadores, análises.
- Os plugins correm no worker e acedem à geometria apenas pela API do núcleo.
