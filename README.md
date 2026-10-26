# CAD protótipo

Protótipo de CAD paramétrico open source, no browser, com foco futuro em náutica.

- **Núcleo geométrico:** [OpenCASCADE](https://dev.opencascade.org/) (LGPL-2.1) compilado para WebAssembly, via [replicad](https://replicad.xyz/).
- **Visualização:** Three.js.
- **Exportação:** STEP (AP214) e STL binário, sempre em **milímetros**.

A geometria corre num Web Worker (`src/worker.js`), por isso a UI não bloqueia durante as reconstruções.

## Correr

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # build estática em dist/
npm run test:hull  # teste do casco e da hidrostática em Node, sem browser
```

## Estrutura

| Ficheiro | Papel |
|---|---|
| `src/model-defs.js` | Metadados dos modelos (parâmetros e limites), usados pela UI |
| `src/models.js` | Construtores de geometria (OpenCASCADE), usados pelo worker |
| `src/hull.js` | Casco por loft de secções transversais e hidrostática simplificada |
| `src/worker.js` | Núcleo geométrico, malha para visualização e exportação |
| `src/main.js` | Visualizador 3D, painel de parâmetros e downloads |

Para adicionar um modelo, acrescente os parâmetros a `model-defs.js` e o construtor com a mesma chave a `models.js`.

## Hidrostática: hipóteses e limites

Calcula o volume imerso, o deslocamento, o LCB, o VCB e o C<sub>B</sub> por interseção do sólido com o semiespaço z < 0. Considera águas paradas, sem caimento nem adornamento, e água salgada com ρ = 1025 kg/m³. É uma **estimativa de conceção**: não substitui um cálculo de estabilidade (ex. ISO 12217) nem tem valor de certificação.

## Propriedade intelectual

As funcionalidades inspiram-se no que o SolidWorks e o CATIA fazem bem, mas a implementação é independente (*clean-room*). Não usa código, binários nem formatos nativos proprietários. A interoperabilidade faz-se por formatos abertos (STEP, IGES, STL, 3MF, DXF).

Ver `ROADMAP.md`.
