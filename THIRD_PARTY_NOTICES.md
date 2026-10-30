# Componentes de terceiros

O código deste projeto é proprietário (ver `LICENSE`). Usa as bibliotecas abaixo, que mantêm as suas licenças. Os textos completos estão em `licenses/`.

| Componente | Versão | Licença | Uso | Origem |
|---|---|---|---|---|
| Open CASCADE Technology, compilação WASM `replicad-opencascadejs` | 1.1.0 | LGPL-2.1 (com a exceção da Open CASCADE) | Núcleo geométrico B-rep | https://dev.opencascade.org · https://github.com/sgenoud/replicad |
| PlaneGCS, `@salusoft89/planegcs` (solver do FreeCAD) | 1.3.0 | LGPL-2.0-or-later | Solver de restrições do esboço | https://github.com/Salusoft89/planegcs |
| replicad | 1.2.0 | MIT | Utilitários sobre o OpenCASCADE | https://github.com/sgenoud/replicad |
| three.js | 0.186.1 | MIT | Visualização 3D | https://github.com/mrdoob/three.js |
| Preact | 11.0.2 | MIT | Interface | https://github.com/preactjs/preact |
| Anthropic TypeScript SDK, `@anthropic-ai/sdk` | 1.3.0 | Apache-2.0 | Sugestões de BOM com o Claude (opcional, só com a chave do utilizador) | https://github.com/anthropics/anthropic-sdk-typescript |
| Zod | 4.6.7 | MIT | Esquema da resposta estruturada do assistente | https://github.com/colinhacks/zod |

## Solvers distribuídos com o instalador Windows

O instalador da app de ambiente de trabalho **inclui** estes programas (pasta `resources/solvers`), que a app corre como **programas separados** através do agente; não são ligados ao código da GALCAD. Versões, origens e SHA-256 em `solvers/MANIFEST.json`; textos das licenças em `solvers/<solver>/licenses/`.

