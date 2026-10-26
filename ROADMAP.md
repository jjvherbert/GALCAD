# Roadmap

## Fase 0: protótipo (feito)
- Núcleo OpenCASCADE/WASM num worker, visualizador Three.js
- Modelos paramétricos (placa, casco por loft) com sliders
- Exportação STEP e STL em mm, hidrostática simplificada

## Fase 1: núcleo de CAD
- Esboço 2D com restrições geométricas e cotas (solver: PlaneGCS ou o do SolveSpace)
- Árvore de features editável (extrusão, revolução, corte, furo, fillet, chamfer, padrões, espelho)
- Nomeação topológica estável (referências a faces e arestas que sobrevivem a edições)
- Formato de projeto aberto (JSON do histórico de features) e importação STEP/IGES
- Exportação: STEP AP242, IGES, 3MF, glTF, DXF

## Fase 2: superfícies e montagens
- Superfícies NURBS: loft/sweep com guias, preenchimento, continuidade G1/G2, análise de curvatura (zebra)
- Montagens com mates e solver de restrições 3D
- Desenhos técnicos: vistas HLR, cotas, exportação DXF e PDF

## Fase 3: módulo náutico (plugin)
- Linhas do casco: secções, linhas de água, longitudinais; fairing com controlo de curvatura
- Importação e exportação de tabelas de offsets
- Hidrostática completa: curvas hidrostáticas, coeficientes (C<sub>B</sub>, C<sub>P</sub>, C<sub>M</sub>, C<sub>WP</sub>), KB, BM, KM, TPC, MCT1cm
- Estabilidade: curva GZ com adornamento e caimento livre. Ligação ao `galkeel-calculadora` para ISO 12217, sem reimplementar
- Estrutura: cavernas, longarinas e anteparas geradas a partir do casco; laminados de PRFV por zonas
- Planificação de chapas e painéis desenvolvíveis
- Apêndices: patilhão, leme, quilha, com perfis NACA
- Massa e centro de gravidade por componente

## Fase 4: FEA com solvers abertos
- Malhação: Gmsh (sólidos e cascas)
- Solvers: CalculiX (estrutural linear e não linear, compósitos em casca), Code_Aster, Elmer (multifísica)
- Fluxo: geometria → grupos físicos (faces de carga e apoio) → `.inp` do CalculiX → execução local ou num servidor → resultados (`.frd`) mostrados no visualizador
- Casos náuticos: pressões de projeto do casco (ISO 12215-5), slamming, cargas no patilhão e no leme
- Mais tarde: CFD (OpenFOAM) para a resistência ao avanço

## Arquitetura de plugins
- API estável: registar features, painéis, exportadores e análises
- Os plugins correm em worker isolado e acedem à geometria apenas pela API
- Plugins de referência: `nautica`, `fea-calculix`
