"""
Cross-check of CardioTrace's automatic artifact detection / correction (Lipponen & Tarvainen 2019)
against NeuroKit2's signal_fixpeaks(method="kubios").

  python verification/compare_artifacts.py      (from the repository root; needs node, numpy, pandas, neurokit2)

Cases: the real two-strap recording (no artifacts expected) and synthetic series with injected ectopic beats,
missed beats, extra beats and long/short intervals. Peaks are integer samples at 1000 Hz, as NeuroKit2 expects.
Checked: (1) first-pass detections per class identical; (2) iteratively corrected peaks within 1 sample
(NeuroKit2 truncates moved peaks to integer samples, CardioTrace keeps fractional milliseconds).
"""
import json, os, subprocess, sys, warnings
import numpy as np
import neurokit2 as nk
from neurokit2.signal.signal_fixpeaks import _find_artifacts
warnings.filterwarnings('ignore')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def synthetic(seed, n=600):
    rng = np.random.default_rng(seed)
    t = np.cumsum(np.full(n, 0.85))
    rr = 850 + 40 * np.sin(2 * np.pi * 0.1 * t) + 25 * np.sin(2 * np.pi * 0.25 * t) + rng.normal(0, 8, n)
    rr = list(np.round(rr))
    events = []
    for k in rng.choice(np.arange(30, n - 30), 12, replace=False):
        kind = ['ectopic', 'missed', 'extra', 'longshort'][len(events) % 4]
        events.append((int(k), kind))
    for k, kind in sorted(events, reverse=True):
        if kind == 'ectopic':  a = round(rr[k] * 0.65); rr[k + 1] += rr[k] - a; rr[k] = a
        elif kind == 'missed': rr[k] = rr[k] + rr[k + 1]; del rr[k + 1]
        elif kind == 'extra':  a = round(rr[k] * 0.4); rr.insert(k + 1, rr[k] - a); rr[k] = a
        else:                  rr[k] = round(rr[k] * 1.45)
    return [float(v) for v in rr]

raw = [float(x) for x in open(os.path.join(ROOT, 'manuscript', 'raw_data', 'cardiotrace.txt')).read().split() if x.strip()]
series = [('real recording (1002 beats)', [round(v) for v in raw])] + [(f'synthetic #{s} (12 injected artifacts)', synthetic(s)) for s in range(1, 9)]
cases = [{'peaks': [float(p) for p in np.cumsum([0] + rr)]} for _, rr in series]

tmp = os.path.join(ROOT, 'verification', '_artifacts.json'); json.dump({'cases': cases}, open(tmp, 'w'))
app = json.loads(subprocess.run(['node', os.path.join(ROOT, 'verification', 'app_artifacts.js'), tmp], capture_output=True, text=True, check=True).stdout)
os.remove(tmp)

ok_all = True
results = []
print(f"{'case':42s} {'ectopic':>8s} {'missed':>7s} {'extra':>6s} {'long/sh':>8s}  detections  corrected peaks")
for (label, _), case, a in zip(series, cases, app):
    peaks = np.array(case['peaks'], dtype=np.int64)
    art, _ = _find_artifacts(peaks, sampling_rate=1000)
    _, nk_clean = nk.signal_fixpeaks(peaks, sampling_rate=1000, iterative=True, method='kubios', show=False)
    same_det = all(list(map(int, art[k])) == a['first'][k] for k in ('ectopic', 'missed', 'extra', 'longshort'))
    app_pk = np.array(a['peaks'])
    same_len = len(app_pk) == len(nk_clean)
    max_dev = float(np.max(np.abs(app_pk - nk_clean))) if same_len else float('inf')
    ok = same_det and same_len and max_dev <= 1.0
    ok_all &= ok
    counts = [len(art[k]) for k in ('ectopic', 'missed', 'extra', 'longshort')]
    print(f"{label:42s} {counts[0]:8d} {counts[1]:7d} {counts[2]:6d} {counts[3]:8d}  {'identical' if same_det else 'DIFFERENT':10s}  "
          f"{'n equal' if same_len else 'n DIFFERS'}, max |Δ| = {max_dev:.3f} sample")
    results.append({'case': label, 'nk2_counts': dict(zip(('ectopic', 'missed', 'extra', 'longshort'), counts)),
                    'detections_identical': same_det, 'corrected_peaks_same_count': same_len, 'max_abs_peak_difference_samples': max_dev})
json.dump({'neurokit2': nk.__version__, 'cases': results, 'all_ok': bool(ok_all)},
          open(os.path.join(ROOT, 'verification', 'artifact_results.json'), 'w'), indent=2)
print('\nALL OK' if ok_all else '\nMISMATCH'); sys.exit(0 if ok_all else 1)
