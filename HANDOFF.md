# Handoff — Fases 1 a 5 e pré-processador de simulação (F1–F3)

## Atualização: esboço transparente sobre o modelo e convergência da malha configurável

Pedido de Juan: «Garante que o esboço é apresentável. Gosto da animação do esboço do SolidWorks quando passas da peça ao esboço e não gosto do fundo azul. Gosto do fundo transparente… Garante que o pré-processador consegue competir com o Abaqus e ser tão forte como o Femap, permitindo configurar internamente já estudos de convergência de malha e extrair tabelas, gráficos e resultados das mesmas». A maquinagem (R5) fica para depois.

**Esboço (commit `996ca9d`)**
- `Viewport.setSketchCamera` / `leaveSketchView` (`viewport.ts`): a câmara 3D fica normal ao plano e alinhada com o editor 2D (px = tx + u·k, py = ty − v·k), por isso o modelo vê-se por trás do esboço transparente; panorâmica e zoom movem os dois. Ao abrir, a vista desliza da peça para o plano (como o SolidWorks) e o esboço entra depois; ao sair, volta à vista anterior com transição. O seletor de plano já não roda a câmara (fá-lo o editor), e sem planos azuis durante o esboço.
- Barra compacta (ícones; nome da ferramenta ativa), canto de confirmação ✓/✕, grelha discreta, contorno claro nas entidades.

**Convergência (este commit)**
- Relatório (`src/sim/convergence.ts`, `tools/cad-runner.ts`): `levels` (todas as malhas com todas as grandezas, tamanho, elementos, tempo) e `setup`. Estudo: `FemStudy/CfdStudy.convergence` (configuração) e `convergenceRuns` (últimos 6). `runActiveStudy` usa a configuração do estudo (já não o estado global `simRun`, removido) e guarda o relatório; `runConvergence` liga-a e corre.
- `src/sim/convreport.ts` (puro): tabelas (malhas, GCI, erro vs. extrapolado), gráficos SVG em texto, CSV, relatório HTML, tamanhos previstos. `src/io/table.ts`: XLSX com várias folhas. `ConvergencePanel.tsx`: configuração, malhas previstas, histórico, tabelas, três gráficos e exportações (CSV, XLSX, JSON, SVG, PNG, HTML, imprimir/PDF); `ResultExports` extrai resumo, métricas, histórias no tempo e qualidade da malha.
- Correção: os blocos do painel de simulação já não encolhem (um `fieldset` num contentor flex sobrepunha o bloco seguinte).
- **Testes** (`tests/convstudy.test.ts`, 4, CalculiX real: 3 malhas com todas as grandezas, extrapolação a 5 % de Timoshenko; tabelas, CSV, XLSX, SVG e HTML; planeamento) e e2e da simulação reescrito (configurar, correr, tabelas, 3 gráficos, guardado no estudo, extrair CSV/XLSX/JSON/SVG/HTML, varrimento de 7 malhas com dois estudos guardados).
- **Limites:** o GCI é uma estimativa de incerteza (três malhas mais finas), não uma garantia; modos «automático» e «varrimento» seguem uma grandeza (as outras ficam nas tabelas, com GCI do trio mais fino); a CFD usa o mesmo painel mas não foi reverificada nesta passagem; os PNG dependem do canvas do navegador.
- **Por fazer no R4:** cargas e apoios em arestas, molas, massas pontuais, acoplamentos, referenciais locais, passos múltiplos, conjuntos de arestas e volumes.

## Atualização: revisão de usabilidade do R3 e primeira parte do R4 (pré-processador)

Pedido de Juan: «Verifica que não me obriga a fazer cliques demais, que há boas animações e que os duplos cliques funcionam. Depois passa ao r4».

**Revisão (R3)** — achados e correções
- Duplo clique numa face no espaço FEM/CFD entrava numa edição de feature invisível (sete botões da barra desativados até Esc): agora abre e destaca a condição da face (`conditionAtFace`), ou avisa; na árvore do modelo o duplo clique no estudo renomeia e na condição ativa a escolha das suas faces.
- Enter com a escolha de faces ativa repetia o último comando; agora conclui a seleção.
- O espaço FEM abria no separador «Estudo» e tinha de se clicar em «Cargas e apoios»: abre agora direto nele (com a secção correspondente no painel). Escolha do plano: teclas 1, 2, 3 e Enter. Contagem: condição = 1 clique na barra + 1 na face.
- Animações acrescentadas: entrada dos painéis, mensagens, banner da seleção, menus, diálogos, linhas da árvore, destaque da condição, e as faces de uma feature recém-confirmada acendem e desvanecem-se (`flashFeature`). Falta: animar a deformada ao aparecer um resultado.
- Teste auxiliar: `data-last-dbl-click` no `.viewport` (o último duplo clique no 3D).

**R4 (parte 1)** — `src/sim/modelcheck.ts` (novo): `checkStudy` (erros/avisos/notas por secção), `CAPABILITIES` (matriz por solver) e `solverVerdict`; `runActiveStudy` bloqueia com erros (não bloqueia a pré-visualização da malha). Painel «Verificação do modelo» (`CheckPanel` em `SimPanel.tsx`) e nó «Verificação» na árvore. `FemSet`/`FemStudy.sets` e `sets` em cada condição; carga `symmetry` (resolvida em `kernel/sim.ts` para deslocamento normal nulo por eixo, com `CaseFace.normal`); carga `pointForce` (nó mais próximo; CalculiX `*CLOAD`, code_aster `FORCE_NODALE`; recusada no OpenRadioss).
- **Testes** (`tests/preproc.test.ts`, 8, CalculiX 2.21 e code_aster 18.1 reais): conjuntos = faces diretas; simetria (meia viga com metade da carga = viga inteira a 1 %, Timoshenko a 4 %; code_aster a 5 %); força pontual (flecha a meio vão contra Timoshenko a 3 % nos dois solvers, reação = força); regras de verificação; matriz por solver; CFD. E2e de interação alargado (duplo clique, renomear, atalhos, conjuntos, simetria, verificação, bloqueio com F5).
- **Limites:** a matriz diz o que *este software* implementa, não o que o solver sabe fazer; a simetria só aceita faces planas alinhadas com os eixos (as inclinadas pedem *TRANSFORM/referencial local, por fazer); a força pontual dá singularidade local (aviso no resultado).
- **Por fazer no R4:** cargas e apoios em arestas (grupos físicos de curvas no Gmsh), molas, massas pontuais, acoplamentos RBE2/RBE3, referenciais locais, passos múltiplos, conjuntos de arestas e volumes.

