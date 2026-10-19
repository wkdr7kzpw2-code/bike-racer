#!/usr/bin/env python3
"""iOS-card karaoke video generator.

Each lyric line gets its own iOS-style card on a dark pastel background,
a karaoke caption runs on top, and cards swap through a blur exactly on the beat.

Usage:
  python3 make_video.py --lyrics lyrics.txt --audio song.mp3 --start 42.5 -o out.mp4
  python3 make_video.py --demo -o demo.mp4          # placeholder text + synth beat

lyrics.txt: one line per card. Optional LRC timestamps "[00:03.20] text" pin a
line's start (relative to --start); otherwise lines are spread evenly and
snapped to the nearest detected beat.
"""
import argparse, math, os, re, subprocess, sys, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1080, 1920, 30
FONT_DIR = "/usr/share/fonts/opentype/inter"
F_BOLD = os.path.join(FONT_DIR, "Inter-Bold.otf")
F_SEMI = os.path.join(FONT_DIR, "Inter-SemiBold.otf")
F_MED = os.path.join(FONT_DIR, "Inter-Medium.otf")
SR = 22050

# ---------- audio / beats ----------

def decode_audio(path, start, dur):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(dur), "-i", path,
           "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

def detect_beats(y, dur, bpm=None):
    """Spectral-flux onset envelope -> tempo by autocorrelation -> beat phase."""
    hop, n = 512, 2048
    frames = 1 + max(0, (len(y) - n) // hop)
    win = np.hanning(n)
    spec = np.abs(np.stack([np.fft.rfft(y[i*hop:i*hop+n] * win) for i in range(frames)]))
    spec = np.log1p(spec * 10)
    flux = np.maximum(0, np.diff(spec, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")
    flux = np.maximum(flux, 0)
    fr = SR / hop
    # an onset first shows up in the frame whose window just reaches it
    t_env = (np.arange(len(flux)) * hop + 0.75 * n) / SR

    def comb(period):
        """Best (score, phase) for a beat grid of this period."""
        best = (-1.0, 0.0)
        for phase in np.linspace(0, period, 48, endpoint=False):
            v = np.interp(np.arange(phase, dur, period), t_env, flux).mean()
            if v > best[0]:
                best = (v, phase)
        return best

    if bpm is None:
        cands = np.arange(70, 181, 0.5)
        prior = np.exp(-0.5 * (np.log2(cands / 120) / 1.0) ** 2)
        scores = [comb(60 / c)[0] * p for c, p in zip(cands, prior)]
        bpm = float(cands[int(np.argmax(scores))])
    period = 60.0 / bpm
    best_phase = comb(period)[1]
    return bpm, [float(b) for b in np.arange(best_phase, dur, period)]

def synth_beat(dur, bpm=120):
    t = np.arange(int(dur * SR)) / SR
    y = np.zeros_like(t)
    period = 60 / bpm
    for k, b in enumerate(np.arange(0, dur, period)):
        i = int(b * SR); seg = t[: min(len(t) - i, int(0.35 * SR))]
        kick = np.sin(2 * np.pi * (50 + 90 * np.exp(-seg * 30)) * seg) * np.exp(-seg * 9)
        y[i:i+len(seg)] += 0.8 * kick
        if k % 2 == 1:  # snare-ish noise on 2 and 4
            noise = np.random.default_rng(k).standard_normal(len(seg)) * np.exp(-seg * 18)
            y[i:i+len(seg)] += 0.25 * noise
        hi = int((b + period / 2) * SR)
        if hi < len(t):
            hs = t[: min(len(t) - hi, int(0.05 * SR))]
            y[hi:hi+len(hs)] += 0.08 * np.random.default_rng(1000+k).standard_normal(len(hs)) * np.exp(-hs * 80)
    pad = sum(0.06 * np.sin(2 * np.pi * f * t) for f in (220, 277.2, 329.6))
    y = y + pad * (0.6 + 0.4 * np.sin(2 * np.pi * t / 4))
    return np.clip(y / np.max(np.abs(y)) * 0.9, -1, 1).astype(np.float32)

def write_wav(path, y):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((y * 32767).astype(np.int16).tobytes())

# ---------- lyrics / timing ----------

LRC = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$")

def read_lyrics(path):
    lines = []
    for raw in open(path, encoding="utf-8"):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        m = LRC.match(raw)
        lines.append((int(m[1]) * 60 + float(m[2]), m[3]) if m else (None, raw))
    return lines

def schedule(lines, beats, dur):
    n = len(lines)
    snap = lambda t: min(beats, key=lambda b: abs(b - t)) if beats else t
    starts = []
    for i, (ts, _) in enumerate(lines):
        starts.append(snap(ts) if ts is not None else (0.0 if i == 0 else snap(dur * i / n)))
    starts[0] = 0.0
    return [(starts[i], starts[i+1] if i + 1 < n else dur, lines[i][1]) for i in range(n)]

# ---------- drawing ----------

PALETTE = [(44, 32, 78), (28, 40, 82), (66, 34, 76), (24, 52, 70)]
BLOBS = [(196, 164, 232), (150, 190, 236), (236, 168, 196), (160, 214, 200), (240, 200, 160)]

def background(t, tint):
    w, h = W // 8, H // 8
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = np.array(tint, np.float32)
    img = np.ones((h, w, 3), np.float32) * (base * 0.6)
    for k, c in enumerate(BLOBS):
        cx = w * (0.5 + 0.38 * math.sin(0.23 * t + k * 1.7))
        cy = h * (0.5 + 0.40 * math.cos(0.17 * t + k * 2.3))
        r = w * (0.55 + 0.1 * math.sin(0.3 * t + k))
        g = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))[..., None]
        img += g * np.array(c, np.float32) * 0.32
    # vignette: darken the edges so the card stands out
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 * 0.3 + ((yy - h / 2) / (h / 2)) ** 2)[..., None]
    img = img * (1 - 0.55 * np.clip((d - 0.35) / 0.65, 0, 1)) + np.array((10, 6, 22)) * 0.55 * np.clip((d - 0.35) / 0.65, 0, 1)
    img = np.clip(img, 0, 255).astype(np.uint8)
    return Image.fromarray(img).resize((W, H), Image.BICUBIC)

