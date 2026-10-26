# CAD protótipo

CAD paramétrico open source, no browser, para modelação de sólidos e de superfícies. O objetivo é ter fluxos de trabalho ao nível do SolidWorks e, mais tarde, funcionalidades de superfícies avançadas inspiradas no CATIA. Os domínios específicos, como o boat design, são **plugins** opcionais e não fazem parte do núcleo.

- **Núcleo geométrico:** [OpenCASCADE](https://dev.opencascade.org/) (LGPL-2.1) compilado para WebAssembly, via [replicad](https://replicad.xyz/).
- **Visualização:** Three.js.
- **Exportação:** STEP (AP214) e STL binário, sempre em **milímetros**.

## Correr

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # constrói todos os modelos de todos os plugins e verifica o STEP (Node, sem browser)
npm run build      # build estática em dist/
```

## Arquitetura

```
src/
  core/      núcleo: worker OpenCASCADE, registo de plugins, testes
  app/       interface: visualizador 3D, painel de parâmetros, exportação
  plugins/
    base/    peças e superfícies genéricas (placa, caixa em casca, loft aberto)
    nautica/ módulo náutico: casco paramétrico e hidrostática simplificada
```

A geometria corre num Web Worker, por isso a UI não bloqueia durante as reconstruções.

**Plugins.** Cada pasta em `src/plugins/<id>/` é descoberta automaticamente e tem:

- `plugin.js`: metadados (nome e modelos com parâmetros e limites). A UI importa só este ficheiro.
- `geometry.js`: exporta `builders`, com um construtor `build(params) → { shape, info? }` por modelo. Só o worker o carrega.

O `info` opcional (`{ title, rows: [[rótulo, valor]], note }`) aparece no painel lateral. Qualquer resultado técnico deve indicar as hipóteses e os limites no `note`.

Nesta fase os "modelos" são peças paramétricas fixas. A Fase 1 do roadmap substitui-os por esboços com restrições e uma árvore de features editável, que é o modelo de trabalho do SolidWorks.

## Propriedade intelectual

As funcionalidades inspiram-se no que o SolidWorks e o CATIA fazem bem, mas a implementação é independente (*clean-room*). Não usa código, binários nem formatos nativos proprietários. A interoperabilidade faz-se por formatos abertos (STEP, IGES, STL, 3MF, DXF).

Ver `ROADMAP.md`.