## Atualização: redesign R3 (interação ao estilo do SolidWorks)

Pedido de Juan: «O desenho deve mesmo imitar o solidworks, com os atalhos do rato, as animações na aplicação e as transições e escolhas de plano… Deve ter funções de preview também e deve ter a mesma cena do solidworks que explica o que uma feature faz».

**Alterações**
- `src/app/viewport.ts`: `smooth()` — as mudanças de câmara (`view`, `normalTo`, `fit`, `setCameraView`, `previousView`) animam ~380 ms (slerp da orientação, centro, distância e zoom em log); o estado final fica logo publicado nos atributos `data-*` e `data-animating` indica a transição; `finishAnim()` salta para o fim em qualquer gesto (`onDown`, `onWheel`, rodar, rolar, deslocar, zoom); `animate` desligado com `prefers-reduced-motion`; o primeiro enquadramento ao abrir é instantâneo. `setHoverKey` (realce vindo de um painel), `setPreviewFeature` (faces da feature em edição a amarelo; `data-preview-faces`).
- `src/app/Dialogs.tsx`: `PlaneChooser` novo — cartões Planta/Frente/Lateral com realce do plano no 3D, seleção no 3D ativa logo (plano ou face plana), rotação para o plano (`planeFrame` em `commands.ts`) e só depois abre o esboço; o editor entra com uma transição (`.sketch-editor`).
- `src/app/featurehelp.tsx` (novo): ajuda por feature — figuras SVG com SMIL (sem animação em movimento reduzido), texto (o que faz, passos, nota) para 18 features da barra e 11 comandos da simulação; `FeatureTip` (dica flutuante na barra, ~0,55 s) e `HelpCard` (cartão «O que faz» recolhível no painel, escolha em `localStorage`).
- `tests/e2e/interacao.e2e.cjs` (novo, também em `npm run test:e2e`): transição e estado final, gesto a saltar a animação, dica na barra, escolha do plano com rotação, cartão e pré-visualização, movimento reduzido.

**Limites:** a pré-visualização é a geometria reconstruída com as faces novas a amarelo (não há malha translúcida separada); uma feature que não cria faces próprias (ex.: união idêntica) não mostra amarelo; as figuras são esquemáticas (isometria fixa), não a geometria real do utilizador; só há dicas para as features do separador Features/Referências e para a simulação.

**Próxima ação:** R4 — pré-processador FEM ao nível Abaqus/Femap (sets, passos múltiplos, acoplamentos, molas, massas pontuais, referenciais locais, cargas em arestas e vértices, simetria, verificação dos dados e matriz de compatibilidade por solver).

## Atualização: redesign R1 (instalador) e R2 (espaços de trabalho)

Pedido de Juan (redesign): «O desenho deve mesmo imitar o solidworks… As coisas devem ser por módulos, tipo fusion: modulo cad, módulo fem, cfd, machining, etc, cada um com a sua barra de tarefas inteira e especificidades e vai adaptando o modelo… A experiência do instalador deve ser melhor… Em vez de descarregar o zip descarregas logo o instalador com o logo… O módulo de pré-processado do fem está muito fraco». Plano em cinco etapas no `ROADMAP.md` («Redesign»); R1 e R2 feitas aqui, R3–R5 por fazer.

**R1 — instalador** (commits `909dbda`, `ae1261b`): `desktop/brand/` (símbolo GK e logótipo horizontal — variações finais 03 e 02, as únicas válidas são as com GK — e o gerador `make-assets.py`), `desktop/build/` (ícone, barra lateral, cabeçalho), NSIS assistido com a marca, ecrã de arranque em `desktop/main.cjs`, versão 0.2.0; o workflow publica uma release em rascunho com o `.exe` (etiqueta `v*` ou lançamento manual com `release = true`; o proxy deste ambiente não deixa empurrar etiquetas).

**R2 — espaços de trabalho** (Fusion 360):
- `src/app/workspaces.ts` (novo): Design, Simulação FEM, Simulação CFD, Desenho; separadores de cada um; FEM na ordem do Abaqus/CAE (Estudo → Propriedades → Cargas e apoios → Malha → Resolver → Resultados); cada separador abre a secção correspondente; Ctrl+Alt+1…4.
- `src/app/SimBrowser.tsx` (novo): árvore do modelo (estudos e secções com resumo e estado, condições com a cor de cada uma).
- `src/app/sim-actions.ts` (novo): estudos, condições (`addCondition` abre a seleção de faces), sondas, materiais, malha, cálculo (`runActiveStudy`, também F5) e cores das condições no 3D.
- `src/app/SimPanel.tsx` reorganizado por secções (cabeçalho do PropertyManager, barra de progresso); `src/app/Toolbar.tsx` (marca, seletor de espaço, rótulos curtos `Command.short`); `src/app/viewport.ts` (`setConditionFaces`); `src/app/style.css` (identidade Galkeel: navy/teal, Montserrat, animações discretas com `prefers-reduced-motion`).
- O separador «Simulação» do Design deu lugar ao espaço FEM; o comando antigo `sim.panel` abre-o.

**Testes:** `tsc` limpo; e2e da simulação reescrito para os espaços de trabalho (barra própria, separador → secção, + pressão com seleção de faces, convergência por F5 a partir de outra secção, hexaedros pela barra, Design volta a mostrar o corpo, montagem); capturas revistas (menu de espaços, árvore FEM, cargas a cores no 3D, materiais, malha).

**Limites:** os comandos térmicos aparecem também nos estudos estruturais (dão uma mensagem clara em vez de ficarem cinzentos); sem espaço Fabrico ainda; o Desenho mantém a barra anterior.

**Próxima ação:** R3 — interação SolidWorks (transições de câmara animadas, escolha do plano ao abrir um esboço, pré-visualização amarela, PropertyManager ✓/✕, dicas animadas por feature).

## Atualização: malha manual (seeds, hexaedros, qualidade e pré-visualização)

