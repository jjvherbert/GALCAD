import { draw, drawRoundedRectangle, drawCircle, drawRectangle, measureArea } from "replicad";

// Construtores do plugin base: build(params) → { shape, info? }.
export const builders = {
  placa({ w, h, t, r, f }) {
    let s = drawRoundedRectangle(w, h, Math.min(8, w / 4, h / 4)).sketchOnPlane().extrude(t);
    s = s.cut(drawCircle(Math.min(r, w / 2 - 1, h / 2 - 1)).sketchOnPlane().extrude(t));
    if (f > 0) s = s.fillet(Math.min(f, t / 2 - 0.1), (e) => e.inPlane("XY", t));
    return { shape: s };
  },

  // Equivalente ao "Shell" do SolidWorks: remove a face de topo e dá espessura às restantes.
  caixa({ w, d, h, r, e }) {
    const rr = Math.min(r, w / 2 - 0.5, d / 2 - 0.5);
    let s = (rr > 0 ? drawRoundedRectangle(w, d, rr) : drawRectangle(w, d)).sketchOnPlane().extrude(h);
    s = s.shell(Math.min(e, rr > 0 ? rr - 0.1 : e, h / 2), (f) => f.inPlane("XY", h));
    return { shape: s };
  },

  // Superfície aberta (não sólida) por loft de três curvas em planos paralelos.
  superficie({ L, W, h0, h1, h2 }) {
    const curve = (sag, x) =>
      draw([-W / 2, 0]).sagittaArcTo([W / 2, 0], sag || 0.001).done().sketchOnPlane("YZ", x);
    const [a, b, c] = [curve(h0, 0), curve(h1, L / 2), curve(h2, L)];
    const shape = a.loftWith([b, c], { ruled: false }, true);
    return {
      shape,
      info: { title: "Superfície", rows: [["Área", `${measureArea(shape).toFixed(0)} mm²`]] },
    };
  },
};
