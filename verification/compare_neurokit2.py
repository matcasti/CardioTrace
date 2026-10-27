"""
Cross-check of CardioTrace's HRV indices against NeuroKit2.

  python verification/compare_neurokit2.py            (from the repository root)

Requires: node, python packages numpy, pandas, neurokit2.
Part A  real 10.4-min recording (manuscript/raw_data/cardiotrace.txt): time-domain and Poincare indices
Part B  same recording, last 300 s: wavelet (CardioTrace) vs Welch (NeuroKit2) spectral indices
Part C  synthetic RR series with a known LF/HF power ratio: error of each method against the ground truth
"""
import json, subprocess, sys, os, warnings
import numpy as np, pandas as pd
import neurokit2 as nk
warnings.filterwarnings('ignore')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def app(rr):
    tmp = os.path.join(ROOT, 'verification', '_rr.json'); json.dump({'rr': list(map(float, rr))}, open(tmp, 'w'))
    out = subprocess.run(['node', os.path.join(ROOT, 'verification', 'app_indices.js'), tmp], capture_output=True, text=True, check=True).stdout
    os.remove(tmp); return json.loads(out)

def peaks_from_rr(rr):                       # NeuroKit2 wants R-peak sample indices; use a 100 kHz time base (10 us) so that rounding cannot affect pNN50
    return np.round(np.cumsum(np.r_[0, rr]) * 100).astype(np.int64)

def nk_time_nonlinear(rr):
    pk = peaks_from_rr(rr)
    t = nk.hrv_time(pk, sampling_rate=100000); n = nk.hrv_nonlinear(pk, sampling_rate=100000)
    return dict(mean_rr=t['HRV_MeanNN'][0], sdnn=t['HRV_SDNN'][0], rmssd=t['HRV_RMSSD'][0], pnn50=t['HRV_pNN50'][0],
                sd1=n['HRV_SD1'][0], sd2=n['HRV_SD2'][0])

def nk_freq(rr):
    f = nk.hrv_frequency(peaks_from_rr(rr), sampling_rate=100000, psd_method='welch', show=False)
    return dict(vlf=f['HRV_VLF'][0], lf=f['HRV_LF'][0], hf=f['HRV_HF'][0], lfhf=f['HRV_LFHF'][0])

# ---------------- Part A ----------------
raw = [float(x) for x in open(os.path.join(ROOT, 'manuscript', 'raw_data', 'cardiotrace.txt')).read().replace('\r', '').split('\n') if x.strip()][13:][:983]
rr = np.array(raw)
a, k = app(rr), nk_time_nonlinear(rr)
rows = []
for key, label, unit in [('mean_rr', 'Mean NN', 'ms'), ('sdnn', 'SDNN', 'ms'), ('rmssd', 'RMSSD', 'ms'), ('pnn50', 'pNN50', '%'), ('sd1', 'Poincare SD1', 'ms'), ('sd2', 'Poincare SD2', 'ms')]:
    rows.append((label, unit, a[key], k[key], a[key] - k[key], 100 * (a[key] - k[key]) / k[key]))
A = pd.DataFrame(rows, columns=['Index', 'Unit', 'CardioTrace', 'NeuroKit2', 'Difference', 'Difference_%'])
print('\nPART A - real recording (n = %d beats)\n' % len(rr)); print(A.round(4).to_string(index=False))

# ---------------- Part B ----------------
t = np.cumsum(rr) / 1000.0
seg = rr[t >= t[-1] - 300.0]
ab, kb = app(seg)['cwt'], nk_freq(seg)
def share(d):   # relative band shares (CWT power and Welch power are in different units, shares are comparable)
    s = d['vlf'] + d['lf'] + d['hf']; return {b: 100 * d[b] / s for b in ('vlf', 'lf', 'hf')}
B = pd.DataFrame({'Index': ['VLF share (%)', 'LF share (%)', 'HF share (%)', 'LF/HF'],
                  'CardioTrace (Morlet CWT)': [share(ab)['vlf'], share(ab)['lf'], share(ab)['hf'], ab['lfhf']],
                  'NeuroKit2 (Welch)': [share(kb)['vlf'], share(kb)['lf'], share(kb)['hf'], kb['lfhf']]})
print('\nPART B - last 300 s of the recording (%d beats)\n' % len(seg)); print(B.round(3).to_string(index=False))

# ---------------- Part C ----------------
def synth(a_lf, a_hf, dur=300, seed=0, noise=3.0, mean=850.0):
    rng = np.random.default_rng(seed); t_ = 0.0; out = []
    while t_ < dur:
        r = mean + a_lf * np.sin(2 * np.pi * 0.10 * t_) + a_hf * np.sin(2 * np.pi * 0.25 * t_) + rng.normal(0, noise)
        out.append(r); t_ += r / 1000
    return np.array(out)
rows = []
for ratio_amp in (0.5, 1.0, 2.0, 4.0):
    truth = ratio_amp ** 2                       # power ratio of two sinusoids = (A_LF/A_HF)^2
    for seed in range(5):
        s = synth(20 * ratio_amp, 20, seed=seed)
        rows.append((truth, app(s)['cwt']['lfhf'], nk_freq(s)['lfhf']))
C = pd.DataFrame(rows, columns=['true', 'cwt', 'welch'])
C['cwt_err_%'] = 100 * (C.cwt - C.true) / C.true; C['welch_err_%'] = 100 * (C.welch - C.true) / C.true
S = C.groupby('true').agg(cwt_mean=('cwt', 'mean'), cwt_err_mean=('cwt_err_%', 'mean'), cwt_err_sd=('cwt_err_%', 'std'),
                           welch_mean=('welch', 'mean'), welch_err_mean=('welch_err_%', 'mean'), welch_err_sd=('welch_err_%', 'std')).reset_index()
print('\nPART C - synthetic series with known LF/HF (5 noise seeds each, 300 s)\n'); print(S.round(3).to_string(index=False))
# ---------------- Part D: sensitivity to the mean heart rate (equal LF and HF amplitude, true LF/HF = 1) ----------------
rows = []
for mean in (700.0, 850.0, 1000.0):
    for seed in range(5):
        s_ = synth(20, 20, seed=seed, mean=mean)
        rows.append((mean, app(s_)['cwt']['lfhf'], nk_freq(s_)['lfhf']))
D = pd.DataFrame(rows, columns=['mean_rr_ms', 'cwt', 'welch'])
D = D.groupby('mean_rr_ms').agg(cwt_mean=('cwt', 'mean'), cwt_sd=('cwt', 'std'), welch_mean=('welch', 'mean'), welch_sd=('welch', 'std')).reset_index()
print('\nPART D - mean-RR sensitivity (true LF/HF = 1)\n'); print(D.round(3).to_string(index=False))
out = {'A': A.to_dict('records'), 'B': B.to_dict('records'), 'C': S.to_dict('records'), 'D': D.to_dict('records')}
json.dump(out, open(os.path.join(ROOT, 'verification', 'results.json'), 'w'), indent=1)