Pedido de Juan: «Quero elementos hexaédricos e dinâmica implícita e explícita… O openradioss é uma opção» e «Quero um mesher bom em que possa pôr seeds… como o pré-processador do Femap… meshes de qualidade para poder equiparar a um Abaqus… convergence study: escolher um ponto aproximado da peça… 3 parâmetros acima e abaixo». Esta etapa fecha a malha; a convergência ±3, a dinâmica e o OpenRadioss vêm a seguir (ver `ROADMAP.md`, «Malha manual, dinâmica e explícito»). O módulo de otimização (scripts, otimização topológica) fica registado no ROADMAP para depois.

**Alterações**
- `src/sim/elements.ts` (novo): topologia e numeração Gmsh → CalculiX/Abaqus → code_aster de tet4/tet10/hex8/hex20 e tri3/tri6/quad4/quad8; integrais das faces por Gauss (áreas nodais e vetores área consistentes).
- `src/kernel/meshplan.ts` (novo): plano da malha a partir da topologia exata — volumes hexaédricos, classes de arestas opostas (union-find), seeds (n.º/tamanho, razão maior/menor, início/fim/pontas/meio), propagação e conflitos.
- `src/sim/gmsh.ts`: `Transfinite Curve/Surface/Volume`, `Recombine`, `SubdivisionAlgorithm`, `SecondOrderIncomplete`; sem `HighOrderOptimize` nos hexaedros (o Gmsh ficava minutos a otimizar).
- `src/sim/calculix.ts`, `src/sim/aster.ts`, `src/sim/msh.ts`: decks e resultados genéricos por tipo de elemento; C3D8I/C3D8/C3D8R/C3D20R/C3D20; HEXA8/HEXA20 com `3D`/`3D_SI` (linhas do `.mail` partidas a 80 colunas); prismas/pirâmides recusados com mensagem clara.
- `src/sim/quality.ts`, `src/sim/meshview.ts` (novos), `tools/cad-runner.ts` (`previewMesh`, `POST /mesh`, conferência das arestas pelas caixas das curvas, seeds escaladas nas convergências).
- `src/doc/study.ts` (`element`, `hexMethod`, `integration`, `seeds`, `mapped`), `src/kernel/sim.ts`, `src/app/SimPanel.tsx` (editor da malha, «Pré-visualizar malha», relatório de qualidade), `src/app/viewport.ts` (arestas dos elementos), `src/app/sim-client.ts`.

**Testes** (`tests/mesh.test.ts`, 8; Gmsh 4.15.2, CalculiX 2.21, code_aster 18.1 reais): consola de Timoshenko (δ = 0,19196 mm) em C3D8I e C3D20R a < 3 %, HEXA20 a < 3 %, HEXA8 `3D_SI` a −5,5 % (4 camadas), C3D8 com bloqueio por corte visível (87 %); pressão em quad8 → reação 1000 N exata; seeds com bump e progressão no Gmsh real; numeração das arestas Gmsh = OpenCASCADE confirmada; subdivisão numa placa com furo (estruturado recusado, automático passa a subdivisão); pré-visualização (volume 10 000 mm³, jacobiano 1, 168 faces exteriores com arestas). E2e da simulação com hexaedros: pré-visualização, qualidade e consola em C3D20R na app (0,1910 mm). Os testes de hexaedros entram também na CI do instalador (Windows real).

**Limites:** os limites de qualidade «do Abaqus» são os do Verify Mesh por omissão tal como os conheço (ângulos 10°/160° em quadriláteros e 5°/170° em triângulos, aspeto 10, fator de forma 10⁻⁴) — VALIDAR com a documentação do Abaqus de Juan; a distribuição «bump» do Gmsh é aproximada (a pré-visualização mostra a real); sem partição de sólidos em blocos dentro da app (uma peça que não é bloco só tem hexaedros por subdivisão).

**Convergência ±3 níveis num ponto** (mesmo pedido): modo «±3 níveis» no estudo de convergência — 7 malhas h·r^k, k = 3 … −3 (`RunOptions.convergence.sweep`), sonda «Ponto» com «Escolher ponto no 3D», gráfico e tabela com a malha pedida destacada, monotonia, extrapolação/GCI no trio mais fino e erro estimado da malha pedida (`ConvergenceReport.sweep`). Testado no agente (`tests/mesh.test.ts`) e na app (e2e da simulação: 7 malhas de hexaedros, monotónica).

## Atualização: dinâmica implícita e explícita (CalculiX e code_aster)

Análise «Dinâmica transitória» no estudo FEM (`FemStudy.dynamic`, `FemCase.dynamic`): implícita (CalculiX `*DYNAMIC, DIRECT`, α-HHT; code_aster `DYNA_NON_LINE` Newmark) ou explícita (CalculiX `*DYNAMIC, EXPLICIT`; code_aster `DIFF_CENT` com `MASS_DIAG`, sempre `3D`); cargas em degrau, rampa, meio seno ou seno (`*AMPLITUDE`, `FONC_MULT`); Rayleigh C = α·M + β·K (`*DAMPING`; no code_aster AMOR_BETA = α e AMOR_ALPHA = β, confirmado pelo teste); passo estável da malha no explícito (`stableIncrement`: 0,35·Lc/cd, metade nos quadráticos — abaixo do limite do CalculiX, sem escalamento de massa; aviso se o utilizador forçar um passo maior); resultados com envolventes no tempo, deformadas por instante (o pico assinalado), histórias do deslocamento máximo e das sondas (`FemResult.timeHistory`) e gráfico na app.

**Testes** (`tests/dynamics.test.ts`, 6; CalculiX 2.21 e code_aster 18.1 reais): consola sob degrau — fator 2 e pico em T₁/2 (f₁ = 835 Hz) no implícito e no explícito dos dois solvers (< 6–8 %); Rayleigh ζ = 5 % → 1 + e^(−ζπ/√(1−ζ²)) = 1,855 (< 6 %) nos dois; explícito sem escalamento de massa. E2e da simulação: dinâmica implícita na app (pico 0,3715 mm em 0,600 ms, deformadas por instante). Na CI do Windows entram o implícito/explícito do CalculiX e o implícito do code_aster.

**Limites:** só dinâmica linear (sem contacto, plasticidade nem grandes deslocamentos no tempo); o explícito do code_aster é lento (3–4 min para 7500 passos em 640 elementos) e o do CalculiX serve para modelos pequenos — para impacto/crash: OpenRadioss (a seguir).

## Atualização: OpenRadioss (OpenCourant)

