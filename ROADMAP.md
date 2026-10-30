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
- **náutica;**
- **FEM:** pré-processador associativo que exporta para solvers abertos (CalculiX, Code_Aster, Elmer, MYSTRAN), com integração direta dos solvers numa etapa posterior.

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

## Fase 2: superfícies (nível SolidWorks Surfacing) ✅ (com as limitações listadas)
- ✅ Corpos de superfície no motor (chave = feature criadora), resolução de referências em sólido + superfícies + curvas, malha e exportação conjuntas
- ✅ Curvas 3D: spline por pontos, esboço projetado em faces, interseção, curva composta, hélice; usáveis como caminho de varrimento, limite de superfícies e arestas de referência
- ✅ Superfície extrudida, de revolução, varrida (caminho = esboço ou curva 3D) e loft
- ✅ Superfície limite (*boundary*) em duas direções, com curvas guia interiores e contacto/tangência/curvatura nos limites
- ✅ Preenchimento N-lados, superfície regrada (normal, tangente, direção), superfície deslocada
- ✅ Aparar (plano, superfície, esboço) e aparar mútuo; desaparar; costura (com sólido); espessar; substituir face; apagar face e apagar e remendar
- ✅ Padrões e espelho de corpos de superfície; o aparar entra no grafo de dependências das features a jusante
- ✅ Análises: zebra, curvatura (gaussiana/média, exata por vértice), inclinação, desvio de tangência nas arestas; verificação automática do desvio G1 nos preenchimentos, limites e remendos

Limitações que passam para a Fase 4 (geometria de classe A e cura): o remendo não prolonga as faces vizinhas (não reconstrói cantos vivos, *delete and heal* verdadeiro); substituir face pressupõe faces laterais aproximadamente paralelas à normal da face; o loft não tem condições de tangência nos extremos (usar a superfície limite); tangência difícil com faces vizinhas quase perpendiculares ao remendo (detetada e avisada).

## Fase 3: montagens, desenhos 2D e BOM ✅ (com as limitações listadas)
- ✅ **Projeto multi-documento** (`.cadp.json`): peças, montagens e desenhos, com abas; propriedades da peça (número, descrição, material, massa volúmica, propriedades personalizadas); ficheiros antigos de peça única abrem como projeto
- ✅ **Montagens**: componentes (peças e subconjuntos rígidos), mates coincidente, concêntrico, paralelo, perpendicular, distância, ângulo, tangente e fixar, com solver próprio (Levenberg–Marquardt, arranques múltiplos), graus de liberdade e mates em conflito; mates a faces de dentro de subconjuntos; massa com a densidade de cada peça; deteção de interferências; exportação da montagem (STEP/STL/malhas)
- ✅ **Desenhos técnicos 2D associativos**:
  - formatos ISO 216 (A4–A0), esquadria e zonas (ISO 5457), legenda (ISO 7200) com símbolo do método de projeção, massa e material;
  - vistas de modelo, projetadas (1.º/3.º diedro, alinhadas), isométrica, corte (com tracejado), pormenor e auxiliar, por HLR; ocultas e tangentes; marcas e linhas de centro;
  - cotas do modelo (esboços paralelos à vista) e cotas de desenho (horizontal, vertical, alinhada, raio, diâmetro, ângulo) com tolerâncias e ajustes ISO 286; cota inteligente;
  - GD&T (ISO 1101, 14 características), referências, estado de superfície, soldadura (ISO 2553), notas, balões (automáticos) e tabela de BOM;
  - exportação PDF vetorial, DXF R12 (camadas e tipos de linha) e SVG.
- ✅ **BOM**: nível de topo, só peças, indentada; massas; painel na montagem; exportação CSV e XLSX; tabela no desenho com os balões ligados
- ✅ **BOM com IA** (sempre sugestões a aceitar uma a uma):
  - assistente local, sem rede: reconhecimento de parafusos ISO 4017, porcas ISO 4032, anilhas ISO 7089, rolamentos (ISO 15), cavilhas ISO 2338 a partir da geometria; descrições normalizadas; processo provável; material de partida; duplicados e quase-duplicados; massa volúmica incoerente com o material; números repetidos; itens sem balão; custo indicativo (€/kg editável) e prazo indicativo; categoria de fornecedor (nunca empresas);
  - opcional: sugestões do Claude (API da Anthropic, chave do utilizador só em memória; envia a BOM e um resumo da geometria; resposta estruturada validada).

Pendente (passa para fases seguintes): peças em contexto (editar uma peça com referências à montagem); arrastar componentes com o rato respeitando os mates; vistas explodidas; DWG nativo (formato fechado: usar o DXF ou um conversor externo); cotas por coordenadas/cadeia e quebras de vista; numeração de balões própria em BOM "só peças"; ligação a ERP/PLM; catálogo de normalizados mais completo (DIN, ISO 4762, 4014…).

