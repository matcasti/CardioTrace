
// Constants
const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';
const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';

// State variables
let device, server, hrChar, batteryChar, pmdControlChar, pmdDataChar;
let rrIntervals = [];
let timestamps = [];
let eventMarkers = [];
let sessionAnnotations = [];
let sessionTags = [];
let rollingRMSSD = [];
let rollingRMSSDTimes = [];
let ecgData = [];
let ecgTimestamps = [];
let sriScore = 0;
let sriComponents = { rmssd: 0, lfhf: 0, hrRecovery: 0 };
let sriHistory = [];
let peakHR = 0;
let chartUpdateThrottle = {
    ecg: 0,
    rr: 0,
    rmssd: 0,
    poincare: 0,
    psd: 0,
    hr: 0,
    vagalProxy: 0
};
const CHART_UPDATE_INTERVAL = 100; // ms

// ── App Settings ──────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    age: 30,
    calibrationSecs: 8,
    autosaveSecs: 10,
    rmssdWindow: 60,
    artifactThreshold: 300,
    visibleCharts: {
        ecg: true, rr: true, rollingRMSSD: true,
        poincare: true, psd: true, hr: true, vagalProxy: true
    }
};
let appSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function loadSettings() {
    try {
        const saved = localStorage.getItem('cardioTraceSettings');
        if (saved) {
            const p = JSON.parse(saved);
            appSettings = {
                ...DEFAULT_SETTINGS, ...p,
                visibleCharts: { ...DEFAULT_SETTINGS.visibleCharts, ...(p.visibleCharts || {}) }
            };
        }
    } catch(e) { /* use defaults */ }
}

function saveSettings() {
    localStorage.setItem('cardioTraceSettings', JSON.stringify(appSettings));
}

function applyChartVisibility() {
    const map = {
        ecg: 'ecgItem', rr: 'rrItem', rollingRMSSD: 'rollingRMSSDItem',
        poincare: 'poincareItem', psd: 'psdItem', hr: 'hrItem', vagalProxy: 'vagalProxyItem'
    };
    Object.entries(map).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = appSettings.visibleCharts[key] !== false ? '' : 'none';
    });
}

function applySettings() {
    // Age
    const ageSlider = document.getElementById('settingsAge');
    if (ageSlider) {
        ageSlider.value = appSettings.age;
        const d = document.getElementById('settingsAgeVal');
        if (d) d.textContent = `${appSettings.age} yrs`;
        const p = document.getElementById('maxHRPreview');
        if (p) p.textContent = `Max HR: ${220 - appSettings.age} bpm · Zones recalculated live`;
    }
    // Calibration
    const calibSlider = document.getElementById('settingsCalib');
    if (calibSlider) {
        calibSlider.value = appSettings.calibrationSecs;
        const d = document.getElementById('settingsCalibVal');
        if (d) d.textContent = `${appSettings.calibrationSecs} s`;
    }
    // Autosave
    const autosaveSlider = document.getElementById('settingsAutosave');
    if (autosaveSlider) {
        autosaveSlider.value = appSettings.autosaveSecs;
        const d = document.getElementById('settingsAutosaveVal');
        if (d) d.textContent = `${appSettings.autosaveSecs} s`;
    }
    // RMSSD window
    const rmssdSlider = document.getElementById('settingsRMSSDWindow');
    if (rmssdSlider) {
        rmssdSlider.value = appSettings.rmssdWindow;
        const d = document.getElementById('settingsRMSSDWindowVal');
        if (d) d.textContent = `${appSettings.rmssdWindow} s`;
    }
    // Artifact chips
    document.querySelectorAll('#artifactGroup .sett-chip').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val) === appSettings.artifactThreshold);
    });
    // Chart toggles
    ['ecg','rr','rollingRMSSD','poincare','psd','hr','vagalProxy'].forEach(key => {
        const cb = document.getElementById(`show_${key}`);
        if (cb) cb.checked = appSettings.visibleCharts[key] !== false;
    });
    applyChartVisibility();
}

// ── GridStack ─────────────────────────────────────────────────────
let grid = null;
const ALL_CHART_IDS = ['ecgChart','rrChart','rollingRMSSDChart','poincareChart','psdChart','hrChart','vagalProxyChart'];

const DEFAULT_GRID_LAYOUT = [
    { id: 'ecg',          x: 0,  y: 0,  w: 6,  h: 5 },
    { id: 'rr',           x: 6,  y: 0,  w: 6,  h: 5 },
    { id: 'rollingRMSSD', x: 0,  y: 5,  w: 6,  h: 5 },
    { id: 'poincare',     x: 6,  y: 5,  w: 6,  h: 5 },
    { id: 'psd',          x: 0,  y: 10, w: 12, h: 5 },
    { id: 'hr',           x: 0,  y: 15, w: 6,  h: 5 },
    { id: 'vagalProxy',   x: 6,  y: 15, w: 6,  h: 5 },
];

function resizeAllCharts() {
    ALL_CHART_IDS.forEach(id => {
        try { Plotly.Plots.resize(document.getElementById(id)); } catch(e) {}
    });
}

function saveGridLayout() {
    if (grid) {
        try { localStorage.setItem('cardioTraceGridLayout', JSON.stringify(grid.save(false))); } catch(e) {}
    }
}

function resetGridLayout() {
    if (!grid) return;
    localStorage.removeItem('cardioTraceGridLayout');
    grid.load(DEFAULT_GRID_LAYOUT, true);
    setTimeout(resizeAllCharts, 150);
}

function initGrid() {
    if (typeof GridStack === 'undefined') {
        console.warn('GridStack not loaded — using fallback CSS grid');
        document.getElementById('chartsGrid').classList.add('fallback-grid');
        return;
    }
    grid = GridStack.init({
        column: 12,
        cellHeight: 70,
        margin: 10,
        animate: true,
        float: false,
        resizable: { handles: 'e,se,s,sw,w' },
        draggable: { handle: '.chart-title' }
    }, '#chartsGrid');

    const saved = localStorage.getItem('cardioTraceGridLayout');
    if (saved) {
        try { grid.load(JSON.parse(saved)); } catch(e) {}
    }

    grid.on('change resizestop dragstop', () => {
        saveGridLayout();
        setTimeout(resizeAllCharts, 120);
    });

    setTimeout(resizeAllCharts, 150);
}
let isConnected = false;
let ecgSupported = false;
let sessionStartTime = Date.now();
let calibrationStartTime = null;
let timerInterval = null;
let autoSaveInterval = null;
let currentSessionId = null;
let lastCWTResult = null; // Store last CWT calculation for band power reuse
let dataQuality = 100;
let selectedEventType = 'Note';
let currentHR = 0;
let lastPacketTime = Date.now();
let isCalibrating = false;
let calibrationEndTime = null;
const CALIBRATION_DURATION = 8000; // 8 seconds in milliseconds
let rawRRIntervals = []; // Store all raw data
let rawTimestamps = []; // Store all raw timestamps

// DOM Elements
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const resetBtn = document.getElementById('resetBtn');
const exportBtn = document.getElementById('exportBtn');
const copyBtn = document.getElementById('copyBtn');
const reportBtn = document.getElementById('reportBtn');
const timestampBtn = document.getElementById('timestampBtn');
const txtToggle = document.getElementById('txtToggle');
const rawDataToggle = document.getElementById('rawDataToggle');
const status = document.getElementById('status');
const hrValue = document.getElementById('hrValue');
const rmssdValue = document.getElementById('rmssdValue');
const samplesValue = document.getElementById('samplesValue');
const avgRRValue = document.getElementById('avgRRValue');
const batteryIndicator = document.getElementById('batteryIndicator');
const batteryLevel = document.getElementById('batteryLevel');
const batteryText = document.getElementById('batteryText');
const recordingTimer = document.getElementById('recordingTimer');
const cinemaToggle = document.getElementById('cinemaToggle');
const cinemaIcon = document.getElementById('cinemaIcon');
const cinemaText = document.getElementById('cinemaText');
const controlsPanel = document.getElementById('controlsPanel');
const statsGrid = document.querySelector('.stats-grid');
const themeToggle = document.getElementById('themeToggle');
const signalIndicator = document.getElementById('signalIndicator');
const signalText = document.getElementById('signalText');
const hrZoneIndicator = document.getElementById('hrZoneIndicator');
const hrZoneText = document.getElementById('hrZoneText');
const dataQualityValue = document.getElementById('dataQualityValue');

// History elements
const historyBtn = document.getElementById('historyBtn');
const historyPanel = document.getElementById('historyPanel');
const historyOverlay = document.getElementById('historyOverlay');
const historyClose = document.getElementById('historyClose');
const historyContent = document.getElementById('historyContent');
const historyBadge = document.getElementById('historyBadge');
const historySearch = document.getElementById('historySearch');
const tagFilter = document.getElementById('tagFilter');
const sortFilter = document.getElementById('sortFilter');
const clearAllBtn = document.getElementById('clearAllBtn');
const historyTableContent = document.getElementById('historyTableContent');
const historyTableBody = document.getElementById('historyTableBody');
const tabCards = document.getElementById('tabCards');
const tabTable = document.getElementById('tabTable');
let currentHistoryView = 'cards'; // 'cards' | 'table'
const bulkDownloadBtn = document.getElementById('bulkDownloadBtn');
const bulkFormatSelect = document.getElementById('bulkFormatSelect');

const historyTableModal   = document.getElementById('historyTableModal');
const historyTableOverlay = document.getElementById('historyTableOverlay');
const historyTableClose   = document.getElementById('historyTableClose');
const historyTableBulkDownloadBtn = document.getElementById('historyTableBulkDownloadBtn');
const historyTableFormatSelect    = document.getElementById('historyTableFormatSelect');
const historyTableSearch   = document.getElementById('historyTableSearch');
const historyTableTagFilter  = document.getElementById('historyTableTagFilter');
const historyTableSortFilter = document.getElementById('historyTableSortFilter');

// Event type elements
const eventTypePanel = document.getElementById('eventTypePanel');
const eventTypeOverlay = document.getElementById('eventTypeOverlay');
const eventTypeClose = document.getElementById('eventTypeClose');
const eventTypeSelector = document.getElementById('eventTypeSelector');
const eventAnnotation = document.getElementById('eventAnnotation');
const addEventBtn = document.getElementById('addEventBtn');
const annotationsList = document.getElementById('annotationsList');

// Tag elements
const tagInput = document.getElementById('tagInput');
const addTagBtn = document.getElementById('addTagBtn');
const currentTags = document.getElementById('currentTags');

// IndexedDB
let db;
const DB_NAME = 'PolarH10Monitor';
const DB_VERSION = 4; // Changed from 3 to 4 for SRI migration
const STORE_NAME = 'sessions';

// Initialize IndexedDB
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            const oldVersion = event.oldVersion;

            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                objectStore.createIndex('timestamp', 'timestamp', { unique: false });
                objectStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });
            }

            // Migration for version 4: Add SRI fields to existing sessions
            if (oldVersion < 4) {
                console.log('📊 Migrating database to version 4 (adding SRI support)...');
                // The SRI will be calculated on-demand when sessions are restored
                // No schema changes needed, just marking the upgrade
            }
        };
    });
}

// Theme toggle
function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme === 'dark' ? null : 'light');
    localStorage.setItem('theme', newTheme);
    updateChartThemes();
}

// Load saved theme
function loadTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    if (savedTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
}

// Update chart themes
function updateChartThemes() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const textColor = isLight ? '#4b5563' : '#6b7280';
    const bgColor = 'rgba(0,0,0,0)';

    const updateLayout = {
        'xaxis.color': textColor,
        'yaxis.color': textColor,
        'xaxis.showgrid': false,
        'yaxis.showgrid': false,
        'xaxis.zeroline': false,
        'yaxis.zeroline': false,
        'paper_bgcolor': bgColor,
        'plot_bgcolor': bgColor,
        'font.color': textColor
    };

    ['ecgChart','rrChart','rollingRMSSDChart','poincareChart','psdChart','hrChart','vagalProxyChart'].forEach(id => {
        Plotly.relayout(id, updateLayout);
    });
    // Re-render charts that have theme-sensitive annotations
    if (rrIntervals.length > 1) updatePoincareChart();
}

// Calculate HR zones
function getHRZone(hr, age) {
    age = age || appSettings.age || 30;
    const maxHR = 220 - age;
    const percentage = (hr / maxHR) * 100;

    if (percentage < 60) return { zone: 1, name: 'Zone 1 - Recovery', class: 'zone-1' };
    if (percentage < 70) return { zone: 2, name: 'Zone 2 - Endurance', class: 'zone-2' };
    if (percentage < 80) return { zone: 3, name: 'Zone 3 - Tempo', class: 'zone-3' };
    if (percentage < 90) return { zone: 4, name: 'Zone 4 - Threshold', class: 'zone-4' };
    return { zone: 5, name: 'Zone 5 - Maximum', class: 'zone-5' };
}

// Update HR zone display
function updateHRZone(hr) {
    if (hr > 0) {
        const zoneInfo = getHRZone(hr);
        hrZoneIndicator.style.display = 'flex';
        hrZoneIndicator.className = `hr-zone-indicator ${zoneInfo.class}`;
        hrZoneText.textContent = zoneInfo.name;
    }
}

// Update signal quality
function updateSignalQuality() {
    const now = Date.now();
    const timeSinceLastPacket = now - lastPacketTime;

    let quality = 'excellent';
    if (timeSinceLastPacket > 5000) quality = 'poor';
    else if (timeSinceLastPacket > 3000) quality = 'fair';
    else if (timeSinceLastPacket > 1500) quality = 'good';

    signalIndicator.className = `signal-indicator ${quality}`;

    const qualityNames = {
        excellent: 'Excellent',
        good: 'Good',
        fair: 'Fair',
        poor: 'Poor'
    };
    signalText.textContent = qualityNames[quality];
}

// Monitor signal quality
setInterval(() => {
    if (isConnected) {
        updateSignalQuality();
    }
}, 1000);

// Calculate PSD using Lomb-Scargle periodogram
function calculatePSD(rrIntervals, timestamps) {
    if (rrIntervals.length < 50) return { freq: [], power: [] };

    // Data validation and cleaning
    const cleanedData = cleanRRData(rrIntervals, timestamps);
    if (cleanedData.rr.length < 50) return { freq: [], power: [] };

    // Remove DC component (mean)
    const mean = cleanedData.rr.reduce((a, b) => a + b, 0) / cleanedData.rr.length;
    const centered = cleanedData.rr.map(x => x - mean);

    // Define frequency range for HRV analysis
    const minFreq = 0.003; // VLF start (Hz)
    const maxFreq = 0.4;   // HF end (Hz)
    const freqStep = 0.0005; // 0.5 mHz resolution for better accuracy

    const frequencies = [];
    for (let f = minFreq; f <= maxFreq; f += freqStep) {
        frequencies.push(f);
    }

    // Calculate Lomb-Scargle periodogram
    const power = lombScarglePeriodogram(cleanedData.times, centered, frequencies);

    // Smooth the spectrum with moving average (window size 5)
    const smoothedPower = smoothSpectrum(power, 5);

    return { freq: frequencies, power: smoothedPower };
}

// Clean RR interval data - remove artifacts and invalid values
// This version is for batch processing (e.g., for exports with raw data option)
function cleanRRData(rrIntervals, timestamps) {
    const cleaned = { rr: [], times: [] };

    // Define physiological limits (ms) - MUST MATCH isValidRRInterval
    const minRR = 250;  // 200 BPM max
    const maxRR = 2000; // 30 BPM min
    const maxDiff = appSettings.artifactThreshold || 300;

    for (let i = 0; i < rrIntervals.length; i++) {
        const rr = rrIntervals[i];

        // Check physiological validity
        if (rr < minRR || rr > maxRR) continue;

        // Check for sudden jumps (artifacts)
        if (cleaned.rr.length > 0) {
            const prevRR = cleaned.rr[cleaned.rr.length - 1];
            if (Math.abs(rr - prevRR) > maxDiff) continue;
        }

        // Check for valid timestamp
        if (!isFinite(timestamps[i])) continue;

        cleaned.rr.push(rr);
        cleaned.times.push(timestamps[i]);
    }

    return cleaned;
}

// Calculate data quality percentage
function calculateDataQuality(originalLength, cleanedLength) {
    if (originalLength === 0) return 100;
    return parseFloat(((cleanedLength / originalLength) * 100).toFixed(1));
}

// Lomb-Scargle periodogram implementation
function lombScarglePeriodogram(times, values, frequencies) {
    const n = times.length;
    if (n < 2 || frequencies.length < 2) return frequencies.map(() => 0);

    // --- 1) Demean values

    // values are expected to already be demeaned by the caller
    const y = values;

    const rawPower = [];

    for (let f of frequencies) {
        const omega = 2 * Math.PI * f; // f in Hz, times in seconds -> radians

        // Calculate tau (time offset)
        let sumSin2 = 0, sumCos2 = 0;
        for (let i = 0; i < n; i++) {
            sumSin2 += Math.sin(2 * omega * times[i]);
            sumCos2 += Math.cos(2 * omega * times[i]);
        }
        const tau = Math.atan2(sumSin2, sumCos2) / (2 * omega);

        // Calculate power at this frequency using demeaned y
        let sumCosNum = 0, sumCosDen = 0;
        let sumSinNum = 0, sumSinDen = 0;

        for (let i = 0; i < n; i++) {
            const cosTerm = Math.cos(omega * (times[i] - tau));
            const sinTerm = Math.sin(omega * (times[i] - tau));

            sumCosNum += y[i] * cosTerm;
            sumCosDen += cosTerm * cosTerm;

            sumSinNum += y[i] * sinTerm;
            sumSinDen += sinTerm * sinTerm;
        }

        const cosComponent = sumCosDen > 0 ? (sumCosNum * sumCosNum) / sumCosDen : 0;
        const sinComponent = sumSinDen > 0 ? (sumSinNum * sumSinNum) / sumSinDen : 0;

        // Raw LS power (units: ms^2)
        rawPower.push(0.5 * (cosComponent + sinComponent));
    }

    // --- 2) Compute variance of demeaned signal (ms^2)
    const variance = y.reduce((sum, v) => sum + v * v, 0) / n;

    // --- 3) Trapezoidal integral of raw spectrum over frequency (units: ms^2)
    let integral = 0;
    for (let i = 1; i < frequencies.length; i++) {
        const df = frequencies[i] - frequencies[i - 1];
        if (df > 0 && Number.isFinite(df)) {
            integral += 0.5 * (rawPower[i] + rawPower[i - 1]) * df;
        }
    }

    // --- 4) Normalize so integral(PSD) == variance -> PSD units become ms^2/Hz
    const normFactor = integral > 0 ? (variance / integral) : 0;
    const psdHz = rawPower.map(p => p * normFactor);

    return psdHz; // array of PSD values in ms^2/Hz corresponding to `frequencies`
}


