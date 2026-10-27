/* Algumas compilações do XFOIL (ex.: pacote Debian/Ubuntu 6.99) ativam exceções de vírgula flutuante
 * com _gfortran_set_fpe e abortam (SIGFPE) no modo viscoso. Esta biblioteca substitui essa função por
 * uma que não faz nada; o agente usa-a por LD_PRELOAD quando CAD_XFOIL_PRELOAD aponta para ela:
 *
 *   cc -shared -fPIC -o nofpe.so tools/xfoil-nofpe.c
 *   CAD_XFOIL_PRELOAD=$PWD/nofpe.so node cad-runner.mjs --serve
 *
 * Sem exceções, uma camada-limite divergente dá NaN em vez de abortar: o agente limita o tempo e a
 * saída de cada execução e omite os ângulos que não convergem. */
void _gfortran_set_fpe(int v) { (void)v; }