## Fase 4: funcionalidades inspiradas no CATIA ✅ (com as limitações listadas)
- ✅ **GSD**: multi-secção com guias (Gordon), spine e tangência nos extremos; concordância (blend) G0/G1/G2 com tensão; varrimento circular (3 guias, 2 guias + raio, tubo); varrimentos com binormal, suporte, guia (orientar/contacto/bordo) e lei de escala; extrapolação de superfícies e curvas (tangente/curvatura); regrada a um ângulo; juntar (ligação, tangência, simplificar) e curar (folgas, ShapeFix, quase-tangências)
- ✅ **Classe A**: continuidade G0–G3 por aresta (folga, ângulo, curvatura, derivada da curvatura), linhas de realce (normais exatas), pentes de curvatura (porcupine); a tangência pedida em cada superfície amostrada é medida e reportada
- ✅ **Forma livre**: controlo direto dos polos NURBS (patch ou face convertida), arrasto no 3D e edição numérica, edições guardadas por índice
- ✅ **Knowledgeware**: expressões lógicas, regras, verificações com medidas do modelo, tabela de configurações (peças, componentes de montagem, BOM, CSV), templates de features (PowerCopy/UDF) com entradas e parâmetros
- ✅ **Publicação** de geometria com nomes estáveis e **referências externas controladas** (ligadas/congeladas, posição de montagem, deteção de ciclos); mates a publicações
- ✅ **STEP AP242** com produtos com nome, cores e estrutura de montagem; **o PMI semântico passa para a Fase 5** (o modelo de PMI 3D é definido lá)

Pendente (passa para fases seguintes): concordância G3; *delete and heal* com prolongamento das faces vizinhas; cura que deforma para repor tangência; forma livre sobre faces recortadas (manter os limites); peças em contexto completas e posição externa que acompanha a montagem; estrutura AP242 com subconjuntos aninhados.

## Fase 5: PMI, tags e produção (inspirado no Siemens NX) ✅ (com as limitações listadas)
- ✅ PMI 3D semântico: referências (ISO 5459), cotas com o valor medido no modelo e afastamentos ou classe ISO 286 (tabelas IT5–IT11 até 500 mm, ajustamentos), tolerâncias geométricas ISO 1101 (14 características, ⌀, Ⓜ/Ⓛ, até três referências), estados de superfície e notas ligados às faces pelo nome topológico; validação contra a norma e a geometria; rótulos no 3D
- ✅ Tags e atributos no corpo, em features e em faces, pesquisáveis em todo o projeto e exportáveis em CSV
- ✅ Exportação STEP AP242 com PMI semântico (verificada com o leitor GD&T do OpenCASCADE); ✅ vistas de modelo (orientação + PMI mostrados) para MBD

- ✅ PMI importado para os desenhos 2D (out. 2026): cotas com tolerância na vista em verdadeira grandeza (⌀ na vista do círculo), GD&T, referências, rugosidade e notas na vista de perfil, associativos ao modelo

Pendente: apresentação gráfica do PMI no STEP (texto e linhas de chamada, polilinhas ou *tessellated annotation*), visibilidade e ângulos do PMI no desenho, PMI em montagens, ISO 286 completa (todas as letras, IT01–IT18, até 3150 mm), leitura de PMI de STEP importados, comparação com medições (relatório de inspeção a partir do PMI).

## Módulos (plugins), desenvolvidos em paralelo quando o núcleo o permitir
- **nautica** (já existe um casco paramétrico simples com hidrostática de conceção):
  - linhas e fairing do casco, tabelas de offsets;
  - hidrostática e curva GZ (ISO 12217 via `galkeel-calculadora`, sem reimplementar);
  - estrutura e laminados de PRFV, apêndices com perfis NACA;
  - planificação de chapas.
- **fem:** pré-processador compatível com solvers abertos — ver a secção própria abaixo. Casos náuticos, como as pressões da ISO 12215-5, vivem no plugin `nautica` (cálculo na `galkeel-calculadora`, sem reimplementar).
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

## Pré-processador FEM/CFD compatível com solvers abertos (módulo `fem`)

**Escolha dos solvers (out. 2026)** — os melhores abertos por domínio, integrados como processos separados:

| Domínio | Escolha | Porquê | Estado na app |
|---|---|---|---|
| Estruturas e térmica (linear, modal, encurvadura, não linear, contacto) | **CalculiX** (ccx 2.23, GPL-2) | Formato tipo Abaqus muito usado e estável, binário leve em Linux/Windows, ótimo para PME (é o do PrePoMax e do FreeCAD) | ✅ F1: estática, modal, encurvadura, térmica; ✅ não linear (NLGEOM, plasticidade bilinear); ✅ montagens com contacto colado (*TIE) e com atrito de Coulomb e separação (penalidade face a face); verificado com valores analíticos (atrito: μ·N a 0,001 %) |
| Estruturas avançadas (plasticidade, fadiga, cascas compósitas, dinâmica, civil) | **code_aster** (18.x, GPL-3) | O mais completo dos abertos (EDF), com validação industrial | ✅ Verificado com o code_aster 18.1 (conda-forge): consola, pressão, modal, plasticidade uniaxial, elástica (GREEN_LAGRANGE) e montagens coladas (LIAISON_MAIL, material por corpo). Por fazer: encurvadura, térmica, contacto com atrito, cascas |
| Dinâmica explícita (impacto, queda, *slamming*) | **OpenCourant** (ex-OpenRadioss, AGPL-3) | Único explícito aberto de nível industrial | Proposto: adaptador `_0000.rad`/`_0001.rad` (VALIDAR o estado do fork) |
| Multifísica (térmico-fluido, eletromagnetismo, acústica) | **Elmer** (GPL / ElmerSolver LGPL) | Amplo e com boa documentação | Proposto (mais tarde) |
| CFD geral (interno/externo, turbulência RANS, térmico, superfície livre VOF para cascos) | **OpenFOAM**, linha openfoam.com (v2606, GPL-3) | Referência aberta da indústria; dicionários estáveis entre versões anuais; pacotes Windows; *snappyHexMesh* para malhas hexa-dominantes com camadas | ✅ F1: simpleFoam interno/externo (laminar, k-ω SST, k-ε) com snappyHexMesh; verificado; ✅ F2: campos no 3D (patches e cortes) |
| CFD compressível/aerodinâmica e otimização de forma (adjunto) | **SU2** (8.x, LGPL-2.1) | Solver adjunto para otimizar a forma — liga ao `rom-fea`/otimizador do esboço adaptativo | ✅ F1: configuração incompressível + malha Gmsh com marcadores (sem SU2 instalado neste ambiente: configuração não corrida) |
| Perfis 2D (polares) | **XFOIL** (6.99, GPL-2) | Referência aberta para perfis subsónicos (painéis + camada-limite e^n) | ✅ polar no agente (NACA ou coordenadas), segunda passagem para ângulos sem convergência; verificado NACA 0012 a Re 1e6 (CLα 0,108/°, CDmin 0,0054) |
| Malhador FEM e SU2 | **Gmsh** (4.15, GPL-2+) | O melhor malhador aberto de uso geral (tetra, quadráticos, grupos físicos, exporta `.inp`, `.su2`, `.msh`, `.med`) | ✅ F1 |
| Malhador CFD | **snappyHexMesh** (OpenFOAM) | Hexa-dominante com camadas, a partir de STL | ✅ F1 |
| Malhador embebido (futuro) | **Netgen** (LGPL) | Pode correr dentro da app como módulo substituível | Proposto |
| Pós-processamento externo | **ParaView** (BSD) | Abre `.frd` (com leitor), VTK e casos OpenFOAM | Ligação por ficheiros |

Não escolhidos (sobreposição): code_saturne (CFD da EDF, excelente mas redundante com o OpenFOAM), FEniCSx/MFEM/deal.II (bibliotecas para quem programa o modelo, não solvers de produto — candidatas a um solver linear embebido).

Objetivo: preparar o modelo de análise dentro do CAD (geometria, materiais, condições, malha) e escrever os ficheiros de entrada dos solvers abertos, sem depender de nenhum em particular. A integração dos solvers **dentro da aplicação** (o utilizador nunca exporta à mão: corre e lê resultados sem sair) usa a mesma interface e entra na etapa F3, com os solvers GPL/AGPL como processos separados e os permissivos podendo correr embebidos.

**Princípios**
- **Associativo:** cada estudo é parte do documento. Cargas, apoios, contactos e controlos de malha ligam-se às faces/arestas pelo nome topológico (o mesmo mecanismo dos filetes), por isso sobrevivem às alterações do modelo; mudar uma cota regenera a malha e o ficheiro do solver.
- **Neutro em relação ao solver:** um modelo de análise interno único (nós, elementos, grupos, materiais, secções, passos, cargas), traduzido por adaptadores para cada formato.
- **Unidades explícitas:** sistema coerente mm–N–MPa–t (tonelada), escrito no cabeçalho de cada ficheiro exportado.
- **Transparência:** cada exportação e cada relatório indicam as hipóteses (linear/não linear, pequenas deformações), o tipo e a ordem dos elementos, o tamanho de malha, as idealizações aplicadas e as limitações. Nunca é apresentado como certificação nem como decisão de uma autoridade ou de um organismo notificado.

**Etapa F1: definição do estudo e exportação ✅ (com as limitações listadas)**

Implementado: estudos FEM (CalculiX) e CFD (OpenFOAM/SU2) na peça, com as condições ligadas às faces pelo nome topológico; caso neutro (`case.json`) com as faces numeradas como no OpenCASCADE/Gmsh (verificado) e conferência dos grupos pelo centroide depois da malha; script Gmsh com grupos físicos e tamanhos; deck CalculiX escrito a partir da malha (C3D10/C3D4, nós dos C3D10 reordenados, faces dos elementos para pressão/convecção/fluxo, forças nodais consistentes, unidades mm–N–MPa–t); caso OpenFOAM completo (blockMesh, surfaceFeatureExtract, snappyHexMesh, simpleFoam, condições de turbulência, STL por patch em metros); configuração SU2; exportação em `.zip` com LEIA-ME e hipóteses. Verificado com os solvers reais: consola (flecha de Timoshenko a < 3 %, tensão de flexão M·c/I, reações), frequência própria (Euler–Bernoulli a < 3 %), condução 1D exata, conduta laminar (balanço de massa 0 %, queda de pressão coerente com Shah & London), caso externo com k-ω SST e camadas.

