#!/usr/bin/env python3
"""Solvers para o instalador Windows da GALCAD, preparados num Linux (compilação cruzada).

  python3 desktop/build-solvers.py [--out desktop/solvers/win] [--work /tmp/galcad-solvers]

Precisa de: micromamba (ou $MICROMAMBA), pip, x86_64-w64-mingw32-gcc e -gfortran, objdump.

- CalculiX 2.23: pacote conda-forge win-64 com OpenBLAS (não MKL); copia-se só o ccx.exe e as
  DLLs de que precisa (importações e reencaminhamentos de exportações, ex. liblapack → openblas).
- Gmsh 4.15.2: a DLL completa do pacote oficial para Python (win_amd64) + um lançador gmsh.exe
  próprio (desktop/gmsh-launcher.c) que chama gmshInitialize(argv, run=1).
- XFOIL 6.99: código-fonte do Debian/Ubuntu (com as correções do pacote), compilado com o
  gfortran mingw, sem gráficos (desktop/xfoil-nogfx.c) e sem as exceções de vírgula flutuante.

Os solvers continuam programas separados (GPL), chamados pelo agente da app. Cada pasta leva os
textos das licenças e o MANIFEST.json regista versões, origens e SHA-256 (código-fonte: ver
THIRD_PARTY_NOTICES.md).
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tarfile, urllib.request, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GMSH = {"version": "4.15.2", "sha256": "7b36083bb410fa27c5d0e052929d1a9844a5b09169d66017b72b41aabd49d711"}
XFOIL = {
    "version": "6.99",
    "files": {
        "xfoil_6.99.dfsg+1.orig.tar.gz": "f5ece350981f35f7b5b4cef540c921ffad877b0942591efb88bad76cc08b597a",
        "xfoil_6.99.dfsg+1-3.debian.tar.xz": "b6688dc60a8437fbabb0da80fdceb623bcdd6c4f35ca8afbe130f817c6140837",
    },
    "base": "http://archive.ubuntu.com/ubuntu/pool/universe/x/xfoil/",
}
CALCULIX = ["calculix=2.23", "libblas=*=*openblas", "liblapack=*=*openblas"]


def run(cmd, **kw):
    print("$", " ".join(map(str, cmd)), flush=True)
    subprocess.run(cmd, check=True, **kw)


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def fetch(url, dest, digest):
    if not dest.exists():
        print("descarregar", url, flush=True)
        urllib.request.urlretrieve(url, dest)
    got = sha256(dest)
    if got != digest:
        sys.exit(f"SHA-256 diferente em {dest.name}: {got} (esperado {digest})")


def pe_deps(path):
    """DLLs importadas e alvos de exportações reencaminhadas (ex. 'openblas.dgemm_')."""
    out = subprocess.run(["objdump", "-p", str(path)], capture_output=True, text=True, check=True).stdout
    deps = set()
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("DLL Name:"):
            deps.add(s.split(":", 1)[1].strip())
        elif "Forwarder RVA --" in s:
            # exportação reencaminhada: "[ n] +base[ m] rva Forwarder RVA -- openblas.dll.dgemm_"
            dll = s.split("--", 1)[1].strip().rsplit(".", 1)[0]
            deps.add(dll if dll.lower().endswith(".dll") else dll + ".dll")
    return deps


def calculix(out, work):
    mm = os.environ.get("MICROMAMBA") or shutil.which("micromamba") or "/opt/mamba/bin/micromamba"
    env = work / "ccx-env"
    root = work / "mamba-root"
    if not (env / "Library/bin/ccx.exe").exists():
        run([mm, "create", "-y", "-q", "-r", str(root), "-p", str(env), "--platform", "win-64", "-c", "conda-forge", *CALCULIX],
            env={**os.environ, "CONDA_OVERRIDE_WIN": "10.0.19045", "MAMBA_ROOT_PREFIX": str(root)})
    dirs = [env / "Library/bin", env / "Library/mingw-w64/bin", env]
    have = {}
    for d in dirs:
        if d.is_dir():
            for f in d.iterdir():
                if f.suffix.lower() in (".dll", ".exe"):
                    have.setdefault(f.name.lower(), f)
    dst = out / "calculix"
    dst.mkdir(parents=True, exist_ok=True)
    todo, seen, system = ["ccx.exe"], set(), set()
    while todo:
        n = todo.pop().lower()
        if n in seen:
            continue
        seen.add(n)
        for d in pe_deps(have[n]):
            # o Windows 10+ resolve os API sets e traz a UCRT: não se copiam
            if d.lower().startswith("api-ms-win-") or d.lower() == "ucrtbase.dll":
                system.add(d)
            elif d.lower() in have:
                todo.append(d)
            else:
                system.add(d)
    for n in seen:
        shutil.copy2(have[n], dst / have[n].name)
    # licenças e versões dos pacotes conda incluídos
    pkgs = []
    lic = dst / "licenses"
    for meta in sorted((env / "conda-meta").glob("*.json")):
        m = json.loads(meta.read_text())
        files = {Path(p).name.lower() for p in m.get("files", [])}
        if not files & seen:
            continue
        pkgs.append({"name": m["name"], "version": m["version"], "build": m["build"], "url": m.get("url")})
        src = Path(m.get("extracted_package_dir", "")) / "info" / "licenses"
        if src.is_dir():
            shutil.copytree(src, lic / m["name"], dirs_exist_ok=True)
    print(f"CalculiX: {len(seen)} ficheiros, DLLs do sistema: {sorted(system)}")
    return {"calculix": {"exe": "calculix/ccx.exe", "packages": pkgs, "system_dlls": sorted(system)}}


def gmsh(out, work):
    whl = work / f"gmsh-{GMSH['version']}-py2.py3-none-win_amd64.whl"
    if not whl.exists():
        run([sys.executable, "-m", "pip", "download", "-q", "--no-deps", "--platform", "win_amd64", "--only-binary=:all:", f"gmsh=={GMSH['version']}", "-d", str(work)])
    if sha256(whl) != GMSH["sha256"]:
        sys.exit("SHA-256 do pacote do Gmsh diferente do esperado")
    dst = out / "gmsh"
    dst.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(whl) as z:
        for n in z.namelist():
            base = Path(n).name
            if n.endswith(".dll") and "/lib/" in n:
                (dst / base).write_bytes(z.read(n))
            elif base.upper() in ("LICENSE.TXT", "CREDITS.TXT") or n.endswith("dist-info/LICENSE"):
                (dst / "licenses").mkdir(exist_ok=True)
                (dst / "licenses" / base).write_bytes(z.read(n))
    run(["x86_64-w64-mingw32-gcc", "-O2", "-s", "-municode", "-static", "-o", str(dst / "gmsh.exe"), str(HERE / "gmsh-launcher.c")])
    return {"gmsh": {"exe": "gmsh/gmsh.exe", "version": GMSH["version"], "source": f"https://pypi.org/project/gmsh/{GMSH['version']}/", "sha256": GMSH["sha256"]}}


def xfoil(out, work):
    for name, digest in XFOIL["files"].items():
        fetch(XFOIL["base"] + name, work / name, digest)
    src = work / "xfoil-src"
    shutil.rmtree(src, ignore_errors=True)
    src.mkdir()
    names = list(XFOIL["files"])
    with tarfile.open(work / names[0]) as t:
        for m in t.getmembers():
            parts = Path(m.name).parts[1:]
            if parts:
                m.name = str(Path(*parts))
                t.extract(m, src, filter="data")
    with tarfile.open(work / names[1]) as t:
        t.extractall(src, filter="data")
    for p in (src / "debian/patches/series").read_text().split():
        run(["patch", "-p1", "-s", "-i", f"debian/patches/{p}"], cwd=src)
    b = work / "xfoil-build"
    shutil.rmtree(b, ignore_errors=True)
    b.mkdir()
    fc = ["x86_64-w64-mingw32-gfortran", "-O2", "-fdefault-real-8", "-fallow-argument-mismatch", "-std=legacy", "-w"]
    objs = []
    for f in ["plt_base", "plt_font", "plt_util", "plt_color", "set_subs", "gw_subs", "ps_subs"]:
        run([*fc, f"-I{src}/plotlib", "-c", str(src / "plotlib" / f"{f}.f"), "-o", str(b / f"p_{f}.o")]); objs.append(b / f"p_{f}.o")
    xf = ["xfoil", "xpanel", "xoper", "xtcam", "xgdes", "xqdes", "xmdes", "xsolve", "xbl", "xblsys", "xpol", "xplots", "pntops", "xgeom", "xutils",
          "modify", "blplot", "polplt", "aread", "naca", "spline", "plutil", "iopol", "gui", "sort", "dplot", "profil", "userio", "frplot", "ntcalc", "osmap"]
    for f in xf:
        p = src / "src" / f"{f}.f"
        if not p.exists():
            p = src / "osrc" / f"{f}.f"
        run([*fc, f"-I{src}/src", f"-I{src}/osrc", "-c", str(p), "-o", str(b / f"{f}.o")]); objs.append(b / f"{f}.o")
    run(["x86_64-w64-mingw32-gcc", "-O2", "-DUNDERSCORE", "-c", str(src / "osrc/getosfile.c"), "-o", str(b / "getosfile.o")]); objs.append(b / "getosfile.o")
    run(["x86_64-w64-mingw32-gcc", "-O2", "-c", str(HERE / "xfoil-nogfx.c"), "-o", str(b / "nogfx.o")]); objs.append(b / "nogfx.o")
    dst = out / "xfoil"
    dst.mkdir(parents=True, exist_ok=True)
    run(["x86_64-w64-mingw32-gfortran", "-static", "-s", "-o", str(dst / "xfoil.exe"), *map(str, objs)])
    (dst / "licenses").mkdir(exist_ok=True)
    shutil.copy2(src / "debian/copyright", dst / "licenses/copyright")
    return {"xfoil": {"exe": "xfoil/xfoil.exe", "version": XFOIL["version"], "source": XFOIL["base"], "files": XFOIL["files"], "notes": "sem gráficos; sem -ffpe-trap"}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "solvers" / "win"))
    ap.add_argument("--work", default="/tmp/galcad-solvers")
    ap.add_argument("--only", nargs="*", choices=["calculix", "gmsh", "xfoil"])
    a = ap.parse_args()
    out, work = Path(a.out), Path(a.work)
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for name, fn in (("calculix", calculix), ("gmsh", gmsh), ("xfoil", xfoil)):
        if not a.only or name in a.only:
            manifest.update(fn(out, work))
    manifest_path.write_text(json.dumps(manifest, indent=1))
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"Solvers em {out}: {size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
