# ❤️ CardioTrace

> **Real-time Heart Rate Variability Analysis for Polar H10**
> Runs entirely in the browser — no server, no install, no dependencies to manage.

---

## Table of Contents

1. [Overview](#overview)
2. [Feature Summary](#feature-summary)
3. [Architecture](#architecture)
4. [File Structure](#file-structure)
5. [Setup & Requirements](#setup--requirements)
6. [Bluetooth Device Support](#bluetooth-device-support)
7. [User Interface Guide](#user-interface-guide)
   - [Controls Panel](#controls-panel)
   - [Stats Grid](#stats-grid)
   - [Stress Recovery Index (SRI)](#stress-recovery-index-sri)
   - [Charts](#charts)
   - [History Panel](#history-panel)
   - [Settings](#settings)
8. [Signal Pipeline](#signal-pipeline)
   - [Calibration & Artifact Rejection](#calibration--artifact-rejection)
   - [RR Interval Storage (Raw vs. Clean)](#rr-interval-storage-raw-vs-clean)
9. [HRV Metrics Reference](#hrv-metrics-reference)
   - [Time Domain](#time-domain)
   - [Frequency Domain — Lomb-Scargle PSD](#frequency-domain--lomb-scargle-psd)
   - [Frequency Domain — Morlet CWT Spectrogram](#frequency-domain--morlet-cwt-spectrogram)
   - [Geometric — Poincaré Plot](#geometric--poincaré-plot)
10. [Stress Recovery Index (SRI) Deep-Dive](#stress-recovery-index-sri-deep-dive)
11. [Settings Reference](#settings-reference)
12. [Data Export](#data-export)
    - [CSV Format](#csv-format)
    - [TXT Format](#txt-format)
    - [HTML Report](#html-report)
    - [Bulk ZIP Download](#bulk-zip-download)
13. [Session History & IndexedDB](#session-history--indexeddb)
14. [Chart Layout (GridStack)](#chart-layout-gridstack)
15. [Theming](#theming)
16. [Key Constants & Configuration](#key-constants--configuration)
17. [Known Bugs & Audit Notes](#known-bugs--audit-notes)
18. [iOS / Mobile Notes](#ios--mobile-notes)
19. [Contributing](#contributing)

---

## Overview

CardioTrace connects to a **Polar H10** chest-strap heart-rate monitor via the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) and streams raw RR intervals (beat-to-beat timings) in real time. It computes a comprehensive set of HRV metrics, visualises them across seven interactive charts, and calculates a composite **Stress Recovery Index (SRI)** score. All session data is persisted locally in **IndexedDB** and can be exported as CSV, plain-text RR lists, or a print-ready HTML report.

The entire application is three static files — `index.html`, `style.css`, and `engine.js` — with no build step and no backend. It can be served from any static host or opened directly from the filesystem (with a browser that supports Web Bluetooth over a `file://` origin, which Chrome currently allows on some platforms).

---

## Feature Summary

| Category | Feature |
|---|---|
| **Connection** | Web Bluetooth (HR + PMD + Battery services) |
| **ECG** | Live ECG waveform at 130 Hz (Polar PMD protocol) |
| **HRV — Time domain** | RMSSD, SDNN, pNN50, mean RR, avg HR |
| **HRV — Frequency domain** | Lomb-Scargle PSD; VLF / LF / HF band powers |
| **HRV — Spectrogram** | Morlet CWT (ω₀ = 6, 4 Hz interpolation), rendered as heatmap |
| **HRV — Geometric** | Poincaré plot with SD1 / SD2 ellipse overlay |
| **Composite score** | Stress Recovery Index (SRI), 0–100 |
| **HR zones** | 5 training zones derived from age-based max HR |
| **Vagal proxy** | Rolling RMSSD / SDNN ratio |
| **Calibration** | Configurable warm-up period (default 8 s) automatically discarded |
| **Artifact rejection** | Real-time per-beat validation + configurable max Δ threshold |
| **Data quality** | Live percentage of accepted vs. raw intervals |
| **Event markers** | Timestamped event types with free-text annotations |
| **Session tags** | Free-form tag chips per session |
| **Auto-save** | Periodic IndexedDB writes (configurable interval) |
| **History** | Card view + sortable/filterable table view |
| **Export** | CSV with metadata header, plain-text RR, HTML report, bulk ZIP |
| **Layout** | Draggable and resizable charts via GridStack; layout saved to localStorage |
| **Theme** | Dark (default) / Light toggle, persisted to localStorage |
| **Cinema mode** | Hides controls panel to maximise chart area |
| **Settings** | Age, calibration period, autosave interval, rolling window, artifact threshold, chart visibility |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser tab (single-origin, no server)                         │
│                                                                 │
│  index.html ─── DOM structure, modal panels, chart containers   │
│  style.css  ─── CSS custom properties, all component styles     │
│  engine.js  ─── All application logic (BLE, math, charts, DB)   │
│                                                                 │
│  External CDN scripts (loaded at runtime):                      │
│    • Plotly.js 2.27  – chart rendering                          │
│    • GridStack 8.4   – drag/resize layout engine                │
│    • JSZip 3.10      – ZIP generation for bulk export           │
│                                                                 │
│  Browser APIs:                                                  │
│    • Web Bluetooth API  – device communication                  │
│    • IndexedDB          – session storage                       │
│    • Canvas 2D          – SRI gauge rendering                   │
│    • Web Share API      – iOS export fallback                   │
└─────────────────────────────────────────────────────────────────┘
```

### Data flow (live session)

```
Polar H10 (BLE)
    │
    ├─ HR Measurement characteristic (0x2A37)
    │       └─ handleHRData()
    │               ├─ Raw RR → rawRRIntervals[] / rawTimestamps[]
    │               ├─ isValidRRInterval() → rrIntervals[] / timestamps[]
    │               └─ Triggers: updateStats(), chart updates (throttled)
    │
    └─ PMD Data characteristic (fb005c82-...)
            └─ handleECGData()
                    └─ ecgData[] / ecgTimestamps[]  →  updateECGChart()

State arrays (in-memory, also written to IndexedDB every N seconds):
    rrIntervals[]        – clean, artifact-rejected RR intervals (ms)
    timestamps[]         – corresponding session-relative timestamps (s)
    rawRRIntervals[]     – all post-calibration intervals before rejection
    rawTimestamps[]      – corresponding raw timestamps
    rollingRMSSD[]       – precomputed rolling RMSSD values
    ecgData[]            – ECG amplitude samples (µV)
    eventMarkers[]       – timestamped user-placed markers
    sessionTags[]        – string tags for the current session
```

---

## File Structure

```
cardiotrace/
├── index.html      Layout, modals, chart containers, inline SVG for SRI info button
├── style.css       All styles; CSS custom properties drive theming
└── engine.js       Entire application logic:
                      ├─ BLE constants & device management
                      ├─ State variables
                      ├─ Settings (load / save / apply)
                      ├─ GridStack initialisation
                      ├─ PSD: Lomb-Scargle periodogram
                      ├─ CWT: Morlet spectrogram (FFT-based)
                      ├─ Poincaré SD1/SD2
                      ├─ Rolling RMSSD (O(n) sliding window)
                      ├─ Vagal proxy
                      ├─ HR zones
                      ├─ SRI calculation & gauge (Canvas)
                      ├─ IndexedDB CRUD
                      ├─ Session auto-save
                      ├─ History render (cards + table)
                      ├─ Export (CSV / TXT / HTML report / ZIP)
                      ├─ Event markers & annotations
                      ├─ Tag management
                      ├─ Plotly chart init & update functions
                      └─ UI event listeners & initialisation IIFE
```

---

## Setup & Requirements

### Browser
- **Chrome 56+** or **Edge 79+** on desktop (Windows / macOS / Linux / Android)
- Web Bluetooth is **not supported** in Firefox or Safari
- The page must be served over **HTTPS** or `localhost`; `file://` works on some Chromium builds but is not guaranteed

### Serving locally

```bash
# Python 3
python -m http.server 8080

# Node (npx)
npx serve .

# Then open: http://localhost:8080
```

No npm install, no build step.

---

## Bluetooth Device Support

CardioTrace communicates using three standard BLE services:

| Service | UUID | Purpose |
|---|---|---|
| Heart Rate | `0000180d-0000-1000-8000-00805f9b34fb` | RR intervals + HR value |
| Polar Measurement Data (PMD) | `fb005c80-02e7-f387-1cad-8acd2d8df0c8` | Raw ECG streaming |
| Battery | `0000180f-0000-1000-8000-00805f9b34fb` | Battery percentage |

**Characteristics used:**

| Characteristic | UUID | Direction |
|---|---|---|
| HR Measurement | `00002a37-...` | Notify |
| Battery Level | `00002a19-...` | Notify + Read |
| PMD Control | `fb005c81-...` | Write + Notify |
| PMD Data | `fb005c82-...` | Notify |

The app requests ECG streaming with the byte sequence `[0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00]` (130 Hz, 14-bit resolution). ECG streaming gracefully degrades — if the device doesn't support it, HR-only mode continues normally.

> **Tested device:** Polar H10. Other BLE heart-rate monitors that implement the standard HR Measurement characteristic will supply RR intervals; ECG will be unavailable on non-Polar hardware.

---

## User Interface Guide

### Controls Panel

Three collapsible sections across the top (hidden in Cinema mode):

**Connection**
- `Connect Device` — triggers the browser's BLE device picker
- `Disconnect` — saves the current session to history then disconnects
- Status indicator (Not Connected / Calibrating / Connected) with animated dot
- Signal quality indicator (Excellent / Good / Fair / Poor based on time since last packet)
- Battery indicator with level bar
- HR zone badge
- Data Quality percentage

**Recording**
- `Mark Event` — opens the event type panel; timestamped markers appear on RR and Rolling RMSSD charts
- `Reset Session` — clears all current data (prompts for confirmation)
- Session timer (counts up from end of calibration)
- Tag input — add/remove free-form string tags per session

**Export Data**
- Session name input
- `Download` — saves CSV or TXT to disk
- `Copy` — copies to clipboard
- `Report` — generates a full HTML report in a new tab
- `RR only` toggle — switches export format to plain-text RR list
- `Include raw data` toggle — exports unfiltered (pre-rejection) intervals

### Stats Grid

Four always-visible cards showing 1-minute rolling values:

| Card | Metric | Notes |
|---|---|---|
| Heart Rate | BPM from HR characteristic | Updates on every packet |
| RMSSD (1 min) | Root mean square of successive differences | Filtered to last 60 s of timestamps |
| RR Intervals | Total clean sample count | Running total |
| Avg RR (1 min) | Mean RR over last 60 s | Converted to ms |

Cards pulse with a glow animation on new data receipt (`is-live` class + `value-flash` transition).

### Stress Recovery Index (SRI)

A prominent section between the stats grid and charts. Contains:
- **Gauge** — Canvas-drawn arc dial (0–100), responsive to container width, redrawn on ResizeObserver
- **Score overlay** — Animated counter with easing
- **Component readouts** — RMSSD, LF/HF, HR Recovery
- **Status banner** — Colour-coded interpretation (Excellent / Good / Fair / Poor)
- **ⓘ Info button** — Opens a slide-in panel with full methodology, component weights, scale guide, and scientific references

### Charts

Seven Plotly charts arranged in a GridStack drag-and-resize layout:

| Chart ID | Description | Minimum data |
|---|---|---|
| `ecgChart` | Raw ECG waveform at 130 Hz | Any ECG samples |
| `rrChart` | RR intervals over session time; event markers as vertical dashed lines | 1 interval |
| `rollingRMSSDChart` | Rolling RMSSD sliding window; event markers | 30 s of data |
| `poincareChart` | Scatter plot RR(n) vs RR(n+1) with SD1/SD2 ellipse and identity line | 2 intervals |
| `psdChart` | Morlet CWT spectrogram (heatmap); VLF/LF/HF band percentage annotations | 50 intervals |
| `hrChart` | HR (bpm) over time with coloured training zone bands | 1 interval |
| `vagalProxyChart` | Rolling RMSSD/SDNN ratio; 0.5 reference line | 30 s of data |

Charts with insufficient data show a placeholder icon and blurred background (`chart-blurred` class).

### History Panel

Slide-in panel from the right, triggered by the floating `📚` button.

**Card view** — One card per session, showing:
- Date/time, duration, filename, tags
- Stats: samples, avg RR, RMSSD, SRI (colour-coded), events
- Actions: Download (💾), Delete (🗑️)
- Click anywhere on the card (outside action buttons) to **restore** the session

**Table view** — Wide modal with a full sortable table:
- Columns: Date, Name, Duration, Samples, Avg RR, RMSSD, SRI, Events, Tags, Actions
- Per-row actions: Restore (↩️), Download (💾), Rename (✏️), Delete (🗑️)
- Checkbox column for multi-select bulk operations
- Separate search/tag/sort filters synced from the sidebar

**Search & Filters** (both views):
- Free-text search across filename and date string
- Tag dropdown (populated from all tags across saved sessions)
- Sort: Newest / Oldest / Longest / Shortest

### Settings

Slide-in panel from the right, triggered by the `⚙️` button:

- **Profile** — Age slider (used for max HR and zone calculations)
- **Recording** — Calibration period, autosave interval
- **HRV Analysis** — Rolling window duration, artifact rejection threshold (chip selector)
- **Visible Charts** — Toggle each of the 7 charts on/off
- **Chart Layout** — Reset to default GridStack layout

---

## Signal Pipeline

### Calibration & Artifact Rejection

When the device connects, a **calibration period** begins immediately (default 8 seconds, configurable 5–30 s). During this period:
- The status indicator shows "Calibrating..." with an amber pulse
- HR values still update in the stats display
- **No RR intervals are stored** in either `rrIntervals` or `rawRRIntervals`
- `calibrationStartTime` remains `null`

After the calibration period, `calibrationStartTime` is set to `Date.now()`. All subsequent timestamps are calculated as `(Date.now() - calibrationStartTime) / 1000` seconds. This baseline is used consistently across all stats calculations, chart time axes, event markers, exports, and auto-saves.

**Per-beat validation** (`isValidRRInterval()`):

```
1. Physiological bounds:  250 ms ≤ RR ≤ 2000 ms  (i.e., 30–200 BPM)
2. Successive difference:  |RR[i] − RR[i−1]| ≤ artifactThreshold
   Threshold options: 150 ms (Strict) | 300 ms (Moderate, default) | 500 ms (Loose)
```

Intervals that pass validation go into `rrIntervals[]` / `timestamps[]`.
All post-calibration intervals (pass or fail) go into `rawRRIntervals[]` / `rawTimestamps[]`.

**Data Quality** is displayed as `(rrIntervals.length / rawRRIntervals.length) × 100 %`.

### RR Interval Storage (Raw vs. Clean)

The dual-array scheme enables:
- Accurate data quality reporting at all times
- Export of either cleaned or raw data (toggle in the Export section)
- Transparent session restore — old sessions stored before v2 of the format are re-cleaned on restore using the current artifact threshold

---

## HRV Metrics Reference

### Time Domain

| Metric | Computation | Typical reference (5-min resting) |
|---|---|---|
| Mean RR | Arithmetic mean of `rrIntervals` | 600–1000 ms |
| RMSSD | √(Σ(RR[i]−RR[i−1])² / (N−1)) | 20–50 ms |
| SDNN | √(Σ(RR[i]−mean)² / N) | 50–100 ms |
| pNN50 | % of consecutive pairs differing by > 50 ms | > 5–15% |

The **1-minute rolling** RMSSD shown in the stat card and exported header uses only the RR intervals whose timestamps fall within the last 60 s of session time.

### Frequency Domain — Lomb-Scargle PSD

`calculatePSD()` uses a **Lomb-Scargle periodogram** on the non-uniformly sampled RR series (no interpolation required). The spectrum is computed at 0.5 mHz resolution from 0.003 Hz to 0.4 Hz, then normalised so that the integral equals the signal variance (ms²), giving units of **ms²/Hz**.

Frequency bands:

| Band | Range | Interpretation |
|---|---|---|
| VLF | 0.003–0.04 Hz | Very low frequency; thermoregulation, RAAS |
| LF | 0.04–0.15 Hz | Mixed sympathetic + parasympathetic; baroreflex |
| HF | 0.15–0.40 Hz | High frequency; respiratory sinus arrhythmia (vagal) |

Band powers are integrated with the trapezoidal rule (`integrateBandPower()`). This function is used only in the standalone PSD path; the spectrogram uses its own CWT-based integration.

> **Note:** The Lomb-Scargle PSD is currently used only in export metadata and legacy code paths. The spectrogram chart and SRI's LF/HF component use the Morlet CWT pipeline exclusively.

### Frequency Domain — Morlet CWT Spectrogram

`computeMorletCWT()` implements the **Morlet continuous wavelet transform** following Torrence & Compo (1998):

1. **Interpolation** — `interpolateRRUniform()` linearly resamples the non-uniform RR series to a uniform grid at `CWT_FS = 4 Hz` using cumulative beat times as the time axis.
2. **Windowing** — At most the last 1200 samples (~5 min) are used to bound computation.
3. **Demean** — DC offset is removed before transform.
4. **Zero-padding** — To the next power-of-2 × 2 to reduce circular wrap-around artifacts.
5. **FFT** — In-place Cooley-Tukey radix-2 FFT (`fftInPlace()`).
6. **Wavelet filter** — For each of `CWT_VOICES = 22` log-spaced frequencies (0.005–0.40 Hz), a Morlet wavelet spectrum is computed in the frequency domain. The normalisation factor `√(2π·s/dt) · π^(-1/4)` preserves energy across scales.
7. **IFFT** — Per-voice complex time series retrieved via IFFT.
8. **Scalogram** — Instantaneous power `|W(s,t)|²` stored per voice per time point.
9. **Band powers** — Time-averaged power per voice, integrated trapezoidally in frequency over VLF / LF / HF bands.
10. **LF/HF ratio** — `lfPow / hfPow`.

The result is cached in `lastCWTResult` and reused by the SRI calculation within the same heartbeat cycle to avoid redundant computation.

**Display decimation** — The scalogram is decimated to ~1 Hz before passing to Plotly to keep rendering responsive. Colours represent `log₁₀(power)`.

### Geometric — Poincaré Plot

`computePoincareStats()` derives SD1 and SD2 from the full RR series:

```
SD1 = RMSSD / √2           (short-term, parasympathetic)
SD2 = √(2·SDNN² − ½·RMSSD²)   (long-term, sympathetic + parasympathetic)
```

`generateEllipseTrace()` draws the 1-SD ellipse in the rotated (45°) coordinate system. The identity line `RR(n) = RR(n+1)` is overlaid as a dashed reference.

---

## Stress Recovery Index (SRI) Deep-Dive

`calculateSRI()` computes a composite score on a 0–100 scale from three components:

### Component 1 — RMSSD (35% weight)

```
rmssdNormalized = min(100, (RMSSD / 100) × 100)
```

Higher RMSSD → higher score. The 100 ms anchor point maps to a normalised score of 100 (clamped).

### Component 2 — LF/HF Ratio (35% weight)

Inverse relationship — lower ratio indicates better parasympathetic recovery:

| LF/HF range | Normalised score |
|---|---|
| ≤ 0.5 | 100 |
| 0.5 – 2.0 | Linear 100 → 70 |
| 2.0 – 3.0 | Linear 70 → 40 |
| > 3.0 | Linear 40 → 0 (floor 0) |

The LF/HF ratio is sourced from `lastCWTResult` when the cached result matches the current data length (avoiding a redundant full CWT pass), otherwise a fresh CWT is computed.

### Component 3 — HR Recovery Rate (30% weight)

```
recoveryRate = max(
    (peakHR − avgHR) / peakHR × 100,
    (peakHR − minHR) / peakHR × 100
)
hrRecoveryNormalized = min(100, max(0, recoveryRate))
```

### Composite

```
SRI = rmssdNormalized × 0.35 + lfhfNormalized × 0.35 + hrRecoveryNormalized × 0.30
```

Rounded to the nearest integer.

### Score interpretation

| Range | Category | Status class |
|---|---|---|
| 75–100 | Excellent Recovery | `excellent` |
| 55–74 | Good Recovery | `good` |
| 35–54 | Fair Recovery | `fair` |
| 0–34 | Poor Recovery | `poor` |

### SRI Gauge

`drawSRIGauge(score)` uses the Canvas 2D API to render a multi-layer arc gauge:
- Background arc with 4 colour-banded segments
- Score arc with gradient + glow
- Tick marks (adaptive density; labels at 0, 25, 50, 75, 100 for sizes ≥ 250 px)
- Score indicator dot at the arc tip
- Centre decorative ring

The gauge is redrawn via a `ResizeObserver` on the wrapper element for responsive sizing. Device pixel ratio scaling (`window.devicePixelRatio`) keeps it sharp on HiDPI displays.

---

## Settings Reference

All settings are serialised to `localStorage` under the key `cardioTraceSettings`.

| Setting | Key | Default | Range / Options |
|---|---|---|---|
| Age | `age` | 30 | 10–100 years |
| Calibration period | `calibrationSecs` | 8 | 5–30 s |
| Auto-save interval | `autosaveSecs` | 10 | 10–120 s |
| Rolling window | `rmssdWindow` | 60 | 30–300 s |
| Artifact threshold | `artifactThreshold` | 300 | 150 (Strict) / 300 (Moderate) / 500 (Loose) ms |
| Visible charts | `visibleCharts.*` | all `true` | Per-chart boolean |

---

## Data Export

### CSV Format

The CSV file consists of a **metadata header block** (lines starting with `#`) followed by columnar data.

**Header fields:**

```
# Polar H10 HRV Data Export
# Generated: <ISO timestamp>
# Date: <session start>
# Duration: <formatted duration>
# Filename: <session name>
# Tags: <comma-separated>
# Data Type: Clean (artifacts removed) | Raw (uncleaned)
# Total RR Intervals: <N>
# Valid Intervals: <N> (<quality %>)
# Removed Artifacts: <N>
# Calibration Period: 8 seconds (excluded from data)
# Total Events: <N>
# Event Types: <comma-separated list>
```

**Data columns:**

```
Timestamp (s), RR Interval (ms), Event Type, Annotation
```

- `Timestamp` — seconds since `calibrationStartTime` (i.e., session-relative, not wall clock)
- Commas inside annotations are escaped to semicolons to preserve CSV structure

### TXT Format

One RR interval per line (milliseconds, 3 decimal places). Compatible with tools like Kubios HRV.

```
832.031
780.273
815.430
...
```

### HTML Report

`generatePDFReport()` captures all seven Plotly charts as high-resolution PNG images (`scale: 10`) via `Plotly.toImage()`, then builds a self-contained HTML document in memory. Opened in a new tab with a `🖨️ Print / Save PDF` button that invokes `window.print()`.

Report sections:
- Session header (date, duration, sample count, data quality, tags)
- KPI cards (SRI, RMSSD, LF/HF, avg HR)
- Interpretation banner (auto-generated from SRI score)
- Signal overview charts (RR + Rolling RMSSD)
- Frequency & geometric charts (Spectrogram + Poincaré, 3:2 grid)
- HR + Vagal Proxy charts
- SRI component breakdown
- Time domain metrics table (with reference ranges and clinical notes)
- Frequency domain metrics table
- Events table
- Session metadata table
- SRI reference scale
- Scientific references and disclaimer

### Bulk ZIP Download

`bulkDownloadSessions()` iterates all sessions that pass the current filter/sort state, generates a CSV or TXT file per session, and packages them into a single ZIP using JSZip. The ZIP filename includes today's date.

---

## Session History & IndexedDB

Database name: `PolarH10Monitor`  
Object store: `sessions`  
Current version: **4** (schema migrated from v3 to add SRI fields)

**Session record schema:**

```js
{
  id:               number,          // auto-increment primary key
  timestamp:        number,          // Date.now() at save time
  date:             string,          // ISO date string
  startTime:        number,          // calibrationStartTime or sessionStartTime
  duration:         number,          // seconds from timestamps array
  filename:         string,
  rrIntervals:      number[],        // clean RR intervals (ms)
  timestamps:       number[],        // clean timestamps (s)
  rawRRIntervals:   number[],
  rawTimestamps:    number[],
  eventMarkers:     object[],        // { time, type, annotation, label }
  annotations:      object[],        // same as eventMarkers (legacy alias)
  tags:             string[],
  stats: {
    samples:        number,
    avgRR:          number | null,
    rmssd:          number | null
  },
  sri:              number,
  sriComponents:    { rmssd, lfhf, hrRecovery },
  peakHR:           number
}
```

**Auto-save** writes on an interval (`autoSaveInterval`). The first write creates a new record and stores its `id` in `currentSessionId`; subsequent writes use `objectStore.put()` to update in place.

On **disconnect**, a final save is triggered. On **reset**, `currentSessionId` is cleared so the next write starts a fresh record.

**Restore** (`restoreSession(id)`) loads a session, cleans data if from an old format, calculates SRI, and updates all charts and UI — without requiring a device connection.

---

## Chart Layout (GridStack)

GridStack is initialised in `initGrid()` with:
- 12-column grid
- Cell height: 70 px
- Draggable by `.chart-title` handle
- Resizable via `e,se,s,sw,w` handles

The layout is saved to `localStorage` (`cardioTraceGridLayout`) on every `change`, `resizestop`, and `dragstop` event. On load, the saved layout is restored; if none exists, the default layout applies.

**Default layout:**

| Chart | x | y | w | h |
|---|---|---|---|---|
| ECG Signal | 0 | 0 | 6 | 5 |
| RR Intervals | 6 | 0 | 6 | 5 |
| Rolling RMSSD | 0 | 5 | 6 | 5 |
| Poincaré Plot | 6 | 5 | 6 | 5 |
| HRV Spectrogram | 0 | 10 | 12 | 5 |
| Heart Rate + Zones | 0 | 15 | 6 | 5 |
| Vagal Proxy | 6 | 15 | 6 | 5 |

If GridStack fails to load from CDN, a CSS fallback grid (`fallback-grid` class) renders a 2-column static layout.

---

## Theming

CSS custom properties defined on `:root` (dark, default) and `[data-theme="light"]`:

| Variable | Dark | Light |
|---|---|---|
| `--bg-primary` | `#000` | `#f9fafb` |
| `--bg-secondary` | `rgba(17,24,39,0.4)` | `rgba(255,255,255,0.9)` |
| `--text-primary` | `#fff` | `#111827` |
| `--text-secondary` | `#9ca3af` | `#4b5563` |
| `--accent-primary` | `#6366f1` | (same) |
| `--accent-secondary` | `#ec4899` | (same) |
| `--accent-tertiary` | `#22d3ee` | (same) |

The theme toggle writes the current theme to `localStorage` under the key `theme` and calls `updateChartThemes()` which re-applies axis colours to all Plotly charts. The SRI gauge also detects the active theme and adjusts glow intensity, shadow opacity, and tick colours.

---

## Key Constants & Configuration

Defined at the top of `engine.js`:

```js
// BLE
PMD_SERVICE    = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8'
PMD_CONTROL    = 'fb005c81-...'
PMD_DATA       = 'fb005c82-...'
HR_SERVICE     = '0000180d-...'
HR_MEASUREMENT = '00002a37-...'
BATTERY_SERVICE= '0000180f-...'
BATTERY_LEVEL  = '00002a19-...'

// Chart throttle
CHART_UPDATE_INTERVAL = 100  // ms between allowed chart updates per channel

// CWT
CWT_FS      = 4     // Hz — uniform interpolation rate
CWT_OMEGA0  = 6     // rad — Morlet wavelet central frequency
CWT_VOICES  = 22    // log-spaced frequency bins
CWT_F_MIN   = 0.005 // Hz
CWT_F_MAX   = 0.40  // Hz

// ECG buffer
maxSamples = 650    // ~5 s at 130 Hz

// IndexedDB
DB_NAME    = 'PolarH10Monitor'
DB_VERSION = 4
STORE_NAME = 'sessions'

// Calibration (hard-coded fallback, configurable via settings)
CALIBRATION_DURATION = 8000  // ms
```

---

## Known Bugs & Audit Notes

The following issues have been identified in the codebase and are pending resolution:

### Critical

| # | Location | Description |
|---|---|---|
| 1 | `performSessionReset()` | Sets `calibrationStartTime = Date.now()` instead of `null`; this causes the recording timer and all timestamp calculations to start from a non-null baseline immediately after a reset, even before a new device calibration completes |
| 2 | `updateStats()` | The `currentTime` reference for the 1-minute rolling window uses the last element of `timestamps[]`, which is correct during live sessions but will silently return stale values if called after a reset where `timestamps` is empty |
| 3 | `generateMetadataHeader()` | Falls back to the global `timestamps` and `eventMarkers` arrays when `sessionData.sessionTimestamps`/`sessionEventMarkers` are not passed; `downloadSession()` passes these correctly but other call sites may not |
| 4 | `downloadSession()` | Builds the export filename from `session.startTime` (correct) but the current live session's `exportData()` uses the global `sessionStartTime` instead of `calibrationStartTime`, which can misdate the filename |
| 5 | History table filters | `historyTableSearch`, `historyTableTagFilter`, `historyTableSortFilter` are only passed to `filterAndSortSessions()` inside `renderHistoryTable()` — the equivalent card-view filter inputs are hard-wired to the sidebar's DOM elements, not the table modal's separate inputs |

### High Severity

| # | Location | Description |
|---|---|---|
| 6 | `updateRollingRMSSD()` | Previously O(n²); now O(n) with the incremental sliding window, but the window-start eviction loop `while (timestamps[left] < windowStart)` does not account for the case where `left` advances past `i`, which could produce negative `pairCount` |
| 7 | `calculateDataQuality()` | Returns a `string` (via `parseFloat(...toFixed(1))`) — floating-point arithmetic on its return value would coerce correctly in JS, but it creates a type inconsistency with the `number` typed `dataQuality` state variable |
| 8 | `lastCWTResult` | Not cleared on session reset or disconnect; a stale cached result from the previous session could be used for SRI calculation at the start of a new session if `lastCWTResult.dataLength` accidentally matches the new session's early interval count |
| 9 | ECG timestamps | `handleECGData()` calculates ECG timestamps from `sessionStartTime` (wall-clock start) whereas RR timestamps use `calibrationStartTime`; the two time references diverge by the calibration period, misaligning the ECG and RR charts' x-axes |
| 10 | Lomb-Scargle floating point | `lombScarglePeriodogram()` receives raw timestamp values that can be large absolute numbers if called with wall-clock-based times; trigonometric operations `Math.sin/cos(2π·f·t)` on large `t` values accumulate floating-point error |
| 11 | Signal quality `setInterval` | `setInterval(() => { if (isConnected) updateSignalQuality(); }, 1000)` is started unconditionally at module load and never cleared, leaking a timer for the lifetime of the page |
| 12 | Mobile double-fire | Touch events on the Mark Event and Connect buttons can fire both `touchstart` and `click`, potentially opening two panels or initiating two connection attempts simultaneously |

### Medium Severity

| # | Location | Description |
|---|---|---|
| 13 | `historyTableTagFilter` | Options are only populated by `updateHistoryBadge()`, which only populates the sidebar `tagFilter`. The table modal's tag filter receives the same HTML string, but only at the time of `updateHistoryBadge()` — rapid changes may leave it stale |
| 14 | Auto-save `startTime` | `autoSaveSession()` passes `sessionStartTime` (pre-calibration wall clock) as `startTime` for the session record; the intent is likely `calibrationStartTime` to match what exports use for timestamp offsets |
| 15 | `calibrationStartTime = null` race | A reconnect within 8 s of disconnecting resets the calibration timer but `calibrationStartTime` may still be set from the previous session; there is no stored timeout handle to cancel the previous calibration `setTimeout` |

---

## iOS / Mobile Notes

The Web Bluetooth API is **not available** on any iOS browser (Safari, Chrome for iOS, Firefox for iOS) due to WebKit restrictions. CardioTrace will display an alert and abort connection on those platforms.

For **export on iOS**, the app falls back to the [Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share) when `navigator.share` is available, allowing the user to save the file via the system share sheet (Files, Notes, AirDrop, etc.). If neither share nor clipboard is available, a plain-text alert is shown.

---

## Contributing

The codebase is intentionally framework-free. When adding features, maintain this principle:

- **Keep all logic in `engine.js`** — the separation between structure (`index.html`), presentation (`style.css`), and behaviour (`engine.js`) should remain clean.
- **No implicit globals** — always `let`/`const` for new state; the `dataQuality` implicit global is a known bug to fix, not a pattern to follow.
- **Throttle chart updates** — all Plotly `update` calls that fire from BLE callbacks must go through `shouldUpdateChart()` or an equivalent guard.
- **Maintain dual array invariant** — every interval written to `rrIntervals[]` must also exist in `rawRRIntervals[]`; never append to one without the other in the same code path.
- **Calibration safety** — always check `!isCalibrating && calibrationStartTime` before storing data or computing stats from live BLE events.
- **Clear `lastCWTResult`** on reset and disconnect before any new SRI calls can run.

---

*Made with ❤️ by [Matías Castillo-Aguilar](https://github.com/matcasti)*