Limitações: só material isotrópico; contacto (colado ou com atrito) só em faces planas coincidentes; sem transitório; forças só uniformes por área; SU2 não corrido neste ambiente; nos casos externos o resumo dá só a força de pressão (a parcela viscosa precisa do function object `forces`).

Feito depois da F1 (out. 2026):
- **Não linear no CalculiX**: grandes deslocamentos (NLGEOM) e plasticidade de von Mises com encruamento bilinear, em incrementos, com curva carga–deslocamento e deformação plástica equivalente. Verificado: tração uniaxial elastoplástica (ε = σ/E + (σ − σy)/Hp, erro < 0,5 %, εp médio < 1 %) e consola de Bisshopp–Drucker com PL²/EI = 1 (v/L = 0,3017 a < 3 %, u/L = 0,0566 a < 8 %).
- **Reações exatas**: um conjunto de nós por grau de liberdade restringido e a parcela das cargas aplicada nos nós dos apoios descontada (o RF do CalculiX é a força interna): reações iguais às cargas a < 0,01 % (antes, 0,3–0,6 % de erro).
- **Estudos de montagem**: um volume e um material por corpo, condições nas faces dos componentes ("caminho/face"), contacto colado (*TIE) detetado nas faces planas coincidentes (normais opostas, mesmo plano, área comum > 0), aviso de corpos soltos. Verificado: duas lâminas 100 × 10 × 5 coladas ≈ a consola inteira (0,1905 vs 0,1920 mm), barras de aço + alumínio em série (0,09494 vs 0,09524 mm).
- **code_aster**: adaptador para os mesmos casos (malha no formato ASTER, `.comm` com MECA_STATIQUE/STAT_NON_LINE/CALC_MODES, `.export`, leitura das tabelas IMPR_TABLE) — testado só sem o solver.

Plano original da F1:
- Tipos de estudo: estático linear, modal (frequências próprias), encurvadura linear, térmico em regime permanente; mais tarde não linear geométrico, contacto e transitório.
- Materiais: isotrópico (E, ν, ρ, α, k), biblioteca com origem dos valores; ortotrópico e laminados vindos do módulo `compósitos`.
- Idealização: configuração de análise que suprime features pequenas (filetes, furos) sem alterar o projeto; superfície média de peças finas (usa as ferramentas de superfícies da Fase 2) com espessura por face; vigas a partir de curvas com perfil; simetria e linhas de divisão para regiões de carga.
- Condições de fronteira: encastramento, apoios com graus de liberdade escolhidos, simetria, deslocamento imposto; força, pressão (uniforme ou por expressão, ex. pressão hidrostática), gravidade, carga remota, temperatura; ligações coladas (*tie*) entre corpos.
- Malha: tetraedros lineares/quadráticos, cascas (tri/quad) e vigas; tamanho global, refinamento local em faces/arestas, controlo de curvatura; verificação de qualidade (razão de aspeto, Jacobiano) e grupos físicos com os nomes das condições.
- Malhadores: **Netgen** (LGPL, compilável para WASM, integra com a geometria OpenCASCADE) como opção embebida; **Gmsh** como processo externo opcional (é GPL: só por ficheiros/processo separado, nunca ligado à aplicação).
- Formatos de saída:
  - **CalculiX** `.inp` (formato tipo Abaqus: malha, conjuntos, materiais, passos);
  - **Code_Aster** malha `.med` (ou `.unv`) + ficheiro de comandos `.comm`;
  - **Elmer** malha ElmerGrid + `.sif`;
  - **Nastran BDF** (lido pelo **MYSTRAN**, solver aberto compatível, e por muitas ferramentas);
  - **OpenRadioss/OpenCourant** Starter `_0000.rad` + Engine `_0001.rad` (dinâmica explícita);
  - neutros: Gmsh `.msh` v4 com grupos físicos, `.vtu` para visualização.
- Testes de referência automáticos, comparados com soluções analíticas e benchmarks publicados: consola em flexão (Euler–Bernoulli), placa com furo (fator de concentração de tensões), cilindro sob pressão (Lamé), modos de uma consola, NAFEMS LE1/LE10 quando disponíveis.

**Etapa F2: resultados no visualizador** ✅ (FEM: deslocamento, von Mises, temperatura, deformação plástica, deformada ampliada, modos, curva carga–deslocamento; CFD: pressão nos patches e cortes planos com pressão e |U| em camadas; convergência da malha com GCI)

