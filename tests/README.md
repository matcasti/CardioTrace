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
| Layout | no clipped or overflowing content on any of the five tabs at ten viewport sizes from 240 px to 3440 px |

The tests use only the browser; the numerical accuracy of the HRV indices is checked separately in
[`../verification/`](../verification/README.md).