// Smooth spectrum with moving average
function smoothSpectrum(power, windowSize) {
    const smoothed = [];
    const halfWindow = Math.floor(windowSize / 2);

    for (let i = 0; i < power.length; i++) {
        let sum = 0;
        let count = 0;

        for (let j = Math.max(0, i - halfWindow); j <= Math.min(power.length - 1, i + halfWindow); j++) {
            sum += power[j];
            count++;
        }

        smoothed.push(sum / count);
    }

    return smoothed;
}

// ── CWT / Spectrogram infrastructure ─────────────────────────────────────

const CWT_FS      = 4;    // Hz  – uniform interpolation rate
const CWT_OMEGA0  = 6;    // rad – Morlet central frequency
const CWT_VOICES  = 22;   // log-spaced frequency bins
const CWT_F_MIN   = 0.005;
const CWT_F_MAX   = 0.40;

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// In-place iterative Cooley-Tukey radix-2 FFT
function fftInPlace(re, im, inverse = false) {
    const n    = re.length;
    const sign = inverse ? 1 : -1;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    // Butterfly stages
    for (let len = 2; len <= n; len <<= 1) {
        const ang = sign * 2 * Math.PI / len;
        const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let wr = 1, wi = 0;
            const half = len >> 1;
            for (let k = 0; k < half; k++) {
                const tr = wr * re[i+k+half] - wi * im[i+k+half];
                const ti = wr * im[i+k+half] + wi * re[i+k+half];
                re[i+k+half] = re[i+k] - tr;
                im[i+k+half] = im[i+k] - ti;
                re[i+k] += tr;
                im[i+k] += ti;
                const nr = wr * wr0 - wi * wi0;
                wi = wr * wi0 + wi * wr0;
                wr = nr;
            }
        }
    }
    if (inverse) { for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}

// Linear interpolation of non-uniform RR series → uniform CWT_FS grid
function interpolateRRUniform(rrMs) {
    const n = rrMs.length;
    if (n < 4) return { signal: new Float64Array(0), times: new Float64Array(0) };
    // Beat start times (cumulative RR sum, seconds)
    const beatT = new Float64Array(n);
    for (let i = 1; i < n; i++) beatT[i] = beatT[i-1] + rrMs[i-1] / 1000;
    const nSamp = Math.floor(beatT[n-1] * CWT_FS) + 1;
    const sig   = new Float64Array(nSamp);
    const tArr  = new Float64Array(nSamp);
    let j = 0;
    for (let i = 0; i < nSamp; i++) {
        const t = i / CWT_FS;
        tArr[i] = t;
        while (j < n - 2 && beatT[j+1] <= t) j++;
        const dT = beatT[j+1] - beatT[j];
        const a  = dT > 0 ? (t - beatT[j]) / dT : 0;
        sig[i]  = rrMs[j] + a * (rrMs[j+1] - rrMs[j]);
    }
    return { signal: sig, times: tArr };
}

// Morlet CWT via FFT convolution (Torrence & Compo 1998).
// Returns scalogram, time-averaged band powers and LF/HF ratio, or null if
// insufficient data.
let _cwtLastUpdate = 0;
function computeMorletCWT(rrMs) {
    const { signal, times } = interpolateRRUniform(rrMs);
    const N = signal.length;
    if (N < 32) return null;

    // Rolling buffer cap (~5 min at CWT_FS)
    const MAX_N = 1200;
    const useN  = Math.min(N, MAX_N);
    const sig   = signal.subarray(N - useN);
    const tim   = times.subarray(N - useN);

    // Demean
    let mean = 0;
    for (let i = 0; i < useN; i++) mean += sig[i];
    mean /= useN;

    // Zero-pad to next power-of-2 × 2 (reduces circular wrap-around artifacts)
    const NFFT = nextPow2(useN * 2);
    const xRe  = new Float64Array(NFFT);
    const xIm  = new Float64Array(NFFT);
    for (let i = 0; i < useN; i++) xRe[i] = sig[i] - mean;
    fftInPlace(xRe, xIm, false);

    // Log-spaced frequencies
    const freqs = new Float64Array(CWT_VOICES);
    for (let v = 0; v < CWT_VOICES; v++)
        freqs[v] = CWT_F_MIN * Math.pow(CWT_F_MAX / CWT_F_MIN, v / (CWT_VOICES - 1));

    const scalogram = [];           // [CWT_VOICES][useN] power
    const avgPow    = new Float64Array(CWT_VOICES);
    const TWOPI     = 2 * Math.PI;
    const dt        = 1 / CWT_FS;

    for (let vi = 0; vi < CWT_VOICES; vi++) {
        const f        = freqs[vi];
        const sSeconds = CWT_OMEGA0 / (TWOPI * f);       // scale in seconds
        // Morlet wavelet spectrum (normalised, one-sided)
        const norm = Math.sqrt(TWOPI * sSeconds / dt) * Math.pow(Math.PI, -0.25);
        const wRe  = new Float64Array(NFFT);

        for (let k = 0; k < NFFT; k++) {
            const fk = (k <= NFFT >> 1 ? k : k - NFFT) * CWT_FS / NFFT;
            if (fk <= 0) continue;                       // Heaviside (one-sided)
            const arg = sSeconds * TWOPI * fk - CWT_OMEGA0;
            wRe[k] = norm * Math.exp(-arg * arg / 2);
        }

        // Multiply in frequency domain (wavelet spectrum is real)
        const cRe = new Float64Array(NFFT);
        const cIm = new Float64Array(NFFT);
        for (let k = 0; k < NFFT; k++) {
            cRe[k] = xRe[k] * wRe[k];
            cIm[k] = xIm[k] * wRe[k];
        }
        fftInPlace(cRe, cIm, true);                      // IFFT

        const pow = new Float64Array(useN);
        let sumP  = 0;
        for (let i = 0; i < useN; i++) {
            const p = cRe[i] * cRe[i] + cIm[i] * cIm[i];
            pow[i] = p; sumP += p;
        }
        avgPow[vi] = sumP / useN;
        scalogram.push(pow);
    }

    // Band power integrals (trapezoidal over log-freq axis)
    let vlfP = 0, lfP = 0, hfP = 0;
    for (let vi = 0; vi < CWT_VOICES; vi++) {
        const f  = freqs[vi];
        const p  = avgPow[vi];
        const df = vi < CWT_VOICES - 1
            ? freqs[vi+1] - f
            : (vi > 0 ? f - freqs[vi-1] : f * 0.1);
        if      (f >= 0.003 && f < 0.04)  vlfP += p * df;
        else if (f >= 0.04  && f < 0.15)  lfP  += p * df;
        else if (f >= 0.15  && f <= 0.40) hfP  += p * df;
    }

    const totalP  = vlfP + lfP + hfP;
    const lfhfR   = hfP > 1e-12 ? lfP / hfP : 0;

    return {
        scalogram,
        times:    Array.from(tim),
        freqs:    Array.from(freqs),
        avgPow:   Array.from(avgPow),
        vlfPow: vlfP, lfPow: lfP, hfPow: hfP, totalPow: totalP,
        lfhfRatio: lfhfR,
        vlfPct: totalP > 0 ? vlfP / totalP * 100 : 0,
        lfPct:  totalP > 0 ? lfP  / totalP * 100 : 0,
        hfPct:  totalP > 0 ? hfP  / totalP * 100 : 0,
        dataLength: rrMs.length,
    };
}

// Update spectrogram chart (Morlet CWT)
function updateSpectrogramChart() {
    const el = document.getElementById('psdChart');
    let placeholder = el.querySelector('.chart-placeholder');

    if (rrIntervals.length < 50) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'chart-placeholder';
            placeholder.innerHTML = `
                <div class="chart-placeholder-icon">📊</div>
                <div class="chart-placeholder-text">Spectrogram available after 50 RR intervals</div>`;
            el.appendChild(placeholder);
        }
        el.classList.add('chart-blurred');
        return;
    }
    if (placeholder) { placeholder.remove(); }
    el.classList.remove('chart-blurred');

    // Internal throttle: CWT is heavier than a line update — cap at 0.5 Hz
    const now = Date.now();
    if (now - _cwtLastUpdate < 2000) return;
    _cwtLastUpdate = now;

    const result = computeMorletCWT(rrIntervals);
    if (!result) return;

    lastCWTResult = result; // cache for SRI reuse

    // Decimate display to ~1 Hz to keep Plotly responsive
    const DECIMATE  = Math.max(1, Math.round(CWT_FS));
    const nT        = result.times.length;
    const dispIdx   = [];
    for (let i = 0; i < nT; i += DECIMATE) dispIdx.push(i);
    const dispTimes = dispIdx.map(i => result.times[i]);

    // Z matrix [n_freqs][n_disp_times] — log10 power for visual dynamic range
    const Z = result.freqs.map((_, fi) =>
        dispIdx.map(ti => {
            const p = result.scalogram[fi][ti];
            return p > 0 ? Math.log10(p) : -8;
        })
    );

    const annotations = [
        { xref:'paper', yref:'paper', x:0.02, y:0.12, xanchor:'left',
          text:`<b>VLF</b> ${result.vlfPct.toFixed(1)}%`, showarrow:false,
          font:{ size:11, color:'#FFF' } },
        { xref:'paper', yref:'paper', x:0.02, y:0.55, xanchor:'left',
          text:`<b>LF</b> ${result.lfPct.toFixed(1)}%`, showarrow:false,
          font:{ size:11, color:'#FFF' } },
        { xref:'paper', yref:'paper', x:0.02, y:0.85, xanchor:'left',
          text:`<b>HF</b> ${result.hfPct.toFixed(1)}%`, showarrow:false,
          font:{ size:11, color:'#FFF' } },
        { xref:'paper', yref:'paper', x:0.99, y:0.99, xanchor:'right', yanchor:'top',
          text:`LF/HF: ${result.lfhfRatio.toFixed(2)}`, showarrow:false,
          font:{ size:11, color:'#FFF' } },
    ];

    Plotly.update('psdChart',
        { x: [dispTimes], y: [result.freqs], z: [Z] },
        { annotations },
        [0]
    );
}

// Robust download function for desktop and mobile (iOS-compatible)
function downloadFile(content, filename, mimeType = 'text/csv') {
    // Detect iOS
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isIOSWebView = isIOS && !navigator.standalone && !/Safari/i.test(navigator.userAgent);

    if (isIOS || isIOSWebView) {
        // iOS-specific handling
        return downloadFileIOS(content, filename, mimeType);
    }

    // Standard desktop/Android approach
    try {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;

        // Append to body (required for Firefox)
        document.body.appendChild(a);

        // Trigger download
        a.click();

        // Cleanup
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        return true;
    } catch (error) {
        console.error('Download failed:', error);
        return downloadFileIOS(content, filename, mimeType);
    }
}

// Force iOS Share API with clear fallback message
function downloadFileIOS(content, filename, mimeType) {
    if (navigator.share) {
        const blob = new Blob([content], { type: mimeType });
        const file = new File([blob], filename, { type: mimeType });

        navigator.share({
            files: [file],

        }).catch((error) => {
            // User cancelled or share failed
            if (error.name !== 'AbortError') {
                alert('Share failed. Data copied to clipboard instead.');
                navigator.clipboard.writeText(content);
            }
        });
    } else {
        // No share API - copy to clipboard
        navigator.clipboard.writeText(content).then(() => {
            alert('Data copied to clipboard! Paste in Notes or Files app to save.');
        }).catch(() => {
            alert('Unable to export on this device. Please use a desktop browser.');
        });
    }
    return true;
}

// Helper function to integrate power in a frequency band using trapezoidal rule
function integrateBandPower(freq, psd, fMin, fMax) {
    // Early exit for invalid band
    if (!Number.isFinite(fMin) || !Number.isFinite(fMax) || fMax <= fMin) return 0;

    // Pair and sort by frequency to ensure monotonicity
    const pts = [];
    for (let i = 0; i < freq.length; i++) {
        const f = freq[i], p = psd[i];
        if (Number.isFinite(f) && Number.isFinite(p)) pts.push({ f, p });
    }
    if (pts.length < 2) return 0;
    pts.sort((a, b) => a.f - b.f);

    // Integrate with boundary clipping (trapezoidal rule)
    let area = 0;
    for (let i = 0; i < pts.length - 1; i++) {
        let f0 = pts[i].f, f1 = pts[i + 1].f;
        let p0 = pts[i].p, p1 = pts[i + 1].p;

        // Skip degenerate or reversed segments
        if (!(f1 > f0)) continue;

        // Segment-band intersection: clip to [fMin, fMax]
        const left = Math.max(f0, fMin);
        const right = Math.min(f1, fMax);
        if (right <= left) continue; // no overlap

        // Linear interpolation to get PSD at clipped endpoints
        const tL = (left - f0) / (f1 - f0);
        const tR = (right - f0) / (f1 - f0);
        const pL = p0 + tL * (p1 - p0);
        const pR = p0 + tR * (p1 - p0);

        area += 0.5 * (pL + pR) * (right - left);
    }

    // Ensure non-negative due to numerical noise
    return Math.max(0, area);
}


// Save session
async function saveSession(sessionData, sessionId = null) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);

        const session = {
            timestamp: Date.now(),
            date: new Date().toISOString(),
            startTime: sessionData.startTime || sessionStartTime,
            duration: sessionData.duration !== undefined
                ? sessionData.duration
                : Math.floor((Date.now() - (sessionData.startTime || calibrationStartTime || sessionStartTime)) / 1000),
            filename: sessionData.filename || document.getElementById('filename').value || 'polar-h10-data',
            rrIntervals: sessionData.rrIntervals,
            timestamps: sessionData.timestamps,
            rawRRIntervals: sessionData.rawRRIntervals || [],
            rawTimestamps: sessionData.rawTimestamps || [],
            eventMarkers: sessionData.eventMarkers,
            annotations: sessionData.annotations || [],
            tags: sessionData.tags || [],
            stats: {
                samples: sessionData.rrIntervals.length,
                avgRR: sessionData.avgRR,
                rmssd: sessionData.rmssd
            },
            sri: sessionData.sri || sriScore,
            sriComponents: sessionData.sriComponents || sriComponents,
            peakHR: sessionData.peakHR || peakHR
        };

        if (sessionId) {
            session.id = sessionId;
            const updateRequest = objectStore.put(session);
            updateRequest.onsuccess = () => resolve(sessionId);
            updateRequest.onerror = () => reject(updateRequest.error);
        } else {
            const addRequest = objectStore.add(session);
            addRequest.onsuccess = () => resolve(addRequest.result);
            addRequest.onerror = () => reject(addRequest.error);
        }
    });
}

