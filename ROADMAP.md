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

## Pré-processador FEM compatível com solvers abertos (módulo `fem`)

Objetivo: preparar o modelo de análise dentro do CAD (geometria, materiais, condições, malha) e escrever os ficheiros de entrada dos solvers abertos, sem depender de nenhum em particular. A integração direta dos solvers (correr e ler resultados sem sair da aplicação) fica preparada pela mesma interface e entra por etapas.

**Princípios**
- **Associativo:** cada estudo é parte do documento. Cargas, apoios, contactos e controlos de malha ligam-se às faces/arestas pelo nome topológico (o mesmo mecanismo dos filetes), por isso sobrevivem às alterações do modelo; mudar uma cota regenera a malha e o ficheiro do solver.
- **Neutro em relação ao solver:** um modelo de análise interno único (nós, elementos, grupos, materiais, secções, passos, cargas), traduzido por adaptadores para cada formato.
- **Unidades explícitas:** sistema coerente mm–N–MPa–t (tonelada), escrito no cabeçalho de cada ficheiro exportado.
- **Transparência:** cada exportação e cada relatório indicam as hipóteses (linear/não linear, pequenas deformações), o tipo e a ordem dos elementos, o tamanho de malha, as idealizações aplicadas e as limitações. Nunca é apresentado como certificação nem como decisão de uma autoridade ou de um organismo notificado.

**Etapa F1: definição do estudo e exportação (sem solver na aplicação)**
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
  - neutros: Gmsh `.msh` v4 com grupos físicos, `.vtu` para visualização.
- Testes de referência automáticos, comparados com soluções analíticas e benchmarks publicados: consola em flexão (Euler–Bernoulli), placa com furo (fator de concentração de tensões), cilindro sob pressão (Lamé), modos de uma consola, NAFEMS LE1/LE10 quando disponíveis.

**Etapa F2: resultados no visualizador**
- Leitura de `.frd` (CalculiX), `.vtu`/`.med` e resultados de MYSTRAN.
- Mapas de cores (tensão de von Mises, principais, deslocamento, fator de segurança face ao limite elástico), deformada amplificada, modos animados, sondas, reações nos apoios, verificação do equilíbrio (soma das reações vs. cargas).
- Estudo de convergência de malha assistido (refinamento sucessivo e variação da grandeza de interesse).

**Etapa F3: integração dos solvers**
- Interface de adaptador (`SolverAdapter`): capacidades (tipos de estudo e elementos), `exportDeck(estudo, malha) → ficheiros`, `parseResults(ficheiros) → resultados` e, opcionalmente, `run(ficheiros)`.
- Execução por um agente local opcional na máquina do utilizador (corre os binários instalados, devolve o estado e os resultados); depois, fila de trabalhos remota. Solvers pequenos em WASM (por exemplo, CalculiX) como experiência para casos leves.
- Os solvers são programas separados, contactados por ficheiros ou processo: as licenças GPL dos solvers não se estendem à aplicação proprietária. **VALIDAR** este enquadramento com aconselhamento jurídico antes de distribuir qualquer solver em conjunto.

**Etapa F4: ligação aos outros módulos**
- `rom-fea`: os estudos parametrizados (variáveis → geometria → malha → ficheiro) são a base da amostragem do modelo de ordem reduzida.
- `compósitos`: cascas laminadas (sequência de plies, orientação por roseta) exportadas como secções compostas (`*SHELL SECTION, COMPOSITE` / `PCOMP`).
- `nautica`: casos de carga a partir das pressões de projeto calculadas na `galkeel-calculadora`.

## API de plugins (evolução)
- Hoje: features de plugin que geram um sólido e um painel de resultados.
- A seguir: registar features novas com parâmetros e referências, comandos e painéis, importadores e exportadores, análises.
- Os plugins correm no worker e acedem à geometria apenas pela API do núcleo.
