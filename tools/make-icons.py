#!/usr/bin/env python3
"""브라우저·휴대폰 홈 화면 아이콘 생성기 (학생용·교사용).

  pip install pillow numpy
  python3 tools/make-icons.py          # public/icons/ 에 PNG·ICO 를 만든다

디자인: 교원대 마크(원본 tools/icon-src/knue-mark.png) + 세계 지도 느낌의 지구 격자(사회과) + 'AI-EPS'.
  - 학생용: 파란 바탕 + 초록 말풍선(인물과 대화)
  - 교사용: 초록 바탕 + 남색 체크 표시(진행 확인)
고치려면 아래 COLORS 와 draw_art() 만 바꾸고 다시 실행한다.
"""
import math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "icons")
MARK = Image.open(os.path.join(ROOT, "tools", "icon-src", "knue-mark.png")).convert("RGBA")
FONT = "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"
U = 1024          # 설계 좌표 한 변
SS = 2            # 확대해서 그린 뒤 줄인다(가장자리를 부드럽게)

COLORS = {
    "student": {"bg": ("#06226B", "#0A7ED0"), "badge": "#4EA82B", "glyph": "chat"},
    "teacher": {"bg": ("#0F4A1E", "#4EA82B"), "badge": "#06226B", "glyph": "check"},
}
hexrgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gradient(size, c1, c2):
    """왼쪽 위 → 오른쪽 아래 대각선 그라데이션"""
    y, x = np.mgrid[0:size, 0:size].astype("float32")
    t = ((x + y) / (2 * (size - 1)))[..., None]
    a, b = np.array(hexrgb(c1), "float32"), np.array(hexrgb(c2), "float32")
    return Image.fromarray((a + (b - a) * t).astype("uint8"), "RGB").convert("RGBA")


def recolor(img, rgb):
    out = Image.new("RGBA", img.size, rgb + (0,)); out.putalpha(img.getchannel("A")); return out


def paste_center(base, layer, cx, cy):
    base.alpha_composite(layer, (int(cx - layer.width / 2), int(cy - layer.height / 2)))


def shadow(base, bbox_fn, blur, offset, alpha):
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0)); d = ImageDraw.Draw(sh)
    bbox_fn(d, (0, 0, 0, alpha), offset)
    base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))


def globe(base, k, cx, cy, r):
    """사회과: 은은한 지구 격자(경선·위선)"""
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0)); d = ImageDraw.Draw(layer)
    col, w = (255, 255, 255, 46), int(7 * k)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, 64), width=int(9 * k))
    for f in (0.34, 0.68):                                   # 경선
        d.ellipse((cx - r * f, cy - r, cx + r * f, cy + r), outline=col, width=w)
    d.line((cx, cy - r, cx, cy + r), fill=col, width=w)
    mask = Image.new("L", base.size, 0); ImageDraw.Draw(mask).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    lat = Image.new("RGBA", base.size, (0, 0, 0, 0)); ld = ImageDraw.Draw(lat)
    for f in (-0.62, -0.31, 0, 0.31, 0.62):                  # 위선
        y = cy + r * f; ld.line((cx - r, y, cx + r, y), fill=col, width=w)
    lat.putalpha(Image.composite(lat.getchannel("A"), Image.new("L", base.size, 0), mask))
    base.alpha_composite(layer); base.alpha_composite(lat)


def glyph_chat(d, k, cx, cy, s, fill):
    """말풍선(점 3개)"""
    w, h = 250 * s * k, 180 * s * k
    d.rounded_rectangle((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), radius=70 * s * k, fill=fill)
    d.polygon([(cx - w * 0.28, cy + h * 0.38), (cx - w * 0.42, cy + h * 0.78), (cx - w * 0.05, cy + h * 0.4)], fill=fill)
    for dx in (-0.24, 0, 0.24):
        r = 17 * s * k; d.ellipse((cx + dx * w - r, cy - r, cx + dx * w + r, cy + r), fill=(255, 255, 255, 255))


def glyph_check(d, k, cx, cy, s, fill):
    """남색 원 + 흰 체크"""
    r = 112 * s * k
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)
    pts = [(cx - 0.50 * r, cy + 0.02 * r), (cx - 0.12 * r, cy + 0.42 * r), (cx + 0.52 * r, cy - 0.36 * r)]
    d.line(pts, fill=(255, 255, 255, 255), width=int(34 * s * k), joint="curve")
    for x, y in (pts[0], pts[2]):
        rr = 17 * s * k; d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=(255, 255, 255, 255))


