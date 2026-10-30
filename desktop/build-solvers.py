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
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tarfile, urllib.request, zipfile
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
SU2 = {"version": "8.3.0", "url": "https://github.com/su2code/SU2/releases/download/v8.3.0/SU2-v8.3.0-win64.zip",
       "sha256": "1c4f953b130efa9eebcd825b8f881d630e68227ea9ef2986ebff0c41dcc2cb73",
       "license": "https://raw.githubusercontent.com/su2code/SU2/v8.3.0/LICENSE.md"}
OPENFOAM = {"version": "v2606", "url": "https://sourceforge.net/projects/openfoam/files/v2606/OpenFOAM-v2606-windows-mingw.exe/download",
            "file": "OpenFOAM-v2606-windows-mingw.exe", "sha256": "020321d58b42e1d2ad0b616cdde17f92503608edd902388fb8c73e94e9cb1e25"}
ASTER = ["code-aster=18.1.11=*nompi*", "python=3.11"]


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


def su2(out, work):
    z = work / "SU2-win64.zip"
    fetch(SU2["url"], z, SU2["sha256"])
    dst = out / "su2"
    dst.mkdir(parents=True, exist_ok=True)
    import io
    with zipfile.ZipFile(z) as outer, zipfile.ZipFile(io.BytesIO(outer.read("win64.zip"))) as inner:
        (dst / "SU2_CFD.exe").write_bytes(inner.read("bin/SU2_CFD.exe"))
    (dst / "licenses").mkdir(exist_ok=True)
    urllib.request.urlretrieve(SU2["license"], dst / "licenses" / "LICENSE.md")
    return {"su2": {"exe": "su2/SU2_CFD.exe", "version": SU2["version"], "source": SU2["url"], "sha256": SU2["sha256"], "notes": "binário oficial de série (sem MPI)"}}


def openfoam(out, work):
    """Só os executáveis, as bibliotecas e o etc da versão MinGW oficial; Pstream de série (sem MS-MPI)."""
    exe = work / OPENFOAM["file"]
    fetch(OPENFOAM["url"], exe, OPENFOAM["sha256"])
    x = work / "openfoam-x"
    shutil.rmtree(x, ignore_errors=True)
    run(["7z", "x", "-y", "-bso0", "-bsp0", str(exe), "msys64.7z", f"-o{x}"])
    proj = f"OpenFOAM-{OPENFOAM['version']}"
    base = f"msys64/home/ofuser/OpenFOAM/{proj}"
    run(["7z", "x", "-y", "-bso0", "-bsp0", str(x / "msys64.7z"), f"-o{x}", f"{base}/etc", f"{base}/platforms", f"{base}/LICENSE.md", f"{base}/README.md", "-r-"])
    src = x / base
    dst = out / "openfoam" / proj
    shutil.rmtree(out / "openfoam", ignore_errors=True)
    (dst / "platforms").mkdir(parents=True)
    shutil.copytree(src / "etc", dst / "etc")
    for t in (src / "platforms").iterdir():
        shutil.copytree(t / "bin", dst / "platforms" / t.name / "bin")
        dummy = dst / "platforms" / t.name / "bin" / "libPstream.dll-dummy"
        if dummy.exists():
            shutil.copy2(dummy, dst / "platforms" / t.name / "bin" / "libPstream.dll")
    for f in ("LICENSE.md", "README.md"):
        if (src / f).exists():
            shutil.copy2(src / f, dst / f)
    return {"openfoam": {"dir": f"openfoam/{proj}", "version": OPENFOAM["version"], "source": OPENFOAM["url"], "sha256": OPENFOAM["sha256"], "notes": "versão MinGW oficial (openfoam.com); Pstream de série; sem MSYS2"}}


OPENRADIOSS = {"version": "latest-20261011",
               "url": "https://github.com/OpenCourant/OpenCourant/releases/download/latest-20261011/OpenCourant_win64.zip",
               "sha256": "6d0ea8b43b68aa12f0a2787b339384a554978cbb65a5d3dbaf1e40598f02e7e6"}


def openradioss(out, work):
    """OpenCourant (OpenRadioss, AGPL-3.0) oficial win64: Starter/Engine sem MPI, anim_to_vtk, leitor de
    entradas (hm_cfg_files, hm_reader), h3d e o runtime Intel oneAPI de que os executáveis dependem
    (sem Intel MPI nem as variantes de precisão simples)."""
    z = work / "OpenCourant_win64.zip"
    fetch(OPENRADIOSS["url"], z, OPENRADIOSS["sha256"])
    dst = out / "openradioss"
    keep = re.compile(r"^OpenCourant/(COPYRIGHT\.md|LICENSE.*|licenses/.*|hm_cfg_files/.*|extlib/hm_reader/win64/.*\.dll|extlib/h3d/lib/win64/.*\.dll"
                      r"|extlib/intelOneAPI_runtime/license/.*|extlib/intelOneAPI_runtime/win64/(?!impi|libfabric).*\.dll"
                      r"|exec/(starter_win64|engine_win64|anim_to_vtk_win64)\.exe)$")
    n = 0
    with zipfile.ZipFile(z) as zf:
        for info in zf.infolist():
            if info.is_dir() or not keep.match(info.filename):
                continue
            target = dst / info.filename[len("OpenCourant/"):]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(info))
            n += 1
    for exe in ("starter_win64.exe", "engine_win64.exe", "anim_to_vtk_win64.exe"):
        if not (dst / "exec" / exe).exists():
            raise SystemExit(f"OpenCourant: falta exec/{exe}")
    print(f"OpenCourant: {n} ficheiros")
    return {"openradioss": {"dir": "openradioss", "version": OPENRADIOSS["version"], "source": OPENRADIOSS["url"], "sha256": OPENRADIOSS["sha256"],
                            "notes": "OpenCourant (continuação do OpenRadioss), AGPL-3.0; Starter/Engine sem MPI e o runtime Intel oneAPI"}}


