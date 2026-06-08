"""
CFAR soft-mask A/B evaluation + visualization.

Two deliverables:
  1) Ground-truth SI-SDR A/B: we take a clean-ish target recording, add a KNOWN
     non-stationary noise field (slow swells + random bursts), then measure how
     well baseline vs CFAR masking recovers the target. SI-SDR is scale-invariant
     so the ~7x output-gain shift CFAR introduces does NOT flatter it.
  2) Side-by-side mask plot on a real non-stationary clip (the "with_knock" take),
     so you can eyeball where CFAR re-shaped the floor.

We import the production functions and reproduce estimate_softmask's exact
post-floor pipeline so we can sweep CFAR params in-process (the OCTOVOX_CFAR_MASK
env flag is read once at import, so it can't sweep on its own).

Run:
  $env:OCTOVOX_FORCE_CPU="1"; $env:OCTOVOX_GPU="0"
  c:/Work/New_OCTOVOX/.venv311/Scripts/python.exe c:/Work/New_OCTOVOX/tools/cfar_eval.py
"""
import os, sys
os.environ.setdefault("OCTOVOX_FORCE_CPU", "1")
os.environ.setdefault("OCTOVOX_GPU", "0")

ROOT = r"c:\Work\New_OCTOVOX"
sys.path.insert(0, ROOT)

import numpy as np
import scipy.signal as sps
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import octovox_app.services.pipeline as p

EPS = p.EPS
NFFT, HOP, WIN, FS = p.NFFT, p.HOP, p.WIN, p.FS_REQUIRED

OUTDIR = os.path.join(ROOT, "data", "output", "cfar_eval")
os.makedirs(OUTDIR, exist_ok=True)
INDIR = os.path.join(ROOT, "data", "input")

# --------------------------------------------------------------------------
#  Mask builder — faithful re-implementation of estimate_softmask, but with a
#  pluggable floor so we can A/B baseline vs CFAR(params) in one process.
# --------------------------------------------------------------------------
def build_mask(X, cfar=None):
    """cfar=None -> baseline (global 10th-pct floor). Else dict of cfar kwargs."""
    F, T, C = X.shape
    mag = np.abs(X).mean(axis=2)
    power = mag ** 2
    floor_global = np.maximum(np.quantile(power, 0.10, axis=1, keepdims=True), EPS)
    if cfar is None:
        floor = floor_global
    else:
        local = p.cfar_local_floor(power, xp=np, **cfar)
        floor = floor_global if local is None else np.maximum(floor_global, local)
    snr_post = power / floor
    M = 1.0 / (1.0 + np.exp(-(np.log(snr_post + EPS) - np.log(2.0))))
    if T >= 5:
        k = np.array([0.25, 0.5, 0.25], dtype=np.float32)
        M = sps.fftconvolve(M, k[None, :], mode="same", axes=1)
    if F >= 5:
        M = sps.fftconvolve(M, np.array([[0.25], [0.5], [0.25]], np.float32),
                            mode="same", axes=0)
    return np.clip(M, 0.02, 0.98).astype(np.float32)


def beamform(X, M, n_out, ref=0):
    """Fixed ref=0 across configs so reference-channel choice isn't a confound."""
    phi_x, phi_v = p.compute_csm_masked(X, M)
    phi_x = p.regularise(phi_x)
    phi_v = p.regularise(phi_v)
    rtf = p.estimate_rtf(phi_x, phi_v, ref=ref)
    w = p.bf_mvdr(rtf, phi_v)
    Y = p.apply_beamformer(X, w)
    return p.istft_single(Y, n_out)


def si_sdr(est, ref):
    """Scale-invariant SDR (dB). Both 1-D, same length."""
    est = est - est.mean()
    ref = ref - ref.mean()
    a = np.dot(est, ref) / (np.dot(ref, ref) + EPS)
    s_t = a * ref
    e = est - s_t
    return 10.0 * np.log10((np.dot(s_t, s_t) + EPS) / (np.dot(e, e) + EPS))


