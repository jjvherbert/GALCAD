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
| Estruturas e térmica (linear, modal, encurvadura, não linear, contacto) | **CalculiX** (ccx 2.23, GPL-2) | Formato tipo Abaqus muito usado e estável, binário leve em Linux/Windows, ótimo para PME (é o do PrePoMax e do FreeCAD) | ✅ F1: estática, modal, encurvadura, térmica; verificado com valores analíticos |
| Estruturas avançadas (plasticidade, fadiga, cascas compósitas, dinâmica, civil) | **code_aster** (18.x, GPL-3) | O mais completo dos abertos (EDF), com validação industrial | Proposto: F3 (malha `.med` + `.comm`) |
| Dinâmica explícita (impacto, queda, *slamming*) | **OpenCourant** (ex-OpenRadioss, AGPL-3) | Único explícito aberto de nível industrial | Proposto: adaptador `_0000.rad`/`_0001.rad` (VALIDAR o estado do fork) |
| Multifísica (térmico-fluido, eletromagnetismo, acústica) | **Elmer** (GPL / ElmerSolver LGPL) | Amplo e com boa documentação | Proposto (mais tarde) |
| CFD geral (interno/externo, turbulência RANS, térmico, superfície livre VOF para cascos) | **OpenFOAM**, linha openfoam.com (v2606, GPL-3) | Referência aberta da indústria; dicionários estáveis entre versões anuais; pacotes Windows; *snappyHexMesh* para malhas hexa-dominantes com camadas | ✅ F1: simpleFoam interno/externo (laminar, k-ω SST, k-ε) com snappyHexMesh; verificado |
| CFD compressível/aerodinâmica e otimização de forma (adjunto) | **SU2** (8.x, LGPL-2.1) | Solver adjunto para otimizar a forma — liga ao `rom-fea`/otimizador do esboço adaptativo | ✅ F1: configuração incompressível + malha Gmsh com marcadores (sem SU2 instalado neste ambiente: configuração não corrida) |
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

Limitações: um só sólido por estudo; só material isotrópico; sem contacto, sem não linear, sem transitório; forças só uniformes por área; SU2 não corrido neste ambiente; nos casos externos o resumo dá só a força de pressão (a parcela viscosa precisa do function object `forces`).

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

**Etapa F2: resultados no visualizador** (FEM ✅: deslocamento, von Mises, temperatura, deformada ampliada, modos; CFD: só o resumo por agora)
- Leitura de `.frd` (CalculiX), `.vtu`/`.med` e resultados de MYSTRAN.
- Mapas de cores (tensão de von Mises, principais, deslocamento, fator de segurança face ao limite elástico), deformada amplificada, modos animados, sondas, reações nos apoios, verificação do equilíbrio (soma das reações vs. cargas).
- Estudo de convergência de malha assistido (refinamento sucessivo e variação da grandeza de interesse).

**Etapa F3: integração dos solvers dentro da aplicação (sem exportar à mão)** — **agente local ✅** (`tools/cad-runner.ts` → `cad-runner.mjs`: linha de comandos e servidor em 127.0.0.1 com token; regenera as entradas dos solvers a partir do caso, recusa diretivas que executam código; botão "Calcular" no painel Simulação). Por fazer: fila remota, WASM, gestor de corridas com histórico.

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

## API de plugins (evolução)
- Hoje: features de plugin que geram um sólido e um painel de resultados.
- A seguir: registar features novas com parâmetros e referências, comandos e painéis, importadores e exportadores, análises.
- Os plugins correm no worker e acedem à geometria apenas pela API do núcleo.