Solver «OpenRadioss» no estudo FEM (só dinâmica explícita, elementos lineares). `src/sim/radioss.ts` escreve o Starter `galcad_0000.rad` (formato bloco 2019, kg–mm–ms: E em GPa, ρ em kg/mm³, F em kN, t em ms) e o Engine `galcad_0001.rad`, e lê as animações convertidas pelo `anim_to_vtk` (VTK ASCII: NODE_ID, deslocamento, von Mises por célula); o agente (`runRadioss`) encontra a distribuição por `CAD_RADIOSS_DIR` e corre Starter → Engine → anim_to_vtk. O formato foi tirado dos testes oficiais `qa-tests/miniqa/SOLIDES/nv_elts/poutre_flex` (CC BY-NC: lidos como referência, nada copiado para o GALCAD) e do código do `anim_to_vtk`.

**Verificado** na CI Linux (`.github/workflows/openradioss.yml`, binário oficial `latest-20261011`, SHA-256 fixo; execução 41031990436): Starter «NORMAL TERMINATION, 0 erros, 0 avisos» e consola sob degrau com o Engine — fator 2 e pico em T₁/2 dentro de 10 %. Os binários não correm no ambiente de desenvolvimento (bloqueio de executáveis descarregados), por isso a verificação é só na CI. Instalador Windows: `build-solvers.py` extrai Starter/Engine sem MPI, anim_to_vtk, hm_cfg_files, hm_reader, h3d e o runtime Intel oneAPI (~490 MB); o teste real também corre na CI do Windows.

**Limites:** só material elástico, forças e gravidade, sem contacto nem deslocamentos/velocidades impostos; AGPL-3.0 — oferecer o código com o instalador (VALIDAR com jurista).

**Verificado no Windows real** (Instalador Windows, execução 41032863195, commit `291ff14`): 18/18 casos de referência com os solvers incluídos, 0 saltados — OpenRadioss real (consola sob degrau), dinâmica implícita/explícita do CalculiX e implícita do code_aster, hexaedros (C3D8I/C3D20R, HEXA20, seeds, pré-visualização), e os anteriores (code_aster, XFOIL, atrito, modal/térmica, OpenFOAM, SU2). Instalador de 673 MB (artefacto `GALCAD-Setup` dessa execução), instalado em silêncio e a app instalada calculou a consola (0,1910 mm).

**Próxima ação:** LAW2/LAW36, /INTER/TYPE7 e /IMPVEL para impacto real, e o módulo de otimização (scripts, otimização topológica).

## Atualização: o setup instala todos os solvers

Pedido de Juan: «Faz com que o setup do galcad instale logo tudo». O instalador (560 MB) inclui agora também **SU2 8.3** (binário oficial de série), **OpenFOAM v2606** (MinGW oficial: só `platforms/*/bin` e `etc`; `libPstream` de série, sem MS-MPI nem administrador) e **code_aster 18.1** (conda-forge win-64; `desktop/relocate.cjs` corrige os 33 ficheiros de texto que citam a pasta de construção, chamado pelo instalador com `GALCAD.exe --galcad-setup` e no arranque).

**Alterações:** `desktop/build-solvers.py` (su2, openfoam, code_aster; corrige a disposição `lib/python3.X` que o micromamba usa ao criar ambientes Windows em Linux), `desktop/relocate.cjs`, `desktop/installer.nsh`, `desktop/main.cjs` (CAD_SU2, CAD_FOAM_DIR, CAD_ASTER), `tools/cad-runner.ts` (OpenFOAM nativo Windows por `CAD_FOAM_DIR`, lançadores `.cmd`, `PATH` do Windows; SU2 com `MARKER_ANALYZE` e queda de pressão), teste SU2 da conduta laminar, workflow com todos os casos no Windows e o submódulo privado por `GALKEEL_CALC_TOKEN` (sem ele compila sem a análise Galkeel: `vite.config.ts`, `GalkeelPanel`).

**Verificado aqui:** relocação (33 ficheiros) pela app; compilação com e sem o submódulo; 156 testes; e2e desktop e Galkeel; instalador completo gerado (os executáveis do OpenFOAM e do SU2 não puderam correr aqui: o ambiente bloqueou binários descarregados).

**Verificado no Windows real** (GitHub Actions, Windows Server 2025, execução 40630753783, commit `498bc82`): 8/8 casos de referência com os solvers incluídos, 0 saltados — code_aster (consola; pressão e frequências), XFOIL NACA 0012, CalculiX (consola, modal/térmica, atrito), **OpenFOAM v2606** (conduta laminar: balanço de massa e Δp) e **SU2 8.3** (conduta laminar: convergência e Δp de Poiseuille — primeira execução do adaptador SU2). Instalação silenciosa: o passo `--galcad-setup` relocou o code_aster para `%LOCALAPPDATA%\Programs\GALCAD`; a app instalada arrancou o agente embutido e calculou a consola (0,1910 mm). Instalador (560 MB) no artefacto `GALCAD-Setup` dessa execução.

**Bloqueio:** sem o secret `GALKEEL_CALC_TOKEN` no GALCAD o instalador sai sem a análise Galkeel (a primeira execução falhou exatamente aqui: o runner não clona o submódulo privado).

## Atualização: app Windows com instalador e solvers incluídos

Pedido de Juan: «É um bocado podre ter de instalar os solvers» → «Podemos fazer uma app windows com instalador». Decisão: **Electron** (o agente já é Node e corre lá dentro sem alterações; Tauri obrigava a um processo Node extra). Repositório: `jjvherbert/GALCAD` (público — ver bloqueios).

**Alterações**
- `desktop/main.cjs` (servidor estático + agente em 127.0.0.1 com token novo por arranque, solvers de `resources/solvers` por `CAD_CCX`/`CAD_GMSH`/`CAD_XFOIL`), `desktop/preload.cjs` (`window.cadDesktop`, só endereço/token/versão), `desktop/build-solvers.py`, `desktop/gmsh-launcher.c`, `desktop/xfoil-nogfx.c`.
- `src/app/store.ts`: agente embutido por defeito; `AgentBox` mostra «embutido na app».
- `package.json`: `main`, scripts `desktop`, `solvers:win`, `dist:win` e configuração do electron-builder (NSIS, solvers em `extraResources`).
- `.github/workflows/windows-installer.yml`: solvers em Linux → testes num Windows real → instalador (artefacto; release nas etiquetas `v*`).

