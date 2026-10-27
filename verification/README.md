# Numerical verification of the HRV indices

`compare_neurokit2.py` runs CardioTrace's **own** index functions (`app_indices.js` loads them verbatim from
`../engine.js` and executes them in Node) and compares the results with [NeuroKit2](https://github.com/neuropsychology/NeuroKit)
on (A) a real recording, (B) the same recording's spectrum, and (C, D) synthetic RR series with a known LF/HF ratio.

```bash
pip install numpy pandas neurokit2        # NeuroKit2 0.2.13 was used for the results below
python verification/compare_neurokit2.py  # prints the tables and writes verification/results.json
```

## Results (NeuroKit2 0.2.13, 10 µs peak resolution)

**A. Time-domain and Poincaré indices, 983 beats (10.4 min; `manuscript/raw_data/cardiotrace.txt`)**

| Index | CardioTrace | NeuroKit2 | Difference |
|---|---|---|---|
| Mean NN (ms) | 634.4438 | 634.4438 | < 0.0001 % |
| SDNN (ms) | 56.3245 | 56.3245 | < 0.0001 % |
| RMSSD (ms) | 18.1988 | 18.1987 | 0.0006 % |
| pNN50 (%) | 2.0367 | 2.0346 | 0.10 % ¹ |
| Poincaré SD1 (ms) | 12.8751 | 12.8750 | 0.0006 % |
| Poincaré SD2 (ms) | 78.6074 | 78.5745 | 0.04 % |

¹ NeuroKit2 divides the number of successive differences > 50 ms by the number of intervals (983), CardioTrace by the number of differences (982).

**B. Spectral indices, last 300 s of the same recording (489 beats; non-stationary recovery segment)**

| | CardioTrace (Morlet CWT) | NeuroKit2 (Welch) |
|---|---|---|
| VLF / LF / HF share (%) | 26.6 / 68.5 / 4.9 | 17.6 / 77.3 / 5.1 |
| LF/HF | 14.0 | 15.2 |

**C. Synthetic series, LF (0.10 Hz) and HF (0.25 Hz) sinusoids, 300 s, 5 noise seeds per row. Error of the estimated LF/HF relative to the true power ratio (mean ± SD, %)**

| True LF/HF | CardioTrace (CWT) | NeuroKit2 (Welch) |
|---|---|---|
| 0.25 | +8.1 ± 4.4 | +1.0 ± 6.8 |
| 1 | +6.7 ± 3.0 | −0.1 ± 5.0 |
| 4 | +4.7 ± 2.4 | +1.0 ± 3.4 |
| 16 | +1.2 ± 2.6 | −0.8 ± 3.6 |

**D. Dependence on mean heart rate (true LF/HF = 1):** CWT 1.05 / 1.07 / 1.12 and Welch 1.01 / 1.00 / 1.07 for mean RR of 700 / 850 / 1000 ms.

## What this shows, and what it does not

* Time-domain and geometric indices agree with NeuroKit2 to within rounding (definitions: SDNN and SDSD are sample standard deviations).
* The wavelet band variances are accurate on exact uniform signals (1–3 % of the true variance); on RR series the remaining
  positive LF/HF bias of about +1 to +8 % comes from the interpolation and band-edge effects of the wavelet method.
  Before the corrections described in the README (linear → monotone-cubic interpolation) the bias was about +25 %.
* LF/HF from a wavelet transform and from a Welch periodogram are different estimators; on non-stationary real data they can differ by ≈ 8 %
  (B). Neither is a measure of sympathovagal balance.
* This is a **technical** verification on one recording and synthetic signals; it is not a clinical validation.
