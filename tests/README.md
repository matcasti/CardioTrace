# Automated tests

Headless-Chromium tests that drive the real application against a **simulated Polar H10**
(`navigator.bluetooth` is replaced by a mock that can inject Heart Rate and ECG notifications, drop the link, and
record writes to the PMD control point). No hardware and no internet connection are needed.

```bash
cd tests
npm install                          # test-only copies of Plotly 2.27.0, GridStack 8.4.0 and JSZip 3.10.1
pip install playwright && playwright install chromium
python run_tests.py                  # exit code 0 = all checks passed
```

| Area | What is checked |
|---|---|
| Acquisition | connection and calibration; ECG start through `writeValueWithResponse` (the mock rejects the deprecated `writeValue`); disconnect confirmation; **link loss saves the session**; continuous 130 Hz ECG time stamps under bursty delivery; reset and reconnect during calibration; no duplicate session when disconnecting during a slow auto-save |
| Protocols and events | a protocol can be started, replaced (with confirmation) and restarted at any time; phase markers are written automatically |
| Customisation | optional SRI (hidden and not computed when off); appearance and per-plot settings persist; settings export / import / reset; PNG, SVG and CSV plot downloads |
| Export and history | report contains only the selected sections; exported header of a **stored** session describes that session; history filters survive auto-save refreshes; user-supplied tags are escaped |
| Maintenance regressions | renaming a stored session keeps its date and statistics; subject edits keep `createdAt` / notes; deleting the running protocol stops it cleanly; a completion banner cannot hide the next protocol; HR parser handles the Energy Expended flag and malformed packets; CSV header states the real calibration; RFC 4180 quoting and one row per event; no stack overflow on 200 000 beats; names with quotes or markup are escaped; restored sessions are dated by their own start; deleting a subject unassigns its sessions; the live session cannot be deleted; events during calibration get negative times; a late auto-save cannot re-attach a reset session; calendar-day dates; whole-recording metrics in Analyze; the app works without IndexedDB; a half-failed connection closes the link; the artifact filter re-anchors after a wrong reference beat, still rejects ectopic pairs, and live and batch cleaning agree; beats within one notification get distinct, monotonic times |
| Other RR sources | device name and sensor type stored and exported; notices for HR-only devices, missing ECG and pulse-derived (PPG) data; import of one-value-per-line files (ms, s, decimal comma), CSV / TSV tables and CardioTrace CSV (lossless round trip); invalid files reported |
| Artifact options | live % and running-median methods; the filter is fixed per recording and stored / exported; retrospective Δ, %, centred-median and automatic (Lipponen & Tarvainen) methods flag injected ectopic beats; correction preserves duration; panel preview, apply to the shown session, batch re-clean from Export, reversible; the live session cannot be re-cleaned |
| Interface | get-started guide when empty; saved-session banner with Close (no confirmation); Open buttons in History; no "0" badge; Export select-all enables bulk actions; messages are toasts, not alert dialogs |
| Edge cases | every artifact method on empty, 1- and 4-beat, constant, all-out-of-range, NaN / ∞ / 0 and time-mismatched series; 60 000-beat automatic correction under 1.5 s; corrupted retrospective settings; space-separated imports; re-cleaning with inconsistent raw times; deleting the open session |
| Layout | no clipped or overflowing content on any of the five tabs at ten viewport sizes from 240 px to 3440 px |

The tests use only the browser; the numerical accuracy of the HRV indices is checked separately in
[`../verification/`](../verification/README.md).
