"""Imagens do instalador e ícone da GALCAD a partir da marca Galkeel (símbolo GK e logótipo
horizontal, variações finais 03 e 02 do pacote de marca). Uso:
python3 desktop/brand/make-assets.py <Montserrat-700.woff> <Montserrat-500.woff>
Escreve desktop/build/icon.ico, icon.png, installerSidebar.bmp, uninstallerSidebar.bmp e
installerHeader.bmp, e desktop/brand/splash-logo.png."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "build"
NAVY, TEAL, GREY, WHITE = (10, 36, 100), (1, 138, 138), (90, 102, 115), (255, 255, 255)
bold, medium = sys.argv[1], sys.argv[2]

sym = Image.open(HERE / "gk-simbolo.png").convert("RGBA")
sym = sym.crop(sym.getbbox())
horiz = Image.open(HERE / "gk-horizontal.png").convert("RGBA")
horiz = horiz.crop(horiz.getbbox())


def square(img, pad=0.06):
    s = int(max(img.size) * (1 + 2 * pad))
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, ((s - img.width) // 2, (s - img.height) // 2), img)
    return out


def white(img):
    # símbolo em branco (versão negativa) a partir do canal alfa
    w = Image.new("RGBA", img.size, WHITE + (0,))
    w.putalpha(img.getchannel("A"))
    return w


def fit(img, w, h):
    k = min(w / img.width, h / img.height)
    return img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
icon = square(sym)
icon.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
icon.resize((256, 256), Image.LANCZOS).save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
fit(sym, 320, 320).save(HERE / "splash-logo.png")

# barra lateral do assistente (164 × 314): azul-marinho, símbolo GK em branco, nome e linha turquesa
for name, sub in (("installerSidebar.bmp", "Instalação"), ("uninstallerSidebar.bmp", "Desinstalação")):
    im = Image.new("RGB", (164, 314), NAVY)
    d = ImageDraw.Draw(im)
    s = fit(white(sym), 104, 104)
    im.paste(s, ((164 - s.width) // 2, 40), s)
    f1, f2, f3 = ImageFont.truetype(bold, 22), ImageFont.truetype(medium, 10), ImageFont.truetype(medium, 9)
    for text, font, y, col in (("GALCAD", f1, 168, WHITE), ("CAD · FEM · CFD", f2, 198, (190, 205, 225)), (sub, f3, 284, (150, 170, 200))):
        w = d.textlength(text, font=font)
        d.text(((164 - w) / 2, y), text, font=font, fill=col)
    d.rectangle((52, 222, 112, 224), fill=TEAL)
    d.text(((164 - d.textlength("Galkeel", font=f2)) / 2, 234), "Galkeel", font=f2, fill=WHITE)
    im.save(OUT / name)

# cabeçalho (150 × 57): logótipo horizontal em fundo branco
hd = Image.new("RGB", (150, 57), WHITE)
h = fit(horiz, 140, 45)
hd.paste(h, ((150 - h.width) // 2, (57 - h.height) // 2), h)
hd.save(OUT / "installerHeader.bmp")
print("ok:", ", ".join(sorted(p.name for p in OUT.iterdir())))