def code_aster(out, work):
    """Ambiente conda win-64 relocável: a app substitui o caminho de construção nos ficheiros de texto no 1.º arranque."""
    mm = os.environ.get("MICROMAMBA") or shutil.which("micromamba") or "/opt/mamba/bin/micromamba"
    root = work / "mamba-root"
    dst = out / "code_aster"
    shutil.rmtree(dst, ignore_errors=True)
    run([mm, "create", "-y", "-q", "-r", str(root), "-p", str(dst), "--platform", "win-64", "-c", "conda-forge", *ASTER],
        env={**os.environ, "CONDA_OVERRIDE_WIN": "10.0.19045", "MAMBA_ROOT_PREFIX": str(root)})
    # o micromamba, a criar um ambiente Windows a partir do Linux, põe os pacotes noarch em
    # lib/python3.X/site-packages e alguns em lib/site-packages: juntá-los em Lib/site-packages
    site = dst / "Lib" / "site-packages"
    for wrong in list((dst / "lib").glob("python3*/site-packages")) + [dst / "lib" / "site-packages"]:
        if wrong.is_dir():
            for item in wrong.iterdir():
                target = site / item.name
                if target.exists():
                    shutil.rmtree(item) if item.is_dir() else item.unlink()
                else:
                    shutil.move(str(item), str(target))
    for leftover in list((dst / "lib").glob("python3*")) + [dst / "lib" / "site-packages", dst / "bin"]:
        shutil.rmtree(leftover, ignore_errors=True)
    if (dst / "lib").is_dir() and not any((dst / "lib").iterdir()):
        (dst / "lib").rmdir()
    # o que não é preciso para correr: cabeçalhos, bibliotecas de importação, símbolos de depuração
    for rel in ("Library/include", "include", "conda-meta/history"):
        p = dst / rel
        shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
    for f in list(dst.rglob("*.pdb")) + list((dst / "Library/lib").glob("*.lib")):
        f.unlink()
    prefix = str(dst).encode()
    text, binary = [], []
    for f in dst.rglob("*"):
        if f.is_file() and not f.is_symlink():
            b = f.read_bytes()
            if prefix in b:
                (binary if b"\0" in b[:8192] else text).append(str(f.relative_to(dst)).replace("\\", "/"))
    (dst / ".galcad-relocate.json").write_text(json.dumps({"prefix": str(dst), "files": sorted(text), "binary_ignored": sorted(binary)}, indent=1))
    (dst / "run_aster.cmd").write_text("\r\n".join([
        "@echo off",
        "rem Lancador do code_aster para a GALCAD: ambiente conda sem activate (python -m run_aster).",
        'set "CONDA_PREFIX=%~dp0"',
        'set "CONDA_PREFIX=%CONDA_PREFIX:~0,-1%"',
        'set "PATH=%CONDA_PREFIX%;%CONDA_PREFIX%\\Library\\mingw-w64\\bin;%CONDA_PREFIX%\\Library\\usr\\bin;%CONDA_PREFIX%\\Library\\bin;%CONDA_PREFIX%\\Scripts;%PATH%"',
        'set "PYTHONHOME="',
        '"%CONDA_PREFIX%\\python.exe" -m run_aster %*',
        "",
    ]))
    pkgs = []
    for meta in sorted((dst / "conda-meta").glob("*.json")):
        m = json.loads(meta.read_text())
        pkgs.append({"name": m["name"], "version": m["version"], "build": m["build"], "url": m.get("url")})
        src = Path(m.get("extracted_package_dir", "")) / "info" / "licenses"
        if src.is_dir():
            shutil.copytree(src, dst / "licenses" / m["name"], dirs_exist_ok=True)
    print(f"code_aster: {len(text)} ficheiros de texto a relocar, {len(binary)} binários ignorados: {binary}")
    return {"code_aster": {"exe": "code_aster/run_aster.cmd", "version": "18.1.11", "packages": pkgs, "relocate": len(text)}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "solvers" / "win"))
    ap.add_argument("--work", default="/tmp/galcad-solvers")
    ap.add_argument("--only", nargs="*", choices=["calculix", "gmsh", "xfoil", "su2", "openfoam", "code_aster", "openradioss"])
    a = ap.parse_args()
    out, work = Path(a.out), Path(a.work)
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for name, fn in (("calculix", calculix), ("gmsh", gmsh), ("xfoil", xfoil), ("su2", su2), ("openfoam", openfoam), ("code_aster", code_aster), ("openradioss", openradioss)):
        if not a.only or name in a.only:
            manifest.update(fn(out, work))
    manifest_path.write_text(json.dumps(manifest, indent=1))
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"Solvers em {out}: {size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