**Testes**
- Executáveis Windows no Wine 9 com os testes de referência: consola (Timoshenko), modal e térmica, barras em série coladas, atrito (μ·N) e XFOIL NACA 0012 — 5/5.
- `tests/e2e/desktop.e2e.cjs` (Electron + Xvfb): agente embutido, página sem Node, consola calculada na janela (0,1910 mm para 0,1920) — com os solvers Linux e com os executáveis Windows no Wine.
- Problema real encontrado pelo Wine e corrigido: a `liblapack.dll` do conda reencaminha as funções para a `openblas.dll` (a modal abortava); o script segue agora importações **e** reencaminhamentos.

**Bloqueios**
- O instalador ainda não foi executado num Windows real por uma pessoa: o workflow testa os solvers no Windows do GitHub, mas a instalação e a janela da app só foram vistas em Linux.
- Instalador sem assinatura de código: o Windows SmartScreen vai avisar («Mais informações» → «Executar mesmo assim»).
- GPL: falta publicar o código-fonte dos solvers com cada release (ver `THIRD_PARTY_NOTICES.md`) — VALIDAR com jurista.
- `jjvherbert/GALCAD` é público e o `LICENSE` diz proprietário: decidir a visibilidade.

**Próxima ação:** Juan instala o `GALCAD-Setup` do artefacto do Actions num Windows e corre um estudo; depois code_aster opcional instalado pela app.

## Atualização: code_aster, convergência formal, scripts e IA, análise integrada Galkeel, cálculos/XFOIL, atrito e PMI nos desenhos

Pedido de Juan: competitividade face ao SolidWorks/CATIA/FEM formal; instalação por conda-forge autorizada; estudo de convergência, simulações automáticas e scripts, copiloto, IA, análise integrada com relatório para a Galkeel, escantilhonamento e cálculos aeronáuticos com ferramentas abertas. Commits locais (**sem push**, por indicação de Juan): `3ee5531`, `7165e58`, `f176e6a`, `a5fdadc`, `a77ecc2`, `f4a7005` e o desta documentação.

**Alterações**
- **code_aster 18.1** (micromamba, conda-forge, ambiente `aster`): `src/sim/aster.ts` corrigido e verificado. O agente deteta os ambientes conda.
- **Convergência**: sondas (`FemStudy.probes`) e refinamento automático até ao GCI alvo (`RunOptions.convergence.target`), gráfico no painel.
- **Scripts**: `src/script/api.ts`, worker isolado (`src/app/script-worker.ts`), painel Scripts, lote `tools/cad-script.ts`; superfície de resposta RBF.
- **Copiloto**: `src/ai/copilot.ts` (SDK oficial, saída estruturada zod, chave só em memória).
- **Galkeel**: `vendor/galkeel-calculadora` (submódulo, `c41f83c`, não alterado), `src/galkeel/*`, `src/kernel/panels.ts`, painel Galkeel, contrato `galkeel:calculator-result` (tag `iso12215-5-frp`).
- **Cálculos**: `src/calc/library.ts`, propriedades de secção de faces planas (`PanelGeom.section`), `src/sim/xfoil.ts`, `runXfoil` + `/xfoil` no agente, painel Cálculos, `tools/xfoil-nofpe.c`.
- **Atrito**: `FemStudy.contact.mode = "friction"` + `mu`; deck com `*CONTACT PAIR` face a face, `*FRICTION` e passo incremental; reações por apoio (`FemResult.groupReactions`).
- **PMI nos desenhos**: `ViewResult.pmi` (núcleo), anotações com `pmi: {item, view}`, `importPmi` e botão/comando «Importar PMI».

**Testes:** 156 testes Node e 11 suites e2e a passar (Gmsh 4.15.2, CalculiX 2.21, code_aster 18.1, OpenFOAM v1912, XFOIL 6.99 reais).

| Caso | Resultado | Referência |
|---|---|---|
| code_aster, flecha da consola | 0,1904 mm | 0,192 mm |
| Convergência automática (6 malhas lineares) | GCI 2,08 %, extrapolado 0,1910 mm | 0,1920 mm |
| Varrimento paramétrico L = 80/100/120 | < 3 % | Timoshenko |
| Painel Galkeel 600×400×7, fundo | P 48,09 kN/m², t 6,57 mm | galkeel-calculadora |
| FEM do painel (von Mises) | 62,5 MPa | Roark corrigido 63,4 MPa |
| ISA 11 km | 216,65 K; 22 632 Pa; 0,36392 kg/m³ | ISO 2533 |
| Secção da cantoneira L lida no CAD | A e Imin exatos | fórmulas de Green |
| XFOIL NACA 0012, Re 1e6 | CLα 0,108/°, CDmin 0,0054 | ~0,105–0,110/°, ~0,0055 |
| Atrito (bloco arrastado, μ = 0,3) | 1199,99 N; normal 4000 N | μ·N = 1200 N |
| Separação (puxar o bloco) | ≈ 0 N (colado: > 10⁴ N) | sem tração |

**Bloqueios e pendentes**
- Push: nenhum até Juan indicar.
- Copiloto: só testado com respostas simuladas (sem chave da API neste ambiente).
- ISO 12215-5:2008 é edição retirada: a análise Galkeel fica como legada até a galkeel-calculadora ter a 2019 (não reimplementar aqui).
- XFOIL Debian: precisa de `CAD_XFOIL_PRELOAD` (ver `tools/xfoil-nofpe.c`).
- `PROPOSTO` à galkeel-app (não alterada): etiqueta `cad-analysis` e alojar o CAD em `public/cad` para o envio ao caso funcionar no mesmo origin. `galkeel-context` não foi alterado (Change Control/locks por verificar no Drive).
- Ver «Posicionamento face ao SolidWorks, CATIA e FEM comercial» no ROADMAP: cascas/vigas, qualidade da malha, contacto geral e dossier NAFEMS/V&V são o caminho para FEM de nível formal.

**Próxima ação recomendada:** dossier de V&V com benchmarks NAFEMS (LE1, LE10, R0031) no CalculiX e no code_aster, depois elementos de casca para PRFV (liga ao escantilhonamento Galkeel). Juan escolhe a ordem.

## Atualização: F2, não linear, estudos de montagem e Fase 5 (PMI 3D e tags)