Verificado: perfil desenvolvido na conduta quadrada laminar (u_máx/U entre 1,8 e 2,25, referência 2,096 de Shah & London; |U| ≈ 0 nas paredes; pressão a descer ao longo da conduta); GCI igual ao exemplo publicado de Celik et al. (p = 1,53, φext = 6,1685, GCI 2,2 %); convergência da consola com tetraedros lineares (malha fina 0,1685 mm, extrapolado 0,1922 mm vs 0,1920 mm analítico), máximos de von Mises junto ao encastramento corretamente assinalados como divergentes (singularidade).
- Leitura de `.frd` (CalculiX), `.vtu`/`.med` e resultados de MYSTRAN.
- Mapas de cores (tensão de von Mises, principais, deslocamento, fator de segurança face ao limite elástico), deformada amplificada, modos animados, sondas, reações nos apoios, verificação do equilíbrio (soma das reações vs. cargas).
- ✅ Estudo de convergência de malha assistido (três malhas, Richardson e GCI por grandeza).
- Por fazer: sondas, modos animados, fator de segurança como campo, `.vtu`/`.med`.

**Etapa F3: integração dos solvers dentro da aplicação (sem exportar à mão)** — **app Windows com os solvers incluídos ✅ (out. 2026)**: instalador NSIS (Electron) com **todos** os solvers para Windows — CalculiX, Gmsh, XFOIL, SU2, OpenFOAM (MinGW oficial) e code_aster (conda-forge, relocado pelo instalador) — e o agente embutido (sem configuração); solvers testados contra os casos de referência com os executáveis Windows (Wine aqui para CalculiX/Gmsh/XFOIL; todos no Windows real do GitHub Actions: 8/8 casos de referência, incluindo OpenFOAM, SU2 e code_aster, e a app instalada). Por fazer: execução paralela (MS-MPI), assinatura do instalador, atualizações automáticas, código-fonte GPL publicado com cada release. **agente local ✅** (`tools/cad-runner.ts` → `cad-runner.mjs`: linha de comandos e servidor em 127.0.0.1 com token; regenera as entradas dos solvers a partir do caso, recusa diretivas que executam código; botão "Calcular" no painel Simulação). Por fazer: fila remota, WASM, gestor de corridas com histórico.

Objetivo: o utilizador define o estudo e carrega em "Calcular"; a malha e o ficheiro do solver são gerados em memória, o solver corre em segundo plano e os resultados voltam ao visualizador. O ficheiro de entrada continua a existir, mas como detalhe interno (e fica disponível para quem o queira auditar ou correr à parte). É assim que o FreeCAD FEM e o Salome-Meca trabalham com CalculiX e Code_Aster.

- **Arquitetura**: `SolverAdapter` (capacidades, `exportDeck`, `parseResults`) mais um **executor** (`SolverRunner`) com três implementações, escolhidas por estudo:
  1. **Agente local** (processo do utilizador ou aplicação de ambiente de trabalho, por exemplo Tauri): recebe o pedido por `localhost`, corre o binário instalado (ccx, Code_Aster, ElmerSolver, OpenRadioss/OpenCourant starter + engine), devolve o progresso (resíduos, passos) e os ficheiros de resultados. Necessário para solvers nativos pesados (Fortran/MPI).
  2. **Fila remota** (servidor próprio ou do cliente) para estudos longos ou paralelos, com o mesmo protocolo.
  3. **Dentro do browser** (Web Worker com WASM) para casos leves: CalculiX compilado para WASM, como experiência; ou um solver com licença permissiva ligado diretamente (ver abaixo).
- **Gestor de trabalhos** na aplicação: estado, cancelar, repetir com outra malha, histórico de corridas por estudo (com a revisão do modelo, a versão do solver e as hipóteses), comparação de resultados entre corridas e com o estudo de convergência.
- **OpenRadioss / OpenCourant** (dinâmica explícita: impacto, queda, crash, cargas de impacto em cascos — ex. *slamming*): adaptador próprio. O deck tem duas partes, o *Starter* (`_0000.rad`: malha, materiais, contactos, condições) e o *Engine* (`_0001.rad`: tempo final, saídas). Os resultados (ficheiros de animação) convertem-se para VTK com as ferramentas do próprio projeto e mostram-se no visualizador (deformada, tensões, energia). **Estado atual (VALIDAR antes de investir):** a Siemens descontinuou o OpenRadioss a 1 de outubro de 2026 e retirou o repositório; a continuação comunitária é o **OpenCourant** (Rocky Enterprise Software Foundation), com a mesma licença AGPL-3.0, por agora com pacotes Linux e Windows x86_64 e algumas dependências binárias recentes em falta. O adaptador deve visar o formato de entrada (estável) e não um binário específico.
- **Licenças e o que "dentro da aplicação" pode significar** (a app é proprietária):

  | Solver / biblioteca | Licença | Integração possível |
  |---|---|---|
  | CalculiX | GPL-2.0 | Processo separado (agente local, servidor) ou WASM num worker isolado, por ficheiros — VALIDAR o caso WASM distribuído com a app |
  | Code_Aster | GPL-3.0 | Processo separado |
  | Elmer | GPL-2.0 (ElmerSolver: biblioteca LGPL-2.1) | Processo separado; a biblioteca LGPL poderia ligar-se como módulo substituível |
  | OpenRadioss / OpenCourant | AGPL-3.0 | Processo separado; num servidor que o disponibilize a terceiros, publicar o código do solver (alterado ou não) como a AGPL exige |
  | MYSTRAN | MIT | Pode ser integrado diretamente |
  | MFEM | BSD-3 | Pode ser integrado diretamente (ex. WASM no worker): candidato para um solver linear embebido |
  | deal.II | LGPL-2.1 (em transição para Apache-2.0 com exceção LLVM) | Módulo LGPL substituível, como o OpenCASCADE |
  | Netgen | LGPL-2.1 | Malhador embebido (módulo substituível) |
  | Gmsh | GPL-2.0+ | Só processo separado |

  Regra de arquitetura: tudo o que é GPL/AGPL fica **fora do processo da aplicação** (programa separado, contactado por ficheiros ou por um protocolo), o que em geral é tratado como agregação e não como obra derivada. Os solvers permissivos (MIT/BSD) ou LGPL (como módulo substituível) podem correr dentro da aplicação. **VALIDAR com aconselhamento jurídico** antes de distribuir qualquer solver em conjunto com a aplicação, e em particular o caso AGPL em serviço de rede.
