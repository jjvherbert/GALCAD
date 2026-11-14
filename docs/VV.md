# Dossier de verificação e validação (V&V)

Estado: **F5d, fatia 1** (2026-11-14). Os resultados do GALCAD são apoio à decisão de engenharia e não substituem um software certificado. Este dossier diz o que já foi verificado, contra quê, e o que falta.

## Como correr

Os testes com solvers reais estão em `tests/*.test.ts`. Ficam `skip` quando o solver não está disponível. Para os correr, aponte as variáveis para os executáveis (ou wrappers do contentor `galcad-solvers`):

```
CAD_GMSH=… CAD_CCX=… CAD_ASTER=… node --test tests/vv.test.ts
```

## Benchmarks NAFEMS

| Caso | Grandeza | Referência | CalculiX 2.21 | code_aster | Erro | Teste |
|---|---|---|---|---|---|---|
| **LE1**: membrana elíptica sob pressão (tensão plana, 3D com 100 mm de espessura, tetraedros de 2.ª ordem, h = 80 mm) | σyy no ponto D (2000, 0) | 92,7 MPa | 92,80 MPa | 92,80 MPa | 0,1 % | `tests/vv.test.ts` |
| **LE10**: placa espessa sob pressão (anel elíptico com 600 mm de espessura, pressão de 1 MPa na face superior, tetraedros de 2.ª ordem, h = 100 mm) | σyy no ponto D (2000, 0, 300) | −5,38 MPa | −5,358 MPa | −5,358 MPa | 0,4 % | `tests/vv.test.ts` |
| **LE11**: cilindro sólido com carga térmica | σzz no ponto A | −105 MPa | — | — | — | pendente |
| **R0031**: compósito laminado em tira | tensões interlaminares | (NAFEMS R0031) | — | — | — | pendente |

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

Pendentes:
- **LE11** precisa de carga térmica com campo de temperatura linear em r e z.
- **R0031** precisa da camada sólida laminada.

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

## O que falta para "uso profissional"

- Os benchmarks LE11 e R0031 da tabela acima.
- Medir a taxa de sucesso do núcleo (OpenCASCADE WASM) num conjunto de peças reais.
- Testar montagens grandes (modos leves).