def best_lag_align(est, ref, max_lag=512):
    """Find integer lag (|lag|<=max_lag) maximizing correlation, apply to est."""
    n = min(len(est), len(ref))
    est, ref = est[:n], ref[:n]
    # coarse xcorr via FFT on a normalized center segment
    a = est - est.mean(); b = ref - ref.mean()
    corr = sps.fftconvolve(a, b[::-1], mode="full")
    center = n - 1
    lo, hi = center - max_lag, center + max_lag + 1
    lag = int(np.argmax(corr[lo:hi])) - max_lag
    if lag > 0:
        est2 = np.concatenate([est[lag:], np.zeros(lag)])
    elif lag < 0:
        est2 = np.concatenate([np.zeros(-lag), est[:lag]])
    else:
        est2 = est
    return est2[:n], ref[:n], lag


# --------------------------------------------------------------------------
#  Synthetic non-stationary noise (KNOWN, so we have ground truth)
# --------------------------------------------------------------------------
def make_nonstationary_noise(shape, fs, snr_db, target_rms, seed=0):
    D, N = shape
    rng = np.random.default_rng(seed)
    t = np.arange(N) / fs
    # slow swell (HVAC-like) + random transient bursts (door/knock/chair-like)
    env = 0.25 + 0.75 * (0.5 * (1 + np.sin(2 * np.pi * 0.07 * t)))
    dur = N / fs
    for _ in range(7):
        c = rng.uniform(0.05 * dur, 0.95 * dur)
        w = rng.uniform(0.08, 0.35)
        env = env + 1.6 * np.exp(-((t - c) ** 2) / (2 * w * w))
    # per-channel independent noise (diffuse) + a shared component (semi-coherent)
    indep = rng.standard_normal((D, N)).astype(np.float32)
    common = rng.standard_normal((1, N)).astype(np.float32)
    noise = (0.7 * indep + 0.6 * common) * env[None, :]
    # band-limit roughly to a realistic mechanical-noise band
    sos = sps.butter(2, [60.0, 6000.0], btype="bandpass", fs=fs, output="sos")
    noise = sps.sosfilt(sos, noise, axis=-1).astype(np.float32)
    # scale to target SNR vs the clean target's broadband RMS
    nrms = np.sqrt(np.mean(noise ** 2) + EPS)
    gain = (target_rms / (nrms + EPS)) * (10.0 ** (-snr_db / 20.0))
    return (noise * gain).astype(np.float32), env


CONFIGS = [
    ("baseline",      None),
    ("cfar_time",     dict(train_t=12, train_f=0, guard_t=2, guard_f=0, alpha=1.0)),
    ("cfar_time_a05", dict(train_t=12, train_f=0, guard_t=2, guard_f=0, alpha=0.5)),
    ("cfar_default",  dict(train_t=12, train_f=8, guard_t=2, guard_f=2, alpha=1.0)),
]


def load_multichannel(path):
    x, fs = p.load_wav(path)            # (N, C) float
    if fs != FS:
        print(f"  ! {os.path.basename(path)} fs={fs} != {FS}; proceeding (STFT uses FS_REQUIRED)")
    return x.astype(np.float32)


# ==========================================================================
#  PART 1 — Ground-truth SI-SDR A/B on a synthetic non-stationary mixture
# ==========================================================================
def run_groundtruth_ab(target_path, snr_db=3.0):
    print(f"\n=== PART 1: ground-truth SI-SDR A/B (target={os.path.basename(target_path)}, SNR={snr_db} dB) ===")
    tgt = load_multichannel(target_path)          # (N, C)
    N, C = tgt.shape
    tgt_t = tgt.T                                  # (C, N)
    tgt_rms = np.sqrt(np.mean(tgt_t ** 2) + EPS)
    noise, env = make_nonstationary_noise((C, N), FS, snr_db, tgt_rms, seed=0)
    mix = (tgt_t + noise).T                        # (N, C)

    clean_ref = tgt_t[0].astype(np.float64)        # target as received at ref mic (ch0)

    X = p.stft_multich(mix.astype(np.float32))
    results = {}
    rows = []
    # sanity: our baseline mask must equal the production estimate_softmask
    m_base = build_mask(X, None)
    m_prod = p.estimate_softmask(X)
    assert np.array_equal(m_base, m_prod), "build_mask baseline diverged from estimate_softmask!"

    for name, cfar in CONFIGS:
        M = build_mask(X, cfar)
        y = beamform(X, M, N, ref=0).astype(np.float64)
        y_al, ref_al, lag = best_lag_align(y, clean_ref)
        sdr = si_sdr(y_al, ref_al)
        rms = float(np.sqrt(np.mean(y ** 2) + EPS))
        results[name] = dict(mask=M, y=y, sisdr=sdr, rms=rms, lag=lag,
                             mask_mean=float(M.mean()))
        rows.append((name, sdr, float(M.mean()), rms, lag))

    base_sdr = results["baseline"]["sisdr"]
    print(f"  {'config':<16}{'SI-SDR(dB)':>12}{'dSI-SDR':>10}{'mask_mean':>11}{'out_RMS':>10}{'lag':>6}")
    for name, sdr, mm, rms, lag in rows:
        d = sdr - base_sdr
        flag = "  <- baseline" if name == "baseline" else ("  BETTER" if d > 0.1 else ("  worse" if d < -0.1 else "  ~same"))
        print(f"  {name:<16}{sdr:>12.2f}{d:>+10.2f}{mm:>11.3f}{rms:>10.3f}{lag:>6d}{flag}")

    _plot_masks(X, results, os.path.join(OUTDIR, "synthetic_masks.png"),
                title=f"Synthetic non-stationary mix (SNR={snr_db}dB) — {os.path.basename(target_path)}",
                env=env)
    return rows