- **Transparência**: cada corrida guarda e mostra o solver e a versão, o tipo de análise e de elementos, as hipóteses (linearidade, contacto, amortecimento, passo de tempo crítico na explícita) e as limitações. Nenhum resultado é apresentado como certificação nem como decisão de autoridade ou de organismo notificado.

**Etapa F4: ligação aos outros módulos**
- `rom-fea`: os estudos parametrizados (variáveis → geometria → malha → ficheiro) são a base da amostragem do modelo de ordem reduzida.
- `compósitos`: cascas laminadas (sequência de plies, orientação por roseta) exportadas como secções compostas (`*SHELL SECTION, COMPOSITE` / `PCOMP`).
- `nautica`: casos de carga a partir das pressões de projeto calculadas na `galkeel-calculadora`.

## Automação, análise integrada e cálculos (out. 2026) ✅ (com as limitações listadas)

- ✅ **Convergência formal**: sondas (média/máximo numa face, nó mais próximo de um ponto) e refinamento automático até ao GCI alvo; verificado com tetraedros lineares (6 malhas, 434 → 162 981 elementos, GCI 2,1 %, extrapolado 0,1910 vs 0,1920 mm).
- ✅ **Scripts** `cad.*` num worker isolado e em lote (`tools/cad-script.ts`): estudos paramétricos, superfície de resposta RBF com erro por validação cruzada, tabelas CSV, `cad.calc` e `cad.xfoil`; verificado contra Timoshenko (varrimento de L a < 3 %, previsão a < 5 %).
- ✅ **Copiloto Claude** para gerar, corrigir e interpretar scripts (revisão humana obrigatória antes de correr). Testado só com respostas simuladas.
- ✅ **Análise integrada Galkeel**: painéis do casco medidos no modelo → galkeel-calculadora (submódulo, ISO 12215-5:2008 legada) → verificação FEM com a mesma pressão (Roark corrigido a < 3 %) → relatório e envio ao caso no contrato `galkeel:calculator-result`, veredito sempre indeterminado.
- ✅ **Biblioteca de cálculos** (ISA ISO 2533, asa finita DATCOM, NACA 4 dígitos, Euler–Johnson com a secção lida de uma face plana, encurvadura de placas), cada uma com referência, hipóteses e caso de verificação à mão; **XFOIL** no agente.

Pendente: migrar a análise Galkeel para a ISO 12215-5:2019 quando a galkeel-calculadora a tiver (nunca reimplementar aqui); propor à galkeel-app uma etiqueta `cad-analysis` e alojar o CAD em `public/cad` (decisão de Juan; nada alterado na galkeel-app); mais cálculos (juntas aparafusadas VDI 2230, vigas, fadiga) só com referência e caso de verificação; AVL/VLM para asas; copiloto testado com a API real.

## Malha manual, dinâmica e explícito (nov. 2026, em curso)

Objetivo (Juan): um pré-processador ao nível do Femap — malha feita à mão, com seeds — e malhas de qualidade comparável ao Abaqus; dinâmica implícita e explícita; estudo de convergência num ponto escolhido.