def wrap(draw, text, font, maxw):
    words, out, cur = text.split(), [], ""
    for wd in words:
        trial = (cur + " " + wd).strip()
        if draw.textlength(trial, font=font) <= maxw or not cur:
            cur = trial
        else:
            out.append(cur); cur = wd
    if cur:
        out.append(cur)
    return out

def make_card(text, idx, total, header):
    cw, pad = 920, 56
    f_text = ImageFont.truetype(F_BOLD, 66)
    f_app = ImageFont.truetype(F_SEMI, 34)
    f_small = ImageFont.truetype(F_MED, 30)
    tmp = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    lines = wrap(tmp, text, f_text, cw - 2 * pad)
    lh = 84
    ch = pad + 64 + 40 + len(lines) * lh + 40 + 10 + pad
    m = 80  # margin for shadow
    card = Image.new("RGBA", (cw + 2 * m, ch + 2 * m), (0, 0, 0, 0))
    sh = Image.new("L", card.size, 0)
    ImageDraw.Draw(sh).rounded_rectangle((m, m + 24, m + cw, m + ch + 24), 60, fill=120)
    sh = sh.filter(ImageFilter.GaussianBlur(36))
    card.paste((10, 6, 24, 255), (0, 0), sh)
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((m, m, m + cw, m + ch), 60, fill=(246, 243, 250, 245))
    # app icon
    x0, y0 = m + pad, m + pad
    icon = Image.new("RGBA", (64, 64))
    grad = np.zeros((64, 64, 4), np.uint8)
    for yy in range(64):
        k = yy / 63
        grad[yy, :, :3] = np.array((252, 92, 125)) * (1 - k) + np.array((186, 84, 245)) * k
    grad[..., 3] = 255
    icon = Image.fromarray(grad)
    mask = Image.new("L", (64, 64), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 63, 63), 15, fill=255)
    card.paste(icon, (x0, y0), mask)
    d.text((x0 + 32, y0 + 32), "♫", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36),
           fill="white", anchor="mm")
    d.text((x0 + 88, y0 + 32), header.upper(), font=f_app, fill=(120, 112, 140), anchor="lm")
    d.text((m + cw - pad, y0 + 32), "сейчас", font=f_small, fill=(150, 144, 165), anchor="rm")
    ty = y0 + 64 + 40
    for i, ln in enumerate(lines):
        d.text((x0, ty + i * lh), ln, font=f_text, fill=(28, 24, 40))
    # page dots
    dy = ty + len(lines) * lh + 40
    for k in range(total):
        cx = x0 + 6 + k * 26
        col = (28, 24, 40) if k == idx else (200, 194, 214)
        d.ellipse((cx - 6, dy - 6 + 5, cx + 6, dy + 6 + 5), fill=col)
    return card