Pedido de Juan: "vamos correr todos" (F2 completa, montagens, code_aster/não linear, Fase 5). Feito pela ordem F2 → não linear → montagens → Fase 5. Commits locais (sem push, por indicação de Juan): `0f4dfb1`, `ad51738`, `4ba7d87`, `3c7af04`, `5992c13` e o desta documentação.

**Alterações**
- **F2**
  - `src/sim/result.ts`: vista de resultados neutra em camadas, usada pelo visualizador e pela legenda.
  - `src/sim/foamfields.ts`: leitura dos campos e dos patches do OpenFOAM (incluindo `noSlip`), interpolação célula → ponto, camadas dos patches e cortes planos da malha poliédrica.
  - `src/sim/convergence.ts`: Richardson + GCI (Celik et al. 2008) e relatório por grandeza.
  - O agente passa a devolver `view`, `metrics`, `cells` e `hypotheses`, e aceita `--convergence r` / `convergence: {ratio}` (malhas h, r·h, r²·h).
  - Interface: camadas, escala comum e tabela de convergência.
- **Não linear**
  - `FemStudy.nonlinear` (geometria, plasticidade, incrementos) e `SimMaterial.tangent`.
  - Deck: `*STEP, NLGEOM`, `*STATIC` incremental, `*PLASTIC` bilinear e `PEEQ`; leitura do último incremento e da curva carga–deslocamento.
  - Reações: conjuntos `N_RX/N_RY/N_RZ` por grau de liberdade, descontando a carga aplicada nos nós dos apoios.
- **code_aster**: `src/sim/aster.ts` gera a malha ASTER, o `.comm` e o `.export` e lê as tabelas; o agente usa `run_aster`/`as_run`. **Não verificado** com o solver.
- **Montagens**
  - `AssemblyDoc.studies` (FEM), `FemStudy.bodyMaterials` e `FemStudy.contact`.
  - `assemblyStudyCase` em `src/kernel/sim.ts`: composto de sólidos posicionados, faces "caminho/face" e deteção do contacto.
  - Gmsh com um volume por corpo (`B1`, `B2`, …); deck com `*ELSET`/material por corpo e `*SURFACE` + `*TIE`; o agente confere cada volume com a caixa do corpo.
  - Interface: separador Simulação na montagem, materiais por instância e modo de contacto. A `RefList` passa a prefixar o componente.
- **Fase 5**
  - `src/doc/pmi.ts` (puro): modelo PMI, tabelas ISO 286, regras ISO 1101/5459, textos, atributos, pesquisa e CSV.
  - `src/kernel/pmi.ts`: valor medido, âncora e validação contra a geometria. Vai na resposta da reconstrução (`pmi`).
  - `src/kernel/step-pmi.ts`: entidades AP242 semânticas acrescentadas ao STEP. As faces com PMI saem nomeadas `PMI#k` (`AddSubShape` + `write.stepcaf.subshapes.name`).
  - `asciiStep`: o STEP passa a ser ASCII puro, com `\X2\`. Corrige também a Fase 4.6, em que os nomes iam em UTF-8.
  - Interface: `src/app/PmiPanel.tsx` (anotações, vistas de modelo, atributos); rótulos e linhas de chamada no visualizador (`setPmi`, `cameraView`/`setCameraView`); separador PMI.
  - `tools/read-step-pmi.py`: verificação com o leitor GD&T do OpenCASCADE (OCP).

**Testes:** todos a passar.
- 127 testes em Node. Os novos estão em `convergence`, `aster`, `sim-assembly`, `pmi` e `sim` (não linear, convergência, campos CFD).
- 8 suites e2e. A nova `pmi.e2e.cjs` e a `simulacao` (que ganhou a convergência, o CFD com camadas e a montagem colada) correm com os solvers reais: Gmsh 4.15.2, CalculiX 2.21 e OpenFOAM v1912.

Valores verificados:

| Caso | Resultado | Referência |
|---|---|---|
| Flecha extrapolada (tetraedros lineares) | 0,1922 mm | 0,1920 mm |
| Tração elastoplástica | erro < 0,5 % | analítico |
| Elástica, flecha vertical v/L | 0,3017 ± 3 % | 0,3017 (Bisshopp–Drucker) |
| Lâminas coladas | 0,1905 mm | 0,1920 mm |
| Aço + alumínio em série | 0,09494 mm | 0,09524 mm |
| u_máx/U na conduta | entre 1,8 e 2,25 | 2,096 |
| GCI do exemplo de Celik | p 1,53; φext 6,1685; GCI 2,2 % | iguais aos publicados |

**Bloqueios**
- **code_aster:** a instalação (micromamba/conda-forge) foi recusada pelo classificador de permissões. Opções: autorizar essa instalação, ou a imagem Docker oficial (também por autorizar), e depois correr os casos analíticos com `solver: "code_aster"`.
- **PMI:** as Recommended Practices das CAx-IF não estavam acessíveis (proxy 403). A codificação segue a referência gerada pelo escritor do OCCT e o esquema AP242 (afastamento inferior com sinal, pela regra WR1 de `tolerance_value`). **VALIDAR** com o documento das CAx-IF v4.1 e com um segundo leitor (ex.: NIST STEP File Analyzer).
- OCP (`pip install cadquery-ocp`) e o OpenFOAM do apt só estão instalados neste contentor, para verificação.

**Próxima ação:** apresentação gráfica do PMI no STEP e PMI nos desenhos 2D; verificação do code_aster; contacto com atrito; sondas e modos animados. Juan escolhe a ordem.

---

## Atualização: pré-processador FEM/CFD (F1) e agente local (F3, parcial)

**Escolha dos solvers** (ver ROADMAP): CalculiX (estruturas/térmica), OpenFOAM linha openfoam.com (CFD), SU2 (CFD/adjunto), Gmsh (malhador), snappyHexMesh; code_aster, OpenCourant e Elmer propostos para depois.

**Alterações**
- `src/doc/study.ts`: tipos `FemStudy`/`CfdStudy`, materiais e fluidos de referência; `CadDocument.studies` (guardado no ficheiro).
- `src/sim/` (puro): `case.ts` (caso neutro), `gmsh.ts` (`.geo` FEM e SU2), `msh.ts` (MSH 4.1), `calculix.ts` (deck, `.frd`, `.dat`, resultado para o 3D), `openfoam.ts` (caso simpleFoam completo), `foamread.ts` (fluxos, pressão média e força de pressão a partir dos campos — independente de function objects), `su2.ts`.
- `src/kernel/sim.ts`: estudo → caso (faces → tags na ordem do OCC, que é a do Gmsh: verificado), BREP, STL por patch em metros, LEIA-ME. Pedido `studyCase` ao worker.
- `tools/cad-runner.ts` (empacotado em `public/cad-runner.mjs` por `npm run build:runner`, que o `build` já corre): CLI e servidor 127.0.0.1 com token; regenera os ficheiros dos solvers a partir de `case.json` (não executa scripts recebidos) e recusa diretivas `#codeStream`/`#calc`/… ; deteta Gmsh/ccx/OpenFOAM (com o bashrc da instalação)/SU2; confere os grupos da malha com as faces do CAD.
- UI: separador e painel **Simulação** (`SimPanel`), exportação `.zip`, ligação ao agente, resultados FEM a cores (paleta sequencial) com deformada ampliada e contorno original.
- **Nota de ambiente:** o OpenFOAM v1912 do Ubuntu 24.04 falha em qualquer function object (erro "sha1"); o agente repete com `-noFunctionObjects` e tira o resumo dos campos.