- ✅ **Malha manual** (`src/kernel/meshplan.ts`, `src/sim/gmsh.ts`): seeds nas arestas (n.º de elementos ou tamanho, razão maior/menor com os pequenos no início, no fim, nas pontas ou no meio), faces mapeadas, refinamento local; nas malhas mapeadas o n.º de elementos propaga-se às arestas opostas (classes de arestas opostas) e a distribuição segue no mesmo sentido geométrico; seeds incompatíveis assinaladas. As tags das arestas são as do OpenCASCADE e o agente confere-as com as caixas das curvas do Gmsh.
- ✅ **Hexaedros**: estruturados (volumes com 6 faces de 4 arestas, transfinitos) ou por subdivisão (qualquer geometria, qualidade inferior), automático com aviso. CalculiX C3D8I (por omissão), C3D8, C3D8R, C3D20R (por omissão), C3D20; code_aster HEXA8/HEXA20 (`3D` ou `3D_SI`); faces QUAD4/QUAD8 com cargas nodais consistentes por integração de Gauss. Verificado contra Timoshenko: C3D8I, C3D20R, HEXA20 a < 3 %, HEXA8 3D_SI −5,5 % com 4 camadas; o C3D8 de integração completa mostra o bloqueio por corte (87 %).
- ✅ **Qualidade da malha** (`src/sim/quality.ts`) e **pré-visualização** (agente `/mesh`): jacobiano escalado, razão de aspeto, ângulos das faces, empeno, fator de forma dos tetraedros, com limites por omissão do Verify Mesh do Abaqus/CAE (ângulos, aspeto, fator de forma) e do Femap (jacobiano, empeno), histograma, piores elementos e a malha no 3D com as arestas e a cor por elemento.
- ✅ **Convergência ±3 níveis num ponto**: sonda num ponto escolhido no 3D (clique na peça), 7 malhas h·r^k (k = 3 … −3, r = 1,35 por omissão; seeds e contagens escaladas), tabela e gráfico com a malha pedida destacada, monotonia, GCI e Richardson no trio mais fino e erro estimado da malha pedida; para antes de passar o limite de elementos. Verificado: consola C3D20R, ponta extrapolada a < 2 % de Timoshenko e malha pedida a < 1 % do extrapolado.
- ✅ **Dinâmica implícita e explícita**: CalculiX `*DYNAMIC` (α-HHT) e `*DYNAMIC, EXPLICIT`; code_aster `DYNA_NON_LINE` (Newmark e `DIFF_CENT` com massa diagonal); cargas em degrau, rampa, meio seno ou seno (`*AMPLITUDE`/`FONC_MULT`), amortecimento de Rayleigh (com α a partir de ζ e f₁), passo estável da malha no explícito (sem escalar massa; aviso se o CalculiX escalar), envolventes (deslocamento e von Mises máximos no tempo), deformadas por instante, histórias do deslocamento máximo e das sondas. Verificado com a consola sob degrau: fator 2 e pico em T₁/2 (f₁ = 835 Hz) no implícito e no explícito dos dois solvers; com ζ = 5 % o fator 1 + e^(−ζπ/√(1−ζ²)) = 1,855.
- ✅ **OpenRadioss (OpenCourant, AGPL-3.0)**: explícito de impacto e choque (`src/sim/radioss.ts`): Starter em formato bloco 2019 (kg–mm–ms) com /BRICK Isolid 24 e /TETRA4, /MAT/ELAST, /BCS, /CLOAD das forças nodais consistentes com a amplitude em /FUNCT, /GRAV, /DAMP; Engine com animações de deslocamentos e von Mises, lidas pelo `anim_to_vtk`. Verificado na CI Linux com o binário oficial (`.github/workflows/openradioss.yml`, SHA-256 fixo): consola sob degrau — fator 2 e pico em T₁/2 (±10 %). No instalador Windows com o runtime Intel oneAPI (~490 MB), verificado também no Windows real (instalador de 673 MB, 18/18 casos de referência). Por fazer: materiais elastoplásticos (LAW2/LAW36), contacto (/INTER/TYPE7) e deslocamentos/velocidades impostos (/IMPDISP, /IMPVEL, /INIVEL) — o que torna útil o crash.
- Pendente na malha: dividir sólidos em blocos dentro da app (partições, como no Femap/Abaqus), malha mapeada com faces de 3 arestas, controlo de camadas na espessura para cascas finas, seeds escolhidas por vértice (sentido) em vez de "início/fim", edição de nós/elementos individuais.

## Redesign: interface por módulos, interação SolidWorks e instalador (nov. 2026, em curso)

Pedido de Juan: desenho a imitar o SolidWorks (rato, animações, transições, escolha do plano), módulos como no Fusion (CAD, FEM, CFD, maquinagem), cada um com a sua barra e as suas especificidades, coeso como o Abaqus, instalador com a marca e descarga direta do instalador, pré-processador FEM mais forte e compatível com os solvers, pré-visualização e explicação de cada feature.

