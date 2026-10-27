#!/usr/bin/env python3
"""Lê o PMI semântico de um STEP AP242 com o leitor GD&T do OpenCASCADE (pacote OCP / cadquery-ocp)
e escreve-o em JSON: cotas, tolerâncias geométricas e referências, com o tipo das faces ligadas.
Ferramenta de verificação da exportação (não faz parte da aplicação).

    python3 tools/read-step-pmi.py peca.step
"""
import json
import sys

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane
from OCP.STEPCAFControl import STEPCAFControl_Controller, STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopoDS import TopoDS
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_Datum, XCAFDoc_Dimension, XCAFDoc_DocumentTool, XCAFDoc_GeomTolerance
from OCP.collections import Sequence_TDF_Label


def S(c, n):
    return getattr(c, n + "_s", None) or getattr(c, n)


def enum_name(e):
    return getattr(e, "name", str(e)).split("_")[-1]


def face_kinds(st, labels):
    out = []
    for i in range(1, labels.Length() + 1):
        shape = S(type(st), "GetShape")(labels.Value(i))
        if shape.IsNull() or shape.ShapeType() != TopAbs_FACE:
            out.append(None if shape.IsNull() else str(shape.ShapeType()))
            continue
        t = BRepAdaptor_Surface(S(TopoDS, "Face")(shape)).GetType()
        out.append("plane" if t == GeomAbs_Plane else "cylinder" if t == GeomAbs_Cylinder else str(t))
    return out


def attr_of(cls, label):
    """Atributo XCAF do rótulo (Set encontra o existente)."""
    return S(cls, "Set")(label)


def main(path):
    S(STEPCAFControl_Controller, "Init")()
    app = S(XCAFApp_Application, "GetApplication")()
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    app.NewDocument(TCollection_ExtendedString("MDTV-XCAF"), doc)
    r = STEPCAFControl_Reader()
    r.SetGDTMode(True)
    r.SetNameMode(True)
    if not r.Perform(path, doc):
        raise SystemExit("leitura falhou")
    st = S(XCAFDoc_DocumentTool, "ShapeTool")(doc.Main())
    dt = S(XCAFDoc_DocumentTool, "DimTolTool")(doc.Main())
    res = {"dimensions": [], "tolerances": [], "datums": []}

    seq = Sequence_TDF_Label()
    dt.GetDimensionLabels(seq)
    for i in range(1, seq.Length() + 1):
        L = seq.Value(i)
        a = attr_of(XCAFDoc_Dimension, L)
        o = a.GetObject()
        f, s2 = Sequence_TDF_Label(), Sequence_TDF_Label()
        S(type(dt), "GetRefShapeLabel")(L, f, s2)
        d = {"type": enum_name(o.GetType()), "value": o.GetValue(), "faces": face_kinds(st, f) + face_kinds(st, s2)}
        if o.IsDimWithPlusMinusTolerance():
            d["upper"], d["lower"] = o.GetUpperTolValue(), o.GetLowerTolValue()
        # (a classe ISO 286 devolve-se por referência, o que as ligações OCP não expõem: só a presença)
        d["fit"] = bool(o.IsDimWithClassOfTolerance())
        res["dimensions"].append(d)

    seq = Sequence_TDF_Label()
    dt.GetGeomToleranceLabels(seq)
    for i in range(1, seq.Length() + 1):
        L = seq.Value(i)
        o = attr_of(XCAFDoc_GeomTolerance, L).GetObject()
        f, s2 = Sequence_TDF_Label(), Sequence_TDF_Label()
        S(type(dt), "GetRefShapeLabel")(L, f, s2)
        dl = Sequence_TDF_Label()
        S(type(dt), "GetDatumOfTolerLabels")(L, dl)
        datums = []
        for k in range(1, dl.Length() + 1):
            datums.append(attr_of(XCAFDoc_Datum, dl.Value(k)).GetObject().GetName().ToCString())
        res["tolerances"].append({
            "type": enum_name(o.GetType()), "value": o.GetValue(), "zone": enum_name(o.GetTypeOfValue()),
            "material": enum_name(o.GetMaterialRequirementModifier()), "datums": datums, "faces": face_kinds(st, f),
        })

    seq = Sequence_TDF_Label()
    dt.GetDatumLabels(seq)
    for i in range(1, seq.Length() + 1):
        L = seq.Value(i)
        o = attr_of(XCAFDoc_Datum, L).GetObject()
        f, s2 = Sequence_TDF_Label(), Sequence_TDF_Label()
        S(type(dt), "GetRefShapeLabel")(L, f, s2)
        res["datums"].append({"name": o.GetName().ToCString(), "faces": face_kinds(st, f)})
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