def draw_art(role, size, rounded, simple=False):
    """role: student|teacher, size: 최종 픽셀, rounded: 둥근 모서리, simple: 작은 아이콘용(글자 없음, 마크 크게)"""
    cfg = COLORS[role]; N = size * SS; k = N / U
    base = gradient(N, *cfg["bg"])
    globe(base, k, 512 * k, (470 if simple else 420) * k, 395 * k if simple else 350 * k)

    bx, by, br = 512, (470 if simple else 415), (330 if simple else 215)
    shadow(base, lambda d, c, o: d.ellipse(((bx - br) * k, (by - br + 14) * k, (bx + br) * k, (by + br + 14) * k), fill=c), 18 * k, 0, 85)
    ImageDraw.Draw(base).ellipse(((bx - br) * k, (by - br) * k, (bx + br) * k, (by + br) * k), fill=(255, 255, 255, 255))
    m = MARK.resize((int(br * 1.74 * k), int(MARK.height * br * 1.74 * k / MARK.width)), Image.LANCZOS)
    paste_center(base, m, bx * k, (by + 4) * k)

    gx, gy, gs = (738, 700, 1.22) if simple else (748, 580, 1.0)
    lay = Image.new("RGBA", base.size, (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    fn = glyph_chat if cfg["glyph"] == "chat" else glyph_check
    shadow(base, lambda dd, c, o: fn(dd, k, gx * k, (gy + 10) * k, gs, c), 12 * k, 0, 90)
    fn(d, k, gx * k, gy * k, gs, hexrgb(cfg["badge"]) + (255,))
    # 말풍선·체크 둘레에 흰 테두리(마크 위에서 또렷하게)
    ring = Image.new("RGBA", base.size, (0, 0, 0, 0)); rd = ImageDraw.Draw(ring)
    fn(rd, k, gx * k, gy * k, gs * 1.09, (255, 255, 255, 255)); base.alpha_composite(ring)
    base.alpha_composite(lay)

    if not simple:
        f = ImageFont.truetype(FONT, int(138 * k))
        d = ImageDraw.Draw(base)
        text, track = "AI-EPS", 6 * k
        widths = [d.textlength(ch, font=f) for ch in text]; tw = sum(widths) + track * (len(text) - 1)
        x = 512 * k - tw / 2; y = 790 * k
        for ch, wv in zip(text, widths):
            d.text((x + 3 * k, y + 5 * k), ch, font=f, fill=(0, 0, 0, 42), anchor="lm")
            d.text((x, y), ch, font=f, fill=(255, 255, 255, 255), anchor="lm"); x += wv + track

    if rounded:
        mask = Image.new("L", (N, N), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, N - 1, N - 1), radius=int(N * 0.225), fill=255)
        base.putalpha(mask)
    return base.resize((size, size), Image.LANCZOS)


def save_png(img, name):
    path = os.path.join(OUT, name); img.save(path, optimize=True); print(f"{name:28s} {os.path.getsize(path) // 1024:4d}KB")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for role in COLORS:
        save_png(draw_art(role, 512, True), f"{role}-512.png")                  # 홈 화면(any)·큰 아이콘
        save_png(draw_art(role, 192, True), f"{role}-192.png")
        save_png(draw_art(role, 512, False).convert("RGB"), f"{role}-maskable-512.png")  # 안드로이드 마스크용(투명 없이 전체 채움, 내용은 안전 영역 안)
        save_png(draw_art(role, 180, False).convert("RGB"), f"{role}-180.png")         # iOS 홈 화면(투명 없음, 모서리는 iOS가 둥글게)
        small = {s: draw_art(role, s, True, simple=True) for s in (16, 32, 48, 64)}
        save_png(small[32], f"{role}-32.png"); save_png(small[16], f"{role}-16.png")
        big = draw_art(role, 256, True, simple=True)
        big.save(os.path.join(OUT, f"{role}.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
        print(f"{role}.ico")
    # 브라우저가 알아서 찾는 기본 파비콘은 학생용
    Image.open(os.path.join(OUT, "student.ico")).save(os.path.join(ROOT, "public", "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
