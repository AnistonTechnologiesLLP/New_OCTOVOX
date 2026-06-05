"""Synthesize an 8-ch recording with a speaker MOVING IN AZIMUTH around the
planar Polaris UCA (the geometry the array can actually resolve), plus a
fixed-direction competing talker and sensor noise. This is the scenario the
tracked RTF-MVDR is built for and that the real dataset lacks (its 'moving'
clips move in elevation, which a flat UCA can't see).

Far-field plane-wave model applied in the STFT domain: per frame, the target
is steered from a time-varying azimuth; the interferer from a fixed azimuth.
Then we run the full pipeline and compare batch vs tracked RTF-MVDR.
"""
import sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from octovox_app.services import pipeline as ov

rng = np.random.default_rng(0)
FS, NFFT, GEO = ov.FS_REQUIRED, ov.NFFT, ov.POLARIS_UCA_M

# ---- real mono speech for the moving target -----------------------------
src, fs = ov.load_wav(ROOT / "data/input/conference_room_single_person.wav")
assert fs == FS
s = src[:, 0].astype(np.float32)
s = s[: FS * 8] if len(s) > FS * 8 else s          # ~8 s
s /= (np.max(np.abs(s)) + 1e-9)
N = len(s)

# competing talker: a decorrelated copy (time-reversed, shifted) from a FIXED
# direction — fills some of the target's pauses so 'quiet' frames are noisy.
intf = 0.6 * s[::-1].copy()

# ---- STFTs (use the pipeline's own framing) -----------------------------
S = ov.stft_multich(s[:, None])[:, :, 0]            # (F,T) target
I = ov.stft_multich(intf[:, None])[:, :, 0]         # (F,T) interferer
F, T = S.shape

# ---- time-varying target azimuth: sweep -90deg -> +90deg, el=0 ----------
az = np.linspace(-90, 90, T)
el = 0.0
def unit(az_deg, el_deg):
    a, e = np.deg2rad(az_deg), np.deg2rad(el_deg)
    return np.array([np.cos(e)*np.cos(a), np.cos(e)*np.sin(a), np.sin(e)])

# precompute target steering per frame (F,C) and fixed interferer steering
A_int = ov.steering_vector(unit(135, 0), FS, NFFT, GEO)     # (F,C) fixed @135deg
C = GEO.shape[0]
Xspec = np.zeros((F, T, C), dtype=np.complex64)
for t in range(T):
    a_t = ov.steering_vector(unit(az[t], el), FS, NFFT, GEO)  # (F,C)
    Xspec[:, t, :] = S[:, t, None] * a_t + I[:, t, None] * A_int

# ---- back to 8-ch time domain + sensor noise ----------------------------
x = np.zeros((N, C), dtype=np.float32)
for c in range(C):
    x[:, c] = ov.istft_single(Xspec[:, :, c], n_out=N)
x += 0.01 * rng.standard_normal(x.shape).astype(np.float32)   # ~-40 dB sensors
x /= (np.max(np.abs(x)) + 1e-9) * 1.05

out = ROOT / "data/input/synth_azimuth_sweep.wav"
ov.save_wav(out, x, FS)
print(f"wrote {out.name}: {x.shape[0]} samples x {x.shape[1]} ch, "
      f"target az {az[0]:.0f}->{az[-1]:.0f} deg, interferer fixed @135 deg")

# ---- run the pipeline ----------------------------------------------------
out_dir = ov.process_file(out, ROOT / "octovox_app/services/output/_synth",
                          visualize=False, n_bootstrap=300)
import json
m = json.loads((out_dir / "metrics.json").read_text(encoding="utf-8"))
mp, bs = m["metrics_per_pipeline"], m["bootstrap_stats"]
print("\n=== RESULTS: azimuth-sweep target ===")
for name in ["Single mic", "RTF-MVDR", "RTF-MVDR (tracked)", "RTF-GEV+BAN"]:
    d = mp.get(name); b = bs.get(name, {})
    if d:
        print(f"  {name:22s} snr={d['snr_db']:6.2f} dB  "
              f"boot_median={b.get('median_snr_db',float('nan')):6.2f}  "
              f"win%={b.get('win_rate_pct',0):5.1f}")
batch = mp["RTF-MVDR"]["snr_db"]; trk = mp["RTF-MVDR (tracked)"]["snr_db"]
print(f"\n  tracked - batch = {trk - batch:+.2f} dB  "
      f"({'TRACKED WINS' if trk > batch else 'batch wins'})")
print(f"  ranked: {m['winner']['ranked']}")
