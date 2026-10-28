/* Backend gráfico nulo do plotlib do XFOIL para a GALCAD (Windows): substitui o Xwin2.c (X11).
 * A app corre o XFOIL sempre sem gráficos (PLOP / G F), por isso estas funções nunca desenham;
 * existem para a ligação e devolvem valores neutros se alguma for chamada. Código próprio. */
#include <string.h>
void gwxrevflag_(int *revflag) { *revflag = 0; }
void gwxopen_(int *xs, int *ys, int *depth) { *xs = 1024; *ys = 768; *depth = 24; }
void gwxwinopen_(int *x, int *y, int *w, int *h) { (void)x; (void)y; (void)w; (void)h; }
void gwxclear_(void) {}
void gwxstatus_(int *x, int *y, int *w, int *h) { *x = 0; *y = 0; *w = 1024; *h = 768; }
void gwxresize_(int *x, int *y) { (void)x; (void)y; }
void gwxreset_(void) {}
void gwxclose_(void) {}
void gwxflush_(void) {}
void gwxline_(int *a, int *b, int *c, int *d) { (void)a; (void)b; (void)c; (void)d; }
void gwxdash_(int *m) { (void)m; }
void gwxcurs_(int *x, int *y, int *s) { *x = 0; *y = 0; *s = 0; }
void gwxcursc_(int *x, int *y, int *s) { *x = 0; *y = 0; *s = 0; }
void gwxpen_(int *p) { (void)p; }
void gwxdestroy_(void) {}
void gwxlinez_(int *x, int *y, int *n) { (void)x; (void)y; (void)n; }
void gwxpoly_(int *x, int *y, int *n) { (void)x; (void)y; (void)n; }
void gwxstring_(int *x, int *y, char *s, int *n, int len) { (void)x; (void)y; (void)s; (void)n; (void)len; }
void gwxsetcolor_(int *p) { (void)p; }
void gwxsetbgcolor_(int *p) { (void)p; }
void gwxcolorname2rgb_(int *r, int *g, int *b, int *n, char *name, int len) { *r = *g = *b = 0; (void)n; (void)name; (void)len; }
void gwxallocrgbcolor_(int *r, int *g, int *b, int *ic) { (void)r; (void)g; (void)b; *ic = 0; }
void gwxfreecolor_(int *p) { (void)p; }
void gwxdisplaybuffer_(void) {}
void gwxdrawtobuffer_(void) {}
void gwxdrawtowindow_(void) {}
void mskbits_(int *mask, int *ibits, int *ndash) { (void)mask; memset(ibits, 0, sizeof(int)); *ndash = 0; }
