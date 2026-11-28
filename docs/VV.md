# Dossier de verificação e validação (V&V)

Estado: **F5d, fatia 1** (2026-11-14). Os resultados do GALCAD são apoio à decisão de engenharia e não substituem um software certificado. Este dossier diz o que já foi verificado, contra quê, e o que falta.

## Como correr

Os testes com solvers reais estão em `tests/*.test.ts`. Ficam `skip` quando o solver não está disponível. Para os correr, aponte as variáveis para os executáveis (ou wrappers do contentor `galcad-solvers`):

```
CAD_GMSH=… CAD_CCX=… CAD_ASTER=… node --test tests/vv.test.ts
```

Os testes e2e (`tests/e2e/*.e2e.cjs`) põem no PATH os solvers empacotados em `desktop/solvers/<plataforma>/{gmsh,calculix}` quando existem. Assim a suite `simulacao` gera de facto a malha ao vivo, resolve a consola e verifica a malha estruturada no 3D. Sem esses solvers (por exemplo, no CI), essas secções ficam `skip`.

## Benchmarks NAFEMS

| Caso | Grandeza | Referência | CalculiX 2.21 | code_aster | Erro | Teste |
|---|---|---|---|---|---|---|
| **LE1**: membrana elíptica sob pressão (tensão plana, 3D com 100 mm de espessura, tetraedros de 2.ª ordem, h = 80 mm) | σyy no ponto D (2000, 0) | 92,7 MPa | 92,80 MPa | 92,80 MPa | 0,1 % | `tests/vv.test.ts` |
| **LE10**: placa espessa sob pressão (anel elíptico com 600 mm de espessura, pressão de 1 MPa na face superior, tetraedros de 2.ª ordem, h = 100 mm) | σyy no ponto D (2000, 0, 300) | −5,38 MPa | −5,358 MPa | −5,358 MPa | 0,4 % | `tests/vv.test.ts` |
| **LE11**: cilindro/cone/esfera de parede espessa (revolução de 90°) sob campo de temperatura T = (r + z)/1000 °C, α = 2,3e-4, tetraedros de 2.ª ordem, h = 80 mm | σzz no ponto A (1000, 0, 0) | −105 MPa | −104,30 MPa | −104,34 MPa | 0,7 % | `tests/vv.test.ts` |
| **R0031(1)**: tira laminada [0/90/0/90/0/90/0] de 50 × 10 × 1 mm em flexão de três pontos (quarto de modelo, laminado sólido, uma camada de elementos por lâmina, tetraedros de 2.ª ordem, h = 0,5 mm) | σxx(E) · uz · σxz(D) | 684 MPa · −1,06 mm · ∓4,1 MPa | 693,0 MPa · −1,061 mm · 4,105 MPa | — | 1,3 % · 0,1 % · 0,1 % | `tests/vv.test.ts` |

Notas sobre o LE1:
- A geometria é feita com o esboço do GALCAD: duas splines por 25 pontos das elipses e dois segmentos retos, extrudidos 100 mm.
- A pressão de −10 MPa (tração) é aplicada às faces da elipse exterior. As condições de simetria ficam em x = 0, y = 0 e z = 0.
- O valor é lido por uma **sonda de componente de tensão** (`syy`) no ponto D. No code_aster vem de `SIGM_NOEU`, e no CalculiX do bloco `STRESS` do `.frd`.
- Na mesma malha, os dois solvers dão o mesmo valor, o que é uma verificação cruzada CalculiX × code_aster.

Notas sobre o LE10:
- A placa é o mesmo anel elíptico do LE1, extrudido para os dois lados (±300 mm) como um único prisma.
- A malha é partida pelo plano z = 0 (partição conforme). Assim a face exterior ganha uma aresta a meia espessura.
- Essa aresta é restringida em z com a referência **`cut@<face>`**: as arestas que as partições abrem numa face do corpo. Só funciona com partições e num corpo único (não em montagens).
- A face exterior fica com ux = uy = 0, e as faces de simetria em x = 0 e y = 0.

