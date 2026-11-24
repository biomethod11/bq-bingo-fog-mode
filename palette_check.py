"""Score the Fog Board player colors: pairwise CIEDE2000 (normal vision and protan/deutan/tritan simulations),
distance from an empty square, and WCAG text contrast.

  python palette_check.py                      # score the palette in fog.html (CURRENT below)
  python palette_check.py red=#c62828 ...      # score a candidate palette instead

Aim for: normal-vision pairs >= 20, color-blind pairs >= 10, text >= 4.5:1. Keep CURRENT in sync with fog.html."""
import itertools, math, sys

def hex2rgb(h):
    h = h.lstrip("#"); return [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]

def lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def unlin(c): c = max(0, min(1, c)); return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

def lum(rgb): r, g, b = (lin(c) for c in rgb); return 0.2126 * r + 0.7152 * g + 0.0722 * b
def contrast(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True); return (la + 0.05) / (lb + 0.05)

def lab(rgb):
    r, g, b = (lin(c) for c in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)

def de2000(l1, l2):
    L1, a1, b1 = l1; L2, a2, b2 = l2
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2); Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360; h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = 0 if C1p * C2p == 0 else (h2p - h1p if abs(h2p - h1p) <= 180 else h2p - h1p - 360 if h2p > h1p else h2p - h1p + 360)
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hbp = h1p + h2p if C1p * C2p == 0 else ((h1p + h2p) / 2 if abs(h1p - h2p) <= 180 else (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2)
    T = 1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp)) + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63))
    dth = 30 * math.exp(-(((hbp - 275) / 25) ** 2)); Rc = 2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / math.sqrt(20 + (Lbp - 50) ** 2); Sc = 1 + 0.045 * Cbp; Sh = 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dth)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))

# Machado et al. 2009, severity 1.0
SIM = {
    "protan": [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    "deutan": [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    "tritan": [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
}
def simulate(rgb, m):
    l = [lin(c) for c in rgb]
    return [unlin(sum(m[i][j] * l[j] for j in range(3))) for i in range(3)]

EMPTY, FOG, PANEL = "#262a35", "#0d0f14", "#1f222b"

def score(name, pal):
    print(f"\n== {name} ==")
    fills = {k: hex2rgb(v) for k, v in pal.items()}
    for vision in ["normal"] + list(SIM):
        conv = (lambda c: c) if vision == "normal" else (lambda c, m=SIM[vision]: simulate(c, m))
        pairs = sorted(((de2000(lab(conv(fills[a])), lab(conv(fills[b]))), a, b) for a, b in itertools.combinations(fills, 2)))
        print(f"  {vision:7s} closest pairs: " + ", ".join(f"{a}/{b} {d:.1f}" for d, a, b in pairs[:4]))
    worst_bg = min((de2000(lab(fills[k]), lab(hex2rgb(EMPTY))), k) for k in fills)
    print(f"  closest to an empty square: {worst_bg[1]} {worst_bg[0]:.1f}")
    for k, rgb in fills.items():
        black, white = contrast(rgb, [0, 0, 0]), contrast(rgb, [1, 1, 1])
        text = "#000" if black >= white else "#fff"
        print(f"  {k:7s} {pal[k]}  text {text} {max(black, white):4.1f}:1   vs panel {contrast(rgb, hex2rgb(PANEL)):4.1f}:1")

CURRENT = {"red": "#c62828", "orange": "#ef6c00", "yellow": "#fdd835", "green": "#66bb6a", "teal": "#4dd0e1",
           "blue": "#1e88e5", "purple": "#8e24aa", "pink": "#ff80ab", "brown": "#8d6e63", "white": "#eceff1"}
if __name__ == "__main__":
    if len(sys.argv) > 1: score("candidate", dict(a.split("=") for a in sys.argv[1:]))
    else: score("current palette (fog.html)", CURRENT)