# ==========================================================================
#  PART 2 — Mask visualization on a REAL non-stationary clip (knock)
# ==========================================================================
def run_real_maskplot(path):
    print(f"\n=== PART 2: mask plot on real clip {os.path.basename(path)} ===")
    x = load_multichannel(path)
    X = p.stft_multich(x.astype(np.float32))
    results = {}
    for name, cfar in CONFIGS:
        M = build_mask(X, cfar)
        results[name] = dict(mask=M, mask_mean=float(M.mean()))
        print(f"  {name:<16} mask_mean={M.mean():.3f}  sparsity(<0.1)={(M<0.1).mean():.3f}")
    _plot_masks(X, results, os.path.join(OUTDIR, "real_knock_masks.png"),
                title=f"Real non-stationary clip — {os.path.basename(path)}")


def _plot_masks(X, results, outpath, title, env=None):
    power = (np.abs(X).mean(axis=2)) ** 2
    logP = 10 * np.log10(power + EPS)
    names = [n for n, _ in CONFIGS]
    nrow = 1 + len(names)
    fig, axes = plt.subplots(nrow, 1, figsize=(11, 2.0 * nrow), sharex=True)
    F, T = power.shape
    extent = [0, T, 0, F]
    im0 = axes[0].imshow(logP, origin="lower", aspect="auto", extent=extent, cmap="magma")
    axes[0].set_ylabel("input\n(log power)")
    fig.colorbar(im0, ax=axes[0], pad=0.01)
    if env is not None:
        ax2 = axes[0].twinx()
        ax2.plot(np.linspace(0, T, len(env)), env, color="cyan", lw=0.7, alpha=0.7)
        ax2.set_yticks([]); ax2.set_ylabel("noise env", color="cyan", fontsize=7)
    for ax, name in zip(axes[1:], names):
        M = results[name]["mask"]
        im = ax.imshow(M, origin="lower", aspect="auto", extent=extent,
                       cmap="viridis", vmin=0, vmax=1)
        ax.set_ylabel(f"{name}\nmean={results[name]['mask_mean']:.2f}")
        fig.colorbar(im, ax=ax, pad=0.01)
    axes[-1].set_xlabel("STFT frame")
    fig.suptitle(title, fontsize=11)
    fig.tight_layout(rect=[0, 0, 1, 0.98])
    fig.savefig(outpath, dpi=110)
    plt.close(fig)
    print(f"  -> wrote {outpath}")


if __name__ == "__main__":
    print(f"OCTOVOX CFAR eval  |  NFFT={NFFT} HOP={HOP} FS={FS}  |  CFAR flag default={p._CFAR_MASK}")
    # Ground-truth A/B: clean-ish single-person clip as the target signal.
    tgt = os.path.join(INDIR, "conference_room_single_person.wav")
    rows1 = run_groundtruth_ab(tgt, snr_db=3.0)
    # Also a tougher SNR to see if the verdict holds.
    rows2 = run_groundtruth_ab(tgt, snr_db=0.0)
    # Real non-stationary clip for the visual.
    knock = os.path.join(INDIR, "Conference_room_sitting_take2_with_knock.wav")
    if os.path.exists(knock):
        run_real_maskplot(knock)
    else:
        print(f"  ! knock clip not found at {knock}")
    print("\nDone. Plots in:", OUTDIR)