def draw_karaoke(frame, text, prog):
    """Top caption: words light up left->right as prog goes 0..1."""
    f = ImageFont.truetype(F_BOLD, 50)
    layer = Image.new("RGBA", (W, 420), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    lines = wrap(d, text, f, W - 160)
    total = sum(len(w) for w in text.split()) or 1
    lit = prog * total
    acc, y = 0, 60 + (3 - len(lines)) * 30
    for ln in lines:
        words = ln.split()
        x = (W - d.textlength(ln, font=f)) / 2
        for wd in words:
            ww = d.textlength(wd, font=f)
            d.text((x, y), wd, font=f, fill=(255, 255, 255, 95))
            frac = min(1, max(0, (lit - acc) / len(wd)))
            if frac > 0:
                word = Image.new("RGBA", layer.size, (0, 0, 0, 0))
                ImageDraw.Draw(word).text((x, y), wd, font=f, fill=(255, 236, 250, 255))
                clip = Image.new("L", layer.size, 0)
                ImageDraw.Draw(clip).rectangle((x - 4, y - 10, x + ww * frac + 2, y + 80), fill=255)
                a = np.minimum(np.array(word.getchannel("A")), np.array(clip))
                word.putalpha(Image.fromarray(a))
                layer.alpha_composite(word)
            acc += len(wd)
            x += ww + d.textlength(" ", font=f)
        y += 66
    glow = layer.filter(ImageFilter.GaussianBlur(14))
    frame.alpha_composite(glow, (0, 170))
    frame.alpha_composite(layer, (0, 170))

def place(frame, card, scale, blur, alpha, dy=0):
    scale, blur, alpha = float(scale), float(blur), float(alpha)
    c = card
    if abs(scale - 1) > 1e-3:
        c = c.resize((int(c.width * scale), int(c.height * scale)), Image.BICUBIC)
    if blur > 0.3:
        c = c.filter(ImageFilter.GaussianBlur(blur))
    if alpha < 0.999:
        a = np.array(c.getchannel("A"), np.float32) * alpha
        c.putalpha(Image.fromarray(a.astype(np.uint8)))
    frame.alpha_composite(c, ((W - c.width) // 2, int(H * 0.56 - c.height / 2 + dy)))

def ease(x):
    x = min(1, max(0, x))
    return x * x * (3 - 2 * x)

# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lyrics")
    ap.add_argument("--audio")
    ap.add_argument("--start", type=float, default=0.0, help="song offset in seconds")
    ap.add_argument("--duration", type=float, default=15.0)
    ap.add_argument("--bpm", type=float, help="override tempo detection")
    ap.add_argument("--header", default="Музыка")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("-o", "--out", default="out.mp4")
    a = ap.parse_args()
    dur = a.duration
    work = os.path.splitext(a.out)[0] + "_audio.wav"

    if a.demo:
        lines = [(None, t) for t in (
            "Тут будет первая строчка твоего текста",
            "Вторая строчка на своей карточке",
            "Третья — смена ровно в бит через блюр",
            "И четвёртая, финальная строчка")]
        y = synth_beat(dur, a.bpm or 120)
        write_wav(work, y)
    else:
        if not a.lyrics:
            sys.exit("--lyrics is required (or use --demo)")
        lines = read_lyrics(a.lyrics)
        if a.audio:
            y = decode_audio(a.audio, a.start, dur)
            write_wav(work, y)
        else:
            y = synth_beat(dur, a.bpm or 120); write_wav(work, y)

    if a.audio and not a.demo:
        # tempo from a short clip is unreliable: analyse up to 20 s around the fragment
        w0 = max(0.0, a.start - 20)
        wy = decode_audio(a.audio, w0, dur + (a.start - w0) + 20)
        bpm, wbeats = detect_beats(wy, len(wy) / SR, a.bpm)
        beats = [b - (a.start - w0) for b in wbeats if 0 <= b - (a.start - w0) < dur]
    else:
        bpm, beats = detect_beats(y, dur, a.bpm)
    plan = schedule(lines, beats, dur)
    print(f"tempo ≈ {bpm:.1f} BPM, {len(beats)} beats")
    for s, e, t in plan:
        print(f"  {s:6.2f}–{e:6.2f}s  {t}")

    cards = [make_card(t, i, len(plan), a.header) for i, (_, _, t) in enumerate(plan)]
    TR = 0.16  # half-length of the blur transition, seconds
    enc = subprocess.Popen([
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
        "-r", str(FPS), "-i", "-", "-i", work,
        "-af", f"afade=t=in:d=0.3,afade=t=out:st={dur-0.8}:d=0.8",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", a.out],
        stdin=subprocess.PIPE)
    beat_arr = np.array(beats)
    for fi in range(int(dur * FPS)):
        t = fi / FPS
        i = max(k for k, (s, _, _) in enumerate(plan) if s <= t + 1e-6)
        s, e, text = plan[i]
        frame = background(t, PALETTE[i % len(PALETTE)]).convert("RGBA")
        # beat pulse
        past = beat_arr[beat_arr <= t]
        pulse = 0.018 * math.exp(-(t - past[-1]) * 9) if len(past) else 0
        # karaoke progress: sing across 85% of the line's slot
        prog = min(1, max(0, (t - s) / max(0.1, (e - s) * 0.85)))
        draw_karaoke(frame, text, prog)
        if t < s + TR:      # incoming: blur -> sharp
            k = ease((t - s) / TR) if i > 0 or t > 0 else 0
            if i == 0:
                k = ease(t / (TR * 2))
            place(frame, cards[i], 0.94 + 0.06 * k + pulse, 34 * (1 - k), k, 40 * (1 - k))
        elif i + 1 < len(plan) and t > e - TR:  # outgoing: sharp -> blur
            k = ease((e - t) / TR)
            place(frame, cards[i], 1.05 - 0.05 * k, 34 * (1 - k), k, -30 * (1 - k))
        else:
            place(frame, cards[i], 1 + pulse, 0, 1)
        out = np.asarray(frame.convert("RGB"), np.float32)
        flash = 0.10 * math.exp(-max(0.0, t - s) * 7) if i > 0 else 0
        if flash > 0.004:  # soft light kick on each card change
            out = out * (1 - flash) + np.array((255, 240, 252)) * flash
        fade = (t - (dur - 0.5)) / 0.5
        if fade > 0:       # fade out together with the audio
            k = min(1, fade) * 0.85
            out = out * (1 - k) + np.array((12, 8, 22)) * k
        enc.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
    enc.stdin.close(); enc.wait()
    os.remove(work)
    print("wrote", a.out)

if __name__ == "__main__":
    main()