| Programa | Versão | Licença | Origem |
|---|---|---|---|
| CalculiX (ccx) | 2.23 | GPL-2.0 | pacote conda-forge win-64 (código: http://www.dhondt.de, receita conda-forge `calculix-feedstock`) |
| OpenBLAS, ARPACK-ng, runtime gfortran/gcc (libgfortran, libgomp, libquadmath, winpthreads), VC runtime | ver MANIFEST | BSD-3 / BSD-3 / GPL-3 com exceção de runtime / MIT·ZPL / licença de redistribuição da Microsoft | dependências do pacote CalculiX (conda-forge) |
| Gmsh | 4.15.2 | GPL-2.0-or-later (com as exceções do Gmsh) | biblioteca do pacote oficial `gmsh` (PyPI, win_amd64); código: https://gitlab.onelab.info/gmsh/gmsh |
| XFOIL | 6.99 | GPL-2.0 (plotlib: LGPL-2) | código do pacote Debian/Ubuntu `xfoil_6.99.dfsg+1` (com as correções do pacote), compilado sem gráficos |
| SU2 (SU2_CFD) | 8.3.0 | LGPL-2.1 | binário oficial `SU2-v8.3.0-win64.zip` (https://github.com/su2code/SU2) |
| OpenFOAM | v2606 (MinGW) | GPL-3.0-or-later | instalador oficial `OpenFOAM-v2606-windows-mingw.exe` da openfoam.com (SourceForge); incluídos só `platforms/*/bin` e `etc` |
| code_aster | 18.1.11 | GPL-3.0 | ambiente conda-forge win-64 (`code-aster`, Python 3.11), com as dependências: MEDCoupling/MED, HDF5, MUMPS, MFront/MGIS, SciPy/NumPy, Boost, Scotch/METIS (licenças livres, ver `licenses/` do ambiente) e **Intel oneMKL e Intel Fortran runtime** (licença Intel Simplified Software License, redistribuível) |
| OpenRadioss — OpenCourant (continuação aberta do OpenRadioss) | latest-20261011 | **AGPL-3.0** (Starter, Engine, anim_to_vtk); leitor de entradas `hm_reader` e `h3d` com as licenças em `licenses/`; **runtime Intel oneAPI** (oneMKL, OpenMP, SVML, libmmd: Intel Simplified Software License, redistribuível) | binário oficial `OpenCourant_win64.zip` (https://github.com/OpenCourant/OpenCourant, SHA-256 no `MANIFEST.json`); incluídos só os executáveis sem MPI, `hm_cfg_files`, `extlib` e licenças. AGPL: com o instalador tem de ser oferecido o código-fonte correspondente (etiqueta `latest-20261011`) — VALIDAR com jurista, tal como para os componentes GPL |
| Lançadores `gmsh.exe` e `run_aster.cmd`, backend gráfico nulo do XFOIL, relocação do code_aster | — | código próprio | `desktop/gmsh-launcher.c`, `desktop/xfoil-nogfx.c`, `desktop/build-solvers.py`, `desktop/relocate.cjs` |

**Obrigações da GPL ao distribuir binários** (resumo, não substitui aconselhamento jurídico): incluir os textos das licenças (feito) e acompanhar o instalador com o código-fonte correspondente ou com uma oferta escrita válida por 3 anos (GPL-2 §3). **PENDENTE/VALIDAR**: publicar os arquivos de código-fonte exatos junto de cada release (os links e somas estão no MANIFEST) e confirmar com um jurista que a agregação (app proprietária + solvers GPL como programas separados, no mesmo instalador) está bem enquadrada.

## Solvers e malhadores externos (não distribuídos)

O pré-processador escreve ficheiros para o Gmsh (GPL-2+), o CalculiX (GPL-2), o OpenFOAM (GPL-3) e o SU2 (LGPL-2.1), e o agente local (`cad-runner.mjs`, código próprio, sem dependências) corre-os como **programas separados** já instalados na máquina do utilizador. Nenhum deles é incluído nem ligado à aplicação. Se um dia forem distribuídos em conjunto (instalador, imagem de servidor), cumprir as respetivas licenças (texto, código-fonte; na AGPL do OpenCourant, também em serviço de rede) — **VALIDAR com aconselhamento jurídico**.

## Obrigações das bibliotecas LGPL num produto fechado

Resumo técnico, que não substitui aconselhamento jurídico:

1. **Ligação substituível.** O OpenCASCADE e o PlaneGCS são carregados como módulos WebAssembly separados (`replicad_single.wasm`, `planegcs.wasm` e o respetivo JS de ligação), não fundidos no código proprietário. O utilizador tem de poder substituí-los por uma versão modificada compatível. **Manter esta separação no empacotamento**: não os inlinar no bundle.
2. **Aviso e textos de licença.** Distribuir este ficheiro e a pasta `licenses/` com o produto, e mostrar a informação na janela "Acerca" quando existir.
3. **Código-fonte das bibliotecas.** Disponibilizar, ou indicar com oferta válida, o código-fonte exato das versões LGPL usadas, incluindo eventuais modificações. As versões usadas não são modificadas.
4. **Termos de utilização.** A licença do produto não pode proibir a modificação das bibliotecas LGPL nem a engenharia reversa necessária para depurar essas modificações (LGPL-2.1, §6).
5. As bibliotecas MIT só exigem que se mantenha o aviso de copyright e a licença.
6. A Apache-2.0 (SDK da Anthropic) exige distribuir o texto da licença e indicar alterações aos ficheiros dela (não há alterações). É compatível com um produto fechado.

**Simulação — code_aster:** o adaptador escreve ficheiros para o code_aster (GPL-3.0), que o agente local corre como programa separado, se estiver instalado (verificado com o pacote conda-forge 18.1); não é incluído nem ligado.

**Perfis — XFOIL:** o agente corre o XFOIL (M. Drela e H. Youngren, GPL-2.0) como programa separado, com comandos gerados pelo agente; não é incluído nem ligado. `tools/xfoil-nofpe.c` é código próprio (uma função vazia), carregado só no processo do XFOIL por `LD_PRELOAD`.

**Galkeel — galkeel-calculadora:** submódulo em `vendor/galkeel-calculadora` (repositório da Galkeel); os módulos de cálculo são carregados sem alteração e o seu código não é copiado para este repositório.

**Verificação do PMI (só desenvolvimento):** `tools/read-step-pmi.py` usa o OCP (`cadquery-ocp`, ligações Python do OpenCASCADE, LGPL-2.1 com exceção) para ler o STEP exportado. Não é dependência da aplicação nem distribuído com ela.

## Marca

O símbolo GK, o logótipo Galkeel e as imagens do instalador (`desktop/brand/`, `desktop/build/`) são marca da Galkeel e não estão abrangidos pela licença do código. A tipografia das imagens é a Montserrat (SIL Open Font License 1.1), usada só para as gerar (`desktop/brand/make-assets.py`).