- ✅ **R1 — instalador**: assistente NSIS com a marca Galkeel (ícone GK, barra lateral, cabeçalho), atalhos no menu Galkeel, abrir no fim, ecrã de arranque; release em rascunho com o `.exe` direto (etiqueta `v*` ou lançamento manual). Releases continuam em rascunho até se resolver a oferta de código GPL/AGPL (VALIDAR com jurista).
- ✅ **R2 — espaços de trabalho** (`src/app/workspaces.ts`, `SimBrowser.tsx`, `sim-actions.ts`): Design, Simulação FEM, Simulação CFD e Desenho, cada um com separadores, árvore e painel próprios; FEM na ordem do Abaqus/CAE com apoios/cargas/materiais/malha na barra e a cor das condições no 3D. Falta: espaço **Fabrico** (maquinagem/CAM, R5).
- ✅ **R3 — interação SolidWorks**: transições animadas da câmara (slerp, com `prefers-reduced-motion`), escolha do plano com realce no 3D e rotação para o plano antes de abrir o esboço, pré-visualização amarela das faces da feature em edição, painel com ✓ OK/✕, dicas animadas por feature (figura SMIL, o que faz, como se usa) na barra e cartão «O que faz» no painel. Falta: figuras para as superfícies/GSD/classe A, dicas dos módulos de montagem e desenho, e a pré-visualização translúcida (hoje é a geometria reconstruída com as faces novas a amarelo).
- **R4 — pré-processador FEM ao nível Abaqus/Femap** (em curso):
  - ✅ **Verificação do modelo** (`src/sim/modelcheck.ts`, secção «Verificação» na árvore e na barra): erros (bloqueiam o cálculo: condições sem faces, material impossível, análise que o solver não faz, encurvadura sem carga…), avisos (sem apoios, forças nulas…) e notas; cada item leva à secção onde se corrige.
  - ✅ **Matriz de compatibilidade por solver**: o que o CalculiX, o code_aster e o OpenRadioss fazem *neste software* (análises, não linearidades, elementos, condições, contacto), com veredito do estudo por solver e troca de solver com um clique.
  - ✅ **Conjuntos de faces** nomeados (como os sets do Abaqus): definem-se uma vez, usam-se em várias condições («→ guardar como conjunto» a partir de uma condição).
  - ✅ **Simetria**: faces planas alinhadas com X, Y ou Z → deslocamento normal nulo (verificado: meia viga com metade da carga = viga inteira, CalculiX e code_aster reais).
  - ✅ **Força pontual** no nó mais próximo de um ponto (verificado contra Timoshenko a meio vão nos dois solvers; aviso de tensões locais).
  - Por fazer: cargas e apoios em **arestas**, **molas** e **massas pontuais**, **acoplamentos** (RBE2/RBE3), **referenciais locais**, **passos múltiplos** (casos de carga em sequência), conjuntos de arestas e de volumes.
- **R5 — Fabrico (CAM)**: espaço de maquinagem.

## Otimização e scripts (módulo seguinte, por fazer)

Depois da malha e da dinâmica: módulo de otimização sobre o mesmo estudo — scripts (`cad.*`) como motor, otimização paramétrica (cotas e variáveis, com restrições), **otimização topológica** (SIMP com filtro de densidade sobre a malha de hexaedros; candidato aberto: o próprio CalculiX tem *sensitivity*/*design response* desde a 2.16, ou ToPy/código próprio), otimização de forma (adjunto do SU2 no CFD) e estudos de convergência automáticos como parte de cada iteração. Os resultados voltam ao CAD como geometria proposta, sempre com verificação FEM completa e hipóteses à vista.

## Posicionamento face ao SolidWorks, CATIA e FEM comercial (out. 2026)

**Conclusão: ainda não compete como substituto.** É um CAD paramétrico com CAE integrado credível para peças e montagens pequenas, com os solvers abertos de referência (CalculiX, code_aster, OpenFOAM, XFOIL) verificados contra soluções analíticas, automação por scripts e IA e ligação ao fluxo da Galkeel. Para uso profissional faltam, por ordem de impacto:

1. **Robustez do núcleo**: o OpenCASCADE em WASM falha em casos que o Parasolid/CGM resolvem (filetes complexos, cascas, booleanas degeneradas); falta medir a taxa de sucesso num conjunto de peças reais.
2. **Escala**: montagens grandes (centenas de peças), modos leves, PDM/versões e trabalho em equipa.
3. **Funcionalidades de produção**: chapa metálica, soldaduras/perfis, moldes, desenhos com cortes por patamares e normas completas, DWG.
4. **FEM de nível formal**: cascas e vigas (estruturas de PRFV e chapa), contacto geral (faces curvas, auto-contacto), dinâmica e fadiga, compósitos laminados, e um **dossier de V&V** (benchmarks NAFEMS LE1/LE10/LE11, R0031, comparação com resultados publicados) — sem isto, não se defende um resultado perante um cliente ou um ON.
5. **Certificação de software**: nenhum. Os resultados são apoio à decisão de engenharia, com hipóteses à vista.

Onde já é diferenciador: CAD + FEM/CFD + scripts + IA no mesmo documento, solvers abertos sem custo de licença, rastreabilidade (hipóteses, edição da norma, versão da ferramenta) em cada resultado, e a ligação direta ao caso da Galkeel.

## API de plugins (evolução)
- Hoje: features de plugin que geram um sólido e um painel de resultados.
- A seguir: registar features novas com parâmetros e referências, comandos e painéis, importadores e exportadores, análises.
- Os plugins correm no worker e acedem à geometria apenas pela API do núcleo.