**Testes:** 107 em Node (8 novos em `tests/sim.test.ts`, os de solvers correm com Gmsh 4.15.2, CalculiX 2.21 e OpenFOAM v1912 instalados neste contentor) e 7 suites e2e (nova `tests/e2e/simulacao.e2e.cjs`, com o agente real: flecha 0,191 mm vs 0,192 teórica, von Mises 60,05 MPa vs 60 MPa). Todos a passar.

**Bloqueios:** SU2 não instalado aqui (configuração gerada mas não corrida). VALIDAR licenças antes de distribuir solvers.

**Próxima ação:** F2 completa (campos CFD no 3D via VTK, convergência de malha assistida), estudos de montagens (vários sólidos, contacto colado), code_aster para não linear, ou Fase 5, conforme a prioridade de Juan.

---

## Atualização: Fase 4 (funcionalidades inspiradas no CATIA)

**Alterações**
- `src/geom/spline.ts` (puro): reamostragem por comprimento de arco, reparametrização por troços, `Spline` cúbica vetorial (natural, com derivadas impostas, periódica), `skinGrid`, `gordonGrid` (secções + guias − tensor), Hermite cúbica/quíntica, círculos por 3 pontos e por raio.
- `src/kernel/occ.ts`: `sampleWire`, `wireEnd`, `gridFace` (interpolação bicúbica de uma grelha), `poleRowsFace` (B-spline exata a partir de linhas de polos com nós comuns — garante as tangências/curvaturas transversais), `surfaceAt` (normal e curvatura normal numa direção), `outwardDir`, `wireOf`, `getArena`.
- `src/kernel/features/gsd.ts`: `multiSection` (loft OCC / pipe pela spine / skin com tangências / Gordon com guias), `blend`, `circleSweep`, `setupPipe` (opções de varrimento, usado também pelo varrimento sólido e de superfície), `extrapolate` (mantém a chave do corpo, como o aparar — entra em `effectiveDependencies`), `heal`, `sewFaces`, `simplifyBody` (UnifySameDomain com nomes por contenção), `seamDeviations`, `connectedParts`. `knit` ganhou `checkConnected`/`checkTangency`/`simplify`; `ruled` o modo `angle`; curvas `extend`.
- `src/kernel/analysis.ts`: `continuity` (G0–G3), `combs` (porcupine), `exactNormals`. Pedidos novos ao worker: `continuity`, `combs`, `normals`, `snapshot`. Viewport: shader de linhas de realce, cores de continuidade, pentes, rede de polos com arrasto (`setPoleNet`, `onPoleMoved`); `data-pole-center` ajuda o e2e.
- `src/kernel/features/freeform.ts` (+ `report.net` → `FeatureStatus.net`): patch clamped nu × nv ou face convertida; movimentos por índice.
- `src/doc/expr.ts`: comparações e lógica (`and/or/not`, `&& || !`), `clamp`, `sign`. `src/doc/knowledge.ts`: `configuredDoc`, `partKey`/`splitPartKey` ("p1#Config"), CSV da tabela, `resolveWithRules` (ponto fixo, deteção de oscilação), `runChecks`, `makeTemplate`/`instantiateTemplate`. O núcleo aplica a configuração ativa (`service.rebuild`) e a do componente (`partBuild` com a chave); a BOM separa configurações.
- `src/kernel/features/external.ts`: `publish` e a feature `external` (ligada/congelada via `BRepToolsWrapper`, matriz de posição); `service.envFor` dá o `BuildEnv` (revisão por hash das peças e dependências, ciclos diretos e indiretos). **Atenção:** a origem é reconstruída por outro motor a meio de um passo, que muda a arena atual — a feature repõe-na (`getArena`/`setArena`). Mates aceitam `@Publicação`.
- `src/kernel/step242.ts`: XCAF + `STEPCAFControl_Writer` (esquema 5 = AP242), produtos com nome/cor, montagem com ocorrências (achatada). Formato de exportação `step242`.
- UI: grupos GSD, Forma livre e Classe A no separador Superfícies; separador Conhecimento (`KnowledgePanel`: regras, verificações, configurações, templates, publicações); painéis das features novas; configuração por componente; verificações no painel lateral.
- **Bug corrigido** (apanhado no e2e): `parseDocument`/`parseProject` descartavam regras, verificações, configurações, publicações e templates ao abrir um ficheiro.
- Malha de visualização com tolerância angular 0,12 rad (antes 0,25) para as análises de classe A.
- ROADMAP: Fase 4 fechada; secção FEM com a integração dos solvers **dentro da aplicação** (agente local / fila / WASM), adaptador OpenRadioss/OpenCourant e tabela de licenças.

**Testes:** 99 em Node (novos: `tests/gsd.test.ts` — 15, `tests/knowledge.test.ts` — 6, `tests/external.test.ts` — 3, `tests/step242.test.ts` — 1; valores analíticos: meio cilindro por loft e por Gordon, tira plana por concordância G1, áreas de varrimento circular/tubo/tronco de cone, extrapolação de cilindro em curvatura, polo central de B-spline cúbica = 20·½·½, volumes de configurações e templates, posição por matriz) e 6 suites e2e (nova `tests/e2e/fase4.e2e.cjs` com o fixture gerado por `tests/e2e/fixtures/make-fase4.ts`). Todos a passar.