// Load sessions
async function loadSessions() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Delete session
async function deleteSession(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Clear all sessions
async function clearAllSessions() {
    if (!confirm('Are you sure you want to delete ALL sessions? This cannot be undone.')) return;

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.clear();
        request.onsuccess = () => {
            renderHistory();
            updateHistoryBadge();
            console.log('✓ All sessions cleared');
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

// Load session
async function loadSession(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Format duration
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today at ${timeStr}`;
    if (diffDays === 1) return `Yesterday at ${timeStr}`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Auto-save session
let _autoSaveInProgress = false;
async function autoSaveSession() {
    if (!isConnected || rrIntervals.length === 0 || _autoSaveInProgress) return;
    _autoSaveInProgress = true;

    try {
        const currentTime = calibrationStartTime
            ? (Date.now() - calibrationStartTime) / 1000
            : 0;
        const oneMinAgo = currentTime - 60;
        const recentRR = rrIntervals.filter((_, i) => timestamps[i] >= oneMinAgo);

        let avgRR = null, rmssd = null;
        if (recentRR.length > 0) {
            avgRR = recentRR.reduce((a, b) => a + b, 0) / recentRR.length;
        }
        if (recentRR.length > 1) {
            let sumSquaredDiff = 0;
            for (let i = 1; i < recentRR.length; i++) {
                const diff = recentRR[i] - recentRR[i - 1];
                sumSquaredDiff += diff * diff;
            }
            rmssd = Math.sqrt(sumSquaredDiff / (recentRR.length - 1));
        }

        const sessionId = await saveSession({
            startTime: sessionStartTime,
            filename: document.getElementById('filename').value || 'polar-h10-data',
            rrIntervals: [...rrIntervals],
            timestamps: [...timestamps],
            rawRRIntervals: [...rawRRIntervals],
            rawTimestamps: [...rawTimestamps],
            eventMarkers: [...eventMarkers],
            annotations: [...sessionAnnotations],
            tags: [...sessionTags],
            avgRR,
            rmssd,
            sri: sriScore,
            sriComponents: { ...sriComponents },
            peakHR: peakHR
        }, currentSessionId);

        if (!currentSessionId) {
            currentSessionId = sessionId;
            console.log('✓ Session auto-saved (ID: ' + sessionId + ')');
        } else {
            console.log('✓ Session updated (ID: ' + sessionId + ')');
        }

        await updateHistoryBadge();
    } catch (error) {
        console.error('Auto-save failed:', error);
    } finally {
        _autoSaveInProgress = false;
    }
}

// Start auto-save
function startAutoSave() {
    if (autoSaveInterval) clearInterval(autoSaveInterval);
    autoSaveInterval = setInterval(autoSaveSession, (appSettings.autosaveSecs || 10) * 1000);
    console.log('✓ Auto-save enabled');
}

// Stop auto-save
function stopAutoSave() {
    if (autoSaveInterval) {
        clearInterval(autoSaveInterval);
        autoSaveInterval = null;
        console.log('✓ Auto-save disabled');
    }
}

// Update history badge
async function updateHistoryBadge() {
    try {
        const sessions = await loadSessions();
        historyBadge.textContent = sessions.length;

        // Update tag filter options
        const allTags = new Set();
        sessions.forEach(s => {
            if (s.tags) s.tags.forEach(tag => allTags.add(tag));
        });

        const tagOptions = '<option value="">All Tags</option>' +
            Array.from(allTags).sort().map(tag =>
                `<option value="${tag}">${tag}</option>`
            ).join('');
        tagFilter.innerHTML = tagOptions;
        historyTableTagFilter.innerHTML = tagOptions;
    } catch (error) {
        console.error('Failed to update history badge:', error);
    }
}

// Filter and sort sessions
function filterAndSortSessions(sessions, overrides = {}) {
    const searchTerm = (overrides.search ?? historySearch.value).toLowerCase();
    const selectedTag = overrides.tag ?? tagFilter.value;
    const sortBy = overrides.sort ?? sortFilter.value;

    let filtered = sessions.filter(session => {
        const matchesSearch = !searchTerm ||
            session.filename.toLowerCase().includes(searchTerm) ||
            formatDate(session.date).toLowerCase().includes(searchTerm);
        const matchesTag = !selectedTag || (session.tags && session.tags.includes(selectedTag));
        return matchesSearch && matchesTag;
    });

    filtered.sort((a, b) => {
        switch (sortBy) {
            case 'oldest': return a.timestamp - b.timestamp;
            case 'longest': return b.duration - a.duration;
            case 'shortest': return a.duration - b.duration;
            default: return b.timestamp - a.timestamp;
        }
    });

    return filtered;
}

// Render history
async function renderHistory() {
    if (currentHistoryView === 'table') { return renderHistoryTable(); } // ← ADD THIS LINE
    try {
        const sessions = await loadSessions();
        const filtered = filterAndSortSessions(sessions);

        if (filtered.length === 0) {
            historyContent.innerHTML = `
                <div class="history-empty">
                    <span class="empty-icon">📊</span>
                    <p>No sessions found</p>
                </div>
            `;
            return;
        }

        historyContent.innerHTML = filtered.map(session => `
            <div class="session-card" data-id="${session.id}">
                <div class="session-header">
                    <div class="session-info">
                        <div class="session-date">${formatDate(session.date)}</div>
                        <div class="session-time">Duration: ${formatDuration(session.duration)}</div>
                        <div class="session-filename">${session.filename || 'polar-h10-data'}</div>
                        ${session.tags && session.tags.length > 0 ? `
                            <div class="session-tags">
                                ${session.tags.map(tag => `<span class="session-tag">${tag}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                    <div class="session-actions">
                        <button class="session-action-btn download" data-id="${session.id}" title="Download">💾</button>
                        <button class="session-action-btn delete" data-id="${session.id}" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="session-stats">
                    <div class="session-stat">
                        <div class="session-stat-label">Samples</div>
                        <div class="session-stat-value">${session.stats.samples}</div>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-label">Avg RR</div>
                        <div class="session-stat-value">
                            ${session.stats.avgRR ? session.stats.avgRR.toFixed(1) : '--'}
                            <span class="session-stat-unit">ms</span>
                        </div>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-label">RMSSD</div>
                        <div class="session-stat-value">
                            ${session.stats.rmssd ? session.stats.rmssd.toFixed(1) : '--'}
                            <span class="session-stat-unit">ms</span>
                        </div>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-label">SRI</div>
                        <div class="session-stat-value ${session.sri >= 75 ? 'sri-excellent' : session.sri >= 55 ? 'sri-good' : session.sri >= 35 ? 'sri-fair' : session.sri > 0 ? 'sri-poor' : ''}">
                            ${session.sri !== null && session.sri !== undefined && session.sri > 0 ? session.sri : '--'}
                        </div>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-label">Events</div>
                        <div class="session-stat-value">${session.eventMarkers?.length || 0}</div>
                    </div>
                </div>
            </div>
        `).join('');

        // Add event listeners
        document.querySelectorAll('.session-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (!e.target.closest('.session-action-btn')) {
                    restoreSession(parseInt(card.dataset.id));
                }
            });
        });

        document.querySelectorAll('.session-action-btn.download').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await downloadSession(parseInt(btn.dataset.id));
            });
        });

        document.querySelectorAll('.session-action-btn.delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm('Delete this session?')) {
                    await deleteSession(parseInt(btn.dataset.id));
                    await renderHistory();
                    await updateHistoryBadge();
                }
            });
        });
    } catch (error) {
        console.error('Failed to render history:', error);
    }
}

// Render history as interactive table
async function renderHistoryTable() {
    try {
        const sessions = await loadSessions();
        const filtered = filterAndSortSessions(sessions, {
            search: historyTableSearch.value,
            tag:    historyTableTagFilter.value,
            sort:   historyTableSortFilter.value,
        });

        if (filtered.length === 0) {
            historyTableBody.innerHTML = `
                <tr><td colspan="11" style="text-align:center; padding:32px; color:var(--text-tertiary);">
                    No sessions found
                </td></tr>`;
            return;
        }

        historyTableBody.innerHTML = filtered.map(session => {
            const sriClass = session.sri >= 75 ? 'sri-excellent'
                           : session.sri >= 55 ? 'sri-good'
                           : session.sri >= 35 ? 'sri-fair'
                           : session.sri > 0  ? 'sri-poor' : '';
            const tagsHtml = session.tags?.length
                ? session.tags.map(t => `<span class="session-tag">${t}</span>`).join('')
                : '<span style="color:var(--text-tertiary)">—</span>';

            return `
            <tr class="table-row" data-id="${session.id}">
                <td><input type="checkbox" class="row-select" data-id="${session.id}"></td>
                <td class="table-date">${formatDate(session.date)}</td>
                <td class="table-name">${session.filename || 'polar-h10-data'}</td>
                <td>${formatDuration(session.duration)}</td>
                <td>${session.stats.samples}</td>
                <td>${session.stats.avgRR ? session.stats.avgRR.toFixed(1) + ' ms' : '—'}</td>
                <td>${session.stats.rmssd ? session.stats.rmssd.toFixed(1) + ' ms' : '—'}</td>
                <td class="${sriClass}" style="font-weight:700;">${session.sri > 0 ? session.sri : '—'}</td>
                <td>${session.eventMarkers?.length || 0}</td>
                <td>${tagsHtml}</td>
                <td class="table-actions">
                    <button class="tbl-btn restore" data-id="${session.id}" title="Restore session">↩️</button>
                    <button class="tbl-btn download" data-id="${session.id}" title="Download CSV">💾</button>
                    <button class="tbl-btn edit" data-id="${session.id}" title="Rename session">✏️</button>
                    <button class="tbl-btn delete" data-id="${session.id}" title="Delete">🗑️</button>
                </td>
            </tr>`;
        }).join('');

        // Select-all checkbox
        document.getElementById('selectAllRows').onchange = (e) => {
            document.querySelectorAll('.row-select').forEach(cb => cb.checked = e.target.checked);
        };

        // Row-level buttons
        historyTableBody.querySelectorAll('.tbl-btn.restore').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); restoreSession(parseInt(btn.dataset.id)); });
        });
        historyTableBody.querySelectorAll('.tbl-btn.download').forEach(btn => {
            btn.addEventListener('click', async e => { e.stopPropagation(); await downloadSession(parseInt(btn.dataset.id)); });
        });
        historyTableBody.querySelectorAll('.tbl-btn.delete').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                if (confirm('Delete this session?')) {
                    await deleteSession(parseInt(btn.dataset.id));
                    await renderHistoryTable();
                    await updateHistoryBadge();
                }
            });
        });
        historyTableBody.querySelectorAll('.tbl-btn.edit').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.id);
                const session = await loadSession(id);
                const newName = prompt('Rename session:', session.filename || 'polar-h10-data');
                if (newName !== null && newName.trim()) {
                    await saveSession({ ...session, filename: newName.trim() }, id);
                    await renderHistoryTable();
                }
            });
        });
    } catch (error) {
        console.error('Failed to render history table:', error);
    }
}

async function restoreSession(id) {
    try {
        const session = await loadSession(id);
        if (isConnected) {
            if (!confirm('Disconnect current session and load this one?')) return;
            disconnect(true); // suppress redundant confirm
        }

        // Restore data arrays
        if (session.rawRRIntervals && session.rawRRIntervals.length > 0) {
            // Session has separate raw and cleaned data
            rawRRIntervals = [...session.rawRRIntervals];
            rawTimestamps = [...session.rawTimestamps];
            rrIntervals = [...session.rrIntervals];
            timestamps = [...session.timestamps];
        } else {
            // Old session format - treat saved data as raw, then clean
            rawRRIntervals = [...session.rrIntervals];
            rawTimestamps = [...session.timestamps];
            const cleaned = cleanRRData(rawRRIntervals, rawTimestamps);
            rrIntervals = cleaned.rr;
            timestamps = cleaned.times;
        }

        eventMarkers = [...session.eventMarkers];
        sessionAnnotations = session.annotations || [];
        sessionTags = session.tags || [];
        sessionStartTime = session.startTime || session.timestamp;

        // Calculate or restore SRI using the SAME function
        const sriResult = calculateSRI(rrIntervals, timestamps);
        if (sriResult) {
            sriScore = sriResult.score;
            sriComponents = sriResult.components;
            peakHR = sriResult.peakHR;

            // If session didn't have SRI, save it now
            if (!session.sri || session.sri === 0) {
                console.log(`✓ SRI calculated for historical session: ${sriScore}`);
                await saveSession({
                    ...session,
                    sri: sriScore,
                    sriComponents: sriComponents,
                    peakHR: peakHR
                }, session.id);
            }
        } else {
            sriScore = 0;
            sriComponents = { rmssd: 0, lfhf: 0, hrRecovery: 0 };
            peakHR = 0;
        }

        document.getElementById('filename').value = session.filename || 'polar-h10-data';
        exportBtn.disabled = false;
        copyBtn.disabled = false;
        reportBtn.disabled = false;

        // Update all displays
        updateStats();
        updateRRChart();
        updateRollingRMSSD();
        updatePoincareChart();
        updateSpectrogramChart();
        updateHRChart();
        updateVagalProxyChart();
        updateSRI();
        renderAnnotations();
        renderTags();

        // Dismiss whichever history UI is currently open
        historyPanel.classList.remove('active');
        historyOverlay.classList.remove('active');
        historyTableModal.classList.remove('active');
        historyTableOverlay.classList.remove('active');
        await updateHistoryBadge();

        console.log(`✓ Session restored: ${session.stats.samples} samples, SRI: ${sriScore}`);
    } catch (error) {
        console.error('Failed to restore session:', error);
    }
}

// Download session
async function downloadSession(id) {
    try {
        const session = await loadSession(id);
        const sessionDate = new Date(session.startTime || session.timestamp);
        const dateStr = sessionDate.toISOString().slice(0, 16);
        const tagsStr = session.tags && session.tags.length > 0 ? '_' + session.tags.join('-') : '';
        const filename = `${session.filename || 'polar-h10'}_${dateStr}${tagsStr}`;

        let csv = '';

        // Add unified metadata header
        csv += generateMetadataHeader({
            filename: session.filename,
            startTime: session.startTime,
            tags: session.tags || [],
            rrCount: session.rrIntervals.length,
            rawRRCount: session.rawRRIntervals?.length || session.rrIntervals.length,
            eventCount: session.eventMarkers?.length || 0,
            sessionTimestamps: session.timestamps,
            sessionEventMarkers: session.eventMarkers || [],
            includeRaw: false // Downloaded sessions are always cleaned data
        });

        // Add data header
        csv += 'Timestamp (s),RR Interval (ms),Event Type,Annotation\n';

        for (let i = 0; i < session.rrIntervals.length; i++) {
            const timestamp = session.timestamps[i];
            const rr = session.rrIntervals[i];
            const event = session.eventMarkers?.find(e => Math.abs(e.time - timestamp) < 0.5);
            const eventType = event ? event.type || '' : '';
            const annotation = event ? (event.annotation || '').replace(/,/g, ';') : ''; // Escape commas
            csv += `${timestamp.toFixed(3)},${rr.toFixed(3)},${eventType},${annotation}\n`;
        }

        // Use robust download function
        downloadFile(csv, `${filename}.csv`, 'text/csv');
    } catch (error) {
        console.error('Failed to download session:', error);
    }
}

// Bulk download all filtered sessions
async function bulkDownloadSessions(filterOverrides = {}) {
    const sessions = await loadSessions();
    const filtered = filterAndSortSessions(sessions, filterOverrides);
    if (filtered.length === 0) { alert('No sessions to download.'); return; }

    const format = bulkFormatSelect.value;
    bulkDownloadBtn.disabled = true;
    bulkDownloadBtn.textContent = '⏳ Preparing...';

    try {
        const zip = new JSZip();

        for (const session of filtered) {
            const sessionDate = new Date(session.startTime || session.timestamp);
            const dateStr = sessionDate.toISOString().slice(0, 16);
            const tagsStr = session.tags?.length ? '_' + session.tags.join('-') : '';
            const baseName = `${session.filename || 'polar-h10'}_${dateStr}${tagsStr}`;

            let content, ext;

            if (format === 'txt') {
                content = session.rrIntervals.map(rr => rr.toFixed(3)).join('\n');
                ext = 'txt';
            } else { // csv (default)
                let csv = generateMetadataHeader({
                    filename: session.filename,
                    startTime: session.startTime,
                    tags: session.tags || [],
                    rrCount: session.rrIntervals.length,
                    rawRRCount: session.rawRRIntervals?.length || session.rrIntervals.length,
                    eventCount: session.eventMarkers?.length || 0,
                    includeRaw: false
                });
                csv += 'Timestamp (s),RR Interval (ms),Event Type,Annotation\n';
                for (let i = 0; i < session.rrIntervals.length; i++) {
                    const ts = session.timestamps[i];
                    const rr = session.rrIntervals[i];
                    const ev = session.eventMarkers?.find(e => Math.abs(e.time - ts) < 0.5);
                    csv += `${ts.toFixed(3)},${rr.toFixed(3)},${ev?.type || ''},${(ev?.annotation || '').replace(/,/g, ';')}\n`;
                }
                content = csv;
                ext = 'csv';
            }

            zip.file(`${baseName}.${ext}`, content);
        }

        // Generate and trigger a single ZIP download
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipName = `polar-h10-sessions_${new Date().toISOString().slice(0, 10)}.zip`;
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = zipName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);

        console.log(`✓ Bulk downloaded ${filtered.length} session(s) as .${format} in ZIP`);
    } finally {
        bulkDownloadBtn.disabled = false;
        bulkDownloadBtn.textContent = '⬇ Download';
    }
}

// History panel controls
function openHistory() {
    historyPanel.classList.add('active');
    historyOverlay.classList.add('active');
    renderHistory();
}

function closeHistory() {
    historyPanel.classList.remove('active');
    historyOverlay.classList.remove('active');
}

// Event type panel controls
function openEventTypePanel() {
    eventTypePanel.classList.add('active');
    eventTypeOverlay.classList.add('active');
    renderAnnotations();
}

function closeEventTypePanel() {
    eventTypePanel.classList.remove('active');
    eventTypeOverlay.classList.remove('active');
}

// Add event marker
function addEventMarker() {
    if (!isConnected) return;

    const currentTime = calibrationStartTime
        ? (Date.now() - calibrationStartTime) / 1000
        : 0;
    const annotation = eventAnnotation.value.trim();

    const marker = {
        time: currentTime,
        type: selectedEventType,
        annotation: annotation,
        label: selectedEventType + (annotation ? `: ${annotation}` : '')
    };

    eventMarkers.push(marker);
    sessionAnnotations.push(marker);
    eventAnnotation.value = '';

    updateRRChartWithMarkers();
    updateRollingRMSSD();
    renderAnnotations();

    console.log(`✓ Event added: ${marker.label} at ${currentTime.toFixed(3)}s`);
}

// Render annotations list
function renderAnnotations() {
    if (sessionAnnotations.length === 0) {
        annotationsList.innerHTML = '<p style="color: var(--text-tertiary); text-align: center; padding: 20px;">No events yet</p>';
        return;
    }

    annotationsList.innerHTML = sessionAnnotations.map((ann, idx) => `
        <div class="annotation-item">
            <span class="annotation-time">${ann.time.toFixed(1)}s</span>
            <span class="annotation-text">${ann.type}${ann.annotation ? ': ' + ann.annotation : ''}</span>
            <button class="annotation-delete" data-idx="${idx}">✕</button>
        </div>
    `).join('');

    document.querySelectorAll('.annotation-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            sessionAnnotations.splice(idx, 1);
            eventMarkers.splice(idx, 1);
            renderAnnotations();
            updateRRChartWithMarkers();
            updateRollingRMSSD();
        });
    });
}

// Tag management
function addTag() {
    const tag = tagInput.value.trim();
    if (tag && !sessionTags.includes(tag)) {
        sessionTags.push(tag);
        tagInput.value = '';
        renderTags();
    }
}

function removeTag(tag) {
    sessionTags = sessionTags.filter(t => t !== tag);
    renderTags();
}

function renderTags() {
    if (sessionTags.length === 0) {
        currentTags.innerHTML = '';
        return;
    }

    currentTags.innerHTML = sessionTags.map(tag => `
        <div class="tag-chip">
            ${tag}
            <span class="tag-chip-remove" data-tag="${tag}">✕</span>
        </div>
    `).join('');

    document.querySelectorAll('.tag-chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            removeTag(btn.dataset.tag);
        });
    });
}

// Plot configuration
const plotConfig = {
    responsive: true,
    displayModeBar: false,
    staticPlot: false,
    scrollZoom: false,
    doubleClick: false
};

// Initialize charts
const chartColor = getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary');

const ecgLayout = {
    title: '',
    xaxis: { title: 'Time (s)', color: chartColor, showgrid: false, zeroline: false, fixedrange: true },
    yaxis: { title: 'Amplitude (µV)', color: chartColor, showgrid: false, zeroline: false, fixedrange: true },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 10, r: 20, l: 50, b: 40 },
    autosize: true,
    font: { color: chartColor, family: 'Inter, sans-serif' },
    hovermode: 'closest'
};

const rrLayout = {
    ...ecgLayout,
    yaxis: { ...ecgLayout.yaxis, title: 'RR Interval (ms)' }
};

const rmssdLayout = {
    ...ecgLayout,
    yaxis: { ...ecgLayout.yaxis, title: 'RMSSD (ms)' }
};

const poincareLayout = {
    ...ecgLayout,
    xaxis: { ...ecgLayout.xaxis, title: 'RR(n) (ms)' },
    yaxis: { ...ecgLayout.yaxis, title: 'RR(n+1) (ms)' }
};

const spectrogramLayout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor:  'rgba(0,0,0,0)',
    margin: { t: 30, r: 20, l: 60, b: 40 },
    autosize: true,
    font: { color: chartColor, family: 'Inter, sans-serif' },
    hovermode: 'closest',
    xaxis: { title: 'Time (s)', color: chartColor, showgrid: false, zeroline: false, fixedrange: true },
    yaxis: {
        title: 'Frequency (Hz)', type: 'log',
        color: chartColor, showgrid: false, zeroline: false, fixedrange: true,
        tickvals: [0.005, 0.01, 0.04, 0.15, 0.40],
        ticktext: ['0.005', '0.01', '0.04', '0.15', '0.40'],
    },
    shapes: [
        { type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:0.04, y1:0.04,
          line:{ color:'#FFF', width:1.5, dash:'dot' } },
        { type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:0.15, y1:0.15,
          line:{ color:'#FFF', width:1.5, dash:'dot' } },
    ],
};

const hrLayout = {
    ...ecgLayout,
    margin: { t: 30, r: 20, l: 55, b: 40 },
    yaxis: { ...ecgLayout.yaxis, title: 'Heart Rate (bpm)'}
};

const vagalProxyLayout = {
    ...ecgLayout,
    yaxis: { ...ecgLayout.yaxis, title: 'RMSSD / SDNN', range: [0, 1] }
};

Plotly.newPlot('ecgChart', [{
    x: [], y: [], type: 'scatter', mode: 'lines',
    line: { color: '#6366f1', width: 1.5 },
    hovertemplate: 'Time: %{x:.2f}s<br>Voltage: %{y:.2f}µV<extra></extra>'
}], ecgLayout, plotConfig);

Plotly.newPlot('rrChart', [{
    x: [], y: [], type: 'scatter', mode: 'lines',
    line: { color: '#ec4899', width: 2.0 },
    hovertemplate: 'Time: %{x:.2f}s<br>R-R interval: %{y:.2f}ms<extra></extra>'
}], rrLayout, plotConfig);

Plotly.newPlot('rollingRMSSDChart', [{
    x: [], y: [], type: 'scatter', mode: 'lines',
    line: { color: '#22d3ee', width: 2.0 },
    hovertemplate: 'Time: %{x:.2f}s<br>RMSSD: %{y:.2f}ms<extra></extra>'
}], rmssdLayout, plotConfig);

Plotly.newPlot('poincareChart', [
    {
        x: [], y: [], type: 'scatter', mode: 'markers', name: 'RR Points',
        marker: { color: '#a78bfa', size: 5, opacity: 0.55 },
        hovertemplate: 'RR(n): %{x:.2f}ms<br>RR(n+1): %{y:.2f}ms<extra></extra>'
    },
    {
        x: [], y: [], type: 'scatter', mode: 'lines', name: 'SD Ellipse',
        line: { color: '#22d3ee', width: 2 }, showlegend: false, hoverinfo: 'none'
    },
    {
        x: [], y: [], type: 'scatter', mode: 'lines', name: 'Identity',
        line: { color: 'rgba(156,163,175,0.35)', width: 1.5, dash: 'dash' },
        showlegend: false, hoverinfo: 'none'
    }
], poincareLayout, plotConfig);

Plotly.newPlot('psdChart', [{
    type: 'heatmap',
    x: [], y: [], z: [[]],
    colorscale: [
      ['0', 'rgb(224,243,248)'],
      ['0.5', 'rgb(116,173,209)'],
      ['1', 'rgb(49,54,149)']
    ],
    showscale: false,
    zsmooth: 'best',
    hovertemplate: 'Time: %{x:.1f}s<br>Freq: %{y:.3f} Hz<br>Log Power: %{z:.2f}<extra></extra>'
}], spectrogramLayout, plotConfig);

Plotly.update('ecgChart',          {x: [[]], y: [[]]},               {},                    [0]);
Plotly.update('rrChart',           {x: [[]], y: [[]]},               {shapes:[],annotations:[]}, [0]);
Plotly.update('rollingRMSSDChart', {x: [[]], y: [[]]},               {shapes:[],annotations:[]}, [0]);
Plotly.update('poincareChart',     {x:[[],[],[]], y:[[],[],[]]},     {annotations:[]},      [0,1,2]);
Plotly.update('psdChart',          {x: [[]], y: [[]], z: [[[]]]},    {annotations:[]},           [0]);

Plotly.newPlot('hrChart', [{
    x: [], y: [], type: 'scatter', mode: 'lines', name: 'HR',
    line: { color: '#f43f5e', width: 2.0 },
    hovertemplate: 'Time: %{x:.2f}s<br>HR: %{y:.1f} bpm<extra></extra>'
}], hrLayout, plotConfig);

Plotly.newPlot('vagalProxyChart', [{
    x: [], y: [], type: 'scatter', mode: 'lines', name: 'RMSSD/SDNN',
    line: { color: '#f59e0b', width: 2.0 },
    fill: 'tozeroy', fillcolor: 'rgba(245,158,11,0.08)',
    hovertemplate: 'Time: %{x:.2f}s<br>RMSSD/SDNN: %{y:.3f}<extra></extra>'
}], vagalProxyLayout, plotConfig);

// Event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
resetBtn.addEventListener('click', resetSession);
exportBtn.addEventListener('click', exportData);
copyBtn.addEventListener('click', copyToClipboard);
reportBtn.addEventListener('click', generatePDFReport);
timestampBtn.addEventListener('click', openEventTypePanel);
cinemaToggle.addEventListener('click', toggleCinemaMode);
themeToggle.addEventListener('click', toggleTheme);
historyBtn.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', closeHistory);
eventTypeClose.addEventListener('click', closeEventTypePanel);
eventTypeOverlay.addEventListener('click', closeEventTypePanel);
addEventBtn.addEventListener('click', addEventMarker);
addTagBtn.addEventListener('click', addTag);
clearAllBtn.addEventListener('click', clearAllSessions);
bulkDownloadBtn.addEventListener('click', bulkDownloadSessions);
historySearch.addEventListener('input', renderHistory);
tagFilter.addEventListener('change', renderHistory);
sortFilter.addEventListener('change', renderHistory);
historyTableSearch.addEventListener('input', renderHistoryTable);
historyTableTagFilter.addEventListener('change', renderHistoryTable);
historyTableSortFilter.addEventListener('change', renderHistoryTable);

// View toggle tabs
tabCards.addEventListener('click', () => {
    currentHistoryView = 'cards';
    tabCards.classList.add('active');
    tabTable.classList.remove('active');
    historyContent.style.display = '';
});

tabTable.addEventListener('click', () => {
    currentHistoryView = 'table';
    tabCards.classList.remove('active');
    tabTable.classList.add('active');
    historyContent.style.display = 'none';
    historyPanel.classList.remove('active');
    historyOverlay.classList.remove('active');
    openHistoryTable();
});

function openHistoryTable() {
    // Sync filter values from the sidebar into the table modal
    historyTableSearch.value = historySearch.value;
    historyTableTagFilter.value  = tagFilter.value;
    historyTableSortFilter.value = sortFilter.value;
    historyTableModal.classList.add('active');
    historyTableOverlay.classList.add('active');
    renderHistoryTable();
}

function closeHistoryTable() {
    historyTableModal.classList.remove('active');
    historyTableOverlay.classList.remove('active');
    currentHistoryView = 'cards';
    tabCards.classList.add('active');
    tabTable.classList.remove('active');
    historyContent.style.display = '';
    historyPanel.classList.add('active');    // reopen sidebar
    historyOverlay.classList.add('active');
    renderHistory();                         // refresh card view
}

historyTableClose.addEventListener('click', closeHistoryTable);
historyTableOverlay.addEventListener('click', closeHistoryTable);

// Wire the in-modal bulk download to use its own format select
historyTableBulkDownloadBtn.addEventListener('click', async () => {
    const savedFormat = bulkFormatSelect.value;
    bulkFormatSelect.value = historyTableFormatSelect.value;

    historyTableBulkDownloadBtn.disabled = true;
    historyTableBulkDownloadBtn.textContent = '⏳ Preparing...';
    try {
        await bulkDownloadSessions({
            search: historyTableSearch.value,
            tag:    historyTableTagFilter.value,
            sort:   historyTableSortFilter.value,
        });
    } finally {
        historyTableBulkDownloadBtn.disabled = false;
        historyTableBulkDownloadBtn.textContent = '⬇ Download';
        bulkFormatSelect.value = savedFormat;
    }
});

tagInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addTag();
});

// ── Settings event listeners ─────────────────────────────────────
const settingsBtn     = document.getElementById('settingsBtn');
const settingsPanel   = document.getElementById('settingsPanel');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose   = document.getElementById('settingsClose');
const resetLayoutBtn  = document.getElementById('resetLayoutBtn');

settingsBtn.addEventListener('click', () => {
    applySettings();
    settingsPanel.classList.add('active');
    settingsOverlay.classList.add('active');
});
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);
function closeSettings() {
    settingsPanel.classList.remove('active');
    settingsOverlay.classList.remove('active');
}

// Age slider
document.getElementById('settingsAge').addEventListener('input', (e) => {
    const age = Math.min(100, Math.max(10, parseInt(e.target.value) || 30));
    appSettings.age = age;
    const d = document.getElementById('settingsAgeVal');
    if (d) d.textContent = `${age} yrs`;
    const p = document.getElementById('maxHRPreview');
    if (p) p.textContent = `Max HR: ${220 - age} bpm · Zones recalculated live`;
    saveSettings();
    updateHRZone(currentHR);
    if (rrIntervals.length > 0) updateHRChart();
});

// Calibration slider
document.getElementById('settingsCalib').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    appSettings.calibrationSecs = val;
    const d = document.getElementById('settingsCalibVal');
    if (d) d.textContent = `${val} s`;
    saveSettings();
});

// Autosave slider
document.getElementById('settingsAutosave').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    appSettings.autosaveSecs = val;
    const d = document.getElementById('settingsAutosaveVal');
    if (d) d.textContent = `${val} s`;
    saveSettings();
    if (isConnected) { stopAutoSave(); startAutoSave(); }
});

// RMSSD window slider
document.getElementById('settingsRMSSDWindow').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    appSettings.rmssdWindow = val;
    const d = document.getElementById('settingsRMSSDWindowVal');
    if (d) d.textContent = `${val} s`;
    saveSettings();
    if (rrIntervals.length > 0) { updateRollingRMSSD(); updateVagalProxyChart(); }
});

// Artifact rejection chips
document.querySelectorAll('#artifactGroup .sett-chip').forEach(btn => {
    btn.addEventListener('click', () => {
        appSettings.artifactThreshold = parseInt(btn.dataset.val);
        document.querySelectorAll('#artifactGroup .sett-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        saveSettings();
    });
});

// Chart visibility checkboxes
['ecg','rr','rollingRMSSD','poincare','psd','hr','vagalProxy'].forEach(key => {
    const cb = document.getElementById(`show_${key}`);
    if (cb) cb.addEventListener('change', () => {
        appSettings.visibleCharts[key] = cb.checked;
        saveSettings();
        applyChartVisibility();
        setTimeout(resizeAllCharts, 50);
    });
});

resetLayoutBtn.addEventListener('click', resetGridLayout);

eventAnnotation.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addEventMarker();
});

// Event type selector
document.querySelectorAll('.event-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.event-type-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedEventType = btn.dataset.type;
    });
});

// Cinema mode
let cinemaMode = false;
function toggleCinemaMode() {
    cinemaMode = !cinemaMode;
    if (cinemaMode) {
        controlsPanel.classList.add('hidden');
        statsGrid.classList.add('cinema-mode');
        cinemaToggle.classList.add('active');
        cinemaIcon.textContent = '📺';
        cinemaText.textContent = 'Controls';
    } else {
        controlsPanel.classList.remove('hidden');
        statsGrid.classList.remove('cinema-mode');
        cinemaToggle.classList.remove('active');
        cinemaIcon.textContent = '🎬';
        cinemaText.textContent = 'Cinema';
    }
}

async function performSessionReset(showConfirm = true) {
    if (showConfirm && !confirm('Reset session? All current data will be cleared.')) {
        return false;
    }

    stopAutoSave();

    // Clear all data arrays
    rrIntervals = [];
    timestamps = [];
    rawRRIntervals = [];
    rawTimestamps = [];
    eventMarkers = [];
    sessionAnnotations = [];
    sessionTags = [];
    rollingRMSSD = [];
    rollingRMSSDTimes = [];
    ecgData = [];
    ecgTimestamps = [];

    sriScore = 0;
    sriComponents = { rmssd: 0, lfhf: 0, hrRecovery: 0 };
    sriHistory = [];
    peakHR = 0;

    // Reset session variables
    sessionStartTime = Date.now();
    currentSessionId = null;
    calibrationStartTime = Date.now();
    calibrationEndTime = null;
    isCalibrating = false;

    // Reset UI
    hrValue.textContent = '--';
    rmssdValue.textContent = '--';
    samplesValue.textContent = '0';
    avgRRValue.textContent = '--';
    if (dataQualityValue) dataQualityValue.textContent = '--';

    // Clear charts
    document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('is-live'));
    Plotly.update('ecgChart', {x: [[]], y: [[]]}, {}, [0]);
    Plotly.update('rrChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
    Plotly.update('rollingRMSSDChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
    Plotly.update('psdChart',          {x: [[]], y: [[]], z: [[[]]]},  {annotations:[]},           [0]);
    Plotly.update('hrChart',           {x: [[]], y: [[]]},             {shapes:[],annotations:[]}, [0]);
    Plotly.update('vagalProxyChart',   {x: [[]], y: [[]]},             {shapes:[],annotations:[]}, [0]);
    Plotly.update('poincareChart',     {x:[[],[],[]], y:[[],[],[]]},   {annotations:[]},           [0,1,2]);

    // Reset SRI display:
    if (document.getElementById('sriGauge')) {
        drawSRIGauge(0);
    }
    document.getElementById('sriValue').textContent = '--';
    document.getElementById('sriRMSSD').textContent = '--';
    document.getElementById('sriLFHF').textContent = '--';
    document.getElementById('sriHRRecovery').textContent = '--';
    const statusEl = document.getElementById('sriStatus');
    if (statusEl) {
        statusEl.className = 'sri-status';
        statusEl.innerHTML = `
            <div class="sri-status-icon">⏱️</div>
            <div class="sri-status-text">Calculating... Need at least 2 minutes of data</div>
        `;
    }

    initChartPlaceholders();
    renderAnnotations();
    renderTags();

    if (isConnected) startAutoSave();

    return true;
}

// Connect to device
async function connect() {
    if (!navigator.bluetooth) {
        status.textContent = 'Bluetooth Not Supported';
        alert('Web Bluetooth requires Chrome or Edge on desktop/Android over a secure (HTTPS) connection.');
        return;
    }
    try {
        status.textContent = 'Scanning...';
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [HR_SERVICE] }],
            optionalServices: [PMD_SERVICE, BATTERY_SERVICE]
        });

        // Only now ask to clear and reset
        if (rrIntervals.length > 0) {
            if (!confirm('Starting a new session will clear current data. Continue?')) {
                device = null;
                status.textContent = 'Not Connected';
                return;
            }
            await performSessionReset(false);
            sessionTags = [];
        }

        status.textContent = 'Connecting...';
        server = await device.gatt.connect();

        const hrService = await server.getPrimaryService(HR_SERVICE);
        hrChar = await hrService.getCharacteristic(HR_MEASUREMENT);
        await hrChar.startNotifications();
        hrChar.addEventListener('characteristicvaluechanged', handleHRData);

        try {
            const batteryService = await server.getPrimaryService(BATTERY_SERVICE);
            batteryChar = await batteryService.getCharacteristic(BATTERY_LEVEL);
            await batteryChar.startNotifications();
            batteryChar.addEventListener('characteristicvaluechanged', handleBatteryData);
            const batteryValue = await batteryChar.readValue();
            handleBatteryData({ target: { value: batteryValue } });
            batteryIndicator.style.display = 'flex';
        } catch (e) {
            console.log('Battery service not available');
        }

        try {
            const pmdService = await server.getPrimaryService(PMD_SERVICE);
            pmdControlChar = await pmdService.getCharacteristic(PMD_CONTROL);
            pmdDataChar = await pmdService.getCharacteristic(PMD_DATA);
            await pmdControlChar.startNotifications();
            pmdControlChar.addEventListener('characteristicvaluechanged', handlePMDControlResponse);
            await pmdDataChar.startNotifications();
            pmdDataChar.addEventListener('characteristicvaluechanged', handleECGData);
            await pmdControlChar.writeValue(new Uint8Array([0x01, 0x00]));
            setTimeout(async () => {
                try {
                    const startECG = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00]);
                    await pmdControlChar.writeValue(startECG);
                    ecgSupported = true;
                } catch (err) {
                    console.log('ECG streaming not available');
                }
            }, 500);
        } catch (e) {
            console.log('PMD service not available');
        }


        isConnected = true;
        sessionStartTime = Date.now();
        currentSessionId = null;
        lastPacketTime = Date.now();

        // Start calibration period
        isCalibrating = true;
        calibrationEndTime = Date.now() + (appSettings.calibrationSecs || 8) * 1000;
        calibrationStartTime = null; // Reset
        status.textContent = 'Calibrating...';
        status.classList.add('calibrating');

        // Update status after calibration
        setTimeout(() => {
            if (isConnected) {
                isCalibrating = false;
                calibrationStartTime = Date.now(); // Set the baseline for all timestamps
                status.textContent = 'Connected';
                status.classList.remove('calibrating');
                console.log('✓ Calibration complete - recording started');
                status.classList.add('connected');
            }
        }, (appSettings.calibrationSecs || 8) * 1000);

        startRecordingTimer();
        startAutoSave();

        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        exportBtn.disabled = false;
        copyBtn.disabled = false;
        reportBtn.disabled = false;
        timestampBtn.disabled = false;
        signalIndicator.style.display = 'flex';
    } catch (error) {
        console.error('Connection failed:', error);
        status.textContent = 'Connection Failed';
    }
}

// Disconnect
function disconnect(skipConfirm = false) {
    if (skipConfirm || confirm('Disconnect device? Data will be saved to history.')) {
        stopAutoSave();
        if (device && device.gatt.connected) {
            if (rrIntervals.length > 0) {
                const currentTime = calibrationStartTime
                    ? (Date.now() - calibrationStartTime) / 1000
                    : 0;
                const oneMinAgo = currentTime - 60;
                const recentRR = rrIntervals.filter((_, i) => timestamps[i] >= oneMinAgo);
                let avgRR = null, rmssd = null;
                if (recentRR.length > 0) {
                    avgRR = recentRR.reduce((a, b) => a + b, 0) / recentRR.length;
                }
                if (recentRR.length > 1) {
                    let sumSquaredDiff = 0;
                    for (let i = 1; i < recentRR.length; i++) {
                        const diff = recentRR[i] - recentRR[i - 1];
                        sumSquaredDiff += diff * diff;
                    }
                    rmssd = Math.sqrt(sumSquaredDiff / (recentRR.length - 1));
                }
                saveSession({
                    startTime: calibrationStartTime || sessionStartTime,
                    filename: document.getElementById('filename').value || 'polar-h10-data',
                    rrIntervals: [...rrIntervals],
                    timestamps: [...timestamps],
                    rawRRIntervals: [...rawRRIntervals],
                    rawTimestamps: [...rawTimestamps],
                    eventMarkers: [...eventMarkers],
                    annotations: [...sessionAnnotations],
                    tags: [...sessionTags],
                    avgRR,
                    rmssd,
                    sri: sriScore,
                    sriComponents: { ...sriComponents },
                    peakHR: peakHR
                }, currentSessionId).then(() => {
                    console.log('✓ Session saved to history');
                    updateHistoryBadge();
                });
            }
            device.gatt.disconnect();
        }
        isConnected = false;
        currentSessionId = null;
        isCalibrating = false;
        calibrationEndTime = null;
        stopRecordingTimer();

        rrIntervals = [];
        timestamps = [];
        rawRRIntervals = [];
        rawTimestamps = [];
        eventMarkers = [];

        sessionAnnotations = [];
        sessionTags = [];
        rollingRMSSD = [];
        rollingRMSSDTimes = [];
        ecgData = [];
        ecgTimestamps = [];

        // fully reset SRI state:
        sriScore = 0;
        sriComponents = { rmssd: 0, lfhf: 0, hrRecovery: 0 };
        sriHistory = [];
        peakHR = 0;

        hrValue.textContent = '--';
        rmssdValue.textContent = '--';
        samplesValue.textContent = '0';
        avgRRValue.textContent = '--';
        if (dataQualityValue) dataQualityValue.textContent = '--';

        document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('is-live'));

        Plotly.update('ecgChart', {x: [[]], y: [[]]}, {}, [0]);
        Plotly.update('rrChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
        Plotly.update('rollingRMSSDChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
        Plotly.update('poincareChart',   {x:[[],[],[]], y:[[],[],[]]},   {annotations:[]},           [0,1,2]);
        Plotly.update('psdChart',        {x: [[]], y: [[]], z: [[[]]]},  {annotations:[]},           [0]);
        Plotly.update('hrChart',         {x: [[]], y: [[]]},             {shapes:[],annotations:[]}, [0]);
        Plotly.update('vagalProxyChart', {x: [[]], y: [[]]},             {shapes:[],annotations:[]}, [0]);

        if (document.getElementById('sriGauge')) {
            drawSRIGauge(0);
        }
        document.getElementById('sriValue').textContent = '--';
        document.getElementById('sriRMSSD').textContent = '--';
        document.getElementById('sriLFHF').textContent = '--';
        document.getElementById('sriHRRecovery').textContent = '--';
        const sriStatusEl = document.getElementById('sriStatus');
        if (sriStatusEl) {
            sriStatusEl.className = 'sri-status';
            sriStatusEl.innerHTML = `
                <div class="sri-status-icon">⏱️</div>
                <div class="sri-status-text">Calculating... Need at least 2 minutes of data</div>
            `;
        }

        initChartPlaceholders();

        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        timestampBtn.disabled = true;
        batteryIndicator.style.display = 'none';
        signalIndicator.style.display = 'none';
        hrZoneIndicator.style.display = 'none';
        status.textContent = 'Disconnected';
        status.classList.remove('connected');
        renderAnnotations();
        renderTags();
    }
}

// Reset session
function resetSession() {
    performSessionReset(true);
    console.log('✓ Session reset');
}

// Recording timer
function startRecordingTimer() {
    recordingTimer.style.display = 'flex';
    timerInterval = setInterval(() => {
        // Only show time after calibration starts
        if (!calibrationStartTime) {
            recordingTimer.textContent = '⏱ 00:00';
            return;
        }
        const elapsed = Math.floor((Date.now() - calibrationStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        recordingTimer.textContent = `⏱ ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }, 1000);
}

function stopRecordingTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    recordingTimer.style.display = 'none';
    recordingTimer.textContent = '⏱ 00:00';
}

function shouldUpdateChart(chartType) {
    const now = Date.now();
    if (now - chartUpdateThrottle[chartType] >= CHART_UPDATE_INTERVAL) {
        chartUpdateThrottle[chartType] = now;
        return true;
    }
    return false;
}

// Pulse stat cards on new data receipt
function flashStatCards() {
    document.querySelectorAll('.stat-card').forEach(card => {
        card.classList.add('is-live');
        const valueEl = card.querySelector('.stat-value');
        if (valueEl) {
            valueEl.classList.add('value-flash');
            setTimeout(() => valueEl.classList.remove('value-flash'), 200);
        }
    });
}

// Handle HR data
function handleHRData(event) {
    const value = event.target.value;
    const flags = value.getUint8(0);
    const hrFormat = flags & 0x01;
    let hr = hrFormat === 0 ? value.getUint8(1) : value.getUint16(1, true);

    currentHR = hr;
    hrValue.textContent = hr;
    updateHRZone(hr);
    lastPacketTime = Date.now();

    const rrPresent = flags & 0x10;
    if (rrPresent) {
      let offset = hrFormat === 0 ? 2 : 3;
      while (offset < value.byteLength) {
            const rr = value.getUint16(offset, true) / 1024 * 1000;

            // Only process and store data AFTER calibration completes
            if (!isCalibrating && calibrationStartTime) {
                const timestamp = (Date.now() - calibrationStartTime) / 1000;

                // Store raw data (everything that arrives post-calibration)
                rawRRIntervals.push(rr);
                rawTimestamps.push(timestamp);

                // Store cleaned data (validated intervals only)
                const lastRR = rrIntervals.length > 0 ? rrIntervals[rrIntervals.length - 1] : null;
                if (isValidRRInterval(rr, lastRR)) {
                    rrIntervals.push(rr);
                    timestamps.push(timestamp);
                }
            }

            offset += 2;
        }

        // Update stats and charts only after calibration
        if (!isCalibrating && calibrationStartTime) {
            if (shouldUpdateChart('psd'))        updateSpectrogramChart();
            updateStats();
            flashStatCards();
            if (shouldUpdateChart('rr'))         updateRRChart();
            if (shouldUpdateChart('rmssd'))      updateRollingRMSSD();
            if (shouldUpdateChart('poincare'))   updatePoincareChart();
            if (shouldUpdateChart('hr'))         updateHRChart();
            if (shouldUpdateChart('vagalProxy')) updateVagalProxyChart();
        }
    }
}

// Validate individual RR interval in real-time
function isValidRRInterval(rr, lastRR = null) {
    const minRR = 250;  // 200 BPM max
    const maxRR = 2000; // 30 BPM min
    const maxDiff = appSettings.artifactThreshold || 300;

    // Check physiological validity
    if (rr < minRR || rr > maxRR) return false;

    // Check for sudden jumps only if we have previous data
    if (lastRR !== null && Math.abs(rr - lastRR) > maxDiff) return false;

    return true;
}

// Handle battery data
function handleBatteryData(event) {
    const batteryPercent = event.target.value.getUint8(0);
    batteryText.textContent = `${batteryPercent}%`;
    const levelWidth = (batteryPercent / 100) * 18;
    batteryLevel.style.width = `${levelWidth}px`;
    batteryLevel.classList.toggle('low', batteryPercent <= 20);
}

// Handle PMD control response
function handlePMDControlResponse(event) {
    const value = event.target.value;
    const response = new Uint8Array(value.buffer);
    console.log('PMD Control response:', Array.from(response).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
}

// Handle ECG data
function handleECGData(event) {
    const value = event.target.value;
    const timestamp = (Date.now() - sessionStartTime) / 1000;
    if (value.byteLength < 10) return;

    const data = new Uint8Array(value.buffer);
    const frameType = data[0];
    if (frameType !== 0x00) return;

    const dataStart = 10;
    const sampleCount = Math.floor((data.length - dataStart) / 3);

    for (let i = 0; i < sampleCount; i++) {
        const offset = dataStart + i * 3;
        let sample = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
        if (sample & 0x800000) sample |= 0xFF000000;
        ecgData.push(sample);
        ecgTimestamps.push(timestamp + i / 130);
    }

    const maxSamples = 650;
    if (ecgData.length > maxSamples) {
        ecgData = ecgData.slice(-maxSamples);
        ecgTimestamps = ecgTimestamps.slice(-maxSamples);
    }
    updateECGChart();
}

// Calculate SRI - Uses full dataset for consistency with PSD chart
function calculateSRI(rrData = null, timeData = null) {
    // Use provided data or fall back to current session data
    const rr = rrData || rrIntervals;
    const times = timeData || timestamps;

    if (rr.length < 50) return null;

    // Always use full data for consistency with PSD chart (no time windowing)
    const analysisRR = rr;
    const analysisTimes = times;

    // Component 1: RMSSD (35% weight)
    let rmssdValue = 0;
    if (analysisRR.length > 1) {
        let sumSquaredDiff = 0;
        for (let i = 1; i < analysisRR.length; i++) {
            const diff = analysisRR[i] - analysisRR[i - 1];
            sumSquaredDiff += diff * diff;
        }
        rmssdValue = Math.sqrt(sumSquaredDiff / (analysisRR.length - 1));
    }
    const rmssdNormalized = Math.min(100, Math.max(0, (rmssdValue / 100) * 100));

    // Component 2: LF/HF Ratio via Morlet CWT (35% weight)
    const isCurrentData = !rrData && !timeData;
    let lfhfRatio = 0;
    if (isCurrentData && lastCWTResult &&
        lastCWTResult.dataLength === rrIntervals.length) {
        // Reuse result already computed by the spectrogram chart
        lfhfRatio = lastCWTResult.lfhfRatio;
    } else {
        const cwt = computeMorletCWT(analysisRR);
        lfhfRatio = cwt ? cwt.lfhfRatio : 0;
    }

    // Normalize LF/HF: Inverse relationship - lower is better
    let lfhfNormalized = 0;
    if (lfhfRatio <= 0.5) {
        lfhfNormalized = 100;
    } else if (lfhfRatio <= 2) {
        lfhfNormalized = 100 - ((lfhfRatio - 0.5) / 1.5) * 30;
    } else if (lfhfRatio <= 3) {
        lfhfNormalized = 70 - ((lfhfRatio - 2) / 1) * 30;
    } else {
        lfhfNormalized = Math.max(0, 40 - ((lfhfRatio - 3) / 2) * 40);
    }

    // Component 3: HR Recovery Rate (30% weight)
    const hrValues = analysisRR.map(rr => 60000 / rr);
    const peakHRLocal = hrValues.reduce((a, b) => Math.max(a, b), 0);
    const avgHR = hrValues.reduce((a, b) => a + b, 0) / hrValues.length;
    const minHR = hrValues.reduce((a, b) => Math.min(a, b), Infinity);

    const recoveryRate1 = peakHRLocal > 0 ? ((peakHRLocal - avgHR) / peakHRLocal) * 100 : 0;
    const recoveryRate2 = peakHRLocal > 0 ? ((peakHRLocal - minHR) / peakHRLocal) * 100 : 0;
    const hrRecoveryRate = Math.max(recoveryRate1, recoveryRate2);
    const hrRecoveryNormalized = Math.min(100, Math.max(0, hrRecoveryRate));

    // Weighted composite score
    const sri = (rmssdNormalized * 0.35) + (lfhfNormalized * 0.35) + (hrRecoveryNormalized * 0.30);

    return {
        score: Math.round(sri),
        components: {
            rmssd: Math.round(rmssdValue * 10) / 10,
            lfhf: Math.round(lfhfRatio * 100) / 100,
            hrRecovery: Math.round(hrRecoveryRate * 10) / 10
        },
        peakHR: Math.round(peakHRLocal)
    };
}

// Get SRI status and message
function getSRIStatus(score) {
    if (score >= 75) {
        return {
            class: 'excellent',
            icon: '🌟',
            text: 'Excellent Recovery - Optimal autonomic balance',
            color: '#10b981'
        };
    } else if (score >= 55) {
        return {
            class: 'good',
            icon: '✅',
            text: 'Good Recovery - Healthy stress response',
            color: '#22d3ee'
        };
    } else if (score >= 35) {
        return {
            class: 'fair',
            icon: '⚠️',
            text: 'Fair Recovery - Moderate stress detected',
            color: '#f59e0b'
        };
    } else {
        return {
            class: 'poor',
            icon: '⚡',
            text: 'Poor Recovery - High stress levels',
            color: '#ef4444'
        };
    }
}

// Draw SRI gauge using Canvas - Enhanced futuristic design
function drawSRIGauge(score) {
    const canvas = document.getElementById('sriGauge');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Responsive sizing
    const container = canvas.parentElement;
    const containerWidth = container ? container.offsetWidth : 300;
    const size = Math.min(Math.max(containerWidth * 0.9, 100), 400); // 100px min, 400px max

    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    const centerX = size / 2;
    const centerY = size / 2;
    const baseRadius = size / 2.8;
    const lineWidth = Math.max(size / 15, 8); // Responsive line width

    // Detect theme
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const bgTertiary = isLight ? 'rgba(243, 244, 246, 0.8)' : 'rgba(31, 41, 55, 0.6)';
    const glowColor = isLight ? 'rgba(99, 102, 241, 0.15)' : 'rgba(99, 102, 241, 0.4)';
    const tickColor = isLight ? 'rgba(107, 114, 128, 0.4)' : 'rgba(156, 163, 175, 0.3)';

    // Clear canvas
    ctx.clearRect(0, 0, size, size);

    // === LAYER 1: Outer glow ring ===
    if (!isLight) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius + lineWidth / 2 + 8, 0.75 * Math.PI, 2.25 * Math.PI);
        ctx.strokeStyle = glowColor;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 20;
        ctx.shadowColor = glowColor;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    // === LAYER 2: Background arc with inner shadow ===
    ctx.beginPath();
    ctx.arc(centerX, centerY, baseRadius, 0.75 * Math.PI, 2.25 * Math.PI);
    ctx.strokeStyle = bgTertiary;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.stroke();

    // === LAYER 3: Segmented color bands (background) ===
    const segments = [
        { start: 0, end: 35, color: '#ef4444', label: 'POOR' },
        { start: 35, end: 55, color: '#f59e0b', label: 'FAIR' },
        { start: 55, end: 75, color: '#22d3ee', label: 'GOOD' },
        { start: 75, end: 100, color: '#10b981', label: 'EXCELLENT' }
    ];

    segments.forEach(segment => {
        const startAngle = 0.75 * Math.PI + (segment.start / 100) * 1.5 * Math.PI;
        const endAngle = 0.75 * Math.PI + (segment.end / 100) * 1.5 * Math.PI;

        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius, startAngle, endAngle);
        ctx.strokeStyle = segment.color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.globalAlpha = isLight ? 0.2 : 0.25;
        ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // === LAYER 4: Score arc with gradient and glow ===
    if (score > 0) {
        const scoreAngle = 0.75 * Math.PI + (score / 100) * 1.5 * Math.PI;

        // Determine colors based on score
        let gradientColors;
        if (score >= 75) {
            gradientColors = ['#10b981', '#22d3ee'];
        } else if (score >= 55) {
            gradientColors = ['#22d3ee', '#6366f1'];
        } else if (score >= 35) {
            gradientColors = ['#f59e0b', '#fb923c'];
        } else {
            gradientColors = ['#ef4444', '#f97316'];
        }

        // Create radial gradient
        const gradient = ctx.createLinearGradient(
            centerX - baseRadius,
            centerY - baseRadius,
            centerX + baseRadius,
            centerY + baseRadius
        );
        gradient.addColorStop(0, gradientColors[0]);
        gradient.addColorStop(1, gradientColors[1]);

        // Outer glow
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius, 0.75 * Math.PI, scoreAngle);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = lineWidth + 4;
        ctx.lineCap = 'round';
        ctx.shadowBlur = isLight ? 15 : 25;
        ctx.shadowColor = gradientColors[0];
        ctx.globalAlpha = isLight ? 0.4 : 0.6;
        ctx.stroke();

        // Main score arc
        ctx.globalAlpha = 1;
        ctx.shadowBlur = isLight ? 10 : 20;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Inner highlight line
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius - lineWidth / 3, 0.75 * Math.PI, scoreAngle);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // === LAYER 5: Tick marks (adaptive density) ===
    const tickInterval = size < 200 ? 20 : 10; // Fewer ticks on small screens
    ctx.globalAlpha = 0.6;
    for (let i = 0; i <= 100; i += tickInterval) {
        const angle = 0.75 * Math.PI + (i / 100) * 1.5 * Math.PI;
        const isMajor = i % 25 === 0;
        const tickLength = isMajor ? 8 : 4;
        const innerRadius = baseRadius - lineWidth / 2 - tickLength;
        const outerRadius = baseRadius - lineWidth / 2 + 2;

        ctx.beginPath();
        ctx.moveTo(
            centerX + innerRadius * Math.cos(angle),
            centerY + innerRadius * Math.sin(angle)
        );
        ctx.lineTo(
            centerX + outerRadius * Math.cos(angle),
            centerY + outerRadius * Math.sin(angle)
        );
        ctx.strokeStyle = tickColor;
        ctx.lineWidth = isMajor ? 2 : 1;
        ctx.stroke();

        // Add numeric labels for major ticks (only on larger screens)
        if (isMajor && size >= 250) {
            const labelRadius = baseRadius - lineWidth / 2 - 18;
            const labelX = centerX + labelRadius * Math.cos(angle);
            const labelY = centerY + labelRadius * Math.sin(angle);

            ctx.save();
            ctx.fillStyle = tickColor;
            ctx.font = `${Math.max(size / 30, 8)}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(i.toString(), labelX, labelY);
            ctx.restore();
        }
    }
    ctx.globalAlpha = 1;

    // === LAYER 6: Center dot/indicator ===
    if (score > 0) {
        const scoreAngle = 0.75 * Math.PI + (score / 100) * 1.5 * Math.PI;
        const indicatorRadius = baseRadius + lineWidth / 2;
        const indicatorX = centerX + indicatorRadius * Math.cos(scoreAngle);
        const indicatorY = centerY + indicatorRadius * Math.sin(scoreAngle);

        // Outer glow
        ctx.beginPath();
        ctx.arc(indicatorX, indicatorY, size / 40, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#ffffff';
        ctx.fill();

        // Inner dot
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(indicatorX, indicatorY, size / 50, 0, 2 * Math.PI);
        ctx.fillStyle = score >= 75 ? '#10b981' : score >= 55 ? '#22d3ee' : score >= 35 ? '#f59e0b' : '#ef4444';
        ctx.fill();
    }

    // === LAYER 7: Center decorative ring ===
    const centerRingRadius = baseRadius * 0.35;
    ctx.beginPath();
    ctx.arc(centerX, centerY, centerRingRadius, 0, 2 * Math.PI);
    ctx.strokeStyle = isLight ? 'rgba(99, 102, 241, 0.1)' : 'rgba(99, 102, 241, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Subtle outer glow ring for excellent scores (dark mode)
    if (score >= 75 && !isLight) {
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius + lineWidth / 2 + 5, 0, 2 * Math.PI);
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 12;
        ctx.shadowColor = '#10b981';
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
    }
}

// Responsive gauge redraw on resize
let gaugeResizeObserver;
function initGaugeResponsiveness() {
    const gaugeWrapper = document.querySelector('.sri-gauge-wrapper');
    if (!gaugeWrapper || gaugeResizeObserver) return;

    gaugeResizeObserver = new ResizeObserver(() => {
        if (sriScore > 0 || document.getElementById('sriValue').textContent !== '--') {
            drawSRIGauge(sriScore);
        }
    });

    gaugeResizeObserver.observe(gaugeWrapper);
}

// Update SRI display
function updateSRI() {
    const result = calculateSRI(); // Always use the same function

    if (!result) {
        document.getElementById('sriValue').textContent = '--';
        document.getElementById('sriRMSSD').textContent = '--';
        document.getElementById('sriLFHF').textContent = '--';
        document.getElementById('sriHRRecovery').textContent = '--';

        const statusEl = document.getElementById('sriStatus');
        statusEl.className = 'sri-status';
        statusEl.innerHTML = `
            <div class="sri-status-icon">⏱️</div>
            <div class="sri-status-text">Calculating... Need at least 50 RR intervals</div>
        `;
        return;
    }

    const { score, components } = result;
    sriScore = score;
    sriComponents = components;
    if (result.peakHR) peakHR = result.peakHR;

    // Animate score change
    const currentDisplayedScore = parseInt(document.getElementById('sriValue').textContent) || 0;
    if (currentDisplayedScore !== score) {
        animateScoreChange(currentDisplayedScore, score);
    } else {
        document.getElementById('sriValue').textContent = score;
    }

    document.getElementById('sriRMSSD').textContent = components.rmssd.toFixed(1);
    document.getElementById('sriLFHF').textContent = components.lfhf.toFixed(2);
    document.getElementById('sriHRRecovery').textContent = components.hrRecovery.toFixed(1) + '%';

    drawSRIGauge(score);

    const status = getSRIStatus(score);
    const statusEl = document.getElementById('sriStatus');
    statusEl.className = `sri-status ${status.class}`;
    statusEl.innerHTML = `
        <div class="sri-status-icon">${status.icon}</div>
        <div class="sri-status-text">${status.text}</div>
    `;

    // Store in history (only for live sessions with calibration baseline)
    if (calibrationStartTime) {
        sriHistory.push({
            time: (Date.now() - calibrationStartTime) / 1000,
            score: score
        });
        if (sriHistory.length > 600) sriHistory.shift();
    }
}

// Animate score value changes
function animateScoreChange(from, to) {
    const duration = 800;
    const start = Date.now();
    const element = document.getElementById('sriValue');

    function animate() {
        const elapsed = Date.now() - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // Ease out cubic
        const current = Math.round(from + (to - from) * eased);

        element.textContent = current;

        if (progress < 1) {
            requestAnimationFrame(animate);
        }
    }

    animate();
}

// SRI Info Modal
const sriInfoBtn = document.getElementById('sriInfoBtn');
const sriInfoPanel = document.getElementById('sriInfoPanel');
const sriInfoOverlay = document.getElementById('sriInfoOverlay');
const sriInfoClose = document.getElementById('sriInfoClose');

function openSRIInfo() {
    sriInfoPanel.classList.add('active');
    sriInfoOverlay.classList.add('active');
}

function closeSRIInfo() {
    sriInfoPanel.classList.remove('active');
    sriInfoOverlay.classList.remove('active');
}

sriInfoBtn.addEventListener('click', openSRIInfo);
sriInfoClose.addEventListener('click', closeSRIInfo);
sriInfoOverlay.addEventListener('click', closeSRIInfo);

// Update stats
function updateStats() {
    samplesValue.textContent = rrIntervals.length;

    // Calculate data quality based on raw data vs cleaned data
    if (rawRRIntervals.length > 0) {
        dataQuality = calculateDataQuality(rawRRIntervals.length, rrIntervals.length);
    } else {
        dataQuality = 100; // No raw data yet, assume 100%
    }

    const currentTime = timestamps.length > 0
        ? timestamps[timestamps.length - 1]
        : (calibrationStartTime ? (Date.now() - calibrationStartTime) / 1000 : 0);
    const oneMinAgo = currentTime - 60;
    const recentRR = rrIntervals.filter((_, i) => timestamps[i] >= oneMinAgo);

    if (recentRR.length > 0) {
        const avg = recentRR.reduce((a, b) => a + b, 0) / recentRR.length;
        avgRRValue.textContent = avg.toFixed(1);
    }

    if (recentRR.length > 1) {
        let sumSquaredDiff = 0;
        for (let i = 1; i < recentRR.length; i++) {
            const diff = recentRR[i] - recentRR[i - 1];
            sumSquaredDiff += diff * diff;
        }
        const rmssd = Math.sqrt(sumSquaredDiff / (recentRR.length - 1));
        rmssdValue.textContent = rmssd.toFixed(1);
    }

    if (dataQualityValue) {
        dataQualityValue.textContent = `${dataQuality}%`;
        dataQualityValue.className = '';
        if (dataQuality >= 95) dataQualityValue.classList.add('data-quality-excellent');
        else if (dataQuality >= 80) dataQualityValue.classList.add('data-quality-good');
        else if (dataQuality >= 60) dataQualityValue.classList.add('data-quality-fair');
        else dataQualityValue.classList.add('data-quality-poor');
    }

    updateSRI();
}

// Update ECG chart
function updateECGChart() {
    if (ecgData.length > 0) {
        const paired = ecgTimestamps.map((time, index) => ({ time, value: ecgData[index] }));
        paired.sort((a, b) => a.time - b.time);
        Plotly.update('ecgChart', {
            x: [paired.map(p => p.time)],
            y: [paired.map(p => p.value)]
        }, {}, [0]);
    }
}

// Update RR chart
function updateRRChart() {
    if (timestamps.length > 0) {
        updateRRChartWithMarkers();
    }
}

// Update RR chart with markers
function updateRRChartWithMarkers() {
    if (timestamps.length === 0) return;

    const paired = timestamps.map((time, index) => ({ time, rr: rrIntervals[index] }));
    paired.sort((a, b) => a.time - b.time);

    const shapes = eventMarkers.map(event => ({
        type: 'line',
        x0: event.time, x1: event.time,
        y0: 0, y1: 0.95,
        yref: 'paper',
        line: { color: '#22d3ee', width: 2, dash: 'dot' }
    }));

    const annotations = eventMarkers.map(event => ({
        x: event.time, y: 1,
        yref: 'paper',
        text: event.type,
        showarrow: false,
        font: { size: 10, color: '#22d3ee' },
        bgcolor: 'rgba(34, 211, 238, 0.1)',
        borderpad: 4,
        yshift: 10
    }));

    Plotly.update('rrChart', {
        x: [paired.map(p => p.time)],
        y: [paired.map(p => p.rr)]
    }, { shapes, annotations }, [0]);
}

// Update rolling RMSSD
function updateRollingRMSSD() {
    if (rrIntervals.length < 2) return;

    const windowDuration = appSettings.rmssdWindow || 60;
    rollingRMSSD = [];
    rollingRMSSDTimes = [];

    let left = 0;
    let sumSqDiff = 0;
    let pairCount = 0;

    for (let i = 1; i < rrIntervals.length; i++) {
        // Incrementally add the newest pair
        const newDiff = rrIntervals[i] - rrIntervals[i - 1];
        sumSqDiff += newDiff * newDiff;
        pairCount++;

        const currentTime = timestamps[i];
        const windowStart = currentTime - windowDuration;

        // Evict pairs whose left index has fallen outside the window
        while (left < i && timestamps[left] < windowStart) {
            const evictDiff = rrIntervals[left + 1] - rrIntervals[left];
            sumSqDiff -= evictDiff * evictDiff;
            pairCount--;
            left++;
        }

        if (currentTime >= 30 && pairCount > 0) {
            rollingRMSSD.push(Math.sqrt(sumSqDiff / pairCount));
            rollingRMSSDTimes.push(currentTime);
        }
    }

    // Show/hide placeholder - removed isConnected check
    const rmssdChart = document.getElementById('rollingRMSSDChart');
    let placeholder = rmssdChart.querySelector('.chart-placeholder');

    if (rollingRMSSD.length === 0) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'chart-placeholder';
            placeholder.innerHTML = `
                <div class="chart-placeholder-icon">⏱️</div>
                <div class="chart-placeholder-text">Chart available after 30 seconds</div>
            `;
            rmssdChart.appendChild(placeholder);
        }
        rmssdChart.classList.add('chart-blurred');
    } else {
        if (placeholder) placeholder.remove();
        rmssdChart.classList.remove('chart-blurred');
    }

    const paired = rollingRMSSDTimes.map((time, index) => ({ time, rmssd: rollingRMSSD[index] }));
    paired.sort((a, b) => a.time - b.time);

    const shapes = eventMarkers.map(event => ({
        type: 'line',
        x0: event.time, x1: event.time,
        y0: 0, y1: 0.95,
        yref: 'paper',
        line: { color: '#22d3ee', width: 2, dash: 'dot' }
    }));

    const annotations = eventMarkers.map(event => ({
        x: event.time, y: 1,
        yref: 'paper',
        text: event.type,
        showarrow: false,
        font: { size: 10, color: '#22d3ee' },
        bgcolor: 'rgba(34, 211, 238, 0.1)',
        borderpad: 4,
        yshift: 10
    }));

    Plotly.update('rollingRMSSDChart', {
        x: [paired.map(p => p.time)],
        y: [paired.map(p => p.rmssd)]
    }, { shapes, annotations }, [0]);
}

// Update Poincaré chart
// Update Poincaré chart with SD1/SD2 ellipse
function updatePoincareChart() {
    if (rrIntervals.length < 2) return;
    const rrN  = rrIntervals.slice(0, -1);
    const rrN1 = rrIntervals.slice(1);
    const stats = computePoincareStats(rrIntervals);

    let ellipse = { x: [], y: [] };
    let identX  = [], identY  = [];
    let annotations = [];

    if (stats && stats.sd1 > 0) {
        ellipse = generateEllipseTrace(stats.meanRR, stats.meanRR, stats.sd1, stats.sd2);
        const allRR = [...rrN, ...rrN1];
        const lo = Math.min(...allRR), hi = Math.max(...allRR);
        identX = [lo, hi]; identY = [lo, hi];

        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        annotations = [{
            xref: 'paper', yref: 'paper', x: 0.98, y: 0.98,
            xanchor: 'right', yanchor: 'top',
            text: `<b>SD1</b> ${stats.sd1} ms<br><b>SD2</b> ${stats.sd2} ms<br><b>SD1/SD2</b> ${stats.ratio}`,
            showarrow: false,
            font: { size: 11, color: isLight ? '#4b5563' : '#9ca3af' },
            bgcolor: isLight ? 'rgba(249,250,251,0.92)' : 'rgba(17,24,39,0.8)',
            bordercolor: 'rgba(99,102,241,0.3)',
            borderpad: 6, borderwidth: 1, align: 'right'
        }];
    }

    Plotly.update('poincareChart',
        { x: [rrN, ellipse.x, identX], y: [rrN1, ellipse.y, identY] },
        { annotations },
        [0, 1, 2]
    );
}

// ── Poincaré SD1/SD2 ─────────────────────────────────────────────
function computePoincareStats(rr) {
    if (rr.length < 2) return null;
    const n = rr.length;
    const mean = rr.reduce((a, b) => a + b) / n;
    const sdnn = Math.sqrt(rr.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    let sqd = 0;
    for (let i = 1; i < n; i++) sqd += (rr[i] - rr[i-1]) ** 2;
    const rmssdVal = Math.sqrt(sqd / (n - 1));
    const sd1 = rmssdVal / Math.SQRT2;
    const sd2Sq = Math.max(0, 2 * sdnn ** 2 - 0.5 * rmssdVal ** 2);
    const sd2 = Math.sqrt(sd2Sq);
    return {
        sd1: Math.round(sd1 * 10) / 10,
        sd2: Math.round(sd2 * 10) / 10,
        ratio: sd2 > 0 ? Math.round(sd1 / sd2 * 1000) / 1000 : 0,
        meanRR: Math.round(mean * 10) / 10
    };
}

function generateEllipseTrace(cx, cy, sd1, sd2, numPoints = 72) {
    const x = [], y = [], c45 = Math.SQRT1_2;
    for (let i = 0; i <= numPoints; i++) {
        const t = (2 * Math.PI * i) / numPoints;
        const xr = sd2 * Math.cos(t), yr = sd1 * Math.sin(t);
        x.push(cx + c45 * (xr - yr));
        y.push(cy + c45 * (xr + yr));
    }
    return { x, y };
}

// ── HR Chart with Zones ──────────────────────────────────────────
function updateHRChart() {
    const el = document.getElementById('hrChart');
    if (!el) return;

    const age = appSettings.age || 30;
    const maxHR = 220 - age;
    const zonePcts  = [0, 0.60, 0.70, 0.80, 0.90, 1.10];
    const zoneBPMs  = zonePcts.map(p => p * maxHR);
    const zoneColors = [
        'rgba(107,114,128,0.10)', 'rgba(59,130,246,0.10)',
        'rgba(16,185,129,0.10)',  'rgba(245,158,11,0.10)',
        'rgba(239,68,68,0.10)'
    ];
    const zoneNames  = ['Z1 Recovery','Z2 Endurance','Z3 Tempo','Z4 Threshold','Z5 Max'];

    const hrTimes  = timestamps.map(t => t);
    const hrValues = rrIntervals.map(rr => Math.round(60000 / rr * 10) / 10);

    let placeholder = el.querySelector('.chart-placeholder');
    if (hrTimes.length === 0) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'chart-placeholder';
            placeholder.innerHTML = `<div class="chart-placeholder-icon">💓</div>
                <div class="chart-placeholder-text">Connect device to see HR data</div>`;
            el.appendChild(placeholder);
        }
        el.classList.add('chart-blurred');
        return;
    }
    if (placeholder) placeholder.remove();
    el.classList.remove('chart-blurred');

    const shapes = zoneBPMs.slice(0,5).map((low, i) => ({
        type: 'rect', xref: 'paper', yref: 'y',
        x0: 0, x1: 1, y0: low, y1: zoneBPMs[i+1],
        fillcolor: zoneColors[i], line: { width: 0 }, layer: 'below'
    }));

    const annotations = zoneNames.map((name, i) => ({
        xref: 'paper', yref: 'y',
        x: 0.005, y: (zoneBPMs[i] + zoneBPMs[i+1]) / 2,
        text: name, showarrow: false,
        font: { size: 10, color: 'rgba(156,163,175,0.65)' }, xanchor: 'left'
    }));

    Plotly.update('hrChart', { x: [hrTimes], y: [hrValues] }, { shapes, annotations }, [0]);
}

// ── Vagal Proxy Chart ────────────────────────────────────────────
function computeVagalProxy() {
    const n = rrIntervals.length;
    if (n < 10) return { times: [], values: [] };
    const windowDuration = appSettings.rmssdWindow || 60;
    const stride = Math.max(1, Math.floor(n / 300));
    const times = [], values = [];
    for (let i = stride; i < n; i += stride) {
        const cur = timestamps[i];
        if (cur < 30) continue;
        const ws = cur - windowDuration;
        let lo = 0, hi = i;
        while (lo < hi) { const mid = (lo+hi)>>1; if (timestamps[mid] < ws) lo=mid+1; else hi=mid; }
        const w = rrIntervals.slice(lo, i + 1);
        if (w.length < 5) continue;
        const mean = w.reduce((a,b)=>a+b) / w.length;
        const sdnn = Math.sqrt(w.reduce((s,v)=>s+(v-mean)**2, 0) / w.length);
        if (sdnn <= 0) continue;
        let ss = 0;
        for (let j = 1; j < w.length; j++) ss += (w[j]-w[j-1])**2;
        const rmssd = Math.sqrt(ss / (w.length - 1));
        times.push(cur);
        values.push(rmssd / sdnn);
    }
    return { times, values };
}

function updateVagalProxyChart() {
    const el = document.getElementById('vagalProxyChart');
    if (!el) return;
    let placeholder = el.querySelector('.chart-placeholder');
    const { times, values } = computeVagalProxy();
    if (values.length === 0) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'chart-placeholder';
            placeholder.innerHTML = `<div class="chart-placeholder-icon">🧠</div>
                <div class="chart-placeholder-text">Chart available after 30 seconds</div>`;
            el.appendChild(placeholder);
        }
        el.classList.add('chart-blurred');
        return;
    }
    if (placeholder) placeholder.remove();
    el.classList.remove('chart-blurred');

    const shapes = [{
        type: 'line', xref: 'paper', yref: 'y',
        x0: 0, x1: 1, y0: 0.5, y1: 0.5,
        line: { color: 'rgba(245,158,11,0.5)', width: 1, dash: 'dot' }
    }];
    const annotations = [{
        xref: 'paper', yref: 'y', x: 0.99, y: 0.5,
        text: 'Balanced (0.5)', showarrow: false,
        font: { size: 10, color: 'rgba(245,158,11,0.7)' },
        xanchor: 'right', yanchor: 'bottom'
    }];
    Plotly.update('vagalProxyChart', { x: [times], y: [values] }, { shapes, annotations }, [0]);
}

function generateMetadataHeader(sessionData) {
    const {
        filename = 'polar-h10-data',
        startTime = calibrationStartTime || sessionStartTime,
        tags = sessionTags,
        rrCount = rrIntervals.length,
        rawRRCount = rawRRIntervals.length,
        eventCount = eventMarkers.length,
        includeRaw = false
    } = sessionData;

    const sessionDate = new Date(startTime);
    const dateStr = sessionDate.toISOString().slice(0, 19).replace('T', ' ');

    const srcTimestamps = sessionData.sessionTimestamps || timestamps;
    const srcEventMarkers = sessionData.sessionEventMarkers || eventMarkers;

    // Calculate actual duration from timestamps
    const actualDuration = srcTimestamps.length > 0
        ? Math.floor(srcTimestamps[srcTimestamps.length - 1])
        : 0;

    // Calculate data quality metrics
    const percentValid = calculateDataQuality(rawRRCount, rrCount);
    const removedRR = Math.max(0, rawRRCount - rrCount);

    let header = '';
    header += `# Polar H10 HRV Data Export\n`;
    header += `# Generated: ${new Date().toISOString()}\n`;
    header += `#\n`;
    header += `# Session Information\n`;
    header += `# Date: ${dateStr}\n`;
    header += `# Duration: ${formatDuration(actualDuration)}\n`;
    header += `# Filename: ${filename}\n`;
    header += `# Tags: ${tags.length > 0 ? tags.join(', ') : 'None'}\n`;
    header += `#\n`;
    header += `# Data Quality\n`;
    header += `# Data Type: ${includeRaw ? 'Raw (uncleaned)' : 'Clean (artifacts removed)'}\n`;
    header += `# Total RR Intervals: ${includeRaw ? rawRRCount : rrCount}\n`;
    header += `# Valid Intervals: ${rrCount} (${percentValid}%)\n`;
    header += `# Removed Artifacts: ${removedRR}\n`;
    header += `# Calibration Period: ${CALIBRATION_DURATION / 1000} seconds (excluded from data)\n`;
    header += `#\n`;
    header += `# Events\n`;
    header += `# Total Events: ${eventCount}\n`;
    if (eventCount > 0) {
        header += `# Event Types: ${[...new Set(srcEventMarkers.map(e => e.type))].join(', ')}\n`;
    }
    header += `#\n`;

    return header;
}

// Generate Professional PDF Report
// Generate HTML Report (print-to-PDF friendly)
async function generatePDFReport() {
    if (rrIntervals.length === 0) {
        alert('No data available for report generation');
        return;
    }

    reportBtn.disabled = true;
    reportBtn.textContent = '⏳ Building...';

    try {
        // ── Capture chart images ─────────────────────────────────────────────
        const scale = 10;
        const [imgPSD, imgPoincare, imgRR, imgRMSSD, imgHR, imgVagal] = await Promise.all([
            Plotly.toImage('psdChart',          { format: 'png', width: 1100, height: 600, scale }),
            Plotly.toImage('poincareChart',     { format: 'png', width:  700, height: 600, scale }),
            Plotly.toImage('rrChart',           { format: 'png', width: 1100, height: 380, scale }),
            rollingRMSSD.length > 0
                ? Plotly.toImage('rollingRMSSDChart', { format: 'png', width: 1100, height: 380, scale })
                : Promise.resolve(null),
            rrIntervals.length > 0
                ? Plotly.toImage('hrChart',     { format: 'png', width: 1100, height: 380, scale })
                : Promise.resolve(null),
            rrIntervals.length > 0
                ? Plotly.toImage('vagalProxyChart', { format: 'png', width: 1100, height: 380, scale })
                : Promise.resolve(null),
        ]);

        // Compute Poincaré stats for report
        const poincStats = computePoincareStats(rrIntervals);

        // ── Compute metrics ──────────────────────────────────────────────────
        const sessionDate  = new Date(calibrationStartTime || sessionStartTime);
        const duration     = timestamps.length > 0 ? Math.floor(timestamps[timestamps.length - 1]) : 0;
        const dquality     = calculateDataQuality(rawRRIntervals.length, rrIntervals.length);
        const sessionName  = document.getElementById('filename').value || 'polar-h10-data';

        const avgRR  = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
        const sdnn   = Math.sqrt(rrIntervals.reduce((s, rr) => s + Math.pow(rr - avgRR, 2), 0) / rrIntervals.length);
        let   rmssd  = 0;
        let   pnn50  = 0;
        if (rrIntervals.length > 1) {
            let sqSum = 0, nn50 = 0;
            for (let i = 1; i < rrIntervals.length; i++) {
                const d = rrIntervals[i] - rrIntervals[i - 1];
                sqSum += d * d;
                if (Math.abs(d) > 50) nn50++;
            }
            rmssd = Math.sqrt(sqSum / (rrIntervals.length - 1));
            pnn50 = (nn50 / (rrIntervals.length - 1)) * 100;
        }

        const hrVals = rrIntervals.map(rr => 60000 / rr);
        const avgHR  = hrVals.reduce((a, b) => a + b, 0) / hrVals.length;
        const minHR  = Math.min(...hrVals);
        const maxHR  = Math.max(...hrVals);

        const cwtRep    = (lastCWTResult && lastCWTResult.dataLength === rrIntervals.length)
                          ? lastCWTResult
                          : (computeMorletCWT(rrIntervals) || {});
        const vlfPow    = cwtRep.vlfPow    || 0;
        const lfPow     = cwtRep.lfPow     || 0;
        const hfPow     = cwtRep.hfPow     || 0;
        const totPow    = cwtRep.totalPow  || 0;
        const lfhfRatio = cwtRep.lfhfRatio || 0;

        const sriResult = calculateSRI();
        const sri       = sriResult ? sriResult.score : 0;
        const sriStatus = sriResult ? getSRIStatus(sri) : null;

        // ── Helpers ──────────────────────────────────────────────────────────
        const fmt  = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);
        const pct  = (v)        => totPow > 0 ? ((v / totPow) * 100).toFixed(1) + '%' : '—';
        const fmtD = (s)        => {
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
            if (h > 0) return `${h}h ${m}m`;
            if (m > 0) return `${m}m ${sec}s`;
            return `${sec}s`;
        };

        const sriColor = sri >= 75 ? '#10b981' : sri >= 55 ? '#22d3ee' : sri >= 35 ? '#f59e0b' : '#ef4444';
        const sriLabel = sri >= 75 ? 'Excellent' : sri >= 55 ? 'Good' : sri >= 35 ? 'Fair' : 'Poor';

        // Table row helper
        const row = (label, value, unit, ref, interp) => `
          <tr>
            <td class="lc">${label}</td>
            <td class="vc">${value}</td>
            <td class="uc">${unit}</td>
            <td class="rc">${ref}</td>
            <td class="ic">${interp}</td>
          </tr>`;

        // Events table rows
        const eventRows = eventMarkers.length > 0
            ? eventMarkers.map(e => `
              <tr>
                <td class="vc">${fmt(e.time, 1)}</td>
                <td>${e.type || '—'}</td>
                <td>${e.annotation || '—'}</td>
              </tr>`).join('')
            : `<tr><td colspan="3" style="text-align:center;color:#8a9bb8;padding:16px">No events recorded</td></tr>`;

        // Tags
        const tagsHtml = sessionTags.length > 0
            ? sessionTags.map(t => `<span class="tag">${t}</span>`).join('')
            : '<span style="color:#8a9bb8">None</span>';

        // ── Build HTML ───────────────────────────────────────────────────────
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CardioTrace Report — ${sessionName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#0f172a;--ink2:#334155;--ink3:#64748b;--ink4:#94a3b8;
  --bg:#f8fafc;--card:#fff;--border:#e2e8f0;--border2:#cbd5e1;
  --accent:#6366f1;--accent2:#ec4899;--accent3:#22d3ee;
  --success:#10b981;--warn:#f59e0b;--danger:#ef4444;
}
body{font-family:'Inter',system-ui,sans-serif;font-size:13px;color:var(--ink);
  background:var(--bg);line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}

/* PAGE SHELL */
.page{max-width:1020px;margin:28px auto;background:var(--card);
  border-radius:16px;overflow:hidden;box-shadow:0 8px 48px rgba(15,23,42,.12)}

/* ── HEADER ── */
.rh{background:linear-gradient(135deg,#1e1b4b 0%,#312e81 45%,#4f46e5 100%);
  padding:36px 48px;color:#fff;position:relative;overflow:hidden}
.rh::before{content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse at 80% 50%,rgba(236,72,153,.18) 0%,transparent 60%);
  pointer-events:none}
.rh-eyebrow{font-size:9.5px;font-weight:700;letter-spacing:3px;text-transform:uppercase;
  color:rgba(255,255,255,.45);margin-bottom:10px}
.rh-title{font-size:30px;font-weight:900;letter-spacing:-1px;margin-bottom:4px;
  background:linear-gradient(90deg,#fff 0%,rgba(255,255,255,.75) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.rh-sub{font-size:13px;color:rgba(255,255,255,.55);font-weight:400;margin-bottom:24px}
.rh-pills{display:flex;gap:32px;flex-wrap:wrap;padding-top:18px;
  border-top:1px solid rgba(255,255,255,.1)}
.rh-pill{font-size:10px;color:rgba(255,255,255,.45);line-height:2}
.rh-pill strong{display:block;font-size:12.5px;font-weight:600;color:#fff}

/* ── PRINT BUTTON (hidden on print) ── */
.print-bar{display:flex;gap:10px;justify-content:flex-end;padding:12px 48px;
  background:linear-gradient(90deg,#f1f5f9,#f8fafc);border-bottom:1px solid var(--border)}
.print-btn{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:12px;
  font-weight:600;font-family:inherit;letter-spacing:.3px;transition:all .2s}
.print-btn.primary{background:var(--accent);color:#fff}
.print-btn.primary:hover{background:#4f46e5}
.print-btn.secondary{background:var(--border);color:var(--ink2)}
.print-btn.secondary:hover{background:var(--border2)}

/* ── BODY ── */
.rb{padding:36px 48px}

/* ── KPI ROW ── */
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.kpi{background:var(--bg);border:1px solid var(--border);border-radius:12px;
  padding:18px 16px;position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;
  background:var(--kpi-accent,var(--accent))}
.kpi-label{font-size:9.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;
  color:var(--ink3);margin-bottom:8px}
.kpi-value{font-size:26px;font-weight:900;letter-spacing:-1px;color:var(--ink);line-height:1}
.kpi-unit{font-size:10px;color:var(--ink4);margin-top:4px;font-weight:500}
.kpi-badge{display:inline-block;margin-top:8px;padding:3px 10px;border-radius:20px;
  font-size:10px;font-weight:700;color:#fff;background:var(--kpi-accent,var(--accent))}

/* ── INTERPRETATION BANNER ── */
.interp-banner{padding:14px 20px;border-radius:12px;margin-bottom:28px;
  border-left:4px solid var(--interp-color,var(--accent));
  background:var(--interp-bg,rgba(99,102,241,.06));display:flex;align-items:flex-start;gap:12px}
.interp-icon{font-size:20px;flex-shrink:0;margin-top:1px}
.interp-text{font-size:12px;color:var(--ink2);line-height:1.65}
.interp-text strong{display:block;font-size:13px;color:var(--ink);margin-bottom:3px}

/* ── SECTION ── */
.sec{margin-bottom:32px}
.sec-title{display:flex;align-items:center;gap:10px;margin-bottom:16px;
  padding-bottom:10px;border-bottom:1.5px solid var(--border)}
.sec-title-bar{width:4px;height:16px;border-radius:2px;flex-shrink:0;
  background:linear-gradient(180deg,var(--accent),var(--accent2))}
.sec-title-text{font-size:10px;font-weight:700;letter-spacing:2px;
  text-transform:uppercase;color:var(--ink2)}

/* ── METRIC TABLE ── */
.mt{width:100%;border-collapse:collapse;font-size:12px}
.mt thead tr{background:linear-gradient(90deg,#1e1b4b,#4f46e5)}
.mt thead th{padding:10px 14px;font-size:9.5px;font-weight:700;color:#fff;
  text-align:left;letter-spacing:.8px;text-transform:uppercase}
.mt tbody tr:nth-child(even){background:#f8fafc}
.mt tbody tr:hover{background:#eef2ff}
.mt td{padding:9px 14px;border-bottom:1px solid var(--border);vertical-align:top;line-height:1.5}
.mt tbody tr:last-child td{border-bottom:none}
.lc{font-weight:500;color:var(--ink2);min-width:190px}
.vc{font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--accent);
  font-size:12.5px;min-width:80px}
.uc{color:var(--ink4);min-width:50px;font-size:11px}
.rc{color:#15803d;font-size:11px;min-width:140px}
.ic{color:#92400e;font-size:11px}

/* ── CHART CARDS ── */
.chart-card{background:var(--bg);border:1px solid var(--border);border-radius:12px;
  overflow:hidden;margin-bottom:14px}
.chart-card-label{padding:10px 16px;font-size:9px;font-weight:700;letter-spacing:2px;
  text-transform:uppercase;color:var(--ink3);border-bottom:1px solid var(--border)}
.chart-card img{display:block;width:100%;height:auto}
.charts-2col{display:grid;grid-template-columns:3fr 2fr;gap:14px;margin-bottom:14px}

/* ── EVENTS TABLE ── */
.ev-table{width:100%;border-collapse:collapse;font-size:12px}
.ev-table th{background:#f1f5f9;padding:9px 14px;font-size:10px;font-weight:600;
  color:var(--ink3);text-align:left;border:1px solid var(--border)}
.ev-table td{padding:8px 14px;border:1px solid var(--border)}

/* ── TAG CHIPS ── */
.tag{display:inline-block;padding:2px 10px;margin:2px;border-radius:20px;font-size:10px;
  font-weight:600;background:rgba(99,102,241,.1);color:var(--accent);
  border:1px solid rgba(99,102,241,.25)}

/* ── SRI SECTION ── */
.sri-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px}
.sri-component{background:var(--bg);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
.sri-comp-label{font-size:11px;font-weight:600;color:var(--ink3);text-transform:uppercase;
  letter-spacing:.5px}
.sri-comp-value{font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:700;
  color:var(--accent)}

/* ── FOOTER ── */
.rf{background:#f1f5f9;padding:20px 48px;border-top:1px solid var(--border);
  font-size:10.5px;color:var(--ink3);line-height:1.8}
.rf strong{color:var(--ink2)}
.rf a{color:var(--accent);text-decoration:none}

/* ── NOTE BOX ── */
.note{background:#eff6ff;border-left:3px solid var(--accent);padding:10px 14px;
  font-size:11px;color:var(--ink2);border-radius:0 8px 8px 0;margin-top:12px;line-height:1.6}

/* ── PRINT ── */
@media print{
  body{background:#fff}
  .page{box-shadow:none;border-radius:0;max-width:100%;margin:0}
  .print-bar{display:none}
  .rh{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .mt thead tr{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .mt tbody tr:nth-child(even){-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sec,.mt,.chart-card,.kpi-row,.interp-banner{break-inside:avoid}
  .charts-2col{break-inside:avoid}
}
</style>
</head>
<body>
<div class="page">

<!-- ── HEADER ───────────────────────────────────────────────────────── -->
<div class="rh">
  <div class="rh-eyebrow">❤️ CardioTrace · Cardiac Autonomic Function Report</div>
  <div class="rh-title">Heart Rate Variability Analysis</div>
  <div class="rh-sub">${sessionName}</div>
  <div class="rh-pills">
    <div class="rh-pill">Date<strong>${sessionDate.toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'})}</strong></div>
    <div class="rh-pill">Duration<strong>${fmtD(duration)}</strong></div>
    <div class="rh-pill">RR Intervals<strong>${rrIntervals.length.toLocaleString()}</strong></div>
    <div class="rh-pill">Data Quality<strong>${dquality}%</strong></div>
    ${sessionTags.length ? `<div class="rh-pill">Tags<strong>${sessionTags.join(', ')}</strong></div>` : ''}
    <div class="rh-pill">Generated<strong>${new Date().toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'})}</strong></div>
  </div>
</div>

<!-- ── PRINT BAR ─────────────────────────────────────────────────────── -->
<div class="print-bar">
  <button class="print-btn secondary" onclick="window.close()">✕ Close</button>
  <button class="print-btn primary" onclick="window.print()">🖨️ Print / Save PDF</button>
</div>

<div class="rb">

<!-- ── KPI CARDS ─────────────────────────────────────────────────────── -->
<div class="kpi-row">
  <div class="kpi" style="--kpi-accent:${sriColor}">
    <div class="kpi-label">Stress Recovery Index</div>
    <div class="kpi-value" style="color:${sriColor}">${sri > 0 ? sri : '—'}</div>
    <div class="kpi-unit">out of 100</div>
    ${sri > 0 ? `<div class="kpi-badge" style="background:${sriColor}">${sriLabel}</div>` : ''}
  </div>
  <div class="kpi" style="--kpi-accent:#6366f1">
    <div class="kpi-label">RMSSD</div>
    <div class="kpi-value">${fmt(rmssd)}</div>
    <div class="kpi-unit">ms · 1-min window</div>
  </div>
  <div class="kpi" style="--kpi-accent:#ec4899">
    <div class="kpi-label">LF / HF Ratio</div>
    <div class="kpi-value">${fmt(lfhfRatio, 2)}</div>
    <div class="kpi-unit">sympatho-vagal balance</div>
  </div>
  <div class="kpi" style="--kpi-accent:#22d3ee">
    <div class="kpi-label">Average Heart Rate</div>
    <div class="kpi-value">${fmt(avgHR, 0)}</div>
    <div class="kpi-unit">bpm</div>
  </div>
</div>

<!-- ── INTERPRETATION BANNER ─────────────────────────────────────────── -->
${sriResult ? (() => {
    let bg, color, icon, headline, body;
    if (sri >= 75) {
        color='#10b981'; bg='rgba(16,185,129,.07)'; icon='🌟';
        headline='Excellent Recovery — Optimal Autonomic Balance';
        body=`Strong parasympathetic activity with RMSSD of ${fmt(rmssd)} ms and LF/HF ratio of ${fmt(lfhfRatio,2)}.
              Autonomic regulation is well maintained. Continue current training and recovery protocols.`;
    } else if (sri >= 55) {
        color='#22d3ee'; bg='rgba(34,211,238,.07)'; icon='✅';
        headline='Good Recovery — Healthy Stress Response';
        body=`Adequate recovery capacity detected. RMSSD of ${fmt(rmssd)} ms indicates reasonable parasympathetic tone.
              Monitor trends over consecutive days for a complete picture.`;
    } else if (sri >= 35) {
        color='#f59e0b'; bg='rgba(245,158,11,.07)'; icon='⚠️';
        headline='Fair Recovery — Moderate Stress Detected';
        body=`Reduced HRV metrics suggest elevated sympathetic activity (LF/HF: ${fmt(lfhfRatio,2)}).
              Consider implementing recovery strategies: sleep optimisation, breathing exercises, or reduced training load.`;
    } else {
        color='#ef4444'; bg='rgba(239,68,68,.07)'; icon='⚡';
        headline='Poor Recovery — High Stress Levels';
        body=`Significant autonomic imbalance observed (RMSSD: ${fmt(rmssd)} ms, LF/HF: ${fmt(lfhfRatio,2)}).
              Prioritise rest, hydration, and stress management. Avoid high-intensity exercise until recovery improves.`;
    }
    return `<div class="interp-banner" style="--interp-color:${color};--interp-bg:${bg}">
      <div class="interp-icon">${icon}</div>
      <div class="interp-text">
        <strong>${headline}</strong>
        ${body}
      </div>
    </div>`;
})() : ''}

<!-- ── CHARTS: RR + RMSSD ─────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Signal Overview</span></div>
  <div class="chart-card">
    <div class="chart-card-label">RR Intervals over Time${eventMarkers.length ? ' · Vertical markers = events' : ''}</div>
    <img src="${imgRR}" alt="RR Intervals chart">
  </div>
  ${imgRMSSD ? `<div class="chart-card">
    <div class="chart-card-label">Rolling RMSSD — 1-minute sliding window</div>
    <img src="${imgRMSSD}" alt="Rolling RMSSD chart">
  </div>` : ''}
</div>

<!-- ── CHARTS: PSD + POINCARÉ ─────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Frequency & Geometric Analysis</span></div>
  <div class="charts-2col">
    <div class="chart-card">
      <div class="chart-card-label">HRV Wavelet Spectrogram — Morlet CWT (ω₀ = 6, 4 Hz interpolation, Plasma colorscale = log₁₀ power)</div>
      <img src="${imgPSD}" alt="Power Spectral Density chart">
    </div>
    <div class="chart-card">
      <div class="chart-card-label">Poincaré Plot — RR(n) vs RR(n+1)</div>
      <img src="${imgPoincare}" alt="Poincaré plot">
      ${poincStats ? `<div style="padding:8px 14px;font-size:11px;color:var(--ink3);border-top:1px solid var(--border);display:flex;gap:24px;">
        <span><strong style="color:var(--accent)">SD1</strong> ${poincStats.sd1} ms</span>
        <span><strong style="color:var(--accent)">SD2</strong> ${poincStats.sd2} ms</span>
        <span><strong style="color:var(--accent)">SD1/SD2</strong> ${poincStats.ratio}</span>
      </div>` : ''}
    </div>
  </div>
  <div class="note">
    <strong>Band legend:</strong> VLF 0.003–0.04 Hz · LF 0.04–0.15 Hz · HF 0.15–0.4 Hz.
    Spectrogram computed via Morlet CWT (ω₀ = 6) on RR series linearly interpolated to 4 Hz; colour = log₁₀(power). Dashed lines mark LF boundary (0.04 Hz, indigo) and HF boundary (0.15 Hz, pink). Band powers integrated from time-averaged scalogram.
    Poincaré SD1 reflects short-term (parasympathetic) variability; SD2 reflects long-term variability.
  </div>
</div>

<!-- ── HR + VAGAL PROXY ────────────────────────────────────────── -->
${(imgHR || imgVagal) ? `<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Heart Rate & Vagal Proxy</span></div>
  ${imgHR ? `<div class="chart-card" style="margin-bottom:14px;">
    <div class="chart-card-label">Heart Rate over Time with Training Zones (Age ${appSettings.age}, Max HR ${220-appSettings.age} bpm)</div>
    <img src="${imgHR}" alt="Heart Rate chart">
  </div>` : ''}
  ${imgVagal ? `<div class="chart-card">
    <div class="chart-card-label">Vagal Proxy (RMSSD/SDNN) — 1-minute rolling window · Values > 0.5 favour parasympathetic dominance</div>
    <img src="${imgVagal}" alt="Vagal Proxy chart">
  </div>` : ''}
</div>` : ''}

<!-- ── SRI BREAKDOWN ─────────────────────────────────────────────────── -->
${sriResult ? `<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Stress Recovery Index — Component Breakdown</span></div>
  <div class="sri-row">
    <div class="sri-component">
      <div>
        <div class="sri-comp-label">RMSSD (35% weight)</div>
        <div style="font-size:10px;color:var(--ink4);margin-top:4px">Parasympathetic activity</div>
      </div>
      <div class="sri-comp-value">${fmt(sriResult.components.rmssd)} ms</div>
    </div>
    <div class="sri-component">
      <div>
        <div class="sri-comp-label">LF/HF Ratio (35% weight)</div>
        <div style="font-size:10px;color:var(--ink4);margin-top:4px">Sympatho-vagal balance</div>
      </div>
      <div class="sri-comp-value">${fmt(sriResult.components.lfhf, 2)}</div>
    </div>
    <div class="sri-component">
      <div>
        <div class="sri-comp-label">HR Recovery (30% weight)</div>
        <div style="font-size:10px;color:var(--ink4);margin-top:4px">Cardiovascular fitness</div>
      </div>
      <div class="sri-comp-value">${fmt(sriResult.components.hrRecovery, 1)}%</div>
    </div>
  </div>
  <div class="note">
    SRI is a composite score (0–100) weighting RMSSD (35%), LF/HF inverse ratio (35%), and HR recovery rate (30%).
    Scores ≥ 75 = Excellent · 55–74 = Good · 35–54 = Fair · 0–34 = Poor.
  </div>
</div>` : ''}

<!-- ── TIME DOMAIN ────────────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Time Domain Analysis</span></div>
  <table class="mt">
    <thead>
      <tr><th>Metric</th><th>Value</th><th>Unit</th><th>Reference Range</th><th>Clinical Note (if abnormal)</th></tr>
    </thead>
    <tbody>
      ${row('Mean RR Interval',      fmt(avgRR),      'ms',  '600–1000 ms',   'HR &lt;60 or &gt;100 bpm may affect HRV interpretation')}
      ${row('Average Heart Rate',    fmt(avgHR, 0),   'bpm', '60–100 bpm',    'Tachycardia or bradycardia alters all HRV indices')}
      ${row('Min HR / Max HR',       fmt(minHR,0)+' / '+fmt(maxHR,0), 'bpm', '—', 'Narrow range: autonomic rigidity; wide: good chronotropic reserve')}
      ${row('SDNN',                  fmt(sdnn),       'ms',  '50–100 ms',     '&lt;50 ms: reduced global HRV; risk marker for CV events')}
      ${row('RMSSD',                 fmt(rmssd),      'ms',  '20–50 ms',      '&lt;20 ms: low vagal activity; associated with increased CV risk')}
      ${row('pNN50',                 fmt(pnn50, 1),   '%',   '&gt;5–15%',     '&lt;5%: significant reduction in parasympathetic modulation')}
      ${row('Total RR Intervals',    rrIntervals.length, '—', '≥300 (5 min)', 'Short recordings reduce reliability of all HRV indices')}
      ${row('Data Quality',          dquality + '%', '—',   '&gt;95%',       'Low quality: excessive artifacts removed; check sensor contact')}
    </tbody>
  </table>
</div>

<!-- ── FREQUENCY DOMAIN ───────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Frequency Domain Analysis</span></div>
  <table class="mt">
    <thead>
      <tr><th>Band / Metric</th><th>Value</th><th>Unit</th><th>Reference Range</th><th>Clinical Note (if abnormal)</th></tr>
    </thead>
    <tbody>
      ${row('VLF Power (0.003–0.04 Hz)', fmt(vlfPow, 1) + ' · ' + pct(vlfPow), 'ms²', '&lt;1500 ms² (5 min)', 'Reduced: HF, sepsis; elevated: sleep apnoea')}
      ${row('LF Power (0.04–0.15 Hz)',   fmt(lfPow,  1) + ' · ' + pct(lfPow),  'ms²', '500–1500 ms²',         'Elevated: stress, hypertension; reduced: autonomic neuropathy')}
      ${row('HF Power (0.15–0.4 Hz)',    fmt(hfPow,  1) + ' · ' + pct(hfPow),  'ms²', '200–800 ms²',          'Reduced: low vagal tone, anxiety, DM, HF; elevated: athletes')}
      ${row('Total Power (VLF+LF+HF)',   fmt(totPow, 1),                        'ms²', '—',                    'Correlates with SDNN²; represents global variability')}
      ${row('LF / HF Ratio',            fmt(lfhfRatio, 2),                     '—',   '1.5–2.0 (rest)',       '&gt;2.5: sympathetic dominance or stress; &lt;0.8: vagal dominance')}
    </tbody>
  </table>
</div>

<!-- ── EVENTS ─────────────────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Recorded Events (${eventMarkers.length})</span></div>
  <table class="ev-table">
    <thead><tr><th>Time (s)</th><th>Event Type</th><th>Annotation</th></tr></thead>
    <tbody>${eventRows}</tbody>
  </table>
</div>

<!-- ── SESSION METADATA ───────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Session Metadata</span></div>
  <table class="ev-table">
    <tbody>
      <tr><th style="width:180px">Session Name</th><td>${sessionName}</td></tr>
      <tr><th>Start Time</th><td>${sessionDate.toLocaleString('en-US',{dateStyle:'full',timeStyle:'medium'})}</td></tr>
      <tr><th>Duration</th><td>${fmtD(duration)}</td></tr>
      <tr><th>Calibration Period</th><td>${CALIBRATION_DURATION / 1000} seconds (excluded from data)</td></tr>
      <tr><th>Raw RR Intervals</th><td>${rawRRIntervals.length.toLocaleString()}</td></tr>
      <tr><th>Valid (Clean) Intervals</th><td>${rrIntervals.length.toLocaleString()} (${dquality}%)</td></tr>
      <tr><th>Artifacts Removed</th><td>${Math.max(0, rawRRIntervals.length - rrIntervals.length).toLocaleString()}</td></tr>
      <tr><th>Tags</th><td>${tagsHtml}</td></tr>
      ${peakHR > 0 ? `<tr><th>Peak Heart Rate</th><td>${peakHR} bpm</td></tr>` : ''}
    </tbody>
  </table>
</div>

<!-- ── REFERENCE RANGES ───────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">SRI Reference Scale</span></div>
  <table class="mt">
    <thead><tr><th>Score Range</th><th>Category</th><th>Autonomic Profile</th><th>Recommended Action</th></tr></thead>
    <tbody>
      <tr style="background:rgba(16,185,129,.06)">
        <td class="vc" style="color:#10b981">75–100</td>
        <td style="font-weight:600;color:#10b981">Excellent Recovery</td>
        <td>Optimal parasympathetic activity, strong vagal tone</td>
        <td>Maintain current protocols; suitable for high-intensity work</td>
      </tr>
      <tr style="background:rgba(34,211,238,.06)">
        <td class="vc" style="color:#22d3ee">55–74</td>
        <td style="font-weight:600;color:#22d3ee">Good Recovery</td>
        <td>Healthy autonomic balance, adequate recovery capacity</td>
        <td>Monitor trends; moderate training load is appropriate</td>
      </tr>
      <tr style="background:rgba(245,158,11,.06)">
        <td class="vc" style="color:#f59e0b">35–54</td>
        <td style="font-weight:600;color:#f59e0b">Fair Recovery</td>
        <td>Moderate sympathetic dominance detected</td>
        <td>Reduce training intensity; prioritise sleep and relaxation techniques</td>
      </tr>
      <tr style="background:rgba(239,68,68,.06)">
        <td class="vc" style="color:#ef4444">0–34</td>
        <td style="font-weight:600;color:#ef4444">Poor Recovery</td>
        <td>Significant autonomic imbalance, high allostatic load</td>
        <td>Rest day recommended; address stress, sleep debt, or illness</td>
      </tr>
    </tbody>
  </table>
</div>

</div><!-- /.rb -->

<!-- ── FOOTER ─────────────────────────────────────────────────────────── -->
<div class="rf">
  <strong>References:</strong>
  Task Force of the ESC/NASPE (1996) <em>Eur Heart J</em> 17:354–381 ·
  Cole CR et al. (1999) <em>NEJM</em> 341:1351–1357 ·
  Bauer A et al. (2006) <em>Lancet</em> 367:1674–1681<br>
  <strong>Disclaimer:</strong> This report is generated automatically by
  <a href="https://github.com/matcasti" target="_blank">CardioTrace</a> for informational and research purposes only.
  Reference ranges are indicative; clinical interpretation requires consideration of protocol, recording duration,
  age, sex, medication, and clinical context. This report does not substitute professional medical judgement.
</div>

</div><!-- /.page -->
</body>
</html>`;

        // ── Open in new tab ──────────────────────────────────────────────────
        const blob = new Blob([html], { type: 'text/html' });
        const url  = URL.createObjectURL(blob);
        const win  = window.open(url, '_blank');
        if (!win) {
            // Popup blocked — fall back to download
            const a = document.createElement('a');
            a.href = url;
            a.download = (sessionName + '_report_' + sessionDate.toISOString().slice(0,10) + '.html');
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
        } else {
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        }

        console.log('✅ HTML report generated: ' + sessionName);

    } catch (err) {
        console.error('Report generation failed:', err);
        alert('Report generation failed. See console for details.');
    } finally {
        reportBtn.disabled = false;
        reportBtn.textContent = '📄 Report';
    }
}

// Export data
function exportData() {
    if (rrIntervals.length === 0 && rawRRIntervals.length === 0) {
        alert('No data to export');
        return;
    }

    const baseFilename = document.getElementById('filename').value || 'polar-h10-data';
    const isTxtFormat = txtToggle.checked;
    const includeRaw = rawDataToggle.checked;

    // Use sessionStartTime instead of startTime
    const sessionDate = new Date(sessionStartTime);
    const dateStr = sessionDate.toISOString().slice(0, 16); // YYYY-MM-DD
    const tagsStr = sessionTags.length > 0 ? '_' + sessionTags.join('-') : '';
    const dataType = includeRaw ? '_raw' : '_clean';
    const filename = `${baseFilename}_${dateStr}${tagsStr}${dataType}`;

    // Calculate actual recorded duration
    const actualDuration = timestamps.length > 0
        ? Math.floor(timestamps[timestamps.length - 1])
        : 0;

    // Select which data to export
    const exportRR = includeRaw ? rawRRIntervals : rrIntervals;
    const exportTimes = includeRaw ? rawTimestamps : timestamps;

    let content = '';
    let mimeType = '';
    let fileExtension = '';

    if (isTxtFormat) {
        // Export as TXT with only RR intervals (one per line)
        for (let i = 0; i < exportRR.length; i++) {
            content += `${exportRR[i].toFixed(3)}\n`;
        }
        mimeType = 'text/plain';
        fileExtension = '.txt';
    } else {
        // Add unified metadata header
        content += generateMetadataHeader({
            filename: baseFilename,
            startTime: calibrationStartTime || sessionStartTime,
            tags: sessionTags,
            rrCount: rrIntervals.length,
            rawRRCount: rawRRIntervals.length,
            eventCount: eventMarkers.length,
            includeRaw: includeRaw
        });

        // Add data header
        content += 'Timestamp (s),RR Interval (ms),Event Type,Annotation\n';

        for (let i = 0; i < exportRR.length; i++) {
            const timestamp = exportTimes[i];
            const rr = exportRR[i];
            const event = eventMarkers.find(e => Math.abs(e.time - timestamp) < 0.5);
            const eventType = event ? event.type || '' : '';
            const annotation = event ? (event.annotation || '').replace(/,/g, ';') : ''; // Escape commas
            content += `${timestamp.toFixed(3)},${rr.toFixed(3)},${eventType},${annotation}\n`;
        }

        mimeType = 'text/csv';
        fileExtension = '.csv';
    }

    // Use robust download function
    const success = downloadFile(content, filename + fileExtension, mimeType);

    if (success) {
        console.log(`Exported ${exportRR.length} RR intervals to ${filename}${fileExtension}`);
    }
}

// Copy to clipboard
async function copyToClipboard() {
    if (rrIntervals.length === 0 && rawRRIntervals.length === 0) {
        alert('No data to copy');
        return;
    }

    const isTxtFormat = txtToggle.checked;
    const includeRaw = rawDataToggle.checked;
    let content = '';

    // Select which data to copy
    const exportRR = includeRaw ? rawRRIntervals : rrIntervals;
    const exportTimes = includeRaw ? rawTimestamps : timestamps;

    if (isTxtFormat) {
        // Copy only RR intervals
        for (let i = 0; i < exportRR.length; i++) {
            content += `${exportRR[i].toFixed(3)}\n`;
        }
    } else {
        // Use sessionStartTime instead of startTime
        const sessionDate = new Date(sessionStartTime);
        const actualDuration = exportTimes.length > 0
            ? Math.floor(exportTimes[exportTimes.length - 1])
            : 0;

        // Copy CSV format with unified metadata
        content = generateMetadataHeader({
            filename: document.getElementById('filename').value || 'polar-h10-data',
            startTime: calibrationStartTime || sessionStartTime,
            tags: sessionTags,
            rrCount: rrIntervals.length,
            rawRRCount: rawRRIntervals.length,
            eventCount: eventMarkers.length,
            includeRaw: includeRaw
        });

        content += 'Timestamp (s),RR Interval (ms),Event Type,Annotation\n';

        for (let i = 0; i < exportRR.length; i++) {
            const timestamp = exportTimes[i];
            const rr = exportRR[i];
            const event = eventMarkers.find(e => Math.abs(e.time - timestamp) < 0.5);
            const eventType = event ? event.type || '' : '';
            const annotation = event ? (event.annotation || '').replace(/,/g, ';') : '';
            content += `${timestamp.toFixed(3)},${rr.toFixed(3)},${eventType},${annotation}\n`;
        }
    }

    try {
        await navigator.clipboard.writeText(content);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.style.background = 'rgba(34, 197, 94, 0.2)';
        setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.background = '';
        }, 2000);
        console.log('✓ Copied to clipboard');
    } catch (err) {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
    }
}

// Initialize on page load
(async () => {
    try {
        loadSettings();
        await initDB();
        await updateHistoryBadge();
        loadTheme();
        initChartPlaceholders();
        applySettings();
        initGrid();

        if (document.getElementById('sriGauge')) {
            drawSRIGauge(0);
            updateSRI();
            initGaugeResponsiveness();
        }

        console.log('✓ App initialized');
    } catch (error) {
        console.error('Initialization failed:', error);
    }
})();

// Initialize chart placeholders
function initChartPlaceholders() {
    const placeholders = [
        { id: 'rollingRMSSDChart', icon: '⏱️', text: 'Chart available after 30 seconds' },
        { id: 'psdChart',          icon: '🌊', text: 'Spectrogram available after 50 RR intervals' },
        { id: 'hrChart',           icon: '💓', text: 'Connect device to see HR data' },
        { id: 'vagalProxyChart',   icon: '🧠', text: 'Chart available after 30 seconds' },
    ];
    placeholders.forEach(({ id, icon, text }) => {
        const el = document.getElementById(id);
        if (el && !el.querySelector('.chart-placeholder')) {
            const ph = document.createElement('div');
            ph.className = 'chart-placeholder';
            ph.innerHTML = `<div class="chart-placeholder-icon">${icon}</div>
                            <div class="chart-placeholder-text">${text}</div>`;
            el.appendChild(ph);
            el.classList.add('chart-blurred');
        }
    });
}
