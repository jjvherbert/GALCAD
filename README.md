# CAD protótipo

CAD paramétrico no browser, para modelação de sólidos e de superfícies, com fluxos de trabalho ao estilo do SolidWorks: esboços com restrições, árvore de features editável, variáveis e equações. Os domínios específicos, como o boat design, são **plugins** opcionais por cima de um núcleo genérico.

**Estado:** Fases 1 (peças), 2 (superfícies), 3 (montagens, desenhos 2D e BOM), 4 (inspirada no CATIA: GSD, classe A, forma livre, knowledgeware, publicações, STEP AP242) e 5 (PMI 3D semântico, vistas de modelo e atributos, inspirada no NX) implementadas. Pré-processador de simulação: F1 e F2 feitas (FEM linear e não linear no CalculiX e no code_aster, montagens com contacto colado ou com atrito, CFD com campos no 3D, convergência formal da malha). Automação: scripts `cad.*` (estudos paramétricos, superfície de resposta, lote em Node), copiloto Claude, análise integrada de painéis com a galkeel-calculadora e biblioteca de cálculos com XFOIL. Não substitui ainda um CAD/CAE comercial: ver a avaliação em [ROADMAP.md](ROADMAP.md#posicionamento-face-ao-solidworks-catia-e-fem-comercial-out-2026) e o estado em [HANDOFF.md](HANDOFF.md).

## App Windows (instalador)

A GALCAD também existe como aplicação de ambiente de trabalho (Electron) com os solvers incluídos: instala-se com `GALCAD-Setup-<versão>.exe` e as simulações funcionam logo, sem instalar nada à parte nem copiar tokens.

- **Tudo incluído no instalador** (~560 MB; 2,4 GB instalado): CalculiX 2.23 (conda-forge, OpenBLAS), Gmsh 4.15.2 (biblioteca oficial + lançador próprio `desktop/gmsh-launcher.c`), XFOIL 6.99 (código do Debian, compilado sem gráficos), **SU2 8.3** (binário oficial de série), **OpenFOAM v2606** (versão MinGW oficial da openfoam.com, só executáveis e `etc`, em série sem MS-MPI) e **code_aster 18.1** (ambiente conda-forge win-64 relocável; o instalador corre `GALCAD.exe --galcad-setup` para o apontar à pasta de instalação). Ficam em `resources/solvers` e correm como programas separados.
- **Agente embutido**: arranca com a app em 127.0.0.1, com um token novo a cada arranque passado à página (`window.cadDesktop`); a página não tem acesso ao Node.
- **Obter o instalador**: GitHub → Actions → «Instalador Windows» → artefacto `GALCAD-Setup` (ou a release, nas etiquetas `v*`). O workflow testa os solvers num Windows real contra os casos de referência antes de empacotar.
- **Construir localmente**: `python3 desktop/build-solvers.py` (Linux: micromamba, mingw-w64 gcc/gfortran, pip, 7-Zip) e `npm run dist:win`; `npm run desktop` abre a app de ambiente de trabalho a partir do código.

## Correr

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 156 testes (Node; os de solvers correm se o Gmsh/CalculiX/code_aster/OpenFOAM/XFOIL estiverem instalados, e a leitura do PMI se houver o OCP em Python)
npm run typecheck    # TypeScript estrito
npm run build && npm run test:e2e   # 11 suites no Chromium: aplicação, navegação, superfícies, montagens, desenhos, Fase 4, simulação, PMI, scripts, Galkeel, cálculos
node public/cad-runner.mjs --status # solvers encontrados pelo agente local
node --experimental-strip-types tools/cad-script.ts projeto.cadp.json script.js [--part Nome] [--csv t.csv] [--save novo.cadp.json]   # scripts em lote
```

Solvers (instalados à parte, processos separados): Gmsh, CalculiX, OpenFOAM, SU2, **code_aster** (recomendado: `micromamba create -n aster -c conda-forge code-aster`; o agente encontra o ambiente `aster` ou `CAD_ASTER`) e **XFOIL** (`apt install xfoil`; na compilação Debian 6.99, que aborta com SIGFPE no modo viscoso, compilar `tools/xfoil-nofpe.c` e definir `CAD_XFOIL_PRELOAD`).

## O que faz

**Esboço 2D** (solver de restrições [PlaneGCS](https://github.com/Salusoft89/planegcs), o do FreeCAD):
- Entidades: linha, retângulo, círculo, arco, spline interpolada, ponto e linhas de construção.
- Relações: coincidente, ponto em, ponto médio, horizontal, vertical, paralela, perpendicular, colinear, tangente, igual, concêntrica, simétrica, fixar. As relações horizontal e vertical são inferidas ao desenhar.
- Cota inteligente: distância, horizontal/vertical, raio, diâmetro e ângulo, com valores por expressão (`W/2`). Uma cota que sobre-define o esboço passa a cota de referência.
- Estado de definição: azul quando sub-definido e preto quando totalmente definido, com os graus de liberdade e os conflitos identificados. Os pontos podem ser arrastados com o solver ativo.
- As arestas do modelo aparecem como referência quando se esboça numa face.
- Modificar: **aparar** até às interseções mais próximas, **estender** até à primeira entidade, **filete de canto** (arco tangente) e **deslocar** (offset de cadeias com os cantos ligados, preso à original por paralelismo e distância).
- **Regiões (contornos selecionados)**:
  - curvas que se cruzam ou sobrepõem dividem o plano em regiões, calculadas com exatidão pelo OpenCASCADE;
  - na extrusão e na revolução escolhem-se as regiões a usar, com um clique no 3D;
  - cada região é identificada pelas entidades que a delimitam e pelo lado de cada uma (por exemplo, "dentro de c2 e fora de c4"), o que se mantém quando as cotas mudam.
- **Converter arestas** do modelo, uma a uma ou o contorno inteiro no plano. As entidades ficam ligadas à aresta pelo nome topológico e são reprojetadas a cada reconstrução, por isso o esboço acompanha o modelo. Aparecem a roxo no editor.

**Features:**

| Grupo | Features |
|---|---|
| Sólidos | Extrusão e corte: cega, simétrica, através de tudo, até à face, segunda direção, ângulo de saída. Revolução, varrimento, loft, nervura |
| Furos | Simples, de passagem (ISO 273: fino, médio, largo) e roscado (broca D − P, rosca cosmética). Rebaixo ou escareado; cego (com ponta) ou passante |
| Acabamento | Filete, chanfro (simétrico ou assimétrico), casca, inclinação |
| Padrões | Linear (1 ou 2 direções), circular, espelho: de features ou do corpo inteiro |
| Referências | Planos (desvio e ângulo), eixos, sistemas de coordenadas |
| Curvas 3D | Spline por pontos, esboço projetado em faces, interseção de superfícies, curva composta, hélice. Servem de caminho de varrimento, de limite de superfícies e de arestas de referência |
| Superfícies | Extrudida, de revolução, varrida e loft (contornos abertos ou fechados); **superfície limite** em duas direções com curvas guia e contacto/tangência/curvatura nos limites; preenchimento N-lados; superfície regrada (normal, tangente, direção); superfície deslocada; aparar (plano, superfície ou esboço) e aparar mútuo; desaparar; costura (opcionalmente em sólido); espessar; substituir face; apagar face e apagar e remendar; padrões e espelho de superfícies |
| Outros | Importação STEP; plugins (módulo náutico: casco paramétrico e hidrostática de conceção) |

**Corpos de superfície:** cada corpo fica identificado pela feature que o criou. Aparar mantém o corpo; costurar e espessar consomem os corpos de entrada. As faces de superfície aparecem a âmbar, escolhem-se no 3D como as do sólido e entram na exportação (STEP, STL e malhas). O painel lateral mostra a área e as arestas livres de cada corpo; com 0 arestas livres o corpo está fechado e pode ser costurado em sólido.

**Análises (separadores Superfícies e Avaliar):**
- **Riscas de zebra**: riscas contínuas indicam tangência (G1); riscas sem quebra de direção indicam curvatura contínua (G2).
- **Curvatura**: gaussiana ou média, exata em cada vértice (projeção na superfície e derivadas de 2.ª ordem do OpenCASCADE), com escala no percentil 95.
- **Inclinação** (*draft*) em relação a X, Y ou Z, com ângulo mínimo: verde = positiva, vermelho = negativa, amarelo = precisa de inclinação.
- **Desvio nas arestas**: ângulo máximo entre as normais das duas faces de cada aresta. Verde = tangente (≤ 0,5°), âmbar = quase tangente (0,5–10°, normalmente um defeito), cinzento = aresta viva. Os preenchimentos, superfícies limite e remendos medem o próprio desvio de tangência e avisam acima de 1°.
- São ferramentas de verificação visual da geometria. Não substituem a verificação de um processo de fabrico (moldação, extração) nem são certificação de qualidade de superfície.

**Modelo paramétrico:**
- **Variáveis globais e equações**, com dependências e deteção de ciclos. O avaliador de expressões é seguro: unidades, trigonometria em graus e `if`.
- **Árvore de features**: editar, renomear, suprimir, apagar (com aviso dos dependentes), reordenar (arrastar ou menu, com validação) e **barra de rollback**.
- **Nomeação topológica estável**: as faces e arestas têm nomes derivados do histórico do OpenCASCADE, por exemplo `f2:side:l5` (a face lateral gerada pela linha l5 da extrusão f2) ou `{f2:end:l5&f2:side:l5}` (a aresta entre duas faces). Por isso, um filete continua na aresta certa depois de se mudar uma cota ou de um corte a montante dividir a face.
- Reconstrução **incremental** com cache: editar a feature k só reconstrói de k em diante.
- Desfazer e refazer; propriedades de massa com massa volúmica configurável.

**Projeto, montagens, desenhos e BOM (Fase 3):**
- **Projeto** com várias peças, montagens e desenhos num só `.cadp.json`, em abas (＋ para criar). Cada peça tem propriedades (número, descrição, material com massa volúmica típica, acabamento, fornecedor, propriedades personalizadas).
- **Montagens**: inserir peças ou subconjuntos; mates coincidente, concêntrico, paralelo, perpendicular, distância, ângulo, tangente e fixar, escolhidos no 3D (faces planas, cilíndricas/cónicas, arestas retas/circulares) ou nos planos/eixos padrão; a árvore mostra os graus de liberdade livres e os mates não cumpridos. Massa total com a densidade de cada peça; deteção de interferências (volume comum a vermelho).
- **Desenhos**: folha ISO (A4–A0, 1.º ou 3.º diedro, escala), legenda preenchida a partir da peça; "3 vistas + iso" de uma vez; vistas projetadas alinhadas, cortes, pormenores e auxiliares; cotas importadas do modelo e cota inteligente; GD&T, referências, rugosidade, soldadura, notas, balões automáticos e tabela de BOM. Tudo é associativo: muda com o modelo. Exportação PDF, DXF e SVG em tamanho real.
- **BOM** (separador Montagem → BOM): nível de topo, só peças ou indentada, CSV/XLSX. O **assistente** propõe descrições, normalizados reconhecidos pela geometria, processo, material de partida, duplicados, incoerências e custo indicativo — cada sugestão aceita-se ou ignora-se. Opcionalmente, com uma chave API da Anthropic (fica só em memória), pede sugestões ao Claude (`claude-opus-5-5`, resposta estruturada; envia a BOM e um resumo da geometria, não os ficheiros).
- Os valores de normalizados, densidades e custos são de referência: confirmar na norma, na ficha do material e com cotações. Nada disto é certificação.

**Fase 4 — o melhor do CATIA:**
- **Superfícies GSD** (separador Superfícies → GSD):
  - **multi-secção** com guias (superfície de Gordon: passa exatamente pelas secções e pelas guias), spine e tangência às faces de suporte na primeira/última secção;
  - **concordância** (*blend*) entre duas curvas com contacto, tangência (Hermite cúbica) ou curvatura (quíntica com a curvatura normal das faces de suporte) e tensão em cada lado;
  - **varrimento circular** por 3 guias, por 2 guias e raio, ou tubo em torno de uma curva;
  - **varrimentos avançados** (sólidos e superfícies): binormal fixa, normal das faces de suporte, curva guia (só orienta, contacto ou bordo) e lei de escala linear ou em S;
  - **extrapolar** superfícies (tangente ou curvatura, comprimento ao longo da extensão) e curvas; regrada a um ângulo da superfície;
  - **juntar** (costura com verificação de ligação e de tangência, e simplificação) e **curar** (fecha folgas, corrige faces, assinala arestas quase tangentes).
- **Classe A** (Superfícies → Classe A): **continuidade G0–G3** em cada aresta (folga, ângulo, salto de curvatura e da sua derivada), **linhas de realce** fixas no espaço (com as normais exatas do núcleo) e **pentes de curvatura** (*porcupine*) das arestas escolhidas ou de todas as curvas.
- **Forma livre**: superfície B-spline com controlo direto dos polos (patch num plano ou face convertida); os polos arrastam-se no 3D (livre ou num eixo) ou editam-se numericamente, e as edições ficam guardadas por índice, por cima do patch paramétrico.
- **Knowledgeware** (separador Conhecimento):
  - expressões com comparações e lógica (`if(L > 100 and t < 3, 5, 3)`);
  - **regras** (se/então/senão sobre variáveis, aplicadas por ordem até estabilizar);
  - **verificações** com as variáveis e as medidas do modelo (volume, área, massa, dimensões), mostradas no painel lateral;
  - **tabela de configurações** (famílias de peças): variáveis, supressão de features e propriedades por configuração; importação/exportação CSV; cada componente de uma montagem pode usar outra configuração e a BOM separa-as;
  - **templates de features** (PowerCopy/UDF): um grupo de features com as entradas (referências exteriores) e parâmetros (variáveis); instanciar noutra face/peça; exportar/importar `.cadt.json`.
- **Publicações e referências externas**: cada peça publica geometria com nomes estáveis (faces, arestas, planos, eixos, esboços, superfícies, o corpo); outra peça copia uma publicação **ligada** (acompanha a origem) ou **congelada** (fica a cópia, com aviso se a origem mudar), na origem comum ou com a posição lida de uma montagem; ciclos são detetados. Os mates podem referir publicações (`@Nome`).
- **STEP AP242**: produtos com nome (número + nome), cores, corpos sólidos e de superfície separados e, nas montagens, a estrutura de produto com uma ocorrência por instância.

**Simulação (pré-processador FEM/CFD, separador Simulação):**
- **Estudos** na peça: FEM com o **CalculiX** (estática linear, modal, encurvadura, térmica em regime permanente) e CFD com o **OpenFOAM** (simpleFoam + snappyHexMesh, interno ou externo, laminar/k-ω SST/k-ε) ou o **SU2**. Condições nas faces pelo nome topológico (encastramento, deslocamento, força, pressão, gravidade, temperatura, convecção, fluxo; entrada/saída ou escoamento livre); materiais e fluidos de referência; malha **Gmsh** (tetraedros quadráticos) ou snappyHexMesh.
- **Exportar caso (.zip)**: BREP exato, script Gmsh, dicionários/deck, `case.json`, LEIA-ME com hipóteses e passos.
- **Calcular no agente local**: `node cad-runner.mjs --serve` (descarrega-se no painel) corre os solvers instalados na máquina como processos separados e devolve os resultados: resumo (flecha, von Mises, fator de segurança, frequências, reações, caudal, balanço de massa, queda de pressão, arrasto de pressão) e, no FEM, os campos a cores no 3D com a deformada.
- **Não linear** (estática): grandes deslocamentos e rotações (NLGEOM) e plasticidade de von Mises com encruamento bilinear (cedência e módulo tangente do material), em incrementos, com a curva carga–deslocamento e a deformação plástica equivalente.
- **Montagens**: estudos FEM na própria montagem, um volume e um material por corpo, condições nas faces dos componentes e contacto nas faces planas coincidentes entre corpos: **colado** (*TIE) ou **com atrito de Coulomb e separação** (penalidade face a face, carga em incrementos), com a reação de cada apoio (ex.: a força de atrito transmitida).
- **CFD no 3D**: pressão nas paredes/entrada/saída e cortes planos pela malha do OpenFOAM com pressão e |U|, camadas que se ligam e desligam, escala comum.
- **Convergência da malha**: três malhas (h, r·h, r²·h) ou **refinamento automático até ao GCI alvo**, com a ordem aparente, o valor extrapolado (Richardson), o GCI (Celik et al. 2008 / ASME V&V 20) e o gráfico por nível; **sondas** (média ou máximo numa face, nó mais próximo de um ponto) como grandezas a seguir.
- **code_aster 18.1** como alternativa ao CalculiX (estática linear e não linear — plasticidade, grandes deslocamentos —, modal e montagens coladas por LIAISON_MAIL), verificado com os mesmos casos analíticos.
- Os resultados são apoio à decisão de engenharia, com as hipóteses à vista; não são certificação.

**Automação e análise integrada (separador Automação):**
- **Scripts** JavaScript sobre a API `cad.*` (variáveis, features, reconstrução com medidas, simulações no agente, `grid`/`linspace`, superfície de resposta RBF com erro por validação cruzada, tabelas CSV, cálculos e XFOIL): correm num worker isolado sem rede nem disco, sobre uma cópia do modelo, e em lote em Node (`tools/cad-script.ts`).
- **Copiloto** (Claude, opcional, chave só em memória): gera e corrige scripts a partir de um pedido, e interpreta os resultados com prudência; o código aparece para revisão e nunca corre sozinho.
- **Análise integrada Galkeel**: escolhem-se as faces do casco, a geometria do painel (b, l, flecha) é medida no modelo, as pressões e a espessura FRP vêm dos módulos da [galkeel-calculadora](https://github.com/jjvherbert/galkeel-calculadora) (submódulo, sem reimplementar; ISO 12215-5:2008, edição retirada) e um estudo FEM verifica a tensão com a mesma pressão; relatório HTML/JSON e envio ao caso da galkeel-app no contrato `galkeel:calculator-result`, sempre com veredito indeterminado.
- **Cálculos e perfis**: atmosfera ISO 2533 com Reynolds/Mach, asa finita (DATCOM), perfis NACA de 4 dígitos, coluna de Euler–Johnson (com a secção lida de uma face plana do modelo), encurvadura de placas; cada um com referência, hipóteses, caso de verificação e relatório. **Polares XFOIL** no agente (NACA ou coordenadas), gráficos CL–α e CL–CD, CLα para a asa finita e esboço do perfil no CAD.

**PMI 3D e atributos (separador PMI, Fase 5):**
- **Anotações semânticas** ligadas às faces pelo nome topológico: referências (ISO 5459), cotas de distância, diâmetro, raio e ângulo com **o valor medido no modelo** e afastamentos ou **classe ISO 286** (tabelas IT5–IT11 e afastamentos fundamentais até 500 mm, com o ajustamento furo/veio e as folgas), quadros de **tolerância geométrica ISO 1101** (14 características, ⌀, Ⓜ/Ⓛ, até três referências), estados de superfície (Ra) e notas.
- **Validação** contra a norma e a geometria: tolerâncias de forma sem referências, orientação/localização com referência, planeza só em planos, cilindricidade só em faces de revolução, ⌀ e Ⓜ só onde se aplicam, referências definidas, faces paralelas nas distâncias, valor fixado igual ao do modelo.
- **Rótulos no 3D** com linha de chamada, que acompanham a câmara; clicar num rótulo abre o item.
- **Vistas de modelo** (MBD): orientação da câmara + PMI a mostrar.
- **Atributos (tags)** no corpo, em features e em faces; pesquisa no projeto inteiro (sem acentos) e exportação CSV.
- **PMI nos desenhos 2D** («Importar PMI»): cotas com tolerância na vista onde a grandeza está em verdadeira grandeza (⌀ na vista do círculo), GD&T, referências, rugosidade e notas na vista onde a face se vê de perfil; associativos (o conteúdo e a ancoragem seguem o modelo).
- **STEP AP242 com PMI semântico**: datums, cotas com tolerância ou ajustamento, tolerâncias com sistema de referências, modificadores e zona cilíndrica, ligados às `ADVANCED_FACE`; rugosidade, notas e atributos como atributos definidos pelo utilizador. Verificado com o leitor GD&T do OpenCASCADE (`tools/read-step-pmi.py`).

**Ficheiros:**
- Projeto em JSON aberto e legível (`.cadp.json`), com regras, verificações, configurações, publicações e templates.
- Exportação para **STEP AP214** (sólido exato), **STEP AP242** (produtos, cores, estrutura, PMI semântico e atributos), **STL**, **3MF**, **OBJ** e **glTF (.glb)**, sempre em milímetros.

## Navegação e comandos (como no SolidWorks)

| Rato | Ação |
|---|---|
| Botão do meio, arrastar | Rodar (com o centro de rotação no ponto clicado com o meio, se houver) |
| Ctrl + meio | Deslocar |
| Shift + meio (para cima/baixo) | Zoom |
| Alt + meio | Rolar |
| Roda | Zoom no cursor (para a frente afasta; inverte-se nas preferências) |
| Duplo clique no meio | Ajustar ao ecrã |
| Clique esquerdo | Selecionar (Ctrl/Shift soma) e mostrar a barra de contexto |
| Arrastar no vazio | Caixa de seleção: → janela (o que está dentro), ← cruzamento (o que toca) |
| Duplo clique numa face | Editar a feature que a criou |
| Botão direito | Menu de contexto |
| Arrastar com o direito | Gestos do rato (8 direções, configuráveis) |

| Teclado | Ação |
|---|---|
| Ctrl+1…7 | Frente, trás, esquerda, direita, topo, baixo, isométrica |
| Ctrl+8 | Normal a (face ou plano selecionado) |
| Espaço | Orientação da vista |
| F / Z / Shift+Z | Ajustar / afastar / aproximar |
| Setas, Shift+setas | Rodar 15°, 90° |
| Alt+←/→ · Ctrl+setas | Rolar · deslocar |
| Ctrl+Shift+Z | Vista anterior |
| S | Barra de atalhos com pesquisa de comandos |
| Enter | Repetir o último comando (num painel aberto: OK) |
| Ctrl+B / Ctrl+Q | Reconstruir / forçar reconstrução completa |
| Ctrl+Z / Ctrl+Y · Ctrl+N/O/S · Delete · Esc | Desfazer / refazer · novo / abrir / guardar · apagar · cancelar |

A barra de comandos está organizada em separadores como o CommandManager (Features, Esboço, Referências, Avaliar, Módulos). Sobre o 3D há uma barra de vista com ajustar, vista anterior, orientação, normal a, estilo de visualização e planos. Os comandos estão num registo único (`src/app/commands.ts`), que alimenta o teclado, os menus, os gestos e a pesquisa.

## Arquitetura

```
src/
  doc/      modelo de documento (JSON), expressões, variáveis, histórico, tabelas de furos — sem núcleo geométrico
  sketch/   geometria 2D, solver PlaneGCS, deteção de perfis, operações de edição (puras)
  kernel/   OpenCASCADE: nomeação topológica, motor de reconstrução, features (sólidos e superfícies), malha, análises, worker
  io/       exportação de malhas (3MF, OBJ, glTF)
  plugins/  módulos de domínio (metadados para a UI + geometria para o worker)
  assembly/ solver de mates, BOM, malha de montagem (puros)
  drawing/  folha de desenho: geometria 2D, primitivas, render, edição, exportação SVG/PDF/DXF (puros)
  ai/       assistente de BOM local e sugestões do Claude (opcional)
  geom/     matemática pura das superfícies GSD: splines, Gordon, Hermite, círculos
  sim/      pré-processador (puro): caso neutro, Gmsh, CalculiX (deck e resultados), code_aster, OpenFOAM, SU2, XFOIL, GCI
  script/   API dos scripts cad.*, estudos paramétricos, superfície de resposta (puros)
  calc/     biblioteca de cálculos de engenharia com casos de verificação (pura)
  galkeel/  análise integrada de painéis: carrega a galkeel-calculadora (vendor/, submódulo) sem a alterar
tools/      agente local cad-runner (Node, sem dependências): corre os solvers e serve a aplicação; cad-script (lote)
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

## Limitações conhecidas (Fases 1 a 5)

- Aparar não trata splines (apaga-as) e as entidades convertidas não se aparam. O deslocamento assume que a cadeia tem uma orientação coerente.
- Sem regiões escolhidas, contornos que se intersetam ou ramificam dão erro e pedem a escolha das regiões. Por agora, a escolha de regiões só existe na extrusão e na revolução.
- Feature fina (*thin*) e "até ao próximo" ainda não existem. "Até à face" só aceita faces planas.
- O furo usa os pontos isolados do esboço, sem o assistente de posicionamento do SolidWorks. A rosca é cosmética, não modelada.
- Multi-corpo simples: "corpo separado" junta sem fundir; não há gestão de corpos.
- Importação só em STEP: o IGES não está disponível nesta compilação WASM do OpenCASCADE.
- Superfícies:
  - com uma face vizinha quase perpendicular ao remendo, a tangência pode não ser cumprida (limitação do algoritmo de placa do OpenCASCADE). O desvio é medido e avisado;
  - apagar e remendar preenche o buraco mas não prolonga as faces vizinhas, por isso não reconstrói cantos vivos. O *delete and heal* do OCC não existe nesta compilação WASM;
  - substituir face pressupõe faces laterais aproximadamente paralelas à normal da face substituída;
  - a projeção de curvas é feita segundo a normal do esboço, por interseção com uma extrusão do esboço. Não há projeção segundo a normal da superfície.
- Montagens: os componentes movem-se pelos mates e pela posição inicial (painel do componente), ainda não arrastando com o rato; sem peças em contexto nem vistas explodidas. Os subconjuntos são rígidos.
- Desenhos: a linha de corte é reta (sem cortes por patamares); o pormenor não desenha a fronteira irregular; não há DWG nativo (usar o DXF); as cotas de desenho medem a projeção (verdadeira grandeza só em faces paralelas à vista).
- Assistente de BOM: o reconhecimento de normalizados usa tabelas nominais pequenas (M3–M24, anilhas ISO 7089, 12 rolamentos) e geometria sem rosca modelada.
- Fase 4:
  - as superfícies construídas por amostragem (multi-secção com guias ou tangências, concordância, varrimento circular por guias, extrapolação em curvatura) são B-splines que interpolam uma grelha: a continuidade pedida é aproximada e **sempre medida e reportada**. A concordância e a extrapolação usam polos exatos no sentido transversal;
  - com guias, a tangência nos extremos só é exata se as guias também forem tangentes às faces de suporte; a spine só é usada sem guias nem tangências;
  - G3 é indicativo (derivada da curvatura por diferenças finitas); criar concordâncias G3 ainda não existe;
  - as linhas de realce são calculadas na malha de visualização: onde a amplificação é extrema (normal quase rasante às luzes) pode aparecer serrilhado ou uma zona cinzenta;
  - a forma livre converte a superfície completa da face (sem recortes) e a conversão de faces não B-spline gera n+2 polos por direção;
  - a cura não deforma superfícies para repor tangência (só assinala); o *delete and heal* com prolongamento das faces vizinhas continua por fazer;
  - templates: as coordenadas dentro dos esboços copiados são relativas ao plano/face de entrada (o referencial da face escolhida pode ter os eixos invertidos);
  - referências externas: a posição lida de uma montagem é guardada (não acompanha a montagem automaticamente: "Ler posição" de novo); peças em contexto completas (editar a peça dentro da montagem) continuam por fazer;
  - AP242: estrutura de montagem achatada (uma ocorrência por instância, sem subconjuntos aninhados).
- Simulação:
  - material isotrópico; só elementos sólidos tetraédricos (sem cascas, vigas, hexaedros nem métricas de qualidade da malha); contacto só em faces planas coincidentes (atrito só no CalculiX); sem transitório nem fadiga;
  - o code_aster cobre estática, não linear, modal e contacto colado (não encurvadura, térmica nem atrito);
  - XFOIL: a compilação Debian precisa da biblioteca `xfoil-nofpe`; ângulos que não convergem são omitidos (com uma segunda passagem automática);
  - o copiloto só foi testado com respostas simuladas (sem chave da API neste ambiente);
  - SU2 não corrido neste ambiente; arrasto externo só de pressão; os cortes CFD interpolam valores de célula para os pontos (média das células vizinhas);
  - os solvers não são distribuídos com a aplicação: instalam-se à parte.
- PMI (Fase 5):
  - só representação semântica no STEP (sem a apresentação gráfica: texto e linhas de chamada não vão no ficheiro); os visualizadores que só leem a apresentação não o mostram;
  - o afastamento inferior vai com sinal (−0,2), como pede a regra WR1 de `tolerance_value` (superior ≥ inferior); o leitor do OpenCASCADE 8.0 lê-o sem sinal (0,2), o que é uma divergência desse leitor;
  - ISO 286 só para furos E, F, G, H, JS e veios e, f, g, h, js, k, m, n, p, graus IT5–IT11, até 500 mm;
  - não se mede a conformidade da peça (é a especificação de projeto, não a inspeção); só em peças (não em montagens);
  - no desenho: sem teste de visibilidade (um rótulo pode apontar para uma face oculta), ângulos como texto, colocação automática dos rótulos aproximada (arrastar para afinar).
- O nome de uma face dividida pode mudar de sufixo (`~0`, `~1`) se a ordem geométrica das partes mudar. As referências por nome-base e por posição cobrem a maioria dos casos e deixam um aviso.

## Propriedade intelectual

As funcionalidades inspiram-se no que o SolidWorks e o CATIA fazem bem, mas a implementação é independente (*clean-room*). Não usa código, binários nem formatos nativos proprietários. A interoperabilidade faz-se por formatos abertos.

Licença: **proprietária, todos os direitos reservados** (ver `LICENSE`). As bibliotecas de terceiros mantêm as suas licenças e obrigações (ver `THIRD_PARTY_NOTICES.md`). Em particular, o OpenCASCADE e o PlaneGCS, que são LGPL, têm de continuar a ser módulos WASM substituíveis.