Notas sobre o LE11:
- O perfil é desenhado no plano XZ e revolvido 90° em torno do eixo z; o corpo fica em z ≥ 0 (faces planas em z = 0 e z = 1797,1), com o ponto A no raio interior em z = 0.
- Nova condição **campo de temperatura** (`thermalField`): T(x, y, z) em °C, avaliada em cada nó; no CalculiX vai em `*TEMPERATURE` com `*EXPANSION, ZERO`, no code_aster como variável de comando `TEMP` (`AFFE_VARC`). Só na estática; não existe no OpenRadioss.
- Apoios: simetria em x = 0 e y = 0, uz = 0 nas duas faces planas.

Notas sobre o R0031(1):
- Novo **laminado sólido** no estudo (`solidLaminate`): lista de lâminas ortotrópicas (E1, E2, E3, ν12, ν13, ν23, G12, G13, G23, espessura, ângulo) empilhadas a partir de z0. Cada elemento fica na lâmina que contém o z do seu centróide, com material e `*ORIENTATION` próprios. Só no CalculiX, só na estática/modal, sem casca e num corpo único.
- A malha é partida nas interfaces das lâminas (z = 0,1 … 0,9) e em x = 40, para a linha de apoio: uz = 0 em `cut@<face inferior>`.
- Quarto de modelo (simetria em x = 25 e y = 5), 25 N na aresta superior em x = 25.
- σxz(D) é medido no espelho (x = 32,5) do ponto D da referência, por isso sai com o sinal trocado.
- O code_aster não entra: o laminado sólido ainda não está nesse adaptador.

## Verificações analíticas já automáticas

Cada linha corresponde a um ou mais testes em `tests/`:

| Fenómeno | Referência | Solvers |
|---|---|---|
| Consola em flexão: flecha, reação, von Mises (tetraedros, C3D8I, C3D20R) | Timoshenko | CalculiX, code_aster |
| Simetria: meia viga com metade da carga | Timoshenko | CalculiX |
| Força pontual a meio vão | Timoshenko | CalculiX, code_aster |
| Varrimento de L (δ ∝ L³) e extrapolação de Richardson | Timoshenko | CalculiX |
| Pressão (reação = p·A) | Equilíbrio | CalculiX, code_aster |
| Frequências próprias da consola, massa pontual na ponta | Euler–Bernoulli | CalculiX, code_aster |
| Condução térmica 1D | Fourier | CalculiX |
| Barras coladas (em altura e em série aço/alumínio) | Mecânica dos materiais | CalculiX |
| Contacto com atrito (μ·N, separação) | Coulomb | CalculiX |
| Painel encastrado sob pressão ISO 12215 | Roark | CalculiX |
| Consola sob degrau (pico ≈ 2× estático em T₁/2) | Dinâmica de 1 GL | OpenRadioss |
| Encurvadura de placas (k → 4, Johnson) | Teoria de placas | analítico interno |
| Avaliador de malha: placa fina (≥ 4 elementos lineares / 2 quadráticos na espessura), furo (≤ 15–20° por elemento), aresta minúscula (seed com bias), L em hexaedros (partição em blocos), Jacobiano negativo (refino local); aceitar cada sugestão melhora a métrica e faz a sugestão desaparecer | Limites e fontes em `src/sim/quality.ts` (`ADVISOR_LIMITS`) | plano de malha (sem solver) |
| Cortes para varrer (`suggestSweepCuts`): placa 100×100×10 com furo Ø20 central fica em 6 de 6 blocos com os planos pelo eixo do furo (diagonais + o plano que atravessa a costura); caixa simples não recebe cortes | Critério de bloco do plano de malha (6 faces de 4 arestas) | plano de malha (sem solver) |

## Robustez do núcleo em peças reais

