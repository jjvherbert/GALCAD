/* gmsh.exe para a GALCAD (Windows): o pacote oficial do Gmsh para Python traz a biblioteca
 * gmsh-<versão>.dll completa mas não o executável. Este lançador carrega a DLL e chama
 * gmshInitialize(argc, argv, readConfigFiles=1, run=1), que trata a linha de comandos como a
 * aplicação Gmsh (ex.: "gmsh mesh.geo -3 -o mesh.msh"). O Gmsh é GPL-2.0+; este lançador é código
 * próprio da GALCAD e corre como programa separado, tal como o resto dos solvers.
 *
 *   x86_64-w64-mingw32-gcc -O2 -municode -o gmsh.exe gmsh-launcher.c
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

typedef void (*init_t)(int, char **, int, int, int *);
typedef void (*fin_t)(int *);

int wmain(int argc, wchar_t **wargv) {
  /* a DLL fica ao lado do executável; aceita qualquer versão gmsh-*.dll */
  wchar_t dir[MAX_PATH], pattern[MAX_PATH + 16], dll[MAX_PATH * 2];
  GetModuleFileNameW(NULL, dir, MAX_PATH);
  wchar_t *slash = wcsrchr(dir, L'\\');
  if (slash) *slash = 0;
  swprintf(pattern, MAX_PATH + 16, L"%ls\\gmsh-*.dll", dir);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(pattern, &fd);
  if (h == INVALID_HANDLE_VALUE) { fprintf(stderr, "gmsh: biblioteca gmsh-*.dll em falta ao lado do executável\n"); return 2; }
  FindClose(h);
  swprintf(dll, MAX_PATH * 2, L"%ls\\%ls", dir, fd.cFileName);
  SetDllDirectoryW(dir);
  HMODULE m = LoadLibraryW(dll);
  if (!m) { fprintf(stderr, "gmsh: não foi possível carregar %ls (erro %lu)\n", dll, GetLastError()); return 2; }
  init_t init = (init_t)GetProcAddress(m, "gmshInitialize");
  fin_t fin = (fin_t)GetProcAddress(m, "gmshFinalize");
  if (!init || !fin) { fprintf(stderr, "gmsh: a DLL não exporta gmshInitialize/gmshFinalize\n"); return 2; }
  /* argumentos em UTF-8 (o Gmsh trata caminhos em UTF-8) */
  char **argv = calloc(argc + 1, sizeof(char *));
  for (int i = 0; i < argc; i++) {
    int n = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
    argv[i] = malloc(n);
    WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, argv[i], n, NULL, NULL);
  }
  int ierr = 0;
  init(argc, argv, 1, 1, &ierr);
  int ierr2 = 0;
  fin(&ierr2);
  return ierr ? 1 : 0;
}