**Bloqueios:** nenhum técnico. VALIDAR: estado do OpenCourant e enquadramento das licenças GPL/AGPL antes de distribuir solvers.

**Próxima ação:** etapa F1 do pré-processador FEM (definição do estudo + malha Netgen + exportação CalculiX), ou Fase 5 (PMI 3D semântico e tags, AP242 com PMI), conforme a prioridade de Juan. Sem push: o repositório remoto ainda não existe; titular da licença por confirmar.

---

## Atualização: Fase 3 (projeto, montagens, desenhos 2D, BOM e BOM com IA)

**Alterações**
- `src/doc/project.ts`: `CadProject` (peças com `id` e `properties`, montagens, desenhos), tipos de mates, vistas e anotações; `parseProject` aceita o formato antigo de peça única.
- Store: `project`, `active`, históricos por documento, `commitDoc`, reconstrução por tipo (peça/montagem/desenho); mover vistas/anotações não chama o núcleo (`drawingKernelKey`).
- Núcleo: um `Engine` por peça; `kernel/assembly.ts` (geometria das referências, subconjuntos, massa); `kernel/drawing.ts` (HLR, projeções, corte com `BRepPrimAPI_MakeHalfSpace` + `Common`, pormenor por recorte 2D, auxiliar, centros, cotas dos esboços); `kernel/signature.ts` (assinatura para o assistente). **Atenção:** o campo `id` dos pedidos ao worker colidia com o id da mensagem — os pedidos usam `asmId`/`drawingId`.
- Puros: `assembly/solver.ts` (LM com Jacobiano numérico, 6 incógnitas por componente livre, 8 arranques), `assembly/bom.ts`, `assembly/combine.ts`; `drawing/{geom2d,prims,render,edit,svg,pdf,dxf}.ts`; `io/table.ts` (CSV com `;` e XLSX mínimo); `ai/bom-assistant.ts` e `ai/claude.ts` (SDK oficial no browser, `claude-opus-5-5`, `fallbacks: "default"`, saída estruturada Zod, chave só em memória, carregado a pedido).
- UI: `DocTabs`, `AssemblyUI` (árvore, painel de mate com pré-visualização, componente), `DrawingEditor` (folha SVG, ferramentas, painéis), `BomPanel`, `PropertiesDialog`; separadores Montagem / Esquema de vistas / Anotação.
- Licenças: `@anthropic-ai/sdk` (Apache-2.0) e `zod` (MIT) acrescentados a `THIRD_PARTY_NOTICES.md` e `licenses/`.

**Testes:** 75 em Node (solver e montagens, desenhos e folha, exportadores, BOM, assistente local, pedido ao Claude com `fetch` simulado) e 5 suites e2e (montagem com BOM/CSV/assistente; desenhos com vistas, cotas do modelo, nota, PDF/DXF/SVG, BOM e balões). Todos a passar. O pedido real ao Claude não foi feito (precisa de uma chave e tem custo); está testado o formato do pedido e a leitura da resposta.

**Bloqueios:** nenhum técnico. Validar os valores nominais de normalizados e as taxas de custo antes de os usar com clientes.

**Próxima ação:** etapa F1 do pré-processador FEM, ou Fase 4 (CATIA), conforme a prioridade de Juan. Sem push: o repositório remoto ainda não existe; o titular da licença continua por confirmar.

---


## Atualização: fecho da Fase 2 e plano do pré-processador FEM

**Alterações**
- Curvas 3D (`src/kernel/features/curve.ts`, feature `curve` com `def`): pontos (`GeomAPI_Interpolate`), projetada (extrusão do esboço ∩ alvo, `BRepAlgoAPI_Section`), interseção, composta, hélice (`makeHelix`). `ctx.curves`, arestas `fN:cK` resolvidas em `edges()` e mostradas na malha (`EdgeGroup.curve`). `pathWire` aceita esboço ou curva nos dois varrimentos.
- `surface.ts`: `boundary` (MakeFilling com limites e curvas guia, ou ThruSections só com a direção 1), `ruled`, `untrim` (limites naturais / caixa UV), `replaceFace` (prolongamento por prisma + divisão pela superfície), `deleteFace` com `mode: "patch"`, aparar mútuo (`mutual`), `plate()` com medição automática do desvio G1 (`maxNormalDeviation` em `analysis.ts`) e verificação geométrica de contornos fechados.
- Padrões/espelho aceitam corpos de superfície (novo corpo com a chave do padrão).
- `features.ts`: `effectiveDependencies` — quem consome um corpo depende dos aparares anteriores desse corpo; `dependents`, `orderProblems` e `moveFeature` usam-na.
- Análise de desvio (pedido `deviation` ao worker, cores nas arestas e painel).
- UI: separador Superfícies reorganizado (Curvas, Criar, Editar, Para sólido, Análise), painéis novos, `TargetEditor`, `CurveList`, `PathSelect`, `PointsEditor`, entradas no menu de contexto.
- ROADMAP: Fase 2 fechada; secção nova **Pré-processador FEM compatível com solvers abertos** (etapas F1–F4: estudo associativo e exportação CalculiX/Code_Aster/Elmer/Nastran-MYSTRAN, malhadores Netgen embebido e Gmsh externo, resultados, adaptadores de solver, ligação a rom-fea/compósitos/náutica).

**Testes:** 59 em Node (10 novos em `tests/surface2.test.ts`, com valores analíticos: comprimentos de hélice/círculos, volume de varrimento numa curva, áreas de superfícies limite e regradas, desaparar, substituir face a estender e a aparar, remendo, aparar mútuo, padrão, desvio, dependências) e 3 suites e2e (superfícies inclui agora desvio e hélice criada pela UI). Todos a passar.

**Bloqueios:** nenhum técnico. Licenças dos malhadores/solvers do FEM por VALIDAR antes de distribuir (Gmsh e solvers GPL só por processo/ficheiros).

**Próxima ação:** Fase 3 (desenhos 2D + BOM) ou etapa F1 do FEM, conforme a prioridade de Juan. Sem push: o repositório remoto ainda não existe.

---


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