Conjunto: os modelos de teste PMI do NIST (CTC 01–05 e FTC 06–11, STEP AP203, 11 peças; e as versões AP242, 17 ficheiros), importados e sujeitos a operações típicas: filete e chanfro de 0,5 mm em 4 arestas, filete de uma face (0,3 mm), casca de 1 mm, furo passante, corte de metade e boss. As operações correm sobre o sólido importado tal como está.

| Operação | AP203 antes | AP203 com reparação na importação |
|---|---|---|
| Importação | 11/11 | 11/11 |
| Filete 0,5 (arestas) | 27/44 | 27/44 |
| Chanfro 0,5 (arestas) | 25/44 | 25/44 |
| Filete de face 0,3 | 17/32 | 27/32 |
| Casca 1 mm | 1/11 | 1/11 |
| Furo passante | 11/11 | 11/11 |
| Corte de metade | 11/11 | 11/11 |
| Boss | 4/11 | 11/11 |
| **Total** | **107/175 (61 %)** | **124/175 (71 %)** |

AP242 (17 ficheiros, com reparação): 136/234 (58 %). Um dos ficheiros (FTC 08, só malha tesselada) não tem B-rep e falha em tudo menos na importação.

- A importação repara cada sólido com `ShapeFix_Solid` e só aceita o resultado se for válido, tiver volume positivo e não mudar o volume de um sólido que já era válido.
- Filete e chanfro numa aresta de costura (a linha de fecho de um cilindro) dão agora um erro claro em vez de um erro do núcleo.
- Booleanas (furo, corte, boss) passam em todas as peças com B-rep.
- Limites que ficam: a casca falha em quase todas as peças reais (limite do `BRepOffset` do OpenCASCADE com muitas faces e filetes), e cerca de 40 % dos filetes e chanfros em arestas escolhidas à sorte falham (arestas curtas, entre filetes existentes ou em superfícies B-spline). No Parasolid/CGM estes casos passam quase sempre.
- Sonda usada: importação e operações em série, um processo, tempo e mensagem de cada operação; os ficheiros do NIST não são redistribuídos no repositório.

## Montagens grandes

Sonda: N peças-bloco (5 peças diferentes repetidas) inseridas numa montagem, em dois modos: grelha sem mates (cada componente livre, 6 graus de liberdade) e torre em cadeia (cada componente preso ao anterior por 3 mates de coincidência, totalmente definida). Tempos num portátil, um processo.

| Grelha sem mates | N = 1000 |
|---|---|
| Montagem (rebuild + poses) | 211 ms |
| Interferências | 77 ms |
| Exportação STEP | 1,1 s (17,7 MB) |
| Exportação STEP AP242 | 73 ms |
| Memória do processo | ~430 MB |
| Graus de liberdade | 6N (correto) |

| Torre em cadeia (3N mates) | antes | com jacobiano esparso |
|---|---|---|
| N = 50 | 1183 ms | 210 ms |
| N = 100 | 12 998 ms | 496 ms (cache 357 ms, interferências 651 ms) |
| N = 300 | — | 3999 ms (~870 MB) |

- O solver de mates (Levenberg-Marquardt, 6 incógnitas por componente livre) calculava o jacobiano reavaliando todos os mates por cada incógnita; agora só perturba um componente de cada vez e só reavalia os mates que lhe tocam, e o produto JᵀJ e a eliminação saltam os zeros. Todas as torres ficam com 0 graus de liberdade.
- O que sobra com centenas de mates é a resolução densa das equações normais (O(n³) em 6N incógnitas); aceitável até algumas centenas de componentes ligados por mates.
- Regressão automática: torre de 60 cubos no solver puro (`tests/assembly.test.ts`), dof 0 em ~0,1 s.

## O que falta para "uso profissional"

- Casca e filetes em peças reais (ver a secção anterior).
- Montagens com milhares de componentes ligados por mates: precisaria de um solver esparso (ou por subconjuntos) em vez das equações normais densas.
