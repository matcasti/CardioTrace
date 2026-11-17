
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
const CHART_UPDATE_INTERVAL = 100; // ms (default)
// Per-chart refresh budget: BLE delivers ~1 packet/s, slow-moving charts need far fewer redraws
const CHART_INTERVALS = { rr: 750, rmssd: 750, hr: 750, poincare: 3000, vagalProxy: 3000, psd: 100 /* CWT has its own 2 s gate */ };

// ── App Settings ──────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    age: 30,
    calibrationSecs: 8,
    autosaveSecs: 10,
    rmssdWindow: 60,
    artifactThreshold: 300,                  // Δ method: max |RR − previous accepted| (ms)
    artifactMethod: 'delta',                 // live method: 'delta' | 'percent' | 'median' (see ARTIFACT_METHODS)
    artifactPercent: 20,                     // percent method: max deviation (% of previous accepted)
    artifactMedianLevel: 'medium',           // median method: Kubios-style level (MEDIAN_LEVELS)
    artifactRetro: { method: 'lipponen', correction: 'interpolate', percent: 20, deltaMs: 300, level: 'medium', iterative: true },
    visibleCharts: {
        ecg: true, rr: true, rollingRMSSD: true,
        poincare: true, psd: true, hr: true, vagalProxy: true
    },
    showSRI: true,
    exportLight: true,                       // white background on single-plot PNG/SVG downloads
    appearance: { accent: 'indigo', density: 'comfortable', radius: 20, effects: true, motion: true },
    chartPrefs: {},                          // per-plot customisation, keyed by chart key (see CHART_META)
    report: { sections: {}, scale: 4 }       // section switches (missing key = on) and plot resolution
};
let appSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

// Merge a (possibly partial / older) saved object over the defaults, one level deep
function clampNum(v, lo, hi, def) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
function mergeSettings(p) {
    p = (p && typeof p === 'object') ? p : {};
    const m = {
        ...DEFAULT_SETTINGS, ...p,
        visibleCharts: { ...DEFAULT_SETTINGS.visibleCharts, ...(p.visibleCharts || {}) },
        appearance:    { ...DEFAULT_SETTINGS.appearance,    ...(p.appearance    || {}) },
        chartPrefs:    { ...(p.chartPrefs || {}) },
        report:        { scale: 4, ...(p.report || {}), sections: { ...((p.report && p.report.sections) || {}) } }
    };
    // Same ranges as the Settings sliders: a hand-edited or corrupted file cannot break acquisition
    m.age               = Math.round(clampNum(m.age, 10, 100, DEFAULT_SETTINGS.age));
    m.calibrationSecs   = Math.round(clampNum(m.calibrationSecs, 1, 30, DEFAULT_SETTINGS.calibrationSecs));
    m.autosaveSecs      = Math.round(clampNum(m.autosaveSecs, 5, 120, DEFAULT_SETTINGS.autosaveSecs));
    m.rmssdWindow       = Math.round(clampNum(m.rmssdWindow, 30, 300, DEFAULT_SETTINGS.rmssdWindow));
    m.artifactThreshold = clampNum(m.artifactThreshold, 50, 1000, DEFAULT_SETTINGS.artifactThreshold);
    if (!['delta', 'percent', 'median'].includes(m.artifactMethod)) m.artifactMethod = 'delta';
    m.artifactPercent   = clampNum(m.artifactPercent, 5, 50, DEFAULT_SETTINGS.artifactPercent);
    if (!['vlow', 'low', 'medium', 'strong', 'vstrong'].includes(m.artifactMedianLevel)) m.artifactMedianLevel = 'medium';
    const ar = { ...DEFAULT_SETTINGS.artifactRetro, ...((p.artifactRetro && typeof p.artifactRetro === 'object') ? p.artifactRetro : {}) };
    const dr = DEFAULT_SETTINGS.artifactRetro;
    m.artifactRetro = {
        method:     ['delta', 'percent', 'median', 'lipponen'].includes(ar.method) ? ar.method : dr.method,
        correction: ['remove', 'interpolate'].includes(ar.correction) ? ar.correction : dr.correction,
        deltaMs:    clampNum(ar.deltaMs, 50, 1000, dr.deltaMs),
        percent:    clampNum(ar.percent, 5, 50, dr.percent),
        level:      ['vlow', 'low', 'medium', 'strong', 'vstrong'].includes(ar.level) ? ar.level : dr.level,
        iterative:  ar.iterative !== false
    };
    m.report.scale      = clampNum(m.report.scale, 1, 10, 4);
    return m;
}

function loadSettings() {
    try {
        const saved = localStorage.getItem('cardioTraceSettings');
        if (saved) appSettings = mergeSettings(JSON.parse(saved));
    } catch(e) { /* use defaults */ }
}

function saveSettings() {
    try { localStorage.setItem('cardioTraceSettings', JSON.stringify(appSettings)); }
    catch (e) { console.warn('Settings could not be saved (storage full or blocked):', e); }
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
    updateArtifactSettingsSummary();
    // Chart toggles
    ['ecg','rr','rollingRMSSD','poincare','psd','hr','vagalProxy'].forEach(key => {
        const cb = document.getElementById(`show_${key}`);
        if (cb) cb.checked = appSettings.visibleCharts[key] !== false;
    });
    applyChartVisibility();
    applyAppearance();
    syncCustomControls();
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

// Row height follows the container width: 4K / 32:9 get taller rows, phones get compact ones
let _lastCellH = 0;
function applyResponsiveGrid() {
    if (!grid) return;
    const w = document.getElementById('chartsGrid').clientWidth;
    if (!w) return;                                  // hidden tab: measure later
    const narrow = w < 768;                          // GridStack 8 collapses to 1 column below this
    const k = appSettings.appearance && appSettings.appearance.density === 'compact' ? 0.85 : 1;
    const h = Math.round(k * (narrow
        ? Math.min(90, Math.max(56, w * 0.2))
        : Math.min(150, Math.max(56, (w / 12) * 0.5))));
    if (h !== _lastCellH) { _lastCellH = h; grid.cellHeight(h); }
    grid.enableMove(!narrow);                        // no accidental drags while scrolling on phones
    grid.enableResize(!narrow);
}

// Axis titles / margins / fonts adapt to the real width of each chart
const AXIS_TITLES = {
    ecgChart: ['Time (s)', 'Amplitude (µV)'],      rrChart: ['Time (s)', 'RR Interval (ms)'],
    rollingRMSSDChart: ['Time (s)', 'RMSSD (ms)'], poincareChart: ['RR(n) (ms)', 'RR(n+1) (ms)'],
    psdChart: ['Time (s)', 'Frequency (Hz)'],      hrChart: ['Time (s)', 'Heart Rate (bpm)'],
    vagalProxyChart: ['Time (s)', 'RMSSD / SDNN']
};
const _density = {};
function applyChartDensity() {
    ALL_CHART_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el || !el.clientWidth || !el.data) return;   // hidden or not yet plotted
        const w = el.clientWidth;
        const d = w < 300 ? 'tiny' : w < 480 ? 'small' : w >= 900 ? 'wide' : 'normal';
        if (_density[id] === d) return;                   // relayout only when the class changes
        _density[id] = d;
        const full = d === 'normal' || d === 'wide';
        const [xt, yt] = AXIS_TITLES[id];
        Plotly.relayout(id, {
            'xaxis.title.text': full ? xt : '',
            'yaxis.title.text': full ? yt : '',
            'xaxis.automargin': true,
            'yaxis.automargin': true,
            'margin.l': d === 'tiny' ? 30 : d === 'small' ? 40 : 55,
            'margin.r': d === 'tiny' ? 8 : 20,
            'margin.b': full ? 40 : 28,
            'font.size': d === 'tiny' ? 9 : d === 'small' ? 11 : d === 'wide' ? 13 : 12
        });
    });
}

function resizeAllCharts() {
    ALL_CHART_IDS.forEach(id => {
        try { Plotly.Plots.resize(document.getElementById(id)); } catch(e) {}
    });
}

function saveGridLayout() {
    if (grid && grid.getColumn() === 12) {   // never persist the 1-column (mobile) arrangement
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

    applyResponsiveGrid();
    applyChartDensity();
    setTimeout(resizeAllCharts, 150);

    // One observer instead of relying on window 'resize': also catches orientation changes,
    // split-screen, DevTools docking and monitor changes.
    let raf = 0;
    new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            applyResponsiveGrid();
            resizeAllCharts();
            applyChartDensity();
        });
    }).observe(document.getElementById('chartsGrid'));
}
let isConnected = false;
let sessionStartTime = Date.now();
let calibrationStartTime = null;
let timerInterval = null;
let autoSaveInterval = null;
let currentSessionId = null;
let lastCWTResult = null; // Store last CWT calculation for band power reuse
let calibrationTimeout = null; // handle for the calibration setTimeout (cancel on reset/disconnect)
let ecgClockT = null;          // continuous ECG sample clock (s, same reference as RR timestamps)
let signalTimer = null;
let wakeLock = null;
const ECG_FS = 130;
let dataQuality = 100;
let selectedEventType = 'Note';
let currentHR = 0;
let currentSubjectId = null;
let currentSubjectName = 'Anonymous';
let currentSubjectAge = null;
let activeProtocol      = null;
let currentPhaseIdx     = 0;
let phaseTimer          = null;
let phaseSecondsLeft    = 0;
let protocolRunning     = false;
let protocolBannerTimer = null;  // hides the 'Protocol complete' banner
let protocolEditorState = { id: null, name: '', phases: [] };
let analyzeCurrentSubtab  = 'trends';
let comparisonSelectedIds = new Set();
const TRACE_COLORS = [
    '#6366f1','#ec4899','#22d3ee','#f59e0b',
    '#10b981','#f43f5e','#8b5cf6','#06b6d4'
];
let focusMode       = false;
let biofeedbackMode = false;
let biofeedbackTimer = null;
let breathePhase    = 'inhale'; // 'inhale' | 'exhale'
let monitorChannel  = null;
let monitorWin      = null;
let exportSelectedIds = new Set();
let lastPacketTime = Date.now();
let isCalibrating = false;
let calibrationEndTime = null;
let sessionCalibrationSecs = null; // calibration length used by the current recording (s)
let rawRRIntervals = []; // Store all raw data
let rawTimestamps = []; // Store all raw timestamps
const REANCHOR_BEATS = 3;  // artifact filter: consistent beats needed to re-anchor (see rrFilterStep)
let _rrRun = [];          // live: pending run of mutually consistent, Δ-rejected beats [{rr, t}]
let shownSessionId = null;      // stored session displayed in the Record tab (after restore), else null
let shownSessionMeta = null;    // { name, startTime, duration } of that session, for the context banner
let sessionArtifactCfg = null; // artifact filter of the current recording (fixed at connect) / shown session
let sessionImportInfo = null;  // { filename, format } when the shown session was imported from a file
let sessionDeviceInfo = null;  // { name, source } of the current recording / restored session (see describeRRSource)
let _hrPacketsWithoutRR = 0;   // consecutive post-calibration HR packets without RR intervals
let _ecgCheckTimer = null;

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
const historyContent = document.getElementById('historyContent');
const historyBadge = document.getElementById('historyBadge');
const historySearch = document.getElementById('historySearch');
const tagFilter = document.getElementById('tagFilter');
const sortFilter = document.getElementById('sortFilter');
const clearAllBtn = document.getElementById('clearAllBtn');
const historyTableBody = document.getElementById('historyTableBody');
const tabCards = document.getElementById('tabCards');
const tabTable = document.getElementById('tabTable');
let currentHistoryView = 'cards'; // 'cards' | 'table'
let historySelectedIds = new Set();  // rows ticked in the History table (bulk download / re-clean / delete)
let currentTab = 'record';

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('is-active', panel.id === `tab-${tabId}`);
    });
    currentTab = tabId;
    if (tabId === 'history')  renderHistory();
    if (tabId === 'subjects') renderSubjects();
    if (tabId === 'analyze')  renderAnalyzeTab();
    if (tabId === 'export')   renderExportTab();
    if (tabId === 'record') {
        // Plotly cannot measure display:none containers — resize + catch-up once visible again
        requestAnimationFrame(() => {
            applyResponsiveGrid();
            resizeAllCharts();
            applyChartDensity();
            refreshAllCharts();
        });
    }
}
const bulkDownloadBtn = document.getElementById('bulkDownloadBtn');
const bulkFormatSelect = document.getElementById('bulkFormatSelect');

// Event type elements
const eventTypePanel = document.getElementById('eventTypePanel');
const eventTypeOverlay = document.getElementById('eventTypeOverlay');
const eventTypeClose = document.getElementById('eventTypeClose');
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
const DB_VERSION = 6;
const STORE_NAME = 'sessions';
const SUBJECTS_STORE = 'subjects';

const BUILTIN_PROTOCOLS = [
    {
        id: 'builtin-1', name: '5-min Resting Baseline', isBuiltIn: true,
        phases: [{ name: 'Rest', durationSecs: 300, autoMark: true }]
    },
    {
        id: 'builtin-2', name: 'Short HRV Assessment', isBuiltIn: true,
        phases: [
            { name: 'Baseline rest',    durationSecs: 120, autoMark: true },
            { name: 'Paced breathing',  durationSecs: 180, autoMark: true },
            { name: 'Recovery',         durationSecs: 120, autoMark: true }
        ]
    },
    {
        id: 'builtin-3', name: 'Orthostatic Test', isBuiltIn: true,
        phases: [
            { name: 'Supine baseline',  durationSecs: 300, autoMark: true },
            { name: 'Standing',         durationSecs: 180, autoMark: true },
            { name: 'Recovery',         durationSecs: 300, autoMark: true }
        ]
    },
    {
        id: 'builtin-4', name: 'TMST (5-2-5)', isBuiltIn: true,
        phases: [
            { name: 'Pre-exercise baseline', durationSecs: 300, autoMark: true },
            { name: 'Exercise',              durationSecs: 120, autoMark: true },
            { name: 'Recovery',              durationSecs: 300, autoMark: true }
        ]
    }
];

// Initialize IndexedDB
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onblocked = () => notify('CardioTrace is open in another tab with an older version. Close the other tabs to finish updating the session database.', 'warn', { persist: true });
        request.onsuccess = () => {
            db = request.result;
            db.onversionchange = () => { db.close(); db = null; notify('CardioTrace was updated in another tab. Reload this page to keep saving sessions.', 'warn', { persist: true }); };
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

            if (oldVersion < 4) {
                console.log('📊 Migrating database to version 4 (adding SRI support)...');
            }

            if (oldVersion < 5) {
                console.log('👤 Migrating database to version 5 (adding subjects store)...');
                if (!db.objectStoreNames.contains(SUBJECTS_STORE)) {
                    const subjectsStore = db.createObjectStore(SUBJECTS_STORE, { keyPath: 'id', autoIncrement: true });
                    subjectsStore.createIndex('name', 'name', { unique: false });
                    subjectsStore.createIndex('createdAt', 'createdAt', { unique: false });
                }
            }

            if (oldVersion < 6) {
                console.log('🔬 Migrating database to version 6 (adding protocols store)...');
                if (!db.objectStoreNames.contains('protocols')) {
                    const protoStore = db.createObjectStore('protocols', { keyPath: 'id', autoIncrement: true });
                    protoStore.createIndex('name', 'name', { unique: false });
                }
            }
        };
    });
}

// Theme: 'dark' | 'light' | 'auto' (follows the OS). Stored under localStorage 'theme'.
function getThemeMode() { return localStorage.getItem('theme') || 'dark'; }
function applyThemeMode(mode) {
    const eff = mode === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : mode;
    if (eff === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
}
function setThemeMode(mode) {
    localStorage.setItem('theme', mode);
    applyThemeMode(mode);
    updateChartThemes();
    syncCustomControls();
}
function toggleTheme() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    setThemeMode(isLight ? 'dark' : 'light');
}
function loadTheme() {
    applyThemeMode(getThemeMode());
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (getThemeMode() === 'auto') { applyThemeMode('auto'); updateChartThemes(); }
    });
}

// ── Subject helpers ───────────────────────────────────────

function getEffectiveAge() {
    return (currentSubjectAge !== null && currentSubjectAge > 0)
        ? currentSubjectAge
        : (appSettings.age || 30);
}

function requireDB() {
    if (db) return true;
    notify('This needs the session database (IndexedDB), which is not available in this browser.', 'error');
    return false;
}

async function saveSubject(subjectData, subjectId = null) {
    if (!db) throw new Error('IndexedDB not available');
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SUBJECTS_STORE], 'readwrite');
        const store = transaction.objectStore(SUBJECTS_STORE);
        const subject = {
            name: subjectData.name,
            age: parseInt(subjectData.age) || 30,
            createdAt: subjectData.createdAt || new Date().toISOString(),
            notes: subjectData.notes || ''
        };
        if (subjectId) {
            subject.id = subjectId;
            const req = store.put(subject);
            req.onsuccess = () => resolve(subjectId);
            req.onerror = () => reject(req.error);
        } else {
            const req = store.add(subject);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }
    });
}

async function loadSubjects() {
    if (!db) return [];
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SUBJECTS_STORE], 'readonly');
        const store = transaction.objectStore(SUBJECTS_STORE);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function loadSubject(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SUBJECTS_STORE], 'readonly');
        const store = transaction.objectStore(SUBJECTS_STORE);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function deleteSubject(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SUBJECTS_STORE], 'readwrite');
        const store = transaction.objectStore(SUBJECTS_STORE);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ── Subject UI ────────────────────────────────────────────

function updateSubjectChipDisplay() {
    const nameEl = document.getElementById('currentSubjectName');
    const ageEl  = document.getElementById('currentSubjectAgeTag');
    if (nameEl) nameEl.textContent = currentSubjectName;
    if (ageEl) {
        if (currentSubjectAge) {
            ageEl.textContent = `· ${currentSubjectAge} yrs`;
            ageEl.style.display = '';
        } else {
            ageEl.textContent = '';
            ageEl.style.display = 'none';
        }
    }
}

function selectSubject(id, name, age) {
    currentSubjectId   = id;
    currentSubjectName = name || 'Anonymous';
    currentSubjectAge  = age || null;
    updateSubjectChipDisplay();
    closeSubjectPicker();
    if (currentHR > 0) updateHRZone(currentHR);
    if (rrIntervals.length > 0) updateHRChart();
}

function openSubjectPicker() {
    renderSubjectPickerList();
    document.getElementById('subjectPickerPanel').classList.add('active');
    document.getElementById('subjectPickerOverlay').classList.add('active');
}

function closeSubjectPicker() {
    document.getElementById('subjectPickerPanel').classList.remove('active');
    document.getElementById('subjectPickerOverlay').classList.remove('active');
}

async function renderSubjectPickerList() {
    const subjects = await loadSubjects();
    const list = document.getElementById('subjectPickerList');
    if (!list) return;

    const anonSelected = currentSubjectId === null;
    let html = `
        <div class="subject-option ${anonSelected ? 'selected' : ''}" data-sid="">
            <div class="subject-option-icon">👤</div>
            <div class="subject-option-info">
                <div class="subject-option-name">Anonymous</div>
                <div class="subject-option-sub">No subject assigned</div>
            </div>
            ${anonSelected ? '<div class="subject-option-check">✓</div>' : ''}
        </div>
    `;

    subjects.sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
        const isSel = currentSubjectId === s.id;
        html += `
            <div class="subject-option ${isSel ? 'selected' : ''}" data-sid="${s.id}">
                <div class="subject-option-icon" style="background:rgba(99,102,241,0.15);color:var(--accent-primary);font-weight:800;font-size:15px;">
                    ${escapeHTML(s.name.charAt(0).toUpperCase())}
                </div>
                <div class="subject-option-info">
                    <div class="subject-option-name">${escapeHTML(s.name)}</div>
                    <div class="subject-option-sub">${s.age} yrs</div>
                </div>
                ${isSel ? '<div class="subject-option-check">✓</div>' : ''}
            </div>
        `;
    });

    list.innerHTML = html;
    const byId = new Map(subjects.map(s => [String(s.id), s]));
    list.querySelectorAll('.subject-option').forEach(el => el.addEventListener('click', () => {
        const s = byId.get(el.dataset.sid);
        if (s) selectSubject(s.id, s.name, s.age); else selectSubject(null, 'Anonymous', null);
    }));
}

async function addAndSelectSubject() {
    const name = document.getElementById('newSubjectName').value.trim();
    const age  = parseInt(document.getElementById('newSubjectAge').value) || 30;
    if (!name) { notify('Enter a subject name first.', 'warn'); return; }
    if (!requireDB()) return;

    const id = await saveSubject({ name, age, createdAt: new Date().toISOString() });
    document.getElementById('newSubjectName').value = '';
    document.getElementById('newSubjectAge').value  = '';

    selectSubject(id, name, age);
    if (currentTab === 'subjects') renderSubjects();
    await updateHistoryBadge();
}

function openAddSubjectForm() {
    openSubjectPicker();
    setTimeout(() => {
        const el = document.getElementById('newSubjectName');
        if (el) el.focus();
    }, 150);
}

async function openSubjectEdit(id) {
    const subject = await loadSubject(id);
    if (!subject) return;
    document.getElementById('editSubjectId').value   = id;
    document.getElementById('editSubjectName').value = subject.name;
    document.getElementById('editSubjectAge').value  = subject.age;
    document.getElementById('subjectEditPanel').classList.add('active');
    document.getElementById('subjectEditOverlay').classList.add('active');
}

function closeSubjectEdit() {
    document.getElementById('subjectEditPanel').classList.remove('active');
    document.getElementById('subjectEditOverlay').classList.remove('active');
}

async function saveSubjectEdit() {
    const id   = parseInt(document.getElementById('editSubjectId').value);
    const name = document.getElementById('editSubjectName').value.trim();
    const age  = parseInt(document.getElementById('editSubjectAge').value) || 30;
    if (!name) return;
    const prev = await loadSubject(id);                 // keep createdAt / notes
    await saveSubject({ ...(prev || {}), name, age }, id);
    if (currentSubjectId === id) {
        currentSubjectName = name;
        currentSubjectAge  = age;
        updateSubjectChipDisplay();
    }
    closeSubjectEdit();
    await renderSubjects();
}

async function confirmDeleteSubject(id) {
    const subject  = await loadSubject(id);
    const sessions = await loadSessions();
    const count    = sessions.filter(s => s.subjectId === id).length;
    const msg = count > 0
        ? `Delete "${subject.name}"? This subject has ${count} session(s). Sessions will remain but be unassigned.`
        : `Delete "${subject.name}"?`;
    if (!confirm(msg)) return;
    if (currentSubjectId === id) selectSubject(null, 'Anonymous', null);
    await deleteSubject(id);
    // Unassign (the name is kept as a label); otherwise they vanish from every subject filter
    for (const s of sessions.filter(x => x.subjectId === id)) await updateSession(s.id, { subjectId: null });
    await renderSubjects();
    await updateHistoryBadge();
}

async function renderSubjects() {
    const content = document.getElementById('subjectsContent');
    if (!content) return;
    try {
        const [subjects, sessions] = await Promise.all([loadSubjects(), loadSessions()]);

        const countEl = document.getElementById('subjectsCount');
        if (countEl) countEl.textContent = `${subjects.length} subject${subjects.length !== 1 ? 's' : ''}`;

        if (subjects.length === 0) {
            content.innerHTML = `
                <div class="history-empty" style="grid-column: 1 / -1;">
                    <span class="empty-icon">👤</span>
                    <p>No subjects added yet.<br>Click <strong>+ Add Subject</strong> to get started.</p>
                </div>`;
            return;
        }

        content.innerHTML = subjects.sort((a, b) => a.name.localeCompare(b.name)).map(s => {
            const ss      = sessions.filter(x => x.subjectId === s.id);
            const sriVals = ss.map(x => sessionSRI(x).score).filter(v => v > 0);
            const avgSRI  = sriVals.length ? Math.round(sriVals.reduce((a,b)=>a+b,0)/sriVals.length) : 0;
            const rmssdVals = ss.map(x => sessionMetrics(x)?.rmssd).filter(v => v > 0);
            const avgRMSSD  = rmssdVals.length ? (rmssdVals.reduce((a,b)=>a+b,0)/rmssdVals.length).toFixed(1) : null;
            const last      = ss.sort((a,b) => b.timestamp - a.timestamp)[0];
            const sriCls    = avgSRI >= 75 ? 'sri-excellent' : avgSRI >= 55 ? 'sri-good' : avgSRI >= 35 ? 'sri-fair' : avgSRI > 0 ? 'sri-poor' : '';
            const isActive  = currentSubjectId === s.id;
            return `
            <div class="subject-card ${isActive ? 'subject-card--active' : ''}">
                <div class="subject-card-header">
                    <div class="subject-card-identity">
                        <div class="subject-card-avatar">${escapeHTML(s.name.charAt(0).toUpperCase())}</div>
                        <div>
                            <div class="subject-card-name">${escapeHTML(s.name)}</div>
                            <div class="subject-card-meta">${s.age} yrs · ${ss.length} session${ss.length!==1?'s':''}</div>
                        </div>
                    </div>
                    <div class="subject-card-actions">
                        <button class="session-action-btn" onclick="openSubjectEdit(${s.id})" title="Edit">✏️</button>
                        <button class="session-action-btn delete" onclick="confirmDeleteSubject(${s.id})" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="subject-card-stats">
                    <div class="session-stat">
                        <div class="session-stat-label">Sessions</div>
                        <div class="session-stat-value">${ss.length}</div>
                    </div>
                    <div class="session-stat sri-el">
                        <div class="session-stat-label">Avg SRI</div>
                        <div class="session-stat-value ${sriCls}">${avgSRI > 0 ? avgSRI : '--'}</div>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-label">Avg RMSSD</div>
                        <div class="session-stat-value">${avgRMSSD ? avgRMSSD : '--'}<span class="session-stat-unit">${avgRMSSD?'ms':''}</span></div>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-label">Last</div>
                        <div class="session-stat-value" style="font-size:0.65em;line-height:1.2">${last ? formatDate(last.date) : '--'}</div>
                    </div>
                </div>
                <button class="btn subject-select-btn ${isActive ? 'btn-active-subject' : 'btn-secondary'}"
                        data-sid="${s.id}">
                    ${isActive ? '● Active Subject' : 'Set as Active Subject'}
                </button>
            </div>`;
        }).join('');
        const byId = new Map(subjects.map(s => [String(s.id), s]));
        content.querySelectorAll('.subject-select-btn').forEach(btn => btn.addEventListener('click', () => {
            const s = byId.get(btn.dataset.sid);
            if (s) { selectSubject(s.id, s.name, s.age); renderSubjects(); }
        }));
    } catch(e) {
        console.error('renderSubjects failed:', e);
    }
}

// ══════════════════════════════════════════════════════════
//  SPRINT 5 — Recording Modes
// ══════════════════════════════════════════════════════════

// ── Mode bar availability ─────────────────────────────────
function updateModesAvailability() {
    const bar = document.getElementById('recordModeBar');
    if (!bar) return;
    const recording = isConnected && !!calibrationStartTime && !isCalibrating;
    updateProtocolControls();
    bar.style.display = recording ? '' : 'none';
    if (!recording) {
        exitFocusMode();
        exitBiofeedbackMode();
    }
}

// ── Focus mode ────────────────────────────────────────────
function enterFocusMode() {
    focusMode = true;
    controlsPanel.classList.add('focus-hidden');
    document.getElementById('chartsGrid').classList.add('focus-hidden');
    document.getElementById('focusModeBtn').classList.add('active');
    document.body.classList.add('focus-mode-active');
}

function exitFocusMode() {
    if (!focusMode) return;
    focusMode = false;
    controlsPanel.classList.remove('focus-hidden');
    document.getElementById('chartsGrid').classList.remove('focus-hidden');
    document.getElementById('focusModeBtn').classList.remove('active');
    document.body.classList.remove('focus-mode-active');
}

function toggleFocusMode() {
    focusMode ? exitFocusMode() : enterFocusMode();
}

// ── Biofeedback mode ──────────────────────────────────────
function enterBiofeedbackMode() {
    biofeedbackMode = true;
    document.getElementById('biofeedbackOverlay').style.display = 'flex';
    document.getElementById('biofeedbackModeBtn').classList.add('active');
    const nameEl = document.getElementById('biofeedbackSubjectName');
    if (nameEl) nameEl.textContent = currentSubjectName !== 'Anonymous' ? currentSubjectName : '';
    startBreathingCue();
    updateBiofeedbackDisplay();
}

function exitBiofeedbackMode() {
    if (!biofeedbackMode) return;
    biofeedbackMode = false;
    document.getElementById('biofeedbackOverlay').style.display = 'none';
    document.getElementById('biofeedbackModeBtn').classList.remove('active');
    stopBreathingCue();
}

function toggleBiofeedbackMode() {
    biofeedbackMode ? exitBiofeedbackMode() : enterBiofeedbackMode();
}

function startBreathingCue() {
    stopBreathingCue();
    breathePhase = 'inhale';
    renderBreatheCue();
    biofeedbackTimer = setInterval(() => {
        breathePhase = breathePhase === 'inhale' ? 'exhale' : 'inhale';
        renderBreatheCue();
    }, 5000);
}

function stopBreathingCue() {
    if (biofeedbackTimer) { clearInterval(biofeedbackTimer); biofeedbackTimer = null; }
}

function renderBreatheCue() {
    const textEl = document.getElementById('biofeedbackBreatheText');
    const subEl  = document.getElementById('biofeedbackBreatheSub');
    if (!textEl) return;
    if (breathePhase === 'inhale') {
        textEl.textContent = '↑ Inhale';
        textEl.style.color = '#22d3ee';
        if (subEl) subEl.textContent = 'through the nose · 5 seconds';
    } else {
        textEl.textContent = '↓ Exhale';
        textEl.style.color = '#8b5cf6';
        if (subEl) subEl.textContent = 'slowly through the mouth · 5 seconds';
    }
}

function updateBiofeedbackDisplay() {
    if (!biofeedbackMode) return;
    const hrEl    = document.getElementById('biofeedbackHR');
    const rmssdEl = document.getElementById('biofeedbackRMSSD');
    const sriEl   = document.getElementById('biofeedbackSRI');
    const zoneEl  = document.getElementById('biofeedbackZone');
    const ringEl  = document.getElementById('biofeedbackRing');

    if (hrEl)    hrEl.textContent    = currentHR > 0 ? currentHR : '--';
    if (rmssdEl) rmssdEl.textContent = parseFloat(rmssdValue.textContent) > 0
        ? parseFloat(rmssdValue.textContent).toFixed(1) : '--';
    const sriOn = appSettings.showSRI !== false;
    const lblEl = document.querySelector('.biofeedback-sri-label');
    if (lblEl) lblEl.textContent = sriOn ? 'SRI' : 'RMSSD';
    if (sriEl)   sriEl.textContent   = sriOn ? (sriScore > 0 ? sriScore : '--') : (rmssdEl ? rmssdEl.textContent : '--');
    if (zoneEl)  zoneEl.textContent  = hrZoneText.textContent || '—';

    // Tint ring and SRI score based on current SRI
    if (sriOn && sriScore > 0 && ringEl) {
        const c = sriScore >= 75 ? '#10b981'
                : sriScore >= 55 ? '#22d3ee'
                : sriScore >= 35 ? '#f59e0b'
                : '#ef4444';
        ringEl.style.borderColor = c;
        ringEl.style.boxShadow   = `0 0 60px ${c}30, inset 0 0 40px ${c}08`;
    }
}

// ── Monitor window (subject-facing popup) ─────────────────
function openMonitorWindow() {
    if (monitorWin && !monitorWin.closed) { monitorWin.close(); }

    const html = generateMonitorHTML();
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    monitorWin = window.open(url, 'CardioTrace_Monitor',
        'width=480,height=680,toolbar=no,menubar=no,scrollbars=no,resizable=yes,location=no');

    if (!monitorWin) {
        notify('Popup blocked — allow popups for this site and try again.', 'warn');
        URL.revokeObjectURL(url);
        return;
    }

    if (monitorChannel) monitorChannel.close();
    monitorChannel = new BroadcastChannel('cardiotrace-monitor');
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    setTimeout(() => broadcastMonitorUpdate(), 600);

    document.getElementById('monitorWindowBtn').classList.add('active');
    monitorWin.addEventListener('beforeunload', () => {
        document.getElementById('monitorWindowBtn').classList.remove('active');
        if (monitorChannel) { monitorChannel.close(); monitorChannel = null; }
        monitorWin = null;
    });
}

function broadcastMonitorUpdate() {
    if (!monitorChannel) return;
    const rmssd = parseFloat(rmssdValue.textContent) || 0;
    monitorChannel.postMessage({
        hr:          currentHR,
        sri:         sriScore,
        rmssd,
        zone:        hrZoneText.textContent || '',
        subjectName: currentSubjectName,
        isConnected,
        isCalibrating,
        showSRI: appSettings.showSRI !== false
    });
}

function generateMonitorHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CardioTrace — Subject Monitor</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#070d1a;--card:#111827;--text:#f1f5f9;--sub:#64748b;
  --accent:#6366f1;--teal:#22d3ee;--success:#10b981;--warn:#f59e0b;--danger:#ef4444}
body{background:var(--bg);color:var(--text);
  font-family:'Inter',system-ui,sans-serif;
  min-height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  padding:32px 24px;gap:24px;overflow:hidden;
  background-image:radial-gradient(ellipse at 50% 30%,rgba(99,102,241,.08) 0%,transparent 60%)}
.subject-label{font-size:11px;font-weight:700;letter-spacing:3px;
  text-transform:uppercase;color:var(--sub);min-height:16px;text-align:center}
.sri-block{display:flex;flex-direction:column;align-items:center;gap:10px}
.sri-score{font-size:clamp(80px,20vw,120px);font-weight:900;letter-spacing:-4px;
  line-height:1;transition:color .6s ease;color:var(--teal)}
.sri-tag{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--sub)}
.sri-status-pill{padding:6px 20px;border-radius:20px;font-size:13px;font-weight:600;
  background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.25);color:var(--accent);
  transition:all .5s ease;text-align:center}
.metrics{display:flex;gap:12px;width:100%;max-width:420px}
.metric{flex:1;background:var(--card);border-radius:14px;padding:16px 12px;
  text-align:center;border:1px solid rgba(255,255,255,.06)}
.metric-label{font-size:9px;font-weight:700;text-transform:uppercase;
  letter-spacing:1.5px;color:var(--sub);margin-bottom:8px}
.metric-value{font-size:clamp(28px,8vw,42px);font-weight:900;letter-spacing:-1px;line-height:1}
.metric-unit{font-size:10px;color:var(--sub);margin-top:4px}
.zone-pill{font-size:10px;font-weight:700;padding:3px 10px;border-radius:6px;
  background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.2);color:var(--teal);
  margin-top:6px;display:inline-block}
.status-row{display:flex;align-items:center;gap:7px;
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--sub)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--teal);flex-shrink:0}
.recording .dot{animation:pulse 2s ease-in-out infinite}
.calibrating .dot{background:var(--warn)}
.calibrating .dot{animation:pulse 1s ease-in-out infinite}
.disconnected .dot{background:#374151;animation:none}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.9)}}
</style>
</head>
<body>
<div class="subject-label" id="subjectEl"></div>
<div class="sri-block">
  <div class="sri-score" id="sriEl">--</div>
  <div class="sri-tag">Stress Recovery Index</div>
  <div class="sri-status-pill" id="sriStatusEl">Waiting for data</div>
</div>
<div class="metrics">
  <div class="metric">
    <div class="metric-label">Heart Rate</div>
    <div class="metric-value" id="hrEl" style="color:#f43f5e">--</div>
    <div class="metric-unit">bpm</div>
    <div id="zoneEl" class="zone-pill" style="display:none"></div>
  </div>
  <div class="metric">
    <div class="metric-label">RMSSD</div>
    <div class="metric-value" id="rmssdEl" style="color:#22d3ee">--</div>
    <div class="metric-unit">ms</div>
  </div>
</div>
<div class="status-row disconnected" id="statusRow">
  <div class="dot"></div><span id="statusText">Waiting for connection…</span>
</div>
<script>
const bc=new BroadcastChannel('cardiotrace-monitor');
const COLORS={excellent:'#10b981',good:'#22d3ee',fair:'#f59e0b',poor:'#ef4444'};
function getSRIClass(s){return s>=75?'excellent':s>=55?'good':s>=35?'fair':s>0?'poor':'';}
function getSRILabel(s){return s>=75?'Excellent Recovery':s>=55?'Good Recovery':s>=35?'Fair Recovery':s>0?'Poor Recovery':'Waiting for data';}
bc.onmessage=(e)=>{
  const d=e.data;
  document.getElementById('subjectEl').textContent=d.subjectName&&d.subjectName!=='Anonymous'?d.subjectName:'';
  document.getElementById('hrEl').textContent=d.hr>0?d.hr:'--';
  document.getElementById('rmssdEl').textContent=d.rmssd>0?d.rmssd.toFixed(1):'--';
  const ze=document.getElementById('zoneEl');
  if(d.zone){ze.textContent=d.zone;ze.style.display='';}
  const sb=document.querySelector('.sri-block'); if(sb) sb.style.display=d.showSRI===false?'none':'';
  const score=d.sri||0;
  const cls=getSRIClass(score);
  const sriEl=document.getElementById('sriEl');
  sriEl.textContent=score>0?score:'--';
  sriEl.style.color=cls?COLORS[cls]:'var(--teal)';
  const pill=document.getElementById('sriStatusEl');
  pill.textContent=getSRILabel(score);
  if(cls){pill.style.background=COLORS[cls]+'1a';pill.style.borderColor=COLORS[cls]+'44';pill.style.color=COLORS[cls];}
  const row=document.getElementById('statusRow');
  const txt=document.getElementById('statusText');
  if(d.isCalibrating){row.className='status-row calibrating';txt.textContent='Calibrating…';}
  else if(d.isConnected){row.className='status-row recording';txt.textContent='Recording';}
  else{row.className='status-row disconnected';txt.textContent='Disconnected';}
};
window.addEventListener('beforeunload',()=>bc.close());
</script>
</body>
</html>`;
}

// ── Shared metric computation ─────────────────────────────
// Recomputes time-domain HRV metrics from full RR array at
// export time — more complete than the stored 60-sec window.
function computeSessionMetrics(session) {
    const rr = session.rrIntervals || [];
    const n  = rr.length;
    if (n === 0) return null;

    const mean_rr = rr.reduce((a, b) => a + b, 0) / n;
    // SDNN: sample standard deviation (n - 1), as in Kubios HRV and NeuroKit2
    const sdnn    = n > 1 ? Math.sqrt(rr.reduce((s, v) => s + (v - mean_rr) ** 2, 0) / (n - 1)) : 0;

    let rmssd = 0, nn50 = 0;
    if (n > 1) {
        let sqSum = 0;
        for (let i = 1; i < n; i++) {
            const d = rr[i] - rr[i - 1];
            sqSum += d * d;
            if (Math.abs(d) > 50) nn50++;
        }
        rmssd = Math.sqrt(sqSum / (n - 1));
    }

    const pnn50   = n > 1 ? (nn50 / (n - 1)) * 100 : 0;
    const hrVals  = rr.map(r => 60000 / r);
    const mean_hr = hrVals.reduce((a, b) => a + b, 0) / hrVals.length;
    const min_hr  = hrVals.reduce((a, b) => Math.min(a, b), Infinity);   // no spread: long sessions overflow the stack
    const rawN    = (session.rawRRIntervals || []).length || n;
    const dq      = rawN > 0 ? parseFloat((n / rawN * 100).toFixed(1)) : 100;

    return { mean_rr, sdnn, rmssd, pnn50, mean_hr, min_hr, dq, n, rawN };
}

// Whole-recording metrics of a stored session, cached (lists re-read every session from IndexedDB).
// stats.avgRR / stats.rmssd are only the last minute before the save: never use them to compare sessions.
const _metricsCache = new Map();
function sessionMetrics(s) {
    const key = `${s.id}:${(s.rrIntervals || []).length}:${(s.rawRRIntervals || []).length}:${s.artifactFilter?.appliedAt || ''}`;
    if (!_metricsCache.has(key)) {
        if (_metricsCache.size > 500) _metricsCache.clear();
        _metricsCache.set(key, computeSessionMetrics(s));
    }
    return _metricsCache.get(key);
}

function sriClassOf(v) { return v >= 75 ? 'sri-excellent' : v >= 55 ? 'sri-good' : v >= 35 ? 'sri-fair' : v > 0 ? 'sri-poor' : ''; }
// SRI and LF/HF of a stored session: the saved values, or computed once from its clean series (cached)
const _sriCache = new Map();
function sessionSRI(s) {
    if (s.sri > 0) return { score: s.sri, lfhf: s.sriComponents?.lfhf || null };
    const key = `${s.id}:${(s.rrIntervals || []).length}:${s.artifactFilter?.appliedAt || ''}`;
    if (!_sriCache.has(key)) {
        if (_sriCache.size > 500) _sriCache.clear();
        const r = (s.rrIntervals || []).length >= 50 ? calculateSRI(s.rrIntervals, s.timestamps) : null;
        _sriCache.set(key, r ? { score: r.score, lfhf: r.components.lfhf } : { score: null, lfhf: null });
    }
    return _sriCache.get(key);
}

// ── Filter helpers ────────────────────────────────────────
async function getExportFilteredSessions() {
    const sessions   = await loadSessions();
    const subjectVal = document.getElementById('exportSubjectFilter')?.value || '';
    const tagVal     = document.getElementById('exportTagFilter')?.value || '';
    const sortVal    = document.getElementById('exportSortFilter')?.value || 'newest';

    let filtered = sessions.filter(s => {
        const matchSub = !subjectVal ||
            (subjectVal === 'anonymous' ? !s.subjectId : String(s.subjectId) === subjectVal);
        const matchTag = !tagVal || (s.tags || []).includes(tagVal);
        return matchSub && matchTag;
    });

    filtered.sort((a, b) => {
        if (sortVal === 'oldest')   return a.timestamp - b.timestamp;
        if (sortVal === 'longest')  return b.duration  - a.duration;
        if (sortVal === 'shortest') return a.duration  - b.duration;
        return b.timestamp - a.timestamp;
    });

    return filtered;
}

async function updateExportFilters() {
    const [sessions, subjects] = await Promise.all([loadSessions(), loadSubjects()]);

    const subEl = document.getElementById('exportSubjectFilter');
    const tagEl = document.getElementById('exportTagFilter');
    if (!subEl || !tagEl) return;

    const prevSub = subEl.value;
    const prevTag = tagEl.value;

    subEl.innerHTML = '<option value="">All Subjects</option><option value="anonymous">Anonymous</option>' +
        subjects.sort((a, b) => a.name.localeCompare(b.name))
            .map(s => `<option value="${s.id}">${escapeHTML(s.name)}</option>`).join('');

    const allTags = new Set();
    sessions.forEach(s => (s.tags || []).forEach(t => allTags.add(t)));
    tagEl.innerHTML = '<option value="">All Tags</option>' +
        Array.from(allTags).sort().map(t => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`).join('');

    subEl.value = prevSub;
    tagEl.value = prevTag;
}

// ── Tab render ────────────────────────────────────────────
async function renderExportTab() {
    await updateExportFilters();
    const existing = new Set((await loadSessions()).map(s => s.id));
    [...exportSelectedIds].forEach(id => { if (!existing.has(id)) exportSelectedIds.delete(id); });

    const filtered = await getExportFilteredSessions();
    const list     = document.getElementById('exportSessionList');
    if (!list) return;

    if (filtered.length === 0) {
        list.innerHTML = `<div class="history-empty" style="padding:60px 20px;">
            <span class="empty-icon">💾</span><p>No sessions found</p></div>`;
        updateExportSelectionUI();
        return;
    }

    const rows = filtered.map(s => {
        const isSel    = exportSelectedIds.has(s.id);
        const sriVal   = sessionSRI(s).score;
        const sriClass = sriClassOf(sriVal);
        const tags     = (s.tags || []).map(t => `<span class="session-tag">${escapeHTML(t)}</span>`).join('');
        const subHtml  = s.subjectName && s.subjectName !== 'Anonymous'
            ? `<span class="session-subject-chip" style="font-size:11px;">👤 ${escapeHTML(s.subjectName)}</span>`
            : `<span style="color:var(--text-tertiary)">—</span>`;

        return `
        <tr class="export-session-row ${isSel ? 'is-selected' : ''}" data-id="${s.id}">
            <td class="export-col-check">
                <input type="checkbox" class="export-row-check" data-id="${s.id}" ${isSel ? 'checked' : ''}>
            </td>
            <td class="export-col-name">
                <div class="export-session-name">${escapeHTML(s.filename || 'polar-h10-data')}</div>
                ${s.protocolName ? `<span class="export-proto-tag">🔬 ${escapeHTML(s.protocolName)}</span>` : ''}
            </td>
            <td class="export-col-subject">${subHtml}</td>
            <td class="export-col-date">${formatDate(s.startTime || s.date)}</td>
            <td>${formatDuration(s.duration)}</td>
            <td class="export-col-num">${s.stats?.samples || s.rrIntervals?.length || '—'}</td>
            <td class="export-col-num">${sessionMetrics(s)?.rmssd ? sessionMetrics(s).rmssd.toFixed(1) : '—'}</td>
            <td class="export-col-num sri-el ${sriClass}" style="font-weight:700;">${sriVal > 0 ? sriVal : '—'}</td>
            <td>${tags || '<span style="color:var(--text-tertiary)">—</span>'}</td>
        </tr>`;
    }).join('');

    list.innerHTML = `
    <table class="export-session-table">
        <thead>
            <tr>
                <th class="export-col-check"><input type="checkbox" id="exportCheckAll" title="Select all listed sessions"
                    ${filtered.length && filtered.every(s => exportSelectedIds.has(s.id)) ? 'checked' : ''}></th>
                <th>Session · Protocol</th>
                <th>Subject</th>
                <th>Date</th>
                <th>Duration</th>
                <th>Samples</th>
                <th>RMSSD</th>
                <th class="sri-el">SRI</th>
                <th>Tags</th>
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>`;

    document.getElementById('exportCheckAll')?.addEventListener('change', e => {
        filtered.forEach(s => e.target.checked ? exportSelectedIds.add(s.id) : exportSelectedIds.delete(s.id));
        renderExportTab();
    });
    // Checkbox bindings — toggle without full re-render
    list.querySelectorAll('.export-row-check').forEach(cb => {
        cb.addEventListener('change', e => { e.stopPropagation(); toggleExportSession(parseInt(cb.dataset.id)); });
    });
    list.querySelectorAll('.export-session-row').forEach(row => {
        row.addEventListener('click', e => {
            if (e.target.type === 'checkbox') return;
            toggleExportSession(parseInt(row.dataset.id));
        });
    });

    updateExportSelectionUI();
}

function toggleExportSession(id) {
    exportSelectedIds.has(id) ? exportSelectedIds.delete(id) : exportSelectedIds.add(id);

    const row = document.querySelector(`.export-session-row[data-id="${id}"]`);
    const cb  = document.querySelector(`.export-row-check[data-id="${id}"]`);
    if (row) row.classList.toggle('is-selected', exportSelectedIds.has(id));
    if (cb)  cb.checked = exportSelectedIds.has(id);
    updateExportSelectionUI();
}

function updateExportSelectionUI() {
    const n      = exportSelectedIds.size;
    const countEl = document.getElementById('exportSelectedCount');
    if (countEl) {
        countEl.textContent = n === 0 ? 'None selected' : `${n} selected`;
        countEl.classList.toggle('has-selection', n > 0);
    }
    const off = n === 0;
    ['exportSummaryBtn', 'exportZipBtn', 'exportJsonBtn', 'exportArtifactBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = off;
    });
}

async function selectAllExportSessions() {
    const filtered = await getExportFilteredSessions();
    filtered.forEach(s => exportSelectedIds.add(s.id));
    renderExportTab();
}

function deselectAllExportSessions() {
    exportSelectedIds.clear();
    renderExportTab();
}

// ── Aggregate Summary CSV ────────────────────────────────
async function exportSelectedSummaryCSV() {
    if (exportSelectedIds.size === 0) return;
    const btn = document.getElementById('exportSummaryBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Computing...';

    try {
        const [allSessions, subjects] = await Promise.all([loadSessions(), loadSubjects()]);
        const sessions = allSessions.filter(s => exportSelectedIds.has(s.id));
        const ageMap   = Object.fromEntries(subjects.map(s => [s.id, s.age]));

        const headers = [
            'session_id','date','filename','subject_name','subject_age','protocol_name',
            'duration_s','n_rr','n_rr_raw','data_quality_pct',
            'mean_rr_ms','sdnn_ms','rmssd_ms','pnn50_pct',
            'mean_hr_bpm','min_hr_bpm','peak_hr_bpm',
            'lf_hf_ratio',
            'sri_score','sri_rmssd_ms','sri_lf_hf','sri_hr_recovery_pct',
            'n_events','event_types','tags'
        ];

        const esc = csvField;
        const f = (v, d = 1) => (v != null && isFinite(v)) ? parseFloat(v.toFixed(d)) : '';

        const rows = sessions.map(s => {
            const m    = computeSessionMetrics(s);
            const age  = s.subjectId ? (ageMap[s.subjectId] ?? '') : '';
            const evts = [...new Set((s.eventMarkers || []).map(e => e.type))].join(';');
            return [
                s.id,
                new Date(s.timestamp).toISOString().slice(0, 19).replace('T', ' '),
                s.filename || 'polar-h10-data',
                s.subjectName || 'Anonymous',
                age,
                s.protocolName || '',
                s.duration || '',
                m ? m.n    : '', m ? m.rawN : '', m ? m.dq : '',
                m ? f(m.mean_rr) : '', m ? f(m.sdnn) : '',
                m ? f(m.rmssd)   : '', m ? f(m.pnn50) : '',
                m ? f(m.mean_hr) : '', m ? f(m.min_hr) : '',
                s.peakHR || '',
                s.sriComponents?.lfhf       ? f(s.sriComponents.lfhf, 2)       : '',
                s.sri > 0 ? s.sri           : '',
                s.sriComponents?.rmssd      ? f(s.sriComponents.rmssd)          : '',
                s.sriComponents?.lfhf       ? f(s.sriComponents.lfhf, 2)        : '',
                s.sriComponents?.hrRecovery ? f(s.sriComponents.hrRecovery)     : '',
                (s.eventMarkers || []).length,
                evts,
                (s.tags || []).join(';')
            ].map(esc).join(',');
        });

        const dateStr = new Date().toISOString().slice(0, 10);
        const csv = [
            `# CardioTrace — Aggregate HRV Summary Export`,
            `# Generated: ${new Date().toISOString()}`,
            `# Sessions: ${sessions.length}  |  Columns: ${headers.length}`,
            `#`,
            headers.join(','),
            ...rows
        ].join('\n');

        downloadFile(csv, `cardiotrace_aggregate_${dateStr}.csv`, 'text/csv');
        console.log(`✓ Aggregate CSV: ${sessions.length} sessions, ${headers.length} columns`);
    } finally {
        btn.textContent = 'Export CSV';
        updateExportSelectionUI();
    }
}

// ── Raw Intervals ZIP ────────────────────────────────────
async function exportSelectedZip() {
    if (exportSelectedIds.size === 0) return;
    const btn    = document.getElementById('exportZipBtn');
    const format = document.getElementById('exportZipFormat').value;
    btn.disabled = true;
    btn.textContent = '⏳ Packing...';

    try {
        const allSessions = await loadSessions();
        const sessions    = allSessions.filter(s => exportSelectedIds.has(s.id));
        const zip         = new JSZip();
        const usedNames   = new Set();

        for (const s of sessions) {
            const d    = new Date(s.startTime || s.timestamp);
            const base = uniqueZipName(usedNames, `${s.filename || 'polar-h10'}_${d.toISOString().slice(0, 16)}`);

            if (format === 'txt') {
                zip.file(`${base}.txt`, s.rrIntervals.map(r => r.toFixed(3)).join('\n'));
            } else {
                zip.file(`${base}.csv`, storedSessionCSV(s));
            }
        }

        const blob    = await zip.generateAsync({ type: 'blob' });
        const zipName = `cardiotrace_sessions_${new Date().toISOString().slice(0, 10)}.zip`;
        const url     = URL.createObjectURL(blob);
        const a       = Object.assign(document.createElement('a'), { href: url, download: zipName });
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        console.log(`✓ ZIP: ${sessions.length} sessions as .${format}`);
    } finally {
        btn.textContent = 'Download ZIP';
        updateExportSelectionUI();
    }
}

// ── Structured JSON ───────────────────────────────────────
async function exportSelectedJSON() {
    if (exportSelectedIds.size === 0) return;
    const btn = document.getElementById('exportJsonBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Building...';

    try {
        const [allSessions, subjects] = await Promise.all([loadSessions(), loadSubjects()]);
        const sessions = allSessions.filter(s => exportSelectedIds.has(s.id));
        const ageMap   = Object.fromEntries(subjects.map(s => [s.id, s.age]));
        const f = (v, d = 1) => (v != null && isFinite(v)) ? parseFloat(v.toFixed(d)) : null;

        const payload = {
            exported_at: new Date().toISOString(),
            generator:   'CardioTrace',
            n_sessions:  sessions.length,
            sessions: sessions.map(s => {
                const m = computeSessionMetrics(s);
                return {
                    id: s.id,
                    filename: s.filename,
                    date: new Date(s.timestamp).toISOString(),
                    duration_s: s.duration,
                    subject: {
                        name: s.subjectName || null,
                        age:  s.subjectId ? (ageMap[s.subjectId] ?? null) : null
                    },
                    protocol: s.protocolName || null,
                    tags: s.tags || [],
                    time_domain: m ? {
                        n_rr:             m.n,
                        n_rr_raw:         m.rawN,
                        data_quality_pct: m.dq,
                        mean_rr_ms:       f(m.mean_rr),
                        sdnn_ms:          f(m.sdnn),
                        rmssd_ms:         f(m.rmssd),
                        pnn50_pct:        f(m.pnn50),
                        mean_hr_bpm:      f(m.mean_hr),
                        min_hr_bpm:       f(m.min_hr),
                        peak_hr_bpm:      s.peakHR || null
                    } : null,
                    frequency_domain: {
                        lf_hf_ratio: s.sriComponents?.lfhf
                            ? f(s.sriComponents.lfhf, 2) : null
                    },
                    sri: {
                        score:              s.sri > 0 ? s.sri : null,
                        rmssd_component_ms: s.sriComponents?.rmssd
                            ? f(s.sriComponents.rmssd) : null,
                        lf_hf_component:    s.sriComponents?.lfhf
                            ? f(s.sriComponents.lfhf, 2) : null,
                        hr_recovery_pct:    s.sriComponents?.hrRecovery
                            ? f(s.sriComponents.hrRecovery) : null
                    },
                    events: (s.eventMarkers || []).map(e => ({
                        time_s: parseFloat(e.time.toFixed(3)),
                        type:   e.type,
                        note:   e.annotation || null
                    }))
                };
            })
        };

        const dateStr = new Date().toISOString().slice(0, 10);
        downloadFile(JSON.stringify(payload, null, 2),
            `cardiotrace_export_${dateStr}.json`, 'application/json');
        console.log(`✓ JSON: ${sessions.length} sessions exported`);
    } finally {
        btn.textContent = 'Export JSON';
        updateExportSelectionUI();
    }
}

function linearRegression(xs, ys) {
    const n = xs.length;
    if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
    const sumX  = xs.reduce((a,b) => a+b, 0);
    const sumY  = ys.reduce((a,b) => a+b, 0);
    const sumXY = xs.reduce((s,x,i) => s + x * ys[i], 0);
    const sumX2 = xs.reduce((s,x) => s + x*x, 0);
    const denom = n*sumX2 - sumX*sumX;
    if (denom === 0) return { slope: 0, intercept: sumY/n };
    const slope = (n*sumXY - sumX*sumY) / denom;
    return { slope, intercept: (sumY - slope*sumX) / n };
}

// ── Analytics helpers ─────────────────────────────────────

async function loadFilteredAnalyzeSessions() {
    const sessions = await loadSessions();
    const subjectVal = document.getElementById('analyzeSubjectFilter')?.value || '';
    if (!subjectVal) return sessions;
    if (subjectVal === 'anonymous') return sessions.filter(s => !s.subjectId);
    return sessions.filter(s => String(s.subjectId) === subjectVal);
}

async function updateAnalyzeSubjectFilter() {
    const el = document.getElementById('analyzeSubjectFilter');
    if (!el) return;
    const subjects = await loadSubjects();
    el.innerHTML = '<option value="">All Subjects</option>' +
        '<option value="anonymous">Anonymous</option>' +
        subjects.sort((a,b) => a.name.localeCompare(b.name))
            .map(s => `<option value="${s.id}">${escapeHTML(s.name)}</option>`).join('');
}

// ── Analyze tab dispatcher ────────────────────────────────

async function renderAnalyzeTab() {
    await updateAnalyzeSubjectFilter();
    switchAnalyzeSubtab(analyzeCurrentSubtab);
}

function switchAnalyzeSubtab(name) {
    analyzeCurrentSubtab = name;
    document.querySelectorAll('.analyze-subtab').forEach(btn =>
        btn.classList.toggle('is-active', btn.dataset.subtab === name));
    document.querySelectorAll('.analyze-section').forEach(sec =>
        sec.classList.toggle('is-active', sec.id === `analyze-${name}`));
    if (name === 'trends')     renderTrendsView();
    if (name === 'comparison') renderComparisonView();
    if (name === 'summary')    renderSummaryView();
}

// ── Trends view ───────────────────────────────────────────

async function renderTrendsView() {
    const sessions = await loadFilteredAnalyzeSessions();

    const emptyHtml = `<div class="history-empty" style="min-height:160px;">
        <span class="empty-icon">📊</span><p>No sessions found</p></div>`;

    if (sessions.length === 0) {
        ['analyzeChartSRI','analyzeChartRMSSD','analyzeChartLFHF']
            .forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = emptyHtml; });
        return;
    }

    sessions.sort((a,b) => a.timestamp - b.timestamp);

    // Assign one color per subject
    const subjectKeys = [...new Set(sessions.map(s => s.subjectId ? String(s.subjectId) : 'anon'))];
    const colorMap = Object.fromEntries(subjectKeys.map((k,i) => [k, TRACE_COLORS[i % TRACE_COLORS.length]]));

    const cfg = { responsive: true, displayModeBar: false };
    const baseLayout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        margin: { t: 10, r: 20, l: 55, b: 40 },
        autosize: true,
        font: { color: chartColor, family: 'Inter, sans-serif', size: 11 },
        xaxis: { showgrid: false, zeroline: false, color: chartColor, type: 'date' },
        yaxis: { showgrid: false, zeroline: false, color: chartColor },
        legend: { bgcolor: 'rgba(0,0,0,0)', font: { size: 11 } },
        hovermode: 'closest'
    };

    function buildTraces(metricFn, yLabel) {
        const traces = [];
        subjectKeys.forEach(key => {
            const ss    = sessions.filter(s => (s.subjectId ? String(s.subjectId) : 'anon') === key);
            const color = colorMap[key];
            const label = ss[0]?.subjectName || 'Anonymous';
            const xs    = ss.map(s => new Date(s.startTime || s.timestamp));
            const ys    = ss.map(metricFn);

            traces.push({
                x: xs, y: ys,
                type: 'scatter', mode: 'lines+markers', name: label,
                line: { color, width: 2 },
                marker: { color, size: 8, line: { color: 'rgba(255,255,255,0.8)', width: 1.5 } },
                connectgaps: false,
                hovertemplate: `%{x|%Y-%m-%d %H:%M}<br>${yLabel}: <b>%{y:.1f}</b><extra>${escapeHTML(label)}</extra>`
            });

            // Trend line — needs ≥3 valid points
            const pairs = ss
                .map((s,i) => ({ x: s.timestamp, y: metricFn(s) }))
                .filter(p => p.y != null && isFinite(p.y) && p.y > 0);
            if (pairs.length >= 3) {
                const reg  = linearRegression(pairs.map(p => p.x), pairs.map(p => p.y));
                const tYs  = pairs.map(p => reg.slope * p.x + reg.intercept);
                const tXs  = pairs.map(p => new Date(p.x));
                traces.push({
                    x: tXs, y: tYs,
                    type: 'scatter', mode: 'lines', name: `${label} trend`,
                    line: { color, width: 1.5, dash: 'dash' },
                    showlegend: false, hoverinfo: 'skip'
                });
            }
        });
        return traces;
    }

    Plotly.react('analyzeChartSRI',
        buildTraces(s => sessionSRI(s).score || null, 'SRI'),
        { ...baseLayout, yaxis: { ...baseLayout.yaxis, title: 'SRI', range: [0, 105] } }, cfg);

    Plotly.react('analyzeChartRMSSD',
        buildTraces(s => sessionMetrics(s)?.rmssd > 0 ? Math.round(sessionMetrics(s).rmssd * 10) / 10 : null, 'RMSSD (ms)'),
        { ...baseLayout, yaxis: { ...baseLayout.yaxis, title: 'RMSSD (ms)' } }, cfg);

    Plotly.react('analyzeChartLFHF',
        buildTraces(s => sessionSRI(s).lfhf > 0 ? Math.round(sessionSRI(s).lfhf * 100) / 100 : null, 'LF/HF'),
        { ...baseLayout, yaxis: { ...baseLayout.yaxis, title: 'LF/HF Ratio' } }, cfg);
}

// ── Comparison view ───────────────────────────────────────

async function renderComparisonView() {
    const sessions = await loadSessions();
    const existing = new Set(sessions.map(s => s.id));
    [...comparisonSelectedIds].forEach(id => { if (!existing.has(id)) comparisonSelectedIds.delete(id); });
    sessions.sort((a,b) => b.timestamp - a.timestamp);
    const recent = sessions.slice(0, 40);

    const list = document.getElementById('comparisonSessionList');
    if (!list) return;

    const selectedArr = Array.from(comparisonSelectedIds);

    list.innerHTML = recent.map(s => {
        const isSel  = comparisonSelectedIds.has(s.id);
        const colIdx = selectedArr.indexOf(s.id);
        const color  = isSel ? TRACE_COLORS[colIdx % TRACE_COLORS.length] : null;
        return `
        <div class="comparison-session-item ${isSel ? 'selected' : ''}"
             data-id="${s.id}" onclick="toggleComparisonSession(${s.id})">
            <input type="checkbox" ${isSel ? 'checked' : ''}
                   onclick="event.stopPropagation();toggleComparisonSession(${s.id})">
            <div class="comparison-session-color"
                 style="background:${color || 'transparent'};border:${color ? 'none' : '1px solid var(--border-color)'};">
            </div>
            <div class="comparison-session-info">
                <div class="comparison-session-name">${escapeHTML(s.filename || 'Session')}</div>
                <div class="comparison-session-meta">
                    ${formatDate(s.date)} · ${formatDuration(s.duration)}
                    ${s.subjectName && s.subjectName !== 'Anonymous' ? ` · ${escapeHTML(s.subjectName)}` : ''}
                </div>
            </div>
        </div>`;
    }).join('');

    renderComparisonChart();
}

function toggleComparisonSession(id) {
    if (comparisonSelectedIds.has(id)) {
        comparisonSelectedIds.delete(id);
    } else {
        if (comparisonSelectedIds.size >= 6) {
            notify('You can compare up to 6 sessions at a time.', 'warn');
            return;
        }
        comparisonSelectedIds.add(id);
    }
    renderComparisonView();
}

async function renderComparisonChart() {
    const chartEl = document.getElementById('analyzeChartComparison');
    const labelEl = document.getElementById('comparisonChartLabel');
    if (!chartEl) return;

    if (comparisonSelectedIds.size === 0) {
        chartEl.innerHTML = `<div class="history-empty" style="min-height:280px;">
            <span class="empty-icon">⊞</span>
            <p>Select sessions from the list to compare</p></div>`;
        if (labelEl) labelEl.textContent = 'Select sessions to compare';
        return;
    }

    const metric       = document.getElementById('comparisonMetric')?.value || 'rmssd';
    const metricLabels = {
        rmssd: 'Rolling RMSSD (ms)',
        rr:    'RR Interval (ms)',
        hr:    'Heart Rate (bpm)'
    };

    const selectedArr = Array.from(comparisonSelectedIds);
    const sessions    = (await Promise.all(selectedArr.map(id => loadSession(id)))).filter(Boolean);

    const traces = sessions.map((s, i) => {
        const color = TRACE_COLORS[i % TRACE_COLORS.length];
        let xs = s.timestamps || [];
        let ys;

        if (metric === 'rr') {
            ys = s.rrIntervals || [];
        } else if (metric === 'hr') {
            ys = (s.rrIntervals || []).map(rr => Math.round(60000 / rr));
        } else {
            // Compute rolling 60s RMSSD on stored intervals
            const rr = s.rrIntervals || [];
            const ts = s.timestamps  || [];
            const rmssdX = [], rmssdY = [];
            let left = 0, sq = 0;                         // sliding 60 s window over successive differences
            for (let i = 1; i < rr.length; i++) {
                sq += (rr[i] - rr[i-1]) ** 2;
                const t = ts[i];
                while (left < i && ts[left] < t - 60) { sq -= (rr[left+1] - rr[left]) ** 2; left++; }
                const pairs = i - left;
                if (t < 30 || pairs < 1) continue;
                rmssdX.push(t);
                rmssdY.push(Math.sqrt(Math.max(0, sq) / pairs));
            }
            xs = rmssdX;
            ys = rmssdY;
        }

        return {
            x: xs, y: ys,
            type: 'scatter', mode: 'lines',
            name: s.filename || `Session ${s.id}`,
            line: { color, width: 2 },
            hovertemplate: `t: %{x:.1f}s<br>${metricLabels[metric]}: <b>%{y:.1f}</b><extra>${s.filename || 'Session'}</extra>`
        };
    });

    if (labelEl) {
        labelEl.textContent = `${metricLabels[metric]} — ${sessions.length} session${sessions.length > 1 ? 's' : ''} overlaid`;
    }

    Plotly.react('analyzeChartComparison', traces, {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor:  'rgba(0,0,0,0)',
        margin: { t: 10, r: 20, l: 55, b: 40 },
        autosize: true,
        font: { color: chartColor, family: 'Inter, sans-serif', size: 11 },
        xaxis: { title: 'Time (s)', showgrid: false, zeroline: false, color: chartColor },
        yaxis: { title: metricLabels[metric], showgrid: false, zeroline: false, color: chartColor },
        legend: { bgcolor: 'rgba(0,0,0,0)', font: { size: 11 } },
        hovermode: 'x unified'
    }, { responsive: true, displayModeBar: false });
}

// ── Summary view ──────────────────────────────────────────

async function renderSummaryView() {
    const content = document.getElementById('analyzeSummaryContent');
    if (!content) return;

    const sessions = await loadFilteredAnalyzeSessions();
    if (sessions.length === 0) {
        content.innerHTML = `<div class="history-empty">
            <span class="empty-icon">📊</span><p>No sessions found</p></div>`;
        return;
    }

    const subjects = await loadSubjects();

    // Build row groups: All Sessions + one per subject key
    const byKey = {};
    sessions.forEach(s => {
        const key   = s.subjectId ? String(s.subjectId) : 'anon';
        const label = s.subjectName || 'Anonymous';
        if (!byKey[key]) byKey[key] = { label, initial: label.charAt(0).toUpperCase(), ss: [] };
        byKey[key].ss.push(s);
    });

    const groups = [
        { label: 'All Sessions', initial: '★', ss: sessions },
        ...Object.values(byKey).sort((a,b) => a.label.localeCompare(b.label))
    ];

    function stats(ss, fn) {
        const vals = ss.map(fn).filter(v => v != null && isFinite(v) && v > 0);
        if (!vals.length) return null;
        const avg = vals.reduce((a,b) => a+b) / vals.length;
        const sd  = vals.length > 1
            ? Math.sqrt(vals.reduce((s,v) => s + (v-avg)**2, 0) / (vals.length - 1))
            : 0;
        return { avg, sd, n: vals.length };
    }

    function cell(st, unit = '', decimals = 1) {
        if (!st) return `<span style="color:var(--text-tertiary)">—</span>`;
        const sdStr = st.sd > 0.05 ? `<span class="summary-sd">±${st.sd.toFixed(decimals)}</span>` : '';
        return `<span class="summary-val">${st.avg.toFixed(decimals)}${unit}</span>${sdStr}`;
    }

    function totalDur(ss) { return ss.reduce((s,x) => s + (x.duration || 0), 0); }
    function avgDur(ss)   { return ss.length ? Math.round(totalDur(ss) / ss.length) : 0; }

    content.innerHTML = `
    <div style="overflow-x:auto;">
    <table class="analyze-summary-table">
        <thead>
            <tr>
                <th>Subject / Group</th>
                <th>Sessions</th>
                <th class="sri-el">Avg SRI</th>
                <th>Avg RMSSD</th>
                <th>Avg HR</th>
                <th>Avg Duration</th>
                <th>Total Recorded</th>
            </tr>
        </thead>
        <tbody>
        ${groups.map((g, gi) => {
            const sriSt  = stats(g.ss, s => sessionSRI(s).score || null);
            const rmssdSt = stats(g.ss, s => sessionMetrics(s)?.rmssd || null);
            const hrSt   = stats(g.ss, s => sessionMetrics(s)?.mean_hr || null);
            const sriClass = sriSt
                ? (sriSt.avg >= 75 ? 'sri-excellent' : sriSt.avg >= 55 ? 'sri-good'
                   : sriSt.avg >= 35 ? 'sri-fair' : 'sri-poor')
                : '';
            return `
            <tr class="${gi === 0 ? 'summary-all-row' : ''}">
                <td style="white-space:nowrap;">
                    <span class="summary-avatar">${escapeHTML(g.initial)}</span>${escapeHTML(g.label)}
                </td>
                <td><span class="summary-val">${g.ss.length}</span></td>
                <td class="sri-el ${sriClass}">${cell(sriSt,'',0)}</td>
                <td>${cell(rmssdSt,' ms')}</td>
                <td>${cell(hrSt,' bpm',0)}</td>
                <td><span class="summary-val">${formatDuration(avgDur(g.ss))}</span></td>
                <td><span class="summary-val">${formatDuration(totalDur(g.ss))}</span></td>
            </tr>`;
        }).join('')}
        </tbody>
    </table>
    </div>`;
}

// ── Protocol CRUD ─────────────────────────────────────────

async function saveProtocol(data, id = null) {
    if (!db) throw new Error('IndexedDB not available');
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(['protocols'], 'readwrite');
        const store = tx.objectStore('protocols');
        const obj   = { name: data.name, phases: data.phases, createdAt: data.createdAt || new Date().toISOString() };
        if (id) {
            obj.id = id;
            const req = store.put(obj);
            req.onsuccess = () => resolve(id);
            req.onerror   = () => reject(req.error);
        } else {
            const req = store.add(obj);
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        }
    });
}

async function loadProtocols() {
    if (!db) return [];
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['protocols'], 'readonly');
        const req = tx.objectStore('protocols').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function loadProtocol(id) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['protocols'], 'readonly');
        const req = tx.objectStore('protocols').get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function deleteProtocol(id) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['protocols'], 'readwrite');
        const req = tx.objectStore('protocols').delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ── Protocol helpers ──────────────────────────────────────

function formatPhaseTime(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function getProtocolTotalSecs(protocol) {
    return (protocol?.phases || []).reduce((sum, p) => sum + p.durationSecs, 0);
}

function formatProtocolPhaseList(protocol) {
    return protocol.phases.map(p => `${escapeHTML(p.name)} ${formatPhaseTime(p.durationSecs)}`).join(' → ');
}

function updateProtocolChipDisplay() {
    const nameEl = document.getElementById('currentProtocolName');
    const durEl  = document.getElementById('currentProtocolDuration');
    if (!nameEl) return;
    if (activeProtocol) {
        nameEl.textContent = activeProtocol.name;
        if (durEl) durEl.textContent = `· ${formatPhaseTime(getProtocolTotalSecs(activeProtocol))}`;
    } else {
        nameEl.textContent = 'Free Recording';
        if (durEl) durEl.textContent = '';
    }
    updateProtocolControls();
}

// ── Protocol picker ───────────────────────────────────────

function openProtocolPicker() {
    renderProtocolPickerList();
    document.getElementById('protocolPickerPanel').classList.add('active');
    document.getElementById('protocolPickerOverlay').classList.add('active');
}

function closeProtocolPicker() {
    document.getElementById('protocolPickerPanel').classList.remove('active');
    document.getElementById('protocolPickerOverlay').classList.remove('active');
}

async function renderProtocolPickerList() {
    const builtinEl = document.getElementById('builtinProtocolList');
    const userEl    = document.getElementById('userProtocolList');
    if (!builtinEl || !userEl) return;

    builtinEl.innerHTML = BUILTIN_PROTOCOLS.map((p, i) => {
        const isSel = activeProtocol?.id === p.id;
        return `
        <div class="protocol-option ${isSel ? 'selected' : ''}">
            <div class="protocol-option-header">
                <div class="protocol-option-name">
                    ${p.name}
                    <span class="protocol-builtin-badge">Built-in</span>
                </div>
            </div>
            <div class="protocol-option-phases">${formatProtocolPhaseList(p)}</div>
            <div class="protocol-option-meta">${p.phases.length} phases · ${formatPhaseTime(getProtocolTotalSecs(p))}</div>
            <div class="protocol-option-actions">
                <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px;min-height:28px;"
                        onclick="selectBuiltinProtocol(${i})">
                    ${isRecordingLive() ? (isSel && protocolRunning ? '▶ Restart' : '▶ Start now') : (isSel ? '✓ Selected' : 'Select')}
                </button>
            </div>
        </div>`;
    }).join('');

    const userProtocols = await loadProtocols();
    if (userProtocols.length === 0) {
        userEl.innerHTML = `<p style="color:var(--text-tertiary);font-size:13px;padding:12px 0;">No custom protocols yet.</p>`;
        return;
    }
    userEl.innerHTML = userProtocols.map(p => {
        const isSel = activeProtocol?.id === p.id;
        return `
        <div class="protocol-option ${isSel ? 'selected' : ''}">
            <div class="protocol-option-header">
                <div class="protocol-option-name">${escapeHTML(p.name)}</div>
            </div>
            <div class="protocol-option-phases">${formatProtocolPhaseList(p)}</div>
            <div class="protocol-option-meta">${p.phases.length} phases · ${formatPhaseTime(getProtocolTotalSecs(p))}</div>
            <div class="protocol-option-actions">
                <button class="session-action-btn" onclick="openProtocolEditor(${p.id})" title="Edit">✏️</button>
                <button class="session-action-btn delete" onclick="confirmDeleteProtocol(${p.id})" title="Delete">🗑️</button>
                <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px;min-height:28px;"
                        onclick="selectUserProtocol(${p.id})">
                    ${isRecordingLive() ? (isSel && protocolRunning ? '▶ Restart' : '▶ Start now') : (isSel ? '✓ Selected' : 'Select')}
                </button>
            </div>
        </div>`;
    }).join('');
}

// A protocol can be activated at ANY time: while recording it starts immediately
// (switching away from a running one); before/while calibrating it starts automatically
// when calibration ends (existing behaviour in connect()).
function isRecordingLive() { return isConnected && !isCalibrating && !!calibrationStartTime; }

function chooseProtocol(p) {
    if (protocolRunning && !confirm('A protocol is already running. Replace it?')) return;
    if (protocolRunning) { addEventMarkerProgrammatic('Protocol switched'); stopProtocolRunner(); }
    activeProtocol = p;
    updateProtocolChipDisplay();
    closeProtocolPicker();
    if (p && isRecordingLive()) startProtocolRunner();
}

function selectBuiltinProtocol(idx) { chooseProtocol({ ...BUILTIN_PROTOCOLS[idx] }); }

async function selectUserProtocol(id) {
    const p = await loadProtocol(id);
    if (p) chooseProtocol(p);
}

function selectFreeRecording() { chooseProtocol(null); }

// "▶ Start" next to the protocol chip: visible while recording with a protocol that is not running
function updateProtocolControls() {
    const btn = document.getElementById('startProtocolBtn');
    if (!btn) return;
    btn.style.display = (activeProtocol && isRecordingLive() && !protocolRunning) ? '' : 'none';
}

async function confirmDeleteProtocol(id) {
    const p = await loadProtocol(id);
    if (!confirm(`Delete protocol "${p.name}"?`)) return;
    if (activeProtocol?.id === id) {
        if (protocolRunning) { addEventMarkerProgrammatic('Protocol deleted'); stopProtocolRunner(); }
        activeProtocol = null;
        updateProtocolChipDisplay();
    }
    await deleteProtocol(id);
    renderProtocolPickerList();
}

// ── Protocol editor ───────────────────────────────────────

async function openProtocolEditor(id = null) {
    closeProtocolPicker();
    if (id) {
        const p = await loadProtocol(id);
        if (!p) return;
        protocolEditorState = { id: p.id, name: p.name, phases: p.phases.map(ph => ({ ...ph })) };
        document.getElementById('protocolEditorTitle').textContent = 'Edit Protocol';
        document.getElementById('protocolEditorName').value = p.name;
    } else {
        protocolEditorState = { id: null, name: '', phases: [{ name: 'Phase 1', durationSecs: 300, autoMark: true }] };
        document.getElementById('protocolEditorTitle').textContent = 'Create Protocol';
        document.getElementById('protocolEditorName').value = '';
    }
    renderProtocolPhaseEditor();
    document.getElementById('protocolEditorPanel').classList.add('active');
    document.getElementById('protocolEditorOverlay').classList.add('active');
}

function closeProtocolEditor() {
    document.getElementById('protocolEditorPanel').classList.remove('active');
    document.getElementById('protocolEditorOverlay').classList.remove('active');
}

function renderProtocolPhaseEditor() {
    const list = document.getElementById('protocolPhasesList');
    if (!list) return;

    if (protocolEditorState.phases.length === 0) {
        list.innerHTML = `<div style="color:var(--text-tertiary);text-align:center;padding:16px;font-size:13px;">No phases. Click + Add Phase.</div>`;
        return;
    }

    list.innerHTML = protocolEditorState.phases.map((phase, i) => {
        const mins = Math.floor(phase.durationSecs / 60);
        const secs = phase.durationSecs % 60;
        return `
        <div class="protocol-phase-row" data-idx="${i}">
            <div class="phase-row-num">${i + 1}</div>
            <input type="text"   class="phase-name-input" value="${escapeHTML(phase.name)}" placeholder="Phase name" data-idx="${i}">
            <input type="number" class="phase-min-input"  value="${mins}" min="0" max="120" data-idx="${i}">
            <span class="phase-sep">m</span>
            <input type="number" class="phase-sec-input"  value="${secs}" min="0" max="59"  data-idx="${i}">
            <span class="phase-sep">s</span>
            <button class="annotation-delete phase-remove-btn" data-idx="${i}">✕</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.phase-name-input').forEach(input => {
        input.addEventListener('input', e => {
            protocolEditorState.phases[parseInt(e.target.dataset.idx)].name = e.target.value;
        });
    });

    list.querySelectorAll('.phase-min-input, .phase-sec-input').forEach(input => {
        input.addEventListener('input', e => {
            const idx = parseInt(e.target.dataset.idx);
            const row = list.querySelector(`.protocol-phase-row[data-idx="${idx}"]`);
            const m   = parseInt(row.querySelector('.phase-min-input').value) || 0;
            const s   = parseInt(row.querySelector('.phase-sec-input').value) || 0;
            protocolEditorState.phases[idx].durationSecs = m * 60 + s;
        });
    });

    list.querySelectorAll('.phase-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            protocolEditorState.phases.splice(parseInt(btn.dataset.idx), 1);
            renderProtocolPhaseEditor();
        });
    });
}

function addEditorPhase() {
    protocolEditorState.phases.push({ name: `Phase ${protocolEditorState.phases.length + 1}`, durationSecs: 300, autoMark: true });
    renderProtocolPhaseEditor();
    // Scroll list to bottom so new phase is visible
    const list = document.getElementById('protocolPhasesList');
    if (list) list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveProtocolFromEditor() {
    const name = document.getElementById('protocolEditorName').value.trim();
    if (!name) { notify('Enter a protocol name.', 'warn'); return; }
    if (!requireDB()) return;
    if (protocolEditorState.phases.length === 0) { notify('Add at least one phase.', 'warn'); return; }
    if (protocolEditorState.phases.some(ph => !(ph.durationSecs > 0))) { notify('Every phase needs a duration longer than 0 s.', 'warn'); return; }
    protocolEditorState.phases.forEach((ph, i) => { ph.name = (ph.name || '').trim() || `Phase ${i + 1}`; });

    const id = await saveProtocol({ name, phases: protocolEditorState.phases }, protocolEditorState.id || null);

    // If this was the active protocol, refresh it
    if (activeProtocol && (activeProtocol.id === protocolEditorState.id || activeProtocol.id === id)) {
        activeProtocol = { id, name, phases: protocolEditorState.phases.map(ph => ({ ...ph })) };
        if (protocolRunning && currentPhaseIdx >= activeProtocol.phases.length) {
            currentPhaseIdx = activeProtocol.phases.length - 1;
            phaseSecondsLeft = Math.min(phaseSecondsLeft, activeProtocol.phases[currentPhaseIdx].durationSecs);
        }
        if (protocolRunning) {
            document.getElementById('protocolRunnerName').textContent = name;
            document.getElementById('protocolPhaseTotal').textContent = activeProtocol.phases.length;
            updateProtocolRunnerUI();
        }
        updateProtocolChipDisplay();
    }

    closeProtocolEditor();
    openProtocolPicker();
}

// ── Protocol runner ───────────────────────────────────────

function addEventMarkerProgrammatic(type, annotation = '') {
    if (!calibrationStartTime) return;
    const t = (Date.now() - calibrationStartTime) / 1000;
    const marker = { time: t, type, annotation, label: type };
    eventMarkers.push(marker);
    sessionAnnotations.push(marker);
    updateRRChartWithMarkers();
    updateRollingRMSSD();
    renderAnnotations();
}

function startProtocolRunner() {
    if (!activeProtocol?.phases?.length) return;
    clearTimeout(protocolBannerTimer);
    currentPhaseIdx  = 0;
    phaseSecondsLeft = activeProtocol.phases[0].durationSecs;
    protocolRunning  = true;

    const panel = document.getElementById('protocolRunnerPanel');
    panel.style.display = '';
    // Restore full runner HTML in case complete banner replaced it
    if (!panel.querySelector('.protocol-runner-header')) {
        panel.innerHTML = `
        <div class="protocol-runner-header">
            <div class="protocol-runner-title">
                <span class="protocol-runner-icon">🔬</span>
                <span id="protocolRunnerName"></span>
            </div>
            <div class="protocol-runner-btns">
                <button class="btn btn-secondary protocol-runner-btn" id="protocolSkipBtn">Skip →</button>
                <button class="btn btn-danger protocol-runner-btn" id="protocolStopBtn">■ Stop</button>
            </div>
        </div>
        <div class="protocol-runner-body">
            <div class="protocol-runner-phase-row">
                <span class="protocol-phase-label">Phase <span id="protocolPhaseNum">1</span>/<span id="protocolPhaseTotal">1</span>:</span>
                <span class="protocol-phase-name" id="protocolPhaseName"></span>
                <span class="protocol-phase-time" id="protocolPhaseTime">00:00</span>
            </div>
            <div class="protocol-progress-track"><div class="protocol-progress-fill" id="protocolProgressFill"></div></div>
            <div class="protocol-next-phase" id="protocolNextPhase"></div>
        </div>`;
        // Re-bind buttons (they're new DOM elements)
        document.getElementById('protocolSkipBtn').addEventListener('click', skipProtocolPhase);
        document.getElementById('protocolStopBtn').addEventListener('click', stopProtocolRunner);
    }

    document.getElementById('protocolRunnerName').textContent = activeProtocol.name;
    document.getElementById('protocolPhaseTotal').textContent = activeProtocol.phases.length;

    addEventMarkerProgrammatic(`Start: ${activeProtocol.phases[0].name}`);
    updateProtocolRunnerUI();
    updateProtocolControls();

    if (phaseTimer) clearInterval(phaseTimer);
    phaseTimer = setInterval(() => {
        phaseSecondsLeft--;
        if (phaseSecondsLeft <= 0) {
            advanceProtocolPhase();
        } else {
            updateProtocolRunnerUI();
        }
    }, 1000);
}

function stopProtocolRunner() {
    if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
    protocolRunning  = false;
    currentPhaseIdx  = 0;
    phaseSecondsLeft = 0;
    document.getElementById('protocolRunnerPanel').style.display = 'none';
    updateProtocolControls();
}

function skipProtocolPhase() {
    if (!protocolRunning) return;
    phaseSecondsLeft = 0;
    advanceProtocolPhase();
}

function advanceProtocolPhase() {
    if (!activeProtocol?.phases?.length) { stopProtocolRunner(); return; }
    const phases = activeProtocol.phases;
    addEventMarkerProgrammatic(`End: ${phases[currentPhaseIdx].name}`);
    currentPhaseIdx++;

    if (currentPhaseIdx >= phases.length) {
        addEventMarkerProgrammatic('Protocol Complete');
        stopProtocolRunner();
        // Show completion banner briefly
        const panel = document.getElementById('protocolRunnerPanel');
        panel.style.display = '';
        panel.innerHTML = `
            <div class="protocol-runner-complete">
                <span class="protocol-complete-icon">✅</span>
                <span class="protocol-complete-text">Protocol complete — recording continues</span>
                <button class="btn btn-secondary protocol-runner-btn"
                        onclick="document.getElementById('protocolRunnerPanel').style.display='none'">Dismiss</button>
            </div>`;
        clearTimeout(protocolBannerTimer);
        protocolBannerTimer = setTimeout(() => { if (!protocolRunning) panel.style.display = 'none'; }, 6000);
        return;
    }

    phaseSecondsLeft = phases[currentPhaseIdx].durationSecs;
    addEventMarkerProgrammatic(`Start: ${phases[currentPhaseIdx].name}`);
    updateProtocolRunnerUI();
}

function updateProtocolRunnerUI() {
    if (!protocolRunning || !activeProtocol) return;
    const phase   = activeProtocol.phases[currentPhaseIdx];
    if (!phase) return;
    const total   = phase.durationSecs;
    const elapsed = total - phaseSecondsLeft;

    const numEl  = document.getElementById('protocolPhaseNum');
    const nmEl   = document.getElementById('protocolPhaseName');
    const tmEl   = document.getElementById('protocolPhaseTime');
    const fillEl = document.getElementById('protocolProgressFill');
    const nextEl = document.getElementById('protocolNextPhase');
    if (!numEl) return;

    numEl.textContent  = currentPhaseIdx + 1;
    nmEl.textContent   = phase.name;
    tmEl.textContent   = formatPhaseTime(phaseSecondsLeft);
    fillEl.style.width = `${total > 0 ? Math.min(100, (elapsed / total) * 100) : 100}%`;

    const nextPhase = activeProtocol.phases[currentPhaseIdx + 1];
    nextEl.textContent = nextPhase
        ? `Next: ${nextPhase.name} (${formatPhaseTime(nextPhase.durationSecs)})`
        : 'Last phase';
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
    if (typeof applyAllChartPrefs === 'function') applyAllChartPrefs();   // theme reset grid/axis colours
}

// Calculate HR zones
function getHRZone(hr, age) {
    age = age || getEffectiveAge();
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
        const zoneInfo = getHRZone(hr, getEffectiveAge());
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

// Monitor signal quality (runs only while a device is connected)
function startSignalMonitor() {
    if (!signalTimer) signalTimer = setInterval(updateSignalQuality, 1000);
}
function stopSignalMonitor() {
    clearInterval(signalTimer);
    signalTimer = null;
}

// Keep the screen awake while recording (long sessions on phones/tablets)
async function acquireWakeLock() {
    try {
        if ('wakeLock' in navigator && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch (e) { /* denied or unsupported: non-fatal */ }
}
function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

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
function cleanRRData(rrIntervals, timestamps, cfg = null) {
    // Same rules as the live filter (rrFilterStep), so restored old-format sessions are cleaned identically
    const c = cfg || liveArtifactCfg();
    const cleaned = { rr: [], times: [] };
    const run = [];
    for (let i = 0; i < rrIntervals.length; i++) {
        const ref = rrReference(cleaned.rr, c);
        for (const b of rrFilterStep(rrIntervals[i], timestamps[i], ref, run, c)) {
            cleaned.rr.push(b.rr);
            cleaned.times.push(b.t);
        }
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

    // Shift to t0 = 0: sin/cos of 2*pi*f*t lose precision when t is a large absolute time
    const t0 = times[0];
    times = Array.from(times, v => v - t0);

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
const CWT_VOICES  = 32;   // log-spaced frequency bins
const CWT_F_MIN   = 0.005;
const CWT_F_MAX   = 0.40;
const CWT_C_DELTA = 0.776; // Torrence & Compo (1998), Table 2: reconstruction factor for the Morlet wavelet, omega0 = 6

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

    // Monotone cubic (PCHIP, Fritsch-Carlson) interpolation. Linear interpolation of an RR series
    // low-pass-filters it (about -15 % power at 0.25 Hz for a 70 bpm series), which inflated LF/HF by
    // roughly 25 % on synthetic signals; cubic interpolation is the convention in Kubios HRV and NeuroKit2.
    const h = new Float64Array(n - 1), del = new Float64Array(n - 1);
    for (let k = 0; k < n - 1; k++) { h[k] = beatT[k+1] - beatT[k]; del[k] = h[k] > 0 ? (rrMs[k+1] - rrMs[k]) / h[k] : 0; }
    const d = new Float64Array(n);
    for (let k = 1; k < n - 1; k++) {
        if (del[k-1] * del[k] <= 0) { d[k] = 0; continue; }
        const w1 = 2 * h[k] + h[k-1], w2 = h[k] + 2 * h[k-1];
        d[k] = (w1 + w2) / (w1 / del[k-1] + w2 / del[k]);
    }
    const endSlope = (h0, h1, d0, d1) => {                        // three-point end condition, shape-preserving
        let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if (Math.sign(s) !== Math.sign(d0)) s = 0;
        else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
        return s;
    };
    d[0]     = endSlope(h[0], h[1], del[0], del[1]);
    d[n - 1] = endSlope(h[n-2], h[n-3], del[n-2], del[n-3]);

    const nSamp = Math.floor(beatT[n-1] * CWT_FS) + 1;
    const sig   = new Float64Array(nSamp);
    const tArr  = new Float64Array(nSamp);
    let j = 0;
    for (let i = 0; i < nSamp; i++) {
        const t = i / CWT_FS;
        tArr[i] = t;
        while (j < n - 2 && beatT[j+1] <= t) j++;
        const hj = h[j];
        if (!(hj > 0)) { sig[i] = rrMs[j]; continue; }
        const s = (t - beatT[j]) / hj, s2 = s * s, s3 = s2 * s;   // cubic Hermite basis
        sig[i] = (2*s3 - 3*s2 + 1) * rrMs[j] + (s3 - 2*s2 + s) * hj * d[j]
               + (-2*s3 + 3*s2) * rrMs[j+1] + (s3 - s2) * hj * d[j+1];
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
    const wRe = new Float64Array(NFFT), cRe = new Float64Array(NFFT), cIm = new Float64Array(NFFT);   // reused per voice

    for (let vi = 0; vi < CWT_VOICES; vi++) {
        const f        = freqs[vi];
        const sSeconds = CWT_OMEGA0 / (TWOPI * f);       // scale in seconds
        // Morlet wavelet spectrum (normalised, one-sided)
        const norm = Math.sqrt(TWOPI * sSeconds / dt) * Math.pow(Math.PI, -0.25);
        wRe.fill(0);

        for (let k = 0; k < NFFT; k++) {
            const fk = (k <= NFFT >> 1 ? k : k - NFFT) * CWT_FS / NFFT;
            if (fk <= 0) continue;                       // Heaviside (one-sided)
            const arg = sSeconds * TWOPI * fk - CWT_OMEGA0;
            wRe[k] = norm * Math.exp(-arg * arg / 2);
        }

        // Multiply in frequency domain (wavelet spectrum is real)
        for (let k = 0; k < NFFT; k++) {
            cRe[k] = xRe[k] * wRe[k];
            cIm[k] = xIm[k] * wRe[k];
        }
        fftInPlace(cRe, cIm, true);                      // IFFT

        const pow = new Float64Array(useN);
        let sumP  = 0;
        for (let i = 0; i < useN; i++) {
            // Scale-rectified power |W|^2 / s (Liu et al. 2007): the unit-energy normalisation of
            // Torrence & Compo otherwise over-weights low frequencies in the band integrals
            const p = (cRe[i] * cRe[i] + cIm[i] * cIm[i]) / sSeconds;
            pow[i] = p; sumP += p;
        }
        avgPow[vi] = sumP / useN;
        scalogram.push(pow);
    }

    // Band variance (ms^2), Torrence & Compo (1998) Eq. 24 restricted to a band and averaged in time:
    //   var_band = (dj * dt / C_delta) * sum_j [ time-mean |W_j|^2 / s_j ]
    // dj is the scale spacing in octaves; avgPow already holds |W|^2 / s (rectified above).
    const dj = Math.log2(CWT_F_MAX / CWT_F_MIN) / (CWT_VOICES - 1);
    const K  = dj * dt / CWT_C_DELTA;
    let vlfP = 0, lfP = 0, hfP = 0;
    for (let vi = 0; vi < CWT_VOICES; vi++) {
        const f = freqs[vi];
        const p = avgPow[vi] * K;
        if      (f >= 0.003 && f < 0.04)  vlfP += p;
        else if (f >= 0.04  && f < 0.15)  lfP  += p;
        else if (f >= 0.15  && f <= 0.40) hfP  += p;
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

    const allZ = Z.flatMap(row => row).filter(Number.isFinite);
    allZ.sort((a, b) => a - b);
    const zmin = allZ[Math.floor(allZ.length * 0.05)] ?? -8;
    const zmax = allZ[Math.floor(allZ.length * 0.95)] ?? 0;

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
        { x: [dispTimes], y: [result.freqs], z: [Z], zmin: [zmin], zmax: [zmax] },
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
                notify('Share failed — the data were copied to the clipboard instead.', 'warn');
                navigator.clipboard.writeText(content);
            }
        });
    } else {
        // No share API - copy to clipboard
        navigator.clipboard.writeText(content).then(() => {
            notify('Data copied to the clipboard — paste them in Notes or Files to save.', 'success');
        }).catch(() => {
            notify('Unable to export on this device. Please use a desktop browser.', 'error');
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
    if (!db) throw new Error('session storage (IndexedDB) is not available in this browser');
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);

        const session = {
            timestamp: sessionData.timestamp ?? Date.now(),
            date: sessionData.date ?? new Date().toISOString(),
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
            sri: sessionData.sri ?? sriScore,
            sriComponents: sessionData.sriComponents ?? sriComponents,
            peakHR: sessionData.peakHR ?? peakHR,
            calibrationSecs: sessionData.calibrationSecs ?? null,
            device:       sessionData.device ?? null,
            artifactFilter: sessionData.artifactFilter ?? null,
            importedFrom: sessionData.importedFrom ?? null,
            subjectId:    sessionData.subjectId    !== undefined ? sessionData.subjectId    : currentSubjectId,
            subjectName:  sessionData.subjectName  !== undefined ? sessionData.subjectName  : currentSubjectName,
            protocolId:   sessionData.protocolId   !== undefined ? sessionData.protocolId   : (activeProtocol?.id   ?? null),
            protocolName: sessionData.protocolName !== undefined ? sessionData.protocolName : (activeProtocol?.name ?? null)
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

// Change some fields of a STORED session (rename, SRI back-fill) without rebuilding it:
// saveSession() is for live data and would reset date, stats and SRI from the live globals.
async function updateSession(id, patch) {
    return new Promise((resolve, reject) => {
        const store = db.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME);
        const get = store.get(id);
        get.onsuccess = () => {
            if (!get.result) { reject(new Error(`Session ${id} not found`)); return; }
            const put = store.put({ ...get.result, ...patch, id });
            put.onsuccess = () => resolve(id);
            put.onerror = () => reject(put.error);
        };
        get.onerror = () => reject(get.error);
    });
}

// Load sessions
async function loadSessions() {
    if (!db) return [];
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// The live recording keeps being auto-saved under currentSessionId: deleting it would only make it reappear
function isLiveSession(id) { return isConnected && currentSessionId != null && id === currentSessionId; }
async function confirmAndDeleteSession(id) {
    if (isLiveSession(id)) { notify('This session is being recorded. Disconnect first, then delete it.', 'warn'); return false; }
    if (!confirm('Delete this session?')) return false;
    await deleteSession(id);
    if (!isConnected && id === shownSessionId) await performSessionReset(false);   // the open session no longer exists
    return true;
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
    const keepId = isConnected ? currentSessionId : null;   // never delete the recording in progress
    if (!confirm(keepId != null
        ? 'Delete ALL saved sessions except the one being recorded? This cannot be undone.'
        : 'Are you sure you want to delete ALL sessions? This cannot be undone.')) return;

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        if (keepId != null) {
            objectStore.delete(IDBKeyRange.upperBound(keepId, true));   // ids below the live one
            objectStore.delete(IDBKeyRange.lowerBound(keepId, true));   // and above it
        } else {
            objectStore.clear();
        }
        transaction.oncomplete = () => {
            if (!isConnected && shownSessionId != null) performSessionReset(false);
            renderHistory();
            updateHistoryBadge();
            console.log('✓ All sessions cleared');
            resolve();
        };
        transaction.onerror = () => reject(transaction.error);
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
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);   // calendar days (DST-safe)
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today at ${timeStr}`;
    if (diffDays === 1) return `Yesterday at ${timeStr}`;
    if (diffDays > 1 && diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Auto-save session
let _autoSaveInProgress = false;
let _autoSaveDone = null;      // resolves with { id, gen } when the in-flight auto-save finishes
let _lastAutoSaveId = null;    // id created by the latest auto-save (used by the final save at disconnect)
let _sessionGen = 0;           // bumped by connect / reset: a late auto-save result then belongs to an older session
                               // (not by disconnect: its final save waits for that auto-save to know the record id)
async function autoSaveSession() {
    if (!isConnected || rrIntervals.length === 0 || _autoSaveInProgress) return;
    _autoSaveInProgress = true;
    const gen = _sessionGen;
    let savedId = null;
    let _finishAutoSave;
    _autoSaveDone = new Promise(r => { _finishAutoSave = r; });

    try {
        const { avgRR, rmssd } = recentWindowStats(sessionNowSeconds());

        const sessionId = await saveSession({
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
            peakHR: peakHR,
            calibrationSecs: sessionCalibrationSecs,
            device: sessionDeviceInfo,
            artifactFilter: sessionArtifactCfg,
            subjectId:    currentSubjectId,
            subjectName:  currentSubjectName,
            protocolId:   activeProtocol?.id   ?? null,
            protocolName: activeProtocol?.name ?? null
        }, currentSessionId);

        savedId = sessionId;
        if (gen !== _sessionGen) return;   // reset / new connection meanwhile: that record is finished
        _lastAutoSaveId = sessionId;
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
        _finishAutoSave({ id: savedId, gen });
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

// ══════════════════════════════════════════════════════════════════════════
// Toast notifications — non-blocking replacement for alert()
// notify(text, kind = 'info' | 'success' | 'warn' | 'error', { detail: [lines], persist, timeout })
// ══════════════════════════════════════════════════════════════════════════
function notify(text, kind = 'info', opt = {}) {
    let host = document.getElementById('toastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.setAttribute('aria-live', 'polite');
        document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.setAttribute('role', kind === 'error' || kind === 'warn' ? 'alert' : 'status');
    const icon = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '⛔' }[kind] || 'ℹ️';
    const detail = (opt.detail || []).filter(Boolean);
    el.innerHTML = `<span class="toast-icon">${icon}</span><div class="toast-body"><div class="toast-text">${escapeHTML(text)}</div>` +
        (detail.length ? `<ul class="toast-detail">${detail.map(l => `<li>${escapeHTML(l)}</li>`).join('')}</ul>` : '') +
        `</div><button class="toast-close" type="button" aria-label="Dismiss">✕</button>`;
    const close = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 250); };
    el.querySelector('.toast-close').addEventListener('click', close);
    host.appendChild(el);
    while (host.children.length > 4) host.firstElementChild.remove();
    if (!opt.persist) setTimeout(close, opt.timeout || (kind === 'error' ? 12000 : detail.length ? 9000 : 5000));
    return el;
}

// Escape user-provided text (tags, names) before it is placed in innerHTML / attributes
function escapeHTML(v) {
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Update history badge
async function updateHistoryBadge() {
    try {
        const sessions = await loadSessions();
        historyBadge.textContent = sessions.length;
        historyBadge.style.display = sessions.length ? '' : 'none';

        // Update tag filter options
        const allTags = new Set();
        sessions.forEach(s => {
            if (s.tags) s.tags.forEach(tag => allTags.add(tag));
        });

        // This runs after every auto-save: keep whatever filter the user has chosen
        const prevTag = tagFilter.value;
        const tagOptions = '<option value="">All Tags</option>' +
            Array.from(allTags).sort().map(tag =>
                `<option value="${escapeHTML(tag)}">${escapeHTML(tag)}</option>`
            ).join('');
        tagFilter.innerHTML = tagOptions;
        if (prevTag && allTags.has(prevTag)) tagFilter.value = prevTag;

        const subjectFilterEl = document.getElementById('subjectFilter');
        if (subjectFilterEl) {
            const subjects = await loadSubjects();
            const prevSubject = subjectFilterEl.value;
            subjectFilterEl.innerHTML = '<option value="">All Subjects</option>' +
                '<option value="anonymous">Anonymous</option>' +
                subjects.sort((a,b) => a.name.localeCompare(b.name))
                    .map(s => `<option value="${s.id}">${escapeHTML(s.name)}</option>`).join('');
            if (prevSubject) subjectFilterEl.value = prevSubject;
        }
    } catch (error) {
        console.error('Failed to update history badge:', error);
    }
}

// Filter and sort sessions
function filterAndSortSessions(sessions, overrides = {}) {
    const searchTerm     = (overrides.search  ?? historySearch.value).toLowerCase();
    const selectedTag    = overrides.tag     ?? tagFilter.value;
    const selectedSubject = overrides.subject ?? (document.getElementById('subjectFilter')?.value ?? '');
    const sortBy         = overrides.sort    ?? sortFilter.value;

    let filtered = sessions.filter(session => {
        const matchesSearch = !searchTerm ||
            session.filename.toLowerCase().includes(searchTerm) ||
            (session.subjectName || '').toLowerCase().includes(searchTerm) ||
            formatDate(session.startTime || session.date).toLowerCase().includes(searchTerm);
        const matchesTag = !selectedTag || (session.tags && session.tags.includes(selectedTag));
        const matchesSubject = !selectedSubject ||
            (selectedSubject === 'anonymous'
                ? !session.subjectId
                : String(session.subjectId) === selectedSubject);
        return matchesSearch && matchesTag && matchesSubject;
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
                        <div class="session-date">${escapeHTML(session.filename || 'polar-h10-data')}</div>
                        <div class="session-time">${formatDate(session.startTime || session.date)} · ${formatDuration(session.duration)}</div>
                        ${session.subjectName && session.subjectName !== 'Anonymous' ? `<div class="session-subject-chip">👤 ${escapeHTML(session.subjectName)}</div>` : ''}
                        ${session.importedFrom ? `<div class="session-source-chip" title="${escapeHTML(session.importedFrom.format || '')}">📥 Imported · ${escapeHTML(session.importedFrom.filename || '')}</div>`
                          : session.device ? `<div class="session-source-chip">${session.device.source === 'ppg' ? '⌚' : '🫀'} ${escapeHTML(describeRRSource(session.device))}</div>` : ''}
                        ${session.artifactFilter?.appliedAt ? `<div class="session-source-chip" title="${escapeHTML(describeArtifactCfg(session.artifactFilter))}">🧹 ${escapeHTML(ARTIFACT_METHODS[session.artifactFilter.method]?.label || '')}</div>` : ''}
                        ${session.tags && session.tags.length > 0 ? `
                            <div class="session-tags">
                                ${session.tags.map(tag => `<span class="session-tag">${escapeHTML(tag)}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                    <div class="session-actions">
                        <button class="session-action-btn open" data-id="${session.id}" title="Open in the Record tab">▶ Open</button>
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
                            ${sessionMetrics(session)?.mean_rr ? sessionMetrics(session).mean_rr.toFixed(1) : '--'}
                            <span class="session-stat-unit">ms</span>
                        </div>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-label">RMSSD</div>
                        <div class="session-stat-value">
                            ${sessionMetrics(session)?.rmssd ? sessionMetrics(session).rmssd.toFixed(1) : '--'}
                            <span class="session-stat-unit">ms</span>
                        </div>
                    </div>
                    <div class="session-stat sri-el">
                        <div class="session-stat-label">SRI</div>
                        <div class="session-stat-value ${sriClassOf(sessionSRI(session).score)}">
                            ${sessionSRI(session).score > 0 ? sessionSRI(session).score : '--'}
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

        document.querySelectorAll('.session-action-btn.open').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); restoreSession(parseInt(btn.dataset.id)); });
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
                if (await confirmAndDeleteSession(parseInt(btn.dataset.id))) {
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
        const existing = new Set(sessions.map(s => s.id));
        [...historySelectedIds].forEach(id => { if (!existing.has(id)) historySelectedIds.delete(id); });
        const filtered = filterAndSortSessions(sessions);

        if (filtered.length === 0) {
            historyTableBody.innerHTML = `
                <tr><td colspan="12" style="text-align:center; padding:32px; color:var(--text-tertiary);">
                    No sessions found
                </td></tr>`;
            updateHistorySelectionBar();
            return;
        }

        historyTableBody.innerHTML = filtered.map(session => {
            const sriVal   = sessionSRI(session).score;
            const sriClass = sriClassOf(sriVal);
            const tagsHtml = session.tags?.length
                ? session.tags.map(t => `<span class="session-tag">${escapeHTML(t)}</span>`).join('')
                : '<span style="color:var(--text-tertiary)">—</span>';

            return `
            <tr class="table-row" data-id="${session.id}">
                <td><input type="checkbox" class="row-select" data-id="${session.id}" ${historySelectedIds.has(session.id) ? 'checked' : ''}></td>
                <td class="table-date">${formatDate(session.startTime || session.date)}</td>
                <td class="table-name">${escapeHTML(session.filename || 'polar-h10-data')}</td>
                <td>${session.subjectName && session.subjectName !== 'Anonymous' ? `<span class="session-subject-chip">👤 ${escapeHTML(session.subjectName)}</span>` : '<span style="color:var(--text-tertiary)">—</span>'}</td>
                <td>${formatDuration(session.duration)}</td>
                <td>${session.stats.samples}</td>
                <td>${sessionMetrics(session)?.mean_rr ? sessionMetrics(session).mean_rr.toFixed(1) + ' ms' : '—'}</td>
                <td>${sessionMetrics(session)?.rmssd ? sessionMetrics(session).rmssd.toFixed(1) + ' ms' : '—'}</td>
                <td class="sri-el ${sriClass}" style="font-weight:700;">${sriVal > 0 ? sriVal : '—'}</td>
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

        // Selection: header box = all listed rows; the bar acts on the ticked rows
        const allBox = document.getElementById('selectAllRows');
        allBox.checked = filtered.every(s => historySelectedIds.has(s.id));
        allBox.onchange = (e) => {
            filtered.forEach(s => e.target.checked ? historySelectedIds.add(s.id) : historySelectedIds.delete(s.id));
            historyTableBody.querySelectorAll('.row-select').forEach(cb => cb.checked = e.target.checked);
            updateHistorySelectionBar();
        };
        historyTableBody.querySelectorAll('.row-select').forEach(cb => cb.addEventListener('change', () => {
            const id = parseInt(cb.dataset.id);
            cb.checked ? historySelectedIds.add(id) : historySelectedIds.delete(id);
            allBox.checked = filtered.every(s => historySelectedIds.has(s.id));
            updateHistorySelectionBar();
        }));
        updateHistorySelectionBar();

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
                if (await confirmAndDeleteSession(parseInt(btn.dataset.id))) {
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
                    await updateSession(id, { filename: newName.trim() });
                    if (id === shownSessionId && shownSessionMeta) {
                        shownSessionMeta.name = newName.trim();
                        document.getElementById('filename').value = newName.trim();
                        updateSessionBanner();
                    }
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

        calibrationStartTime = null;          // exports / report must use the restored session's own start
        lastCWTResult = null;                 // never reuse another session's CWT for LF/HF
        _cwtLastUpdate = 0;                   // and let the spectrogram redraw immediately
        switchTab('record');                  // show the Record tab BEFORE drawing into its charts

        eventMarkers = [...session.eventMarkers];
        sessionAnnotations = session.annotations || [];
        sessionTags = session.tags || [];
        sessionStartTime = session.startTime || session.timestamp;
        sessionCalibrationSecs = session.calibrationSecs ?? null;
        sessionDeviceInfo = session.device ?? null;
        sessionArtifactCfg = session.artifactFilter ?? null;
        shownSessionId = session.id;
        shownSessionMeta = { name: session.filename || 'Session', startTime: session.startTime || session.timestamp, duration: session.duration || 0,
                             subject: session.subjectName && session.subjectName !== 'Anonymous' ? session.subjectName : '' };
        sessionImportInfo = session.importedFrom ?? null;

        // Calculate or restore SRI using the SAME function
        const sriResult = appSettings.showSRI === false ? null : calculateSRI(rrIntervals, timestamps);
        if (sriResult) {
            sriScore = sriResult.score;
            sriComponents = sriResult.components;
            peakHR = sriResult.peakHR;

            // If session didn't have SRI, save it now
            if (!session.sri || session.sri === 0) {
                console.log(`✓ SRI calculated for historical session: ${sriScore}`);
                await updateSession(session.id, { sri: sriScore, sriComponents, peakHR });
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
        setChartPlaceholder('ecgChart', '〰️', 'The ECG is shown only while recording live (it is not stored)');
        const mHR = sessionMetrics(session);                   // no live heart rate: show the session mean
        hrValue.textContent = mHR ? Math.round(mHR.mean_hr) : '--';
        hrValue.title = 'Mean heart rate of the saved session';
        updateSessionBanner();

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
        const filename = `${session.filename || 'polar-h10'}_${dateStr}${tagsStr}`.replace(/[\\/:*?"<>|]+/g, '-');

        const csv = storedSessionCSV(session);   // stored sessions are always exported as clean data

        // Use robust download function
        downloadFile(csv, `${filename}.csv`, 'text/csv');
    } catch (error) {
        console.error('Failed to download session:', error);
    }
}

// Bulk download all filtered sessions
async function bulkDownloadSessions(opts = {}) {
    if (!opts || opts instanceof Event) opts = {};
    const sessions = await loadSessions();
    const filtered = opts.ids
        ? filterAndSortSessions(sessions, { search: '', tag: '', subject: '' }).filter(s => opts.ids.has(s.id))
        : filterAndSortSessions(sessions, opts);
    if (filtered.length === 0) { notify(opts.ids ? 'No sessions selected.' : 'No sessions match the current filters.', 'warn'); return; }

    const format = bulkFormatSelect.value;
    bulkDownloadBtn.disabled = true;
    bulkDownloadBtn.textContent = '⏳ Preparing...';

    try {
        const zip = new JSZip();
        const usedNames = new Set();

        for (const session of filtered) {
            const sessionDate = new Date(session.startTime || session.timestamp);
            const dateStr = sessionDate.toISOString().slice(0, 16);
            const tagsStr = session.tags?.length ? '_' + session.tags.join('-') : '';
            const baseName = uniqueZipName(usedNames, `${session.filename || 'polar-h10'}_${dateStr}${tagsStr}`);

            let content, ext;

            if (format === 'txt') {
                content = session.rrIntervals.map(rr => rr.toFixed(3)).join('\n');
                ext = 'txt';
            } else { // csv (default)
                content = storedSessionCSV(session);
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

// ══════════════════════════════════════════════════════════════════════════
// RR file import — TXT / CSV / TSV from CardioTrace, Kubios, Elite HRV and other apps.
// Imported files become ordinary stored sessions (raw = file values, clean = same artifact filter as live).
// ══════════════════════════════════════════════════════════════════════════
// RFC 4180 reader (quoted fields may contain the delimiter, quotes and line breaks)
function parseDelimited(text, delim) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
            else field += c;
        } else if (c === '"') q = true;
        else if (c === delim) { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function parseNumberLoose(v, decimalComma) {
    let t = String(v ?? '').trim().replace(/^"|"$/g, '');
    if (decimalComma) t = t.replace(',', '.');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
    return Number(t);
}
function _median(a) {   // pandas-style median (mean of the two middle values for an even count)
    const b = Array.from(a).sort((x, y) => x - y), n = b.length;
    if (!n) return NaN;
    return n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2;
}

// Returns { rr (ms), times (s) | null, events, name, tags, startTime, calibrationSecs, device, format }
function parseRRFile(text, fileName = '') {
    text = String(text).replace(/^﻿/, '');
    const out = { rr: [], times: null, events: [], name: null, tags: [], startTime: null, calibrationSecs: null, device: null, format: '' };

    // 1) CardioTrace CSV (metadata header + Timestamp / RR / Event / Annotation)
    const ctStart = text.search(/^Timestamp \(s\),RR Interval \(ms\)/m);
    if (ctStart >= 0) {
        const meta = {};
        text.slice(0, ctStart).split(/\r?\n/).forEach(l => { const m = l.match(/^#\s*([^:]+):\s*(.*)$/); if (m) meta[m[1].trim()] = m[2].trim(); });
        const rows = parseDelimited(text.slice(ctStart), ',').slice(1);
        out.times = [];
        for (const r of rows) {
            const t = parseNumberLoose(r[0]), v = parseNumberLoose(r[1]);
            if (!isFinite(t) || !isFinite(v)) continue;
            out.rr.push(v); out.times.push(t);
            const types = (r[2] || '').split(' | '), notes = (r[3] || '').split(' | ');
            types.forEach((type, k) => {
                if (!type) return;
                const annotation = notes[k] || '';
                out.events.push({ time: t, type, annotation, label: type + (annotation ? `: ${annotation}` : '') });
            });
        }
        if (meta.Date) { const d = Date.parse(meta.Date.replace(' ', 'T') + 'Z'); if (isFinite(d)) out.startTime = d; }
        if (meta.Filename) out.name = meta.Filename;
        if (meta.Tags && meta.Tags !== 'None') out.tags = meta.Tags.split(', ').filter(Boolean);
        const cal = parseFloat(meta['Calibration Period']); if (isFinite(cal)) out.calibrationSecs = cal;
        if (meta.Device && meta.Device !== 'not recorded') {
            const [name, label] = meta.Device.split(' — ');
            out.device = { name, source: Object.keys(RR_SOURCES).find(k => RR_SOURCES[k] === label) || 'unknown' };
        }
        out.format = `CardioTrace CSV${/^Raw/.test(meta['Data Type'] || '') ? ' (raw)' : ''}`;
        return out;
    }

    // 2) Generic: one value per line, or a delimited table with an RR column
    const lines = text.split(/\r\n|\n|\r/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const sample = lines.slice(0, 60);
    // A single column written with decimal commas ("0,812"): every numeric line is exactly one such number
    const numericSample = sample.filter(l => /\d/.test(l));
    // ...and read that way the values look like RR in s or ms (otherwise "1,812" is a two-column CSV row)
    const dcMedian = _median(numericSample.map(l => parseNumberLoose(l, true)));
    const decimalCommaOnly = numericSample.length > 0 && numericSample.every(l => /^[-+]?\d+,\d+$/.test(l)) &&
        ((dcMedian >= 0.25 && dcMedian <= 2) || (dcMedian >= 250 && dcMedian <= 2000));
    let delim = null;
    if (!decimalCommaOnly) {
        for (const d of ['\t', ';', ',']) {
            const n = sample.filter(l => l.includes(d)).length;
            if (n >= Math.max(1, sample.length * 0.8)) { delim = d; break; }
        }
        // Columns separated by spaces (e.g. Kubios text exports): normalise to tabs
        if (!delim && numericSample.filter(l => /\S\s+\S/.test(l)).length >= Math.max(1, numericSample.length * 0.8)) {
            delim = '\t';
            for (let k = 0; k < lines.length; k++) lines[k] = lines[k].replace(/\s+/g, '\t');
        }
    }
    let values = [], colName = '';
    if (!delim) {
        values = lines.map(l => parseNumberLoose(l, true));
        out.format = 'RR list (one value per line)';
    } else {
        const rows = parseDelimited(lines.join('\n'), delim).map(r => r.map(x => x.trim()));
        const decComma = delim !== ',';
        const isNumRow = r => r.some(x => isFinite(parseNumberLoose(x, decComma)));
        const header = rows.length && rows[0].some(x => x && !isFinite(parseNumberLoose(x, decComma))) ? rows[0] : null;
        const data = (header ? rows.slice(1) : rows).filter(isNumRow);
        const ncol = Math.max(0, ...data.slice(0, 50).map(r => r.length));
        const cols = [];
        for (let j = 0; j < ncol; j++) {
            const v = data.map(r => parseNumberLoose(r[j], decComma));
            const fin = v.filter(isFinite);
            if (fin.length < data.length * 0.5) continue;
            const med = _median(fin);
            let mono = fin.length > 20;
            for (let i = 1; i < fin.length && mono; i++) if (fin[i] < fin[i - 1]) mono = false;
            cols.push({ j, v, name: header ? header[j] || '' : '', plausible: ((med >= 250 && med <= 2000) || (med >= 0.25 && med <= 2)) && !mono });
        }
        const named = cols.find(c => /(^|[^a-z])(rr|rri|ibi|nn|ppi|r-r|interval|beat)/i.test(c.name) && !/time|stamp|date|bpm|\bhr\b/i.test(c.name));
        const pick = named || cols.find(c => c.plausible);
        if (!pick) throw new Error('no column that looks like RR intervals');
        values = pick.v; colName = pick.name;
        out.format = `${delim === '\t' ? 'TSV' : 'CSV'} table${colName ? ` (column "${colName}")` : ` (column ${pick.j + 1})`}`;
        if (/\(s\)|\bsec|\bs\b/i.test(colName) && !/ms/i.test(colName)) values = values.map(x => x * 1000);
        else if (!/ms/i.test(colName) && _median(values.filter(isFinite)) < 10) values = values.map(x => x * 1000);
    }
    values = values.filter(v => isFinite(v) && v > 0);
    if (!delim && _median(values) < 10) values = values.map(v => v * 1000);     // RR in seconds (e.g. Kubios)
    out.rr = values;
    return out;
}

// ── Garmin / ANT FIT files ────────────────────────────────────────────────
// Minimal reader of the FIT binary format (no library): walks every record, keeps the beat-to-beat intervals of
// the HRV message (global 78, field 0 "time": uint16 array in ms, 0xFFFF = invalid) and the start time (session
// start_time, else the first record / file_id time). Handles both byte orders, developer fields and compressed
// timestamp headers. Garmin writes HRV messages when beat-to-beat / HRV logging is enabled on the device.
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);
function isFitFile(buf) {
    const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
    return b.length >= 12 && b[8] === 0x2E && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54;   // ".FIT"
}
function parseFitFile(buf) {
    const dv = new DataView(buf);
    if (!isFitFile(buf)) throw new Error('not a FIT file');
    const hdr = dv.getUint8(0);
    const declared = hdr + dv.getUint32(4, true);
    const truncated = declared > buf.byteLength;                       // copied / downloaded only partly
    const end = Math.min(buf.byteLength, declared);
    const defs = {};
    const rr = [];
    let sessionStart = null, firstRecordTs = null, fileCreated = null;
    let off = hdr;
    while (off < end) {
        const h = dv.getUint8(off++);
        let local, isDef = false, hasDev = false;
        if (h & 0x80) local = (h >> 5) & 0x03;                              // compressed timestamp header (data)
        else { local = h & 0x0F; isDef = !!(h & 0x40); hasDev = !!(h & 0x20); }
        if (isDef) {
            if (off + 5 > end) break;
            const le = dv.getUint8(off + 1) === 0;
            const global = dv.getUint16(off + 2, le);
            const nf = dv.getUint8(off + 4);
            off += 5;
            const fields = [];
            for (let i = 0; i < nf; i++, off += 3) fields.push({ num: dv.getUint8(off), size: dv.getUint8(off + 1) });
            let devBytes = 0;
            if (hasDev) { const nd = dv.getUint8(off++); for (let i = 0; i < nd; i++, off += 3) devBytes += dv.getUint8(off + 1); }
            defs[local] = { le, global, fields, devBytes };
            continue;
        }
        const d = defs[local];
        if (!d) throw new Error('corrupt FIT file (data before its definition)');
        let p = off;
        for (const f of d.fields) {
            if (p + f.size > end) break;
            if (d.global === 78 && f.num === 0) {
                for (let k = 0; k + 1 < f.size; k += 2) { const v = dv.getUint16(p + k, d.le); if (v !== 0xFFFF && v > 0) rr.push(v); }
            } else if (f.size === 4 && ((d.global === 18 && f.num === 2) || (d.global === 20 && f.num === 253) || (d.global === 0 && f.num === 4))) {
                const t = dv.getUint32(p, d.le);
                if (t !== 0xFFFFFFFF && t > 0) {
                    const ms = FIT_EPOCH_MS + t * 1000;
                    if (d.global === 18 && sessionStart === null) sessionStart = ms;
                    else if (d.global === 20 && firstRecordTs === null) firstRecordTs = ms;
                    else if (d.global === 0 && fileCreated === null) fileCreated = ms;
                }
            }
            p += f.size;
        }
        off += d.fields.reduce((a, f) => a + f.size, 0) + d.devBytes;
    }
    if (!rr.length) throw new Error('this FIT file has no beat-to-beat (HRV) data — enable HRV / beat-to-beat logging on the device and record with a chest strap');
    return { rr, times: null, events: [], name: null, tags: [], startTime: sessionStart ?? firstRecordTs ?? fileCreated,
             calibrationSecs: null, device: null, format: `Garmin FIT (HRV messages)${truncated ? ' — TRUNCATED file, partial data' : ''}` };
}

// Build the stored-session record of one parsed file (pure: no globals except the active subject)
function buildImportedSession(parsed, file) {
    const raw = parsed.rr;
    if (raw.length < 10) throw new Error(`only ${raw.length} RR values found`);
    const plausible = raw.filter(v => v >= 250 && v <= 2000).length;
    if (plausible < raw.length * 0.5) throw new Error('the values do not look like RR intervals (expected ms or s)');
    let times = parsed.times;
    if (!times || times.length !== raw.length) {                       // beat times from cumulative RR
        times = []; let acc = 0;
        for (const v of raw) { acc += v / 1000; times.push(Math.round(acc * 1000) / 1000); }
    }
    const clean = cleanRRData(raw, times);
    const duration = Math.max(0, Math.round(times[times.length - 1] || 0));
    const startEstimated = parsed.startTime == null;
    const startTime = startEstimated ? (file.lastModified || Date.now()) - duration * 1000 : parsed.startTime;
    const sri = clean.rr.length >= 50 ? calculateSRI(clean.rr, clean.times) : null;
    const m = computeSessionMetrics({ rrIntervals: clean.rr, rawRRIntervals: raw });
    return {
        timestamp: startTime + duration * 1000, date: new Date(startTime + duration * 1000).toISOString(),
        startTime, duration,
        filename: parsed.name || String(file.name || 'imported').replace(/\.[^.]+$/, '') || 'imported',
        rrIntervals: clean.rr, timestamps: clean.times, rawRRIntervals: raw, rawTimestamps: times,
        eventMarkers: parsed.events, annotations: parsed.events.map(e => ({ ...e })), tags: parsed.tags,
        avgRR: m ? m.mean_rr : null, rmssd: m ? m.rmssd : null,
        sri: sri ? sri.score : 0, sriComponents: sri ? sri.components : { rmssd: 0, lfhf: 0, hrRecovery: 0 }, peakHR: sri ? sri.peakHR : 0,
        calibrationSecs: parsed.calibrationSecs, device: parsed.device,
        importedFrom: { filename: file.name || '', format: parsed.format, importedAt: new Date().toISOString(), startEstimated },
        subjectId: currentSubjectId, subjectName: currentSubjectName, protocolId: null, protocolName: null
    };
}

async function importRRFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!requireDB()) return;
    const lines = [];
    for (const file of files) {
        try {
            const buf = await file.arrayBuffer();
            const parsed = (/\.fit$/i.test(file.name || '') || isFitFile(buf))
                ? parseFitFile(buf)
                : parseRRFile(new TextDecoder().decode(buf), file.name);
            const rec = buildImportedSession(parsed, file);
            await saveSession(rec);
            const q = rec.rawRRIntervals.length ? Math.round(rec.rrIntervals.length / rec.rawRRIntervals.length * 1000) / 10 : 0;
            lines.push(`✓ ${file.name}: ${rec.rawRRIntervals.length} intervals, ${rec.rrIntervals.length} kept by the artifact filter (${q} %) — ${parsed.format}` +
                (rec.importedFrom.startEstimated ? '; start time estimated from the file date' : ''));
        } catch (e) {
            lines.push(`✗ ${file.name}: ${e.message || e}`);
        }
    }
    await updateHistoryBadge();
    if (currentTab === 'history') await renderHistory();
    const failed = lines.filter(l => l.startsWith('✗')).length, okN = lines.length - failed;
    notify(`Imported ${okN} of ${lines.length} file(s)${okN && currentSubjectName !== 'Anonymous' ? ` — assigned to ${currentSubjectName}` : ''}`,
        failed ? (okN ? 'warn' : 'error') : 'success', { detail: lines });
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

    // Same time reference as RR / ECG: negative while still calibrating
    const ref = calibrationStartTime ?? calibrationEndTime;
    const currentTime = ref ? (Date.now() - ref) / 1000 : 0;
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
            <span class="annotation-text">${escapeHTML(ann.type)}${ann.annotation ? ': ' + escapeHTML(ann.annotation) : ''}</span>
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
            ${escapeHTML(tag)}
            <span class="tag-chip-remove" data-tag="${escapeHTML(tag)}">✕</span>
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
        x: [], y: [], type: 'scattergl', mode: 'markers', name: 'RR Points',   // WebGL: ~10x cheaper than 1 SVG node per beat
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
    colorscale: 'Plasma',
    reversescale: false,
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
disconnectBtn.addEventListener('click', () => disconnect());
resetBtn.addEventListener('click', resetSession);
exportBtn.addEventListener('click', exportData);
copyBtn.addEventListener('click', copyToClipboard);
reportBtn.addEventListener('click', generatePDFReport);
timestampBtn.addEventListener('click', openEventTypePanel);
cinemaToggle.addEventListener('click', toggleCinemaMode);
themeToggle.addEventListener('click', toggleTheme);

eventTypeClose.addEventListener('click', closeEventTypePanel);
eventTypeOverlay.addEventListener('click', closeEventTypePanel);
addEventBtn.addEventListener('click', addEventMarker);
addTagBtn.addEventListener('click', addTag);
clearAllBtn.addEventListener('click', clearAllSessions);
bulkDownloadBtn.addEventListener('click', () => bulkDownloadSessions());
document.getElementById('importRRBtn')?.addEventListener('click', () => document.getElementById('importRRFile').click());
document.getElementById('importRRFile')?.addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';                                  // allow importing the same file again
    await importRRFiles(files);
});

// Protocol management
document.getElementById('changeProtocolBtn').addEventListener('click', openProtocolPicker);
document.getElementById('startProtocolBtn').addEventListener('click', () => { if (activeProtocol && isRecordingLive()) startProtocolRunner(); });
document.getElementById('protocolPickerClose').addEventListener('click', closeProtocolPicker);
document.getElementById('protocolPickerOverlay').addEventListener('click', closeProtocolPicker);
document.getElementById('freeRecordingBtn').addEventListener('click', selectFreeRecording);
document.getElementById('createProtocolBtn').addEventListener('click', () => openProtocolEditor(null));
document.getElementById('protocolEditorClose').addEventListener('click', closeProtocolEditor);
document.getElementById('protocolEditorOverlay').addEventListener('click', closeProtocolEditor);
document.getElementById('addPhaseBtn').addEventListener('click', addEditorPhase);
document.getElementById('saveProtocolBtn').addEventListener('click', saveProtocolFromEditor);
document.getElementById('cancelProtocolEditorBtn').addEventListener('click', closeProtocolEditor);
document.getElementById('protocolSkipBtn').addEventListener('click', skipProtocolPhase);
document.getElementById('protocolStopBtn').addEventListener('click', stopProtocolRunner);

// Recording modes
document.getElementById('focusModeBtn').addEventListener('click', toggleFocusMode);
document.getElementById('biofeedbackModeBtn').addEventListener('click', toggleBiofeedbackMode);
document.getElementById('monitorWindowBtn').addEventListener('click', openMonitorWindow);
document.getElementById('biofeedbackExitBtn').addEventListener('click', exitBiofeedbackMode);

// Analyze tab
document.querySelectorAll('.analyze-subtab').forEach(btn => {
    btn.addEventListener('click', () => switchAnalyzeSubtab(btn.dataset.subtab));
});
document.getElementById('analyzeSubjectFilter')?.addEventListener('change', () => {
    if (analyzeCurrentSubtab === 'trends')  renderTrendsView();
    if (analyzeCurrentSubtab === 'summary') renderSummaryView();
});
document.getElementById('analyzeRefreshBtn')?.addEventListener('click', renderAnalyzeTab);
document.getElementById('comparisonMetric')?.addEventListener('change', renderComparisonChart);

// Export tab
document.getElementById('exportSubjectFilter')?.addEventListener('change', renderExportTab);
document.getElementById('exportTagFilter')?.addEventListener('change', renderExportTab);
document.getElementById('exportSortFilter')?.addEventListener('change', renderExportTab);
document.getElementById('exportSelectAllBtn')?.addEventListener('click', selectAllExportSessions);
document.getElementById('exportDeselectAllBtn')?.addEventListener('click', deselectAllExportSessions);
document.getElementById('exportSummaryBtn')?.addEventListener('click', exportSelectedSummaryCSV);
document.getElementById('exportZipBtn')?.addEventListener('click', exportSelectedZip);
document.getElementById('exportJsonBtn')?.addEventListener('click', exportSelectedJSON);

// Subject management
document.getElementById('changeSubjectBtn').addEventListener('click', openSubjectPicker);
document.getElementById('subjectPickerClose').addEventListener('click', closeSubjectPicker);
document.getElementById('subjectPickerOverlay').addEventListener('click', closeSubjectPicker);
document.getElementById('addAndSelectSubjectBtn').addEventListener('click', addAndSelectSubject);
document.getElementById('addSubjectBtn').addEventListener('click', openAddSubjectForm);
document.getElementById('subjectEditClose').addEventListener('click', closeSubjectEdit);
document.getElementById('subjectEditOverlay').addEventListener('click', closeSubjectEdit);
document.getElementById('saveSubjectEditBtn').addEventListener('click', saveSubjectEdit);
document.getElementById('cancelSubjectEditBtn').addEventListener('click', closeSubjectEdit);
document.getElementById('subjectFilter')?.addEventListener('change', renderHistory);
document.getElementById('newSubjectAge').addEventListener('keypress', e => { if (e.key === 'Enter') addAndSelectSubject(); });
document.getElementById('newSubjectName').addEventListener('keypress', e => { if (e.key === 'Enter') document.getElementById('newSubjectAge').focus(); });

// Tab bar navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.classList.contains('tab-btn--soon')) return;
        switchTab(btn.dataset.tab);
    });
});

historySearch.addEventListener('input', renderHistory);
tagFilter.addEventListener('change', renderHistory);
sortFilter.addEventListener('change', renderHistory);

// View toggle tabs
tabCards.addEventListener('click', () => {
    closeHistoryTable();
});

tabTable.addEventListener('click', () => {
    openHistoryTable();
});

function openHistoryTable() {
    currentHistoryView = 'table';
    tabCards.classList.remove('active');
    tabTable.classList.add('active');
    document.getElementById('historyCardsView').style.display = 'none';
    document.getElementById('historyTableView').style.display = '';
    renderHistoryTable();
}

function closeHistoryTable() {
    currentHistoryView = 'cards';
    tabCards.classList.add('active');
    tabTable.classList.remove('active');
    document.getElementById('historyCardsView').style.display = '';
    document.getElementById('historyTableView').style.display = 'none';
    renderHistory();
}

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
        appSettings.artifactMethod = 'delta';
        updateArtifactSettingsSummary();
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
    stopProtocolRunner();
    exitFocusMode();
    exitBiofeedbackMode();
    updateModesAvailability();

    // Clear all data arrays
    rrIntervals = [];
    timestamps = [];
    rawRRIntervals = [];
    rawTimestamps = [];
    _rrRun = [];
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
    _sessionGen++;
    if (!isConnected) {
        sessionDeviceInfo = null; sessionImportInfo = null; sessionArtifactCfg = null; shownSessionId = null;   // nothing live: the shown session is gone
        // Nothing is streaming: no baseline until the next connect() finishes calibrating
        calibrationStartTime = null;
        calibrationEndTime = null;
        isCalibrating = false;
    } else if (!isCalibrating) {
        calibrationStartTime = Date.now();   // live session: restart the time axis now
    }                                        // still calibrating: leave calibration untouched
    lastCWTResult = null;
    _cwtLastUpdate = 0;
    ecgClockT = null;
    _lastAutoSaveId = null;

    // Reset UI
    hrValue.textContent = '--'; hrValue.title = '';
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
    shownSessionMeta = isConnected ? null : shownSessionMeta;
    updateSessionBanner();

    return true;
}

// Connect to device
async function connect() {
    if (!navigator.bluetooth) {
        status.textContent = 'Bluetooth Not Supported';
        notify('Web Bluetooth needs Chrome or Edge on desktop / Android over HTTPS. You can still import RR files from History.', 'error', { persist: true });
        return;
    }
    try {
        status.textContent = 'Scanning...';
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [HR_SERVICE] }],
            optionalServices: [PMD_SERVICE, BATTERY_SERVICE]
        });

        device.removeEventListener('gattserverdisconnected', onGattDisconnected);
        device.addEventListener('gattserverdisconnected', onGattDisconnected);

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
            await pmdControlChar.writeValueWithResponse(new Uint8Array([0x01, 0x00]));
            setTimeout(async () => {
                try {
                    const startECG = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00]);
                    await pmdControlChar.writeValueWithResponse(startECG);
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
        _sessionGen++;
        lastPacketTime = Date.now();

        // Device / RR source of this recording
        sessionDeviceInfo = { name: device.name || 'Unknown device', source: classifyRRSource(device.name) };
        sessionImportInfo = null;
        _hrPacketsWithoutRR = 0;
        clearDeviceNotice();
        if (sessionDeviceInfo.source === 'ppg') {
            showDeviceNotice('Pulse-derived intervals (PPG): less precise than a chest strap and sensitive to movement. ' +
                'Check data quality and interpret HRV indices with caution.', 'info');
        }
        clearTimeout(_ecgCheckTimer);
        _ecgCheckTimer = setTimeout(() => {          // ECG is Polar-only: say so instead of an empty plot
            if (isConnected && ecgData.length === 0) setChartPlaceholder('ecgChart', '〰️', 'ECG not available for this device');
        }, 6000);

        sessionArtifactCfg = liveArtifactCfg();      // fixed for this recording: one criterion per session
        shownSessionId = null;

        // Start calibration period
        _rrRun = [];
        isCalibrating = true;
        sessionCalibrationSecs = appSettings.calibrationSecs || 8;
        calibrationEndTime = Date.now() + sessionCalibrationSecs * 1000;
        calibrationStartTime = null; // Reset
        status.textContent = 'Calibrating...';
        status.classList.add('calibrating');

        // Update status after calibration
        clearTimeout(calibrationTimeout);
        calibrationTimeout = setTimeout(() => {
            if (isConnected) {
                isCalibrating = false;
                calibrationStartTime = Date.now(); // Set the baseline for all timestamps
                status.textContent = 'Connected';
                status.classList.remove('calibrating');
                console.log('✓ Calibration complete - recording started');
                status.classList.add('connected');
                if (activeProtocol) startProtocolRunner();
                updateModesAvailability();
                broadcastMonitorUpdate();
            }
        }, sessionCalibrationSecs * 1000);

        startRecordingTimer();
        startSignalMonitor();
        acquireWakeLock();
        startAutoSave();

        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        updateSessionBanner();
        exportBtn.disabled = false;
        copyBtn.disabled = false;
        reportBtn.disabled = false;
        timestampBtn.disabled = false;
        signalIndicator.style.display = 'flex';
    } catch (error) {
        console.error('Connection failed:', error);
        status.textContent = 'Connection Failed';
        // A failure after gatt.connect() would otherwise leave the strap linked (and streaming) with no session
        if (!isConnected && device?.gatt?.connected) { try { device.gatt.disconnect(); } catch (e) { /* ignore */ } }
    }
}

// Fired by the browser when the GATT link drops (out of range, strap removed, battery)
function onGattDisconnected() {
    if (!isConnected) return;            // user-initiated: disconnect() already cleaned up
    disconnect(true);                    // saves the session and resets the UI
    status.textContent = 'Connection lost — session saved';
}

// Disconnect
function disconnect(skipConfirm = false) {
    if (skipConfirm || confirm('Disconnect device? Data will be saved to history.')) {
        stopAutoSave();
        clearTimeout(calibrationTimeout);
        clearTimeout(_ecgCheckTimer);
        clearDeviceNotice();
        setChartPlaceholder('ecgChart', null);
        stopSignalMonitor();
        releaseWakeLock();
        lastCWTResult = null; _cwtLastUpdate = 0; ecgClockT = null;
        stopProtocolRunner();
        exitFocusMode();
        exitBiofeedbackMode();
        if (monitorChannel) { broadcastMonitorUpdate(); }
        updateModesAvailability();
        if (device) {
            if (rrIntervals.length > 0) {
                // final save: anchor to the last recorded beat (the link may have been down for a while)
                const { avgRR, rmssd } = recentWindowStats(timestamps[timestamps.length - 1]);
                const finalSid = currentSessionId;
                const finalPayload = {
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
                    peakHR: peakHR,
                    calibrationSecs: sessionCalibrationSecs,
                    device: sessionDeviceInfo,
                    artifactFilter: sessionArtifactCfg,
                    subjectId:    currentSubjectId,
                    subjectName:  currentSubjectName,
                    protocolId:   activeProtocol?.id   ?? null,
                    protocolName: activeProtocol?.name ?? null
                };
                // If the very first auto-save is still in flight, wait for it and update ITS record
                // instead of creating a duplicate session.
                // Only an auto-save of THIS recording (same generation) may give the record id.
                const gen = _sessionGen;
                const pending = _autoSaveInProgress ? _autoSaveDone : Promise.resolve({ id: _lastAutoSaveId, gen });
                pending.then(r => saveSession(finalPayload, finalSid || (r && r.gen === gen ? r.id : null))).then(() => {
                    _lastAutoSaveId = null;
                    console.log('✓ Session saved to history');
                    updateHistoryBadge();
                }).catch(err => {
                    console.error('Final save failed:', err);
                    notify('The session could not be saved to History (' + (err && err.message || err) + '). Export it before closing the page.', 'error', { persist: true });
                });
            }
            if (device.gatt.connected) device.gatt.disconnect();
        }
        isConnected = false;
        currentSessionId = null;
        isCalibrating = false;
        calibrationEndTime = null;
        calibrationStartTime = null;   // the final-save payload above already holds it; a stale value
                                       // would date later exports of restored sessions with this recording
        stopRecordingTimer();

        rrIntervals = [];
        timestamps = [];
        rawRRIntervals = [];
        rawTimestamps = [];
        _rrRun = [];
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

        hrValue.textContent = '--'; hrValue.title = '';
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
        updateSessionBanner();
    }
}

// Reset session
function resetSession() {
    performSessionReset(isConnected);    // a saved session shown offline stays in History: closing it loses nothing
    console.log('✓ Session reset');
}

// Recording timer
function startRecordingTimer() {
    if (timerInterval) clearInterval(timerInterval);
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

// Display-only min/max decimation: keeps peaks/artifacts visible, never touches stored data.
const MAX_DISPLAY_POINTS = 1600;
function decimateXY(x, y, maxPts = MAX_DISPLAY_POINTS) {
    const n = x.length;
    if (n <= maxPts) return [x.slice(), y.slice()];   // copies: Plotly keeps references
    const buckets = Math.floor(maxPts / 2), size = n / buckets;
    const ox = [], oy = [];
    for (let b = 0; b < buckets; b++) {
        const s = Math.floor(b * size), e = Math.min(n, Math.floor((b + 1) * size));
        if (s >= e) continue;
        let lo = s, hi = s;
        for (let i = s + 1; i < e; i++) { if (y[i] < y[lo]) lo = i; if (y[i] > y[hi]) hi = i; }
        const a = Math.min(lo, hi), c = Math.max(lo, hi);
        ox.push(x[a]); oy.push(y[a]);
        if (c !== a) { ox.push(x[c]); oy.push(y[c]); }
    }
    return [ox, oy];
}

// Catch-up redraw after the Record tab / browser tab becomes visible again
function refreshAllCharts() {
    if (currentTab !== 'record') return;
    if (rrIntervals.length > 0) {
        updateRRChart(); updateRollingRMSSD(); updatePoincareChart();
        updateHRChart(); updateVagalProxyChart();
        _cwtLastUpdate = 0; updateSpectrogramChart();
    }
    updateECGChart();
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (isConnected) acquireWakeLock();      // the lock is released automatically when the tab hides
    requestAnimationFrame(() => { resizeAllCharts(); refreshAllCharts(); });
});

function shouldUpdateChart(chartType) {
    if (document.hidden || currentTab !== 'record') return false;   // never draw into hidden containers
    const now = Date.now();
    if (now - chartUpdateThrottle[chartType] >= (CHART_INTERVALS[chartType] ?? CHART_UPDATE_INTERVAL)) {
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

// ── RR source / device description ───────────────────────────────────────
// Any device exposing the standard Bluetooth Heart Rate service (0x180D) can stream RR intervals.
// The kind of sensor cannot be read from the standard profile: it is inferred from the ECG stream (Polar PMD)
// or from well-known product names, and is 'unknown' otherwise.
const RR_SOURCES = {
    ecg:     'ECG chest strap',
    ppg:     'optical pulse sensor (PPG)',
    unknown: 'unknown sensor (standard BLE Heart Rate profile)',
    file:    'imported file'
};
function classifyRRSource(name) {
    const n = String(name || '');
    if (/verity|\bOH1\b|rhythm|scosche|whoop|forerunner|fenix|f[eē]nix|venu|vivo|instinct|epix|enduro|amazfit|mi band|coros|ignite|vantage|grit|pacer|unite|watch/i.test(n)) return 'ppg';
    if (/\bH(10|9|7|6)\b|\bHRM|tickr|polar h|coospo h|magene h|movesense|suunto smart|chest|strap/i.test(n)) return 'ecg';
    return 'unknown';
}
function describeRRSource(info) {
    if (!info) return 'not recorded';
    return `${info.name || 'Unknown device'} — ${RR_SOURCES[info.source] || RR_SOURCES.unknown}`;
}

// Non-blocking notice under the connection controls (replaces nothing; hidden when empty)
function showDeviceNotice(text, kind = 'warn') {
    let el = document.getElementById('deviceNotice');
    if (!el) {
        el = document.createElement('div');
        el.id = 'deviceNotice';
        el.setAttribute('role', 'status');
        const anchor = document.getElementById('status');
        (anchor?.closest('.section-content') || controlsPanel || document.body).appendChild(el);
    }
    el.className = `device-notice device-notice--${kind}`;
    el.textContent = text;
    el.hidden = !text;
}
function clearDeviceNotice() { showDeviceNotice(''); }

// Handle HR data
function handleHRData(event) {
    const value = event.target.value;
    if (value.byteLength < 2) return;
    const flags = value.getUint8(0);
    const hrFormat = flags & 0x01;
    if (hrFormat && value.byteLength < 3) return;
    let hr = hrFormat === 0 ? value.getUint8(1) : value.getUint16(1, true);

    currentHR = hr;
    hrValue.textContent = hr;
    if (hrValue.title) hrValue.title = '';
    updateHRZone(hr);
    lastPacketTime = Date.now();

    const rrPresent = flags & 0x10;
    if (!isCalibrating && calibrationStartTime) {
        if (rrPresent) {
            if (_hrPacketsWithoutRR >= 10) clearDeviceNotice();
            _hrPacketsWithoutRR = 0;
        } else if (++_hrPacketsWithoutRR === 10) {
            showDeviceNotice('This device sends heart rate but no RR intervals: HRV indices and most plots cannot be computed. ' +
                'Use a sensor that transmits RR intervals (e.g. a chest strap), or enable its HRV / beat-to-beat mode.');
        }
    }
    if (rrPresent) {
      let offset = hrFormat === 0 ? 2 : 3;
      if (flags & 0x08) offset += 2;               // Energy Expended field precedes the RR values
      const packetRR = [];
      while (offset + 1 < value.byteLength) {       // ignore a malformed trailing byte
            packetRR.push(value.getUint16(offset, true) / 1024 * 1000);
            offset += 2;
        }

        // Only process and store data AFTER calibration completes
        if (!isCalibrating && calibrationStartTime && packetRR.length) {
            const beatTimes = packetBeatTimes(packetRR, (Date.now() - calibrationStartTime) / 1000,
                rawTimestamps.length ? rawTimestamps[rawTimestamps.length - 1] : 0);
            packetRR.forEach((rr, k) => {
                const timestamp = beatTimes[k];
                // Store raw data (everything that arrives post-calibration)
                rawRRIntervals.push(rr);
                rawTimestamps.push(timestamp);

                // Store cleaned data (validated intervals only, with re-anchoring)
                const cfg = sessionArtifactCfg || liveArtifactCfg();
                for (const b of rrFilterStep(rr, timestamp, rrReference(rrIntervals, cfg), _rrRun, cfg)) {
                    rrIntervals.push(b.rr);
                    timestamps.push(b.t);
                }
            });
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

// ══════════════════════════════════════════════════════════════════════════
// Artifact detection & correction methods (live and retrospective)
// ══════════════════════════════════════════════════════════════════════════
// Kubios-style threshold levels: maximum deviation from the local median as a fraction of it
// (Kubios quotes them in seconds at 60 bpm: very low 0.45 s … very strong 0.05 s, scaled with the mean RR)
const MEDIAN_LEVELS = { vlow: 0.45, low: 0.35, medium: 0.25, strong: 0.15, vstrong: 0.05 };
const MEDIAN_LEVEL_LABELS = { vlow: 'Very low', low: 'Low', medium: 'Medium', strong: 'Strong', vstrong: 'Very strong' };
const ARTIFACT_METHODS = {
    delta:    { label: 'Δ from previous beat (ms)',            live: true },
    percent:  { label: '% of previous beat (Malik)',           live: true },
    median:   { label: 'Local median (Kubios threshold levels)', live: true },
    lipponen: { label: 'Automatic — Lipponen & Tarvainen 2019', live: false }
};

// Live settings → filter configuration (live correction is always 'remove': a beat cannot wait for its successor)
function liveArtifactCfg() {
    const m = ARTIFACT_METHODS[appSettings.artifactMethod]?.live ? appSettings.artifactMethod : 'delta';
    return { method: m, deltaMs: appSettings.artifactThreshold || 300, percent: appSettings.artifactPercent || 20,
             level: appSettings.artifactMedianLevel || 'medium', correction: 'remove' };
}
function artifactThreshold(ref, cfg) {
    if (cfg.method === 'percent') return ref * (cfg.percent || 20) / 100;
    if (cfg.method === 'median')  return ref * (MEDIAN_LEVELS[cfg.level] ?? 0.25);
    return cfg.deltaMs || 300;
}
function describeArtifactCfg(cfg) {
    if (!cfg) return 'not recorded';
    let rule;
    switch (cfg.method) {
        case 'percent':  rule = `|RR − previous accepted RR| ≤ ${cfg.percent} %`; break;
        case 'median':   rule = `|RR − ${cfg.centered ? 'centred' : 'running'} median of 11 beats| ≤ ${Math.round((MEDIAN_LEVELS[cfg.level] ?? .25) * 100)} % (${(MEDIAN_LEVEL_LABELS[cfg.level] || cfg.level).toLowerCase()} level)`; break;
        case 'lipponen': rule = `Lipponen & Tarvainen 2019 automatic detection${cfg.iterative === false ? '' : ' (iterative)'}`; break;
        default:         rule = `|RR − previous accepted RR| ≤ ${cfg.deltaMs} ms`;
    }
    const range = cfg.method === 'lipponen' ? '' : '250–2000 ms; ';
    const reanchor = (cfg.method === 'lipponen' || cfg.centered) ? '' : `; re-anchored after ${REANCHOR_BEATS} consistent beats`;
    const corr = cfg.correction !== 'interpolate' ? 'removed'
        : cfg.method === 'lipponen' ? 'corrected (extra beats merged, missed beats split, ectopic / long-short beats realigned)'
        : 'replaced by linear interpolation';
    return `${range}${rule}${reanchor}; artifacts ${corr}`;
}

// ── Lipponen & Tarvainen (2019), as implemented in NeuroKit2 0.2.13 (signal_fixpeaks, method "kubios") ──
// Mirrors NeuroKit2 step by step (same constants, rolling windows, reflect padding and flow control) so the
// detections can be checked against it (verification/compare_artifacts.py). Peaks in ms; indices are peak indices.
// Centred rolling quantiles (pandas: center=True, min_periods=1, linear interpolation, NaN ignored), several
// quantiles in one pass over a sorted sliding window: O(n·w) instead of sorting every window (O(n·w·log w)).
function _rollingQuantiles(x, w, qs) {
    const n = x.length, h = (w - 1) >> 1, win = [];
    const out = qs.map(() => new Float64Array(n));
    const ins = v => { if (Number.isNaN(v)) return; let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 0, v); };
    const del = v => { if (Number.isNaN(v)) return; let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 1); };
    for (let k = 0; k <= Math.min(h, n - 1); k++) ins(x[k]);
    for (let k = 0; k < n; k++) {
        if (k > 0) { if (k + h < n) ins(x[k + h]); if (k - h - 1 >= 0) del(x[k - h - 1]); }
        const m = win.length;
        qs.forEach((q, qi) => {
            if (!m) { out[qi][k] = NaN; return; }
            const pos = q * (m - 1), lo = Math.floor(pos), fr = pos - lo;
            out[qi][k] = lo + 1 < m ? win[lo] + (win[lo + 1] - win[lo]) * fr : win[lo];
        });
    }
    return out;
}
function _lipponenThreshold(sig, alpha, w) {
    const [q1, q3] = _rollingQuantiles(Array.from(sig, Math.abs), w, [0.25, 0.75]);
    return Array.from(q1, (v, k) => alpha * ((q3[k] - v) / 2));
}
function lipponenFindArtifacts(peaks, opt = {}) {
    const c1 = opt.c1 ?? 0.13, c2 = opt.c2 ?? 0.17, alpha = opt.alpha ?? 5.2, ww = opt.windowWidth ?? 91, mo = opt.medfiltOrder ?? 11;
    const n = peaks.length;
    const empty = { ectopic: [], missed: [], extra: [], longshort: [] };
    if (n < 4) return empty;
    const rr = new Float64Array(n);
    for (let k = 1; k < n; k++) rr[k] = (peaks[k] - peaks[k - 1]) / 1000;
    let s = 0; for (let k = 1; k < n; k++) s += rr[k]; rr[0] = s / (n - 1);
    const drrs = new Float64Array(n);
    for (let k = 1; k < n; k++) drrs[k] = rr[k] - rr[k - 1];
    s = 0; for (let k = 1; k < n; k++) s += drrs[k]; drrs[0] = s / (n - 1);
    const th1 = _lipponenThreshold(drrs, alpha, ww);
    for (let k = 0; k < n; k++) drrs[k] = th1[k] !== 0 ? drrs[k] / th1[k] : NaN;
    const pad = 2, P = k => { let i = k - pad; if (i < 0) i = -i; if (i > n - 1) i = 2 * (n - 1) - i; return drrs[i]; };
    const s12 = new Float64Array(n), s22 = new Float64Array(n);
    const nmax = (a, b) => (Number.isNaN(a) || Number.isNaN(b)) ? NaN : Math.max(a, b);
    const nmin = (a, b) => (Number.isNaN(a) || Number.isNaN(b)) ? NaN : Math.min(a, b);
    for (let d = pad; d < pad + n; d++) {
        const v = P(d);
        if (v > 0) s12[d - pad] = nmax(P(d - 1), P(d + 1)); else if (v < 0) s12[d - pad] = nmin(P(d - 1), P(d + 1));
        if (v >= 0) s22[d - pad] = nmin(P(d + 1), P(d + 2)); else if (v < 0) s22[d - pad] = nmax(P(d + 1), P(d + 2));
    }
    const [medrr] = _rollingQuantiles(Array.from(rr), mo, [0.5]);
    const mrrs = new Float64Array(n);
    for (let k = 0; k < n; k++) { const m = rr[k] - medrr[k]; mrrs[k] = m < 0 ? m * 2 : m; }
    const th2 = _lipponenThreshold(mrrs, alpha, ww);
    for (let k = 0; k < n; k++) mrrs[k] = th2[k] !== 0 ? mrrs[k] / th2[k] : NaN;

    const out = { ectopic: [], missed: [], extra: [], longshort: [] };
    let i = 0;
    while (i < n - 2) {                                  // flow control of Figure 1 (and NeuroKit2's loop)
        if (Math.abs(drrs[i]) <= 1) { i++; continue; }
        const eq1 = drrs[i] > 1 && s12[i] < (-c1 * drrs[i] - c2);
        const eq2 = drrs[i] < -1 && s12[i] > (-c1 * drrs[i] + c2);
        if (eq1 || eq2) { out.ectopic.push(i); i++; continue; }
        if (!(Math.abs(drrs[i]) > 1 || Math.abs(mrrs[i]) > 3)) { i++; continue; }
        const cands = [i];
        if (Math.abs(drrs[i + 1]) < Math.abs(drrs[i + 2])) cands.push(i + 1);
        for (const j of cands) {
            const eq3 = drrs[j] > 1 && s22[j] < -1;
            const eq4 = Math.abs(mrrs[j]) > 3;
            const eq5 = drrs[j] < -1 && s22[j] > 1;
            if (!(eq3 || eq4 || eq5)) { i++; continue; }
            const eq6 = Math.abs(rr[j] / 2 - medrr[j]) < th2[j];
            const eq7 = Math.abs(rr[j] + rr[j + 1] - medrr[j]) < th2[j];
            if (eq5 && eq7) { out.extra.push(j); i++; continue; }
            if (eq3 && eq6) { out.missed.push(j); i++; continue; }
            out.longshort.push(j); i++;
        }
    }
    return out;
}
function _updateIdx(src, upd, delta) {
    if (!upd.length) return upd;
    for (const sIdx of src) upd = upd.map(u => u > sIdx ? u + delta : u);
    return [...new Set(upd)].sort((a, b) => a - b);
}
function lipponenCorrectPeaks(art, peaks) {           // NeuroKit2 _correct_artifacts, on float peaks (no rounding)
    let pk = Array.from(peaks);
    let { missed, ectopic, longshort } = art;
    const extra = art.extra;
    if (extra.length) {
        const del = new Set(extra); pk = pk.filter((_, k) => !del.has(k));
        missed = _updateIdx(extra, missed, -1); ectopic = _updateIdx(extra, ectopic, -1); longshort = _updateIdx(extra, longshort, -1);
    }
    if (missed.length) {
        const valid = missed.filter(m => m > 1 && m < pk.length);
        const added = valid.map(m => pk[m - 1] + (pk[m] - pk[m - 1]) / 2);
        const res = []; let a = 0;
        for (let k = 0; k < pk.length; k++) { while (a < valid.length && valid[a] === k) res.push(added[a++]); res.push(pk[k]); }
        pk = res;
        ectopic = _updateIdx(missed, ectopic, 1); longshort = _updateIdx(missed, longshort, 1);
    }
    const misalign = (idcs) => {
        const valid = idcs.filter(m => m > 1 && m < pk.length - 1);
        if (!valid.length) return;
        const interp = valid.map(m => pk[m - 1] + (pk[m + 1] - pk[m - 1]) / 2);
        const del = new Set(valid);
        pk = pk.filter((_, k) => !del.has(k)).concat(interp).sort((x, y) => x - y);
    };
    misalign(ectopic);
    misalign(longshort);
    return pk;
}
function lipponenFixPeaks(peaks, iterative = true) {
    let art = lipponenFindArtifacts(peaks);
    const first = art;
    let clean = lipponenCorrectPeaks(art, peaks), iterations = 1;
    if (iterative) {
        let nCur = art.ectopic.length + art.missed.length + art.extra.length + art.longshort.length;
        for (;;) {
            const na = lipponenFindArtifacts(clean);
            const nPrev = nCur;
            nCur = na.ectopic.length + na.missed.length + na.extra.length + na.longshort.length;
            if (nCur >= nPrev) break;
            art = na; clean = lipponenCorrectPeaks(art, clean); iterations++;
        }
    }
    return { first, last: art, peaks: clean, iterations };
}

// ── Retrospective cleaning of a whole raw series ──────────────────────────
// Returns { rr, times, flagged (raw indices), counts, cfg } — the raw series itself is never modified.
function applyArtifactCorrection(rawRR, rawTimes, cfg) {
    // Times must be one finite, non-decreasing value per beat; otherwise (inconsistent stored data) rebuild them
    // from the cumulative RR sum so no NaN can reach the clean series.
    let timesOk = rawTimes && rawTimes.length === rawRR.length;
    for (let k = 0; timesOk && k < rawRR.length; k++) if (!isFinite(rawTimes[k]) || (k && rawTimes[k] < rawTimes[k - 1])) timesOk = false;
    if (!timesOk) {
        rawTimes = []; let acc = 0;
        for (const v of rawRR) { if (isFinite(v) && v > 0) acc += v / 1000; rawTimes.push(Math.round(acc * 1000) / 1000); }
    }
    // The automatic method works on beat positions: non-finite or non-positive values cannot be placed.
    // They are flagged as artifacts and the method runs on the remaining beats.
    if (cfg.method === 'lipponen') {
        const keep = [];
        for (let k = 0; k < rawRR.length; k++) if (isFinite(rawRR[k]) && rawRR[k] > 0) keep.push(k);
        if (keep.length < rawRR.length) {
            const sub = applyArtifactCorrection(keep.map(k => rawRR[k]), keep.map(k => rawTimes[k]), cfg);
            const dropped = []; let j = 0;
            for (let k = 0; k < rawRR.length; k++) { if (keep[j] === k) j++; else dropped.push(k); }
            sub.flagged = [...dropped, ...sub.flagged.map(i => keep[i])].sort((a, b) => a - b);
            sub.counts = { ...sub.counts, invalid: dropped.length };
            return sub;
        }
    }
    const n = rawRR.length;
    const res = { rr: [], times: [], flagged: [], counts: {}, cfg: { ...cfg } };
    if (!n) return res;
    if (cfg.method === 'lipponen') {
        const peaks = [0]; for (let k = 0; k < n; k++) peaks.push(peaks[k] + rawRR[k]);
        const fx = lipponenFixPeaks(peaks, cfg.iterative !== false);
        const f = fx.first;
        res.counts = { ectopic: f.ectopic.length, missed: f.missed.length, extra: f.extra.length, longshort: f.longshort.length, iterations: fx.iterations };
        // peak index j = end of raw interval j-1; ectopic / extra beats disturb two intervals (j-1, j)
        const bad = new Set();
        const mark = (j, two) => { if (j - 1 >= 0 && j - 1 < n) bad.add(j - 1); if (two && j < n) bad.add(j); };
        f.ectopic.forEach(j => mark(j, true)); f.extra.forEach(j => mark(j, true));
        f.missed.forEach(j => mark(j, false)); f.longshort.forEach(j => mark(j, false));
        res.flagged = [...bad].sort((a, b) => a - b);
        if (cfg.correction === 'interpolate') {
            // corrected peaks → intervals; times by mapping peak positions onto the raw clock
            const rawPk = peaks.slice(1);
            const toTime = p => {
                let lo = 0, hi = n - 1;
                if (p <= rawPk[0]) return rawTimes[0] + (p - rawPk[0]) / 1000;
                if (p >= rawPk[n - 1]) return rawTimes[n - 1] + (p - rawPk[n - 1]) / 1000;
                while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rawPk[m] <= p) lo = m; else hi = m; }
                const span = rawPk[hi] - rawPk[lo];
                return span > 0 ? rawTimes[lo] + (rawTimes[hi] - rawTimes[lo]) * (p - rawPk[lo]) / span : rawTimes[lo];
            };
            for (let k = 1; k < fx.peaks.length; k++) {
                res.rr.push(fx.peaks[k] - fx.peaks[k - 1]);
                res.times.push(Math.round(toTime(fx.peaks[k]) * 1000) / 1000);
            }
            return res;
        }
        for (let k = 0; k < n; k++) if (!bad.has(k)) { res.rr.push(rawRR[k]); res.times.push(rawTimes[k]); }
        return res;
    }

    // Methods with a per-beat rule: build the "good" mask
    const good = new Uint8Array(n);
    if (cfg.method === 'median' && cfg.centered) {
        const frac = MEDIAN_LEVELS[cfg.level] ?? 0.25;
        const inRange = v => v >= 250 && v <= 2000;
        for (let k = 0; k < n; k++) {
            if (!inRange(rawRR[k])) continue;
            const w = rawRR.slice(Math.max(0, k - 5), Math.min(n, k + 6)).filter(inRange);
            const med = _median(w);
            if (Math.abs(rawRR[k] - med) <= frac * med) good[k] = 1;
        }
    } else {
        const kept = [], run = [];
        for (let k = 0; k < n; k++) {
            for (const b of rrFilterStep(rawRR[k], rawTimes[k], rrReference(kept, cfg), run, cfg, k)) { kept.push(b.rr); good[b.i] = 1; }
        }
    }
    let nRange = 0, nDev = 0;
    for (let k = 0; k < n; k++) if (!good[k]) { res.flagged.push(k); if (rawRR[k] < 250 || rawRR[k] > 2000) nRange++; else nDev++; }
    res.counts = { outOfRange: nRange, deviation: nDev };
    if (cfg.correction === 'interpolate') {
        const gi = []; for (let k = 0; k < n; k++) if (good[k]) gi.push(k);
        if (!gi.length) return res;
        let g = 0;                                   // gi[g] = first good beat at or after k
        for (let k = 0; k < n; k++) {
            let v = rawRR[k];
            while (g < gi.length && gi[g] < k) g++;
            if (!good[k]) {
                const a = g > 0 ? gi[g - 1] : null;      // previous good beat
                const b = g < gi.length ? gi[g] : null;  // next good beat
                if (a === null) v = rawRR[b];
                else if (b === null) v = rawRR[a];
                else { const dt = rawTimes[b] - rawTimes[a]; v = dt > 0 ? rawRR[a] + (rawRR[b] - rawRR[a]) * (rawTimes[k] - rawTimes[a]) / dt : (rawRR[a] + rawRR[b]) / 2; }
            }
            res.rr.push(v); res.times.push(rawTimes[k]);
        }
        return res;
    }
    for (let k = 0; k < n; k++) if (good[k]) { res.rr.push(rawRR[k]); res.times.push(rawTimes[k]); }
    return res;
}

// Artifact filter with re-anchoring.
// Rule 1 (unchanged): 250-2000 ms and |RR - preceding accepted RR| <= threshold.
// Rule 2 (re-anchoring): REANCHOR_BEATS consecutive in-range intervals that fail rule 1 only because of the
// difference to the last accepted one, but agree with EACH OTHER within the threshold, are a level change
// (or a wrong reference beat), not artifacts: they are all accepted and become the new reference.
// Without rule 2, one plausible-but-wrong accepted interval made every later normal beat fail (lock-out).
// Isolated ectopic beats (short-long pairs) never form such a run, so they are still rejected.

// One filter step. `ref` = reference RR (last accepted, or the running median for the 'median' method; null
// at the start); `run` = pending run (mutated); `cfg` = artifact settings (default: the live settings).
// Returns the beats to append to the clean stream, in order (0, 1 or REANCHOR_BEATS of them); `i` is passed
// through so retrospective callers know which raw beats were kept.
function rrFilterStep(rr, t, ref, run, cfg = null, i = -1) {
    const c = cfg || liveArtifactCfg();
    if (rr < 250 || rr > 2000 || !isFinite(t)) { run.length = 0; return []; }
    if (ref === null || Math.abs(rr - ref) <= artifactThreshold(ref, c)) { run.length = 0; return [{ rr, t, i }]; }
    if (run.length) { const p = run[run.length - 1].rr; if (Math.abs(rr - p) > artifactThreshold(p, c)) run.length = 0; }
    run.push({ rr, t, i });
    if (run.length < REANCHOR_BEATS) return [];
    const accepted = run.slice();
    run.length = 0;
    return accepted;
}
// Reference for the next decision: last accepted beat, or (method 'median') the median of the last 11 accepted
function rrReference(accepted, cfg) {
    const n = accepted.length;
    if (!n) return null;
    if (cfg.method !== 'median' || n < 3) return accepted[n - 1];
    return _median(accepted.slice(Math.max(0, n - 11)));
}

// Beat times for the RR values of ONE notification. A notification may carry several intervals but has a
// single arrival time: the last beat is dated at arrival and each earlier one by subtracting the intervals that
// follow it (cumulative RR), instead of giving them all the same stamp. Times never go below the previous
// beat's time (BLE latency / jitter) nor below 0 (beats that ended before calibration finished).
function packetBeatTimes(rrMs, arrivalT, prevT = 0) {
    const t = new Array(rrMs.length);
    let acc = arrivalT;
    for (let k = rrMs.length - 1; k >= 0; k--) { t[k] = acc; acc -= rrMs[k] / 1000; }
    let floor = Math.max(0, prevT);
    for (let k = 0; k < t.length; k++) { if (t[k] < floor) t[k] = floor; floor = t[k]; }
    return t;
}

// Validate individual RR interval in real-time (rule 1 only)
function isValidRRInterval(rr, lastRR = null) {
    const minRR = 250;  // 240 BPM max (60000 / 250)
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
    if (value.byteLength < 10) return;
    // Same time reference as the RR series; negative while calibrating, so the axis is continuous
    const nowT = (Date.now() - (calibrationStartTime ?? calibrationEndTime ?? sessionStartTime)) / 1000;

    const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const frameType = data[0];
    if (frameType !== 0x00) return;
    if (sessionDeviceInfo && sessionDeviceInfo.source !== 'ecg' && isConnected) sessionDeviceInfo.source = 'ecg';
    if (ecgData.length === 0) setChartPlaceholder('ecgChart', null);

    const dataStart = 10;
    const sampleCount = Math.floor((data.length - dataStart) / 3);

    // Continuous 130 Hz clock: packets arrive in bursts, so arrival time is only used to (re)sync
    const expectedStart = nowT - sampleCount / ECG_FS;
    if (ecgClockT === null || Math.abs(ecgClockT - expectedStart) > 0.5) ecgClockT = expectedStart;

    for (let i = 0; i < sampleCount; i++) {
        const offset = dataStart + i * 3;
        let sample = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
        if (sample & 0x800000) sample |= 0xFF000000;
        ecgData.push(sample);
        ecgTimestamps.push(ecgClockT + i / ECG_FS);
    }
    ecgClockT += sampleCount / ECG_FS;

    const maxSamples = 650;
    if (ecgData.length > maxSamples) {
        ecgData = ecgData.slice(-maxSamples);
        ecgTimestamps = ecgTimestamps.slice(-maxSamples);
    }
    scheduleECGRender();
}

// Calculate SRI - Uses full dataset for consistency with PSD chart
function calculateSRI(rrData = null, timeData = null) {
    // Use provided data or fall back to current session data
    const rr = rrData || rrIntervals;
    const times = timeData || timestamps;

    if (rr.length < 50) return null;

    // Always use full data for consistency with PSD chart (no time windowing)
    const analysisRR = rr;

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
        Math.abs(lastCWTResult.dataLength - rrIntervals.length) <= 5) {
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
    if (!canvas || appSettings.showSRI === false) return;

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
    if (appSettings.showSRI === false) return;      // SRI switched off: skip the work entirely
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
let _sriAnimRaf = 0;
function animateScoreChange(from, to) {
    cancelAnimationFrame(_sriAnimRaf);      // overlapping animations made the number flicker
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
            _sriAnimRaf = requestAnimationFrame(animate);
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

// ── Last-minute window helpers (single implementation: stats, auto-save and disconnect) ──
// Live session time in seconds on the RR time axis; outside a live session, the last beat's time.
function sessionNowSeconds() {
    if (isConnected && calibrationStartTime) return (Date.now() - calibrationStartTime) / 1000;
    return timestamps.length ? timestamps[timestamps.length - 1] : 0;
}
// Mean RR and RMSSD over [nowT - windowSecs, nowT]; null when the window has too little data
function recentWindowStats(nowT, windowSecs = 60) {
    const from = nowT - windowSecs;
    let n = 0, sum = 0, prev = null, sq = 0, pairs = 0;
    for (let i = 0; i < rrIntervals.length; i++) {
        if (timestamps[i] < from) continue;
        const v = rrIntervals[i];
        n++; sum += v;
        if (prev !== null) { const d = v - prev; sq += d * d; pairs++; }
        prev = v;
    }
    return { avgRR: n ? sum / n : null, rmssd: pairs ? Math.sqrt(sq / pairs) : null };
}

// Update stats
function updateStats() {
    samplesValue.textContent = rrIntervals.length;

    // Calculate data quality based on raw data vs cleaned data
    if (rawRRIntervals.length > 0) {
        dataQuality = calculateDataQuality(rawRRIntervals.length, rrIntervals.length);
    } else {
        dataQuality = 100; // No raw data yet, assume 100%
    }

    // 1-minute window anchored to the live clock (not the last beat): a stream gap cannot stretch it
    const win = recentWindowStats(sessionNowSeconds());
    if (win.avgRR !== null) avgRRValue.textContent = win.avgRR.toFixed(1);
    if (win.rmssd !== null) rmssdValue.textContent = win.rmssd.toFixed(1);

    if (dataQualityValue) {
        dataQualityValue.textContent = `${dataQuality}%`;
        dataQualityValue.className = '';
        if (dataQuality >= 95) dataQualityValue.classList.add('data-quality-excellent');
        else if (dataQuality >= 80) dataQualityValue.classList.add('data-quality-good');
        else if (dataQuality >= 60) dataQualityValue.classList.add('data-quality-fair');
        else dataQualityValue.classList.add('data-quality-poor');
    }

    updateSRI();
    updateBiofeedbackDisplay();
    broadcastMonitorUpdate();
}

// Update ECG chart
let _ecgRaf = 0;
function scheduleECGRender() {
    if (_ecgRaf || document.hidden || currentTab !== 'record') return;
    _ecgRaf = requestAnimationFrame(() => { _ecgRaf = 0; updateECGChart(); });
}

function updateECGChart() {
    if (ecgData.length === 0) return;
    // Timestamps are monotonic now (continuous clock) — no sort, no per-point objects.
    // Copies: Plotly keeps references to the arrays it is given.
    Plotly.update('ecgChart', {
        x: [ecgTimestamps.slice()],
        y: [ecgData.slice()]
    }, {}, [0]);
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
    setChartPlaceholder('rrChart', null);

    const [wx, wy] = sliceWindow('rr', timestamps, rrIntervals);   // optional per-plot time window
    const [dx, dy] = decimateXY(wx, wy);                            // timestamps are monotonic: no sort needed

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

    Plotly.update('rrChart', { x: [dx], y: [dy] }, { shapes, annotations }, [0]);
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

    const [wx, wy] = sliceWindow('rollingRMSSD', rollingRMSSDTimes, rollingRMSSD);
    const [dx, dy] = decimateXY(wx, wy);

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

    Plotly.update('rollingRMSSDChart', { x: [dx], y: [dy] }, { shapes, annotations }, [0]);
}

// Update Poincaré chart
// Update Poincaré chart with SD1/SD2 ellipse
function updatePoincareChart() {
    if (rrIntervals.length < 2) return;
    setChartPlaceholder('poincareChart', null);
    const rrN  = rrIntervals.slice(0, -1);
    const rrN1 = rrIntervals.slice(1);
    const stats = computePoincareStats(rrIntervals);

    let ellipse = { x: [], y: [] };
    let identX  = [], identY  = [];
    let annotations = [];

    if (stats && stats.sd1 > 0) {
        ellipse = generateEllipseTrace(stats.meanRR, stats.meanRR, stats.sd1, stats.sd2);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < rrIntervals.length; i++) { const v = rrIntervals[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        identX = [lo, hi]; identY = [lo, hi];

        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        const compact = document.getElementById('poincareChart').clientWidth < 340;   // tiny screens: one short line
        annotations = [{
            xref: 'paper', yref: 'paper', x: 0.98, y: 0.98,
            xanchor: 'right', yanchor: 'top',
            text: compact
                ? `<b>SD1</b> ${stats.sd1} · <b>SD2</b> ${stats.sd2}`
                : `<b>SD1</b> ${stats.sd1} ms<br><b>SD2</b> ${stats.sd2} ms<br><b>SD1/SD2</b> ${stats.ratio}`,
            showarrow: false,
            font: { size: compact ? 9 : 11, color: isLight ? '#4b5563' : '#9ca3af' },
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
    // Standard definitions (Brennan et al. 2001): SD1 = SDSD/sqrt(2); SD2^2 = 2*SDNN^2 - SDSD^2/2,
    // with SDSD and SDNN the sample standard deviations of successive differences and of the NN series.
    const sdnn = Math.sqrt(rr.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
    const d = [];
    for (let i = 1; i < n; i++) d.push(rr[i] - rr[i-1]);
    const dMean = d.reduce((a, b) => a + b, 0) / d.length;
    const sdsd = d.length > 1 ? Math.sqrt(d.reduce((s, v) => s + (v - dMean) ** 2, 0) / (d.length - 1)) : 0;
    const sd1 = sdsd / Math.SQRT2;
    const sd2Sq = Math.max(0, 2 * sdnn ** 2 - 0.5 * sdsd ** 2);
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

    const age = getEffectiveAge();
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
                <div class="chart-placeholder-text">Waiting for data — connect a sensor or open a saved session</div>`;
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

    const [wx, wy] = sliceWindow('hr', hrTimes, hrValues);
    const [hx, hy] = decimateXY(wx, wy);
    Plotly.update('hrChart', { x: [hx], y: [hy] }, { shapes, annotations }, [0]);
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
        const sdnn = Math.sqrt(w.reduce((s,v)=>s+(v-mean)**2, 0) / (w.length - 1));   // sample SD
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
    const [vx, vy] = sliceWindow('vagalProxy', times, values);
    Plotly.update('vagalProxyChart', { x: [vx], y: [vy] }, { shapes, annotations }, [0]);
}

// ── CSV helpers (one implementation for every RR export) ─────────────────
// RFC 4180 field: quote when it contains a comma, quote or line break
// File-name-safe stem, unique within one ZIP (equal names used to overwrite each other)
function uniqueZipName(used, stem) {
    const clean = String(stem).replace(/[\\/:*?"<>|]+/g, '-');
    let name = clean, k = 2;
    while (used.has(name)) name = `${clean}_${k++}`;
    used.add(name);
    return name;
}
function csvField(v) {
    if (v == null) return '';
    const str = String(v);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
// Each event is written on the beat nearest to its time, so no event is lost or written twice
function eventsByBeat(times, events) {
    const map = new Map();
    if (!times || !times.length) return map;
    for (const e of events || []) {
        if (!e || !Number.isFinite(e.time)) continue;
        let lo = 0, hi = times.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < e.time) lo = mid + 1; else hi = mid; }
        if (lo > 0 && Math.abs(times[lo - 1] - e.time) <= Math.abs(times[lo] - e.time)) lo--;
        if (!map.has(lo)) map.set(lo, []);
        map.get(lo).push(e);
    }
    return map;
}
function rrCsvBody(rr, times, events) {
    const ev = eventsByBeat(times, events);
    const lines = ['Timestamp (s),RR Interval (ms),Event Type,Annotation'];
    for (let i = 0; i < rr.length; i++) {
        const es = ev.get(i) || [];
        lines.push(`${times[i].toFixed(3)},${rr[i].toFixed(3)},${csvField(es.map(e => e.type || '').join(' | '))},${csvField(es.map(e => e.annotation || '').join(' | ').replace(/^( \| )+$/, ''))}`);
    }
    return lines.join('\n') + '\n';
}
// Complete CSV (metadata header + clean RR series) of a STORED session
function storedSessionCSV(s) {
    return generateMetadataHeader({
        filename: s.filename, startTime: s.startTime || s.timestamp,
        tags: s.tags || [], rrCount: s.rrIntervals.length,
        rawRRCount: s.rawRRIntervals?.length || s.rrIntervals.length,
        eventCount: s.eventMarkers?.length || 0, includeRaw: false,
        calibrationSecs: s.calibrationSecs, device: s.device, importedFrom: s.importedFrom, artifactFilter: s.artifactFilter,
        sessionTimestamps: s.timestamps, sessionEventMarkers: s.eventMarkers || []
    }) + rrCsvBody(s.rrIntervals, s.timestamps, s.eventMarkers);
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
    // Calibration actually used: the stored session's own value, or the live recording's
    const calibSecs = sessionData.live ? sessionCalibrationSecs : sessionData.calibrationSecs;
    const devInfo   = sessionData.live ? sessionDeviceInfo : sessionData.device;
    const imported  = sessionData.live ? sessionImportInfo : sessionData.importedFrom;
    const artCfg    = sessionData.live ? sessionArtifactCfg : sessionData.artifactFilter;

    const sessionDate = new Date(startTime);
    const dateStr = sessionDate.toISOString().slice(0, 19).replace('T', ' ');

    // Stored sessions must pass their own arrays; the live globals are used only for `live: true`
    const srcTimestamps = sessionData.sessionTimestamps || (sessionData.live ? timestamps : []);
    const srcEventMarkers = sessionData.sessionEventMarkers || (sessionData.live ? eventMarkers : []);

    // Calculate actual duration from timestamps
    const actualDuration = srcTimestamps.length > 0
        ? Math.floor(srcTimestamps[srcTimestamps.length - 1])
        : 0;

    // Calculate data quality metrics
    const percentValid = calculateDataQuality(rawRRCount, rrCount);
    const removedRR = Math.max(0, rawRRCount - rrCount);

    let header = '';
    header += `# CardioTrace HRV Data Export\n`;
    header += `# Generated: ${new Date().toISOString()}\n`;
    header += `#\n`;
    header += `# Session Information\n`;
    header += `# Date: ${dateStr}\n`;
    header += `# Duration: ${formatDuration(actualDuration)}\n`;
    header += `# Filename: ${filename}\n`;
    header += imported
        ? `# Source: imported file ${imported.filename || ''} (${imported.format || 'RR list'})\n`
        : `# Device: ${describeRRSource(devInfo)}\n`;
    header += `# Tags: ${tags.length > 0 ? tags.join(', ') : 'None'}\n`;
    header += `#\n`;
    header += `# Data Quality\n`;
    header += `# Data Type: ${includeRaw ? 'Raw (uncleaned)' : 'Clean (artifacts removed)'}\n`;
    header += `# Total RR Intervals: ${includeRaw ? rawRRCount : rrCount}\n`;
    header += `# Valid Intervals: ${rrCount} (${percentValid}%)\n`;
    header += `# Removed Artifacts: ${removedRR}\n`;
    header += `# Artifact Filter: ${describeArtifactCfg(artCfg)}\n`;
    header += imported
        ? `# Calibration Period: not applicable (imported file)\n`
        : calibSecs != null
        ? `# Calibration Period: ${calibSecs} seconds (excluded from data)\n`
        : `# Calibration Period: not recorded (session saved by an older version)\n`;
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
        notify('No data for a report yet — record or open a session first.', 'warn');
        return;
    }

    reportBtn.disabled = true;
    reportBtn.textContent = '⏳ Building...';

    try {
        // ── Capture chart images ─────────────────────────────────────────────
        const scale = appSettings.report.scale || 4;   // was a fixed ×10 (11 000 px plots, ~35 MB reports)
        const cap = (cond, id, width, height) =>
            cond ? Plotly.toImage(id, { format: 'png', width, height, scale }) : Promise.resolve(null);
        const [imgPSD, imgPoincare, imgRR, imgRMSSD, imgHR, imgVagal] = await Promise.all([
            cap(reportOn('spectrogram'),                          'psdChart',          1100, 600),
            cap(reportOn('poincare'),                             'poincareChart',      700, 600),
            cap(reportOn('rr'),                                   'rrChart',           1100, 380),
            cap(reportOn('rmssd') && rollingRMSSD.length > 0,     'rollingRMSSDChart', 1100, 380),
            cap(reportOn('hr'),                                   'hrChart',           1100, 380),
            cap(reportOn('vagal'),                                'vagalProxyChart',   1100, 380),
        ]);

        // Compute Poincaré stats for report
        const poincStats = computePoincareStats(rrIntervals);

        // ── Compute metrics ──────────────────────────────────────────────────
        const sessionDate  = new Date(calibrationStartTime || sessionStartTime);
        const duration     = timestamps.length > 0 ? Math.floor(timestamps[timestamps.length - 1]) : 0;
        const dquality     = calculateDataQuality(rawRRIntervals.length, rrIntervals.length);
        const sessionName  = document.getElementById('filename').value || 'polar-h10-data';

        const avgRR  = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
        const sdnn   = rrIntervals.length > 1 ? Math.sqrt(rrIntervals.reduce((s, rr) => s + Math.pow(rr - avgRR, 2), 0) / (rrIntervals.length - 1)) : 0;   // sample SD
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
        const minHR  = hrVals.reduce((a, b) => Math.min(a, b), Infinity);
        const maxHR  = hrVals.reduce((a, b) => Math.max(a, b), -Infinity);

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
                <td>${escapeHTML(e.type || '—')}</td>
                <td>${escapeHTML(e.annotation || '—')}</td>
              </tr>`).join('')
            : `<tr><td colspan="3" style="text-align:center;color:#8a9bb8;padding:16px">No events recorded</td></tr>`;

        // Tags
        const tagsHtml = sessionTags.length > 0
            ? sessionTags.map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('')
            : '<span style="color:#8a9bb8">None</span>';

        // ── Build HTML ───────────────────────────────────────────────────────
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CardioTrace Report — ${escapeHTML(sessionName)}</title>
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
  <div class="rh-sub">${escapeHTML(sessionName)}</div>
  <div class="rh-pills">
    <div class="rh-pill">Date<strong>${sessionDate.toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'})}</strong></div>
    <div class="rh-pill">Duration<strong>${fmtD(duration)}</strong></div>
    <div class="rh-pill">RR Intervals<strong>${rrIntervals.length.toLocaleString()}</strong></div>
    <div class="rh-pill">Data Quality<strong>${dquality}%</strong></div>
    ${sessionTags.length ? `<div class="rh-pill">Tags<strong>${escapeHTML(sessionTags.join(', '))}</strong></div>` : ''}
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
${reportOn('kpis') ? `<div class="kpi-row">
  ${appSettings.showSRI !== false ? `  <div class="kpi" style="--kpi-accent:${sriColor}">
    <div class="kpi-label">Stress Recovery Index</div>
    <div class="kpi-value" style="color:${sriColor}">${sri > 0 ? sri : '—'}</div>
    <div class="kpi-unit">out of 100</div>
    ${sri > 0 ? `<div class="kpi-badge" style="background:${sriColor}">${sriLabel}</div>` : ''}
  </div>` : ''}
  <div class="kpi" style="--kpi-accent:#6366f1">
    <div class="kpi-label">RMSSD</div>
    <div class="kpi-value">${fmt(rmssd)}</div>
    <div class="kpi-unit">ms · whole recording</div>
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
</div>` : ''}

<!-- ── INTERPRETATION BANNER ─────────────────────────────────────────── -->
${(reportOn('interpretation') && sriResult) ? (() => {
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
${(imgRR || imgRMSSD) ? `<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Signal Overview</span></div>
  ${imgRR ? `<div class="chart-card">
    <div class="chart-card-label">RR Intervals over Time${eventMarkers.length ? ' · Vertical markers = events' : ''}</div>
    <img src="${imgRR}" alt="RR Intervals chart">
  </div>` : ''}
  ${imgRMSSD ? `<div class="chart-card">
    <div class="chart-card-label">Rolling RMSSD — ${appSettings.rmssdWindow || 60}-s sliding window</div>
    <img src="${imgRMSSD}" alt="Rolling RMSSD chart">
  </div>` : ''}
</div>` : ''}

<!-- ── CHARTS: PSD + POINCARÉ ─────────────────────────────────────────── -->
${(imgPSD || imgPoincare || reportOn('notes')) ? `<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Frequency & Geometric Analysis</span></div>
  ${(imgPSD || imgPoincare) ? `<div class="charts-2col">
    ${imgPSD ? `<div class="chart-card">
      <div class="chart-card-label">HRV Wavelet Spectrogram — Morlet CWT (ω₀ = 6, 4 Hz interpolation, Plasma colorscale = log₁₀ power)</div>
      <img src="${imgPSD}" alt="Wavelet spectrogram">
    </div>` : ''}
    ${imgPoincare ? `<div class="chart-card">
      <div class="chart-card-label">Poincaré Plot — RR(n) vs RR(n+1)</div>
      <img src="${imgPoincare}" alt="Poincaré plot">
      ${poincStats ? `<div style="padding:8px 14px;font-size:11px;color:var(--ink3);border-top:1px solid var(--border);display:flex;gap:24px;">
        <span><strong style="color:var(--accent)">SD1</strong> ${poincStats.sd1} ms</span>
        <span><strong style="color:var(--accent)">SD2</strong> ${poincStats.sd2} ms</span>
        <span><strong style="color:var(--accent)">SD1/SD2</strong> ${poincStats.ratio}</span>
      </div>` : ''}
    </div>` : ''}
  </div>` : ''}
  ${reportOn('notes') ? `<div class="note">
    <strong>Band legend:</strong> VLF 0.003–0.04 Hz · LF 0.04–0.15 Hz · HF 0.15–0.4 Hz.
    Spectrogram computed via Morlet CWT (ω₀ = 6) on the RR series resampled to 4 Hz by monotone cubic (PCHIP) interpolation, most recent ≤ 5 min; colour = log₁₀(power). Dotted lines mark the LF (0.04 Hz) and HF (0.15 Hz) boundaries. Band powers integrated from the time-averaged scalogram.
    Poincaré SD1 reflects short-term (parasympathetic) variability; SD2 reflects long-term variability.
  </div>` : ''}
</div>` : ''}

<!-- ── HR + VAGAL PROXY ────────────────────────────────────────── -->
${(imgHR || imgVagal) ? `<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Heart Rate & Vagal Proxy</span></div>
  ${imgHR ? `<div class="chart-card" style="margin-bottom:14px;">
    <div class="chart-card-label">Heart Rate over Time with Training Zones (Age ${getEffectiveAge()}, Max HR ${220-getEffectiveAge()} bpm)</div>
    <img src="${imgHR}" alt="Heart Rate chart">
  </div>` : ''}
  ${imgVagal ? `<div class="chart-card">
    <div class="chart-card-label">Vagal Proxy (RMSSD/SDNN) — ${appSettings.rmssdWindow || 60}-s rolling window · Values &gt; 0.5 favour parasympathetic dominance</div>
    <img src="${imgVagal}" alt="Vagal Proxy chart">
  </div>` : ''}
</div>` : ''}

<!-- ── SRI BREAKDOWN ─────────────────────────────────────────────────── -->
${(reportOn('sriBreakdown') && sriResult) ? `<div class="sec">
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

${reportOn('timeDomain') ? `<!-- ── TIME DOMAIN ────────────────────────────────────────────────────── -->
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
</div>` : ''}

${reportOn('freqDomain') ? `<!-- ── FREQUENCY DOMAIN ───────────────────────────────────────────────── -->
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
</div>` : ''}

${reportOn('events') ? `<!-- ── EVENTS ─────────────────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Recorded Events (${eventMarkers.length})</span></div>
  <table class="ev-table">
    <thead><tr><th>Time (s)</th><th>Event Type</th><th>Annotation</th></tr></thead>
    <tbody>${eventRows}</tbody>
  </table>
</div>` : ''}

${reportOn('metadata') ? `<!-- ── SESSION METADATA ───────────────────────────────────────────────── -->
<div class="sec">
  <div class="sec-title"><span class="sec-title-bar"></span><span class="sec-title-text">Session Metadata</span></div>
  <table class="ev-table">
    <tbody>
      <tr><th style="width:180px">Session Name</th><td>${escapeHTML(sessionName)}</td></tr>
      <tr><th>Start Time</th><td>${sessionDate.toLocaleString('en-US',{dateStyle:'full',timeStyle:'medium'})}</td></tr>
      <tr><th>Duration</th><td>${fmtD(duration)}</td></tr>
      <tr><th>${sessionImportInfo ? 'Source' : 'Device'}</th><td>${escapeHTML(sessionImportInfo ? `imported file ${sessionImportInfo.filename || ''} (${sessionImportInfo.format || 'RR list'})` : describeRRSource(sessionDeviceInfo))}</td></tr>
      <tr><th>Calibration Period</th><td>${sessionImportInfo ? 'not applicable (imported file)' : sessionCalibrationSecs != null ? sessionCalibrationSecs + ' seconds (excluded from data)' : 'not recorded'}</td></tr>
      <tr><th>Raw RR Intervals</th><td>${rawRRIntervals.length.toLocaleString()}</td></tr>
      <tr><th>Valid (Clean) Intervals</th><td>${rrIntervals.length.toLocaleString()} (${dquality}%)</td></tr>
      <tr><th>Artifact Filter</th><td>${escapeHTML(describeArtifactCfg(sessionArtifactCfg))}</td></tr>
      <tr><th>Artifacts Removed</th><td>${Math.max(0, rawRRIntervals.length - rrIntervals.length).toLocaleString()}</td></tr>
      <tr><th>Tags</th><td>${tagsHtml}</td></tr>
      ${peakHR > 0 ? `<tr><th>Peak Heart Rate</th><td>${peakHR} bpm</td></tr>` : ''}
    </tbody>
  </table>
</div>` : ''}

${reportOn('references') ? `<!-- ── REFERENCE RANGES ───────────────────────────────────────────────── -->
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
</div>` : ''}

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
        notify('Report generation failed — see the browser console for details.', 'error');
    } finally {
        reportBtn.disabled = false;
        reportBtn.textContent = '📄 Report';
    }
}

// Export data
function exportData() {
    if (rrIntervals.length === 0 && rawRRIntervals.length === 0) {
        notify('No data to download yet.', 'warn');
        return;
    }

    const baseFilename = document.getElementById('filename').value || 'polar-h10-data';
    const isTxtFormat = txtToggle.checked;
    const includeRaw = rawDataToggle.checked;

    // Same baseline as the data timestamps (end of calibration); falls back for restored sessions
    const sessionDate = new Date(calibrationStartTime || sessionStartTime);
    const dateStr = sessionDate.toISOString().slice(0, 16); // YYYY-MM-DD
    const tagsStr = sessionTags.length > 0 ? '_' + sessionTags.join('-') : '';
    const dataType = includeRaw ? '_raw' : '_clean';
    const filename = `${baseFilename}_${dateStr}${tagsStr}${dataType}`.replace(/[\\/:*?"<>|]+/g, '-');

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
            live: true,
            includeRaw: includeRaw
        }) + rrCsvBody(exportRR, exportTimes, eventMarkers);

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
        notify('No data to copy yet.', 'warn');
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
        // Copy CSV format with unified metadata
        content = generateMetadataHeader({
            filename: document.getElementById('filename').value || 'polar-h10-data',
            startTime: calibrationStartTime || sessionStartTime,
            tags: sessionTags,
            rrCount: rrIntervals.length,
            rawRRCount: rawRRIntervals.length,
            eventCount: eventMarkers.length,
            live: true,
            includeRaw: includeRaw
        }) + rrCsvBody(exportRR, exportTimes, eventMarkers);
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
        notify('Could not copy to the clipboard (permission denied).', 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Customisation layer — appearance, SRI switch, backup/restore of settings
// (everything persists in localStorage via saveSettings(); no new dependencies)
// ═══════════════════════════════════════════════════════════════════════
const ACCENT_PRESETS = {
    indigo:  { name: 'Indigo',  p: '#6366f1', s: '#ec4899', t: '#22d3ee' },
    teal:    { name: 'Teal',    p: '#14b8a6', s: '#6366f1', t: '#38bdf8' },
    emerald: { name: 'Emerald', p: '#10b981', s: '#22d3ee', t: '#a3e635' },
    rose:    { name: 'Rose',    p: '#f43f5e', s: '#f59e0b', t: '#ec4899' },
    amber:   { name: 'Amber',   p: '#f59e0b', s: '#ef4444', t: '#fde047' },
    violet:  { name: 'Violet',  p: '#8b5cf6', s: '#ec4899', t: '#38bdf8' },
    mono:    { name: 'Mono',    p: '#9ca3af', s: '#6b7280', t: '#e5e7eb' }
};

function hexToRgbStr(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function applyAppearance() {
    const a = appSettings.appearance;
    const pr = ACCENT_PRESETS[a.accent] || ACCENT_PRESETS.indigo;
    const root = document.documentElement.style;
    root.setProperty('--accent-primary',   pr.p);
    root.setProperty('--accent-secondary', pr.s);
    root.setProperty('--accent-tertiary',  pr.t);
    root.setProperty('--accent-rgb',  hexToRgbStr(pr.p));
    root.setProperty('--accent2-rgb', hexToRgbStr(pr.s));
    root.setProperty('--accent3-rgb', hexToRgbStr(pr.t));
    root.setProperty('--radius', `${a.radius}px`);
    document.body.classList.toggle('density-compact', a.density === 'compact');
    document.body.classList.toggle('no-fx',     a.effects === false);
    document.body.classList.toggle('no-motion', a.motion  === false);
    document.body.classList.toggle('no-sri',    appSettings.showSRI === false);
}

// Reflect appSettings into the Settings-panel controls
function syncCustomControls() {
    const a = appSettings.appearance;
    const mark = (sel, val) => document.querySelectorAll(sel).forEach(b =>
        b.classList.toggle('active', String(b.dataset.val) === String(val)));
    mark('#accentGroup .swatch', a.accent);
    mark('#themeGroup .sett-chip', getThemeMode());
    mark('#densityGroup .sett-chip', a.density);
    mark('#radiusGroup .sett-chip', a.radius);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    set('fxToggle', a.effects !== false);
    set('motionToggle', a.motion !== false);
    set('exportLightToggle', appSettings.exportLight !== false);
    set('showSRIToggle', appSettings.showSRI !== false);
}

function applySRIVisibility() {
    const on = appSettings.showSRI !== false;
    document.body.classList.toggle('no-sri', !on);
    if (on) requestAnimationFrame(() => {            // redraw the gauge now that it is visible again
        drawSRIGauge(sriScore);
        if (rrIntervals.length >= 50) updateSRI();
    });
}

function initCustomizationControls() {
    // Accent swatches
    const sw = document.getElementById('accentGroup');
    sw.innerHTML = Object.entries(ACCENT_PRESETS).map(([k, v]) =>
        `<button type="button" class="swatch" data-val="${k}" title="${v.name}" aria-label="${v.name} accent" style="--a:${v.p};--b:${v.s}"></button>`).join('');
    sw.addEventListener('click', e => {
        const b = e.target.closest('.swatch'); if (!b) return;
        appSettings.appearance.accent = b.dataset.val;
        saveSettings(); applyAppearance(); syncCustomControls();
    });
    const chipGroup = (id, apply) => document.getElementById(id).addEventListener('click', e => {
        const b = e.target.closest('.sett-chip'); if (!b) return;
        apply(b.dataset.val); saveSettings(); applyAppearance(); syncCustomControls();
    });
    document.getElementById('themeGroup').addEventListener('click', e => {
        const b = e.target.closest('.sett-chip'); if (b) setThemeMode(b.dataset.val);
    });
    chipGroup('densityGroup', v => { appSettings.appearance.density = v; setTimeout(() => { applyResponsiveGrid(); resizeAllCharts(); }, 50); });
    chipGroup('radiusGroup',  v => { appSettings.appearance.radius = parseInt(v); });
    const bindCheck = (id, fn) => document.getElementById(id).addEventListener('change', e => { fn(e.target.checked); saveSettings(); applyAppearance(); });
    bindCheck('fxToggle',          v => appSettings.appearance.effects = v);
    bindCheck('motionToggle',      v => appSettings.appearance.motion = v);
    bindCheck('exportLightToggle', v => appSettings.exportLight = v);
    bindCheck('showSRIToggle',     v => { appSettings.showSRI = v; });
    document.getElementById('showSRIToggle').addEventListener('change', () => { applySRIVisibility(); renderReportOptions(); broadcastMonitorUpdate(); });

    // Backup
    document.getElementById('exportSettingsBtn').addEventListener('click', exportSettings);
    document.getElementById('importSettingsBtn').addEventListener('click', () => document.getElementById('importSettingsFile').click());
    document.getElementById('importSettingsFile').addEventListener('change', e => { if (e.target.files[0]) importSettings(e.target.files[0]); e.target.value = ''; });
    document.getElementById('resetAllSettingsBtn').addEventListener('click', resetAllSettings);
}

// ── Backup / restore ─────────────────────────────────────────────────────
function exportSettings() {
    let grid = null;
    try { grid = JSON.parse(localStorage.getItem('cardioTraceGridLayout') || 'null'); } catch (e) {}
    const payload = {
        app: 'CardioTrace', version: 1, exportedAt: new Date().toISOString(),
        theme: getThemeMode(), settings: appSettings, gridLayout: grid
    };
    downloadFile(JSON.stringify(payload, null, 2), 'cardiotrace-settings.json', 'application/json');
}

function importSettings(file) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const d = JSON.parse(reader.result);
            if (d.app !== 'CardioTrace' || !d.settings) throw new Error('Not a CardioTrace settings file');
            localStorage.setItem('cardioTraceSettings', JSON.stringify(mergeSettings(d.settings)));
            if (d.theme) localStorage.setItem('theme', d.theme);
            if (d.gridLayout) localStorage.setItem('cardioTraceGridLayout', JSON.stringify(d.gridLayout));
            location.reload();                       // simplest way to re-apply everything consistently
        } catch (err) {
            notify('Could not import settings: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
}

function resetAllSettings() {
    if (!confirm('Reset ALL settings, plot customisations and layout to defaults? Saved sessions are not affected.')) return;
    ['cardioTraceSettings', 'cardioTraceGridLayout', 'theme'].forEach(k => localStorage.removeItem(k));
    location.reload();
}

// ═══════════════════════════════════════════════════════════════════════
// Per-plot tools — ⬇ download (PNG / SVG / CSV) and ⚙ plot settings
// ═══════════════════════════════════════════════════════════════════════
const CHART_META = {
    ecg:          { el: 'ecgChart',          label: 'ECG Signal',        kind: 'line',    color: '#6366f1', width: 1.5, win: false, ylab: 'amplitude_uV' },
    rr:           { el: 'rrChart',           label: 'RR Intervals',      kind: 'line',    color: '#ec4899', width: 2,   win: true,  ylab: 'rr_ms',    upd: () => updateRRChart() },
    rollingRMSSD: { el: 'rollingRMSSDChart', label: 'Rolling RMSSD',     kind: 'line',    color: '#22d3ee', width: 2,   win: true,  ylab: 'rmssd_ms', upd: () => updateRollingRMSSD() },
    poincare:     { el: 'poincareChart',     label: 'Poincaré Plot',     kind: 'scatter', color: '#a78bfa', size: 5 },
    psd:          { el: 'psdChart',          label: 'Wavelet Spectrogram', kind: 'heatmap', colorscale: 'Plasma' },
    hr:           { el: 'hrChart',           label: 'Heart Rate',        kind: 'line',    color: '#f43f5e', width: 2,   win: true,  ylab: 'hr_bpm',   upd: () => updateHRChart() },
    vagalProxy:   { el: 'vagalProxyChart',   label: 'Vagal Proxy',       kind: 'line',    color: '#f59e0b', width: 2,   win: true,  ylab: 'rmssd_over_sdnn', yDefault: [0, 1], upd: () => updateVagalProxyChart() }
};
const COLORSCALES = ['Plasma', 'Viridis', 'Inferno', 'Magma', 'Cividis', 'Turbo', 'Hot', 'Blues'];
const WINDOW_OPTIONS = [[0, 'All'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min'], [1800, '30 min']];
const PLOT_GRID_COLOR = 'rgba(128,128,128,0.2)';

function chartPref(key) {
    const m = CHART_META[key];
    return {
        color: m.color, width: m.width, size: m.size || 5, colorscale: m.colorscale,
        grid: false, yMode: 'default', yMin: null, yMax: null, win: 0, ellipse: true, identity: true,
        ...(appSettings.chartPrefs[key] || {})
    };
}
function saveChartPref(key, patch) {
    appSettings.chartPrefs[key] = { ...(appSettings.chartPrefs[key] || {}), ...patch };
    saveSettings();
}
function hexA(hex, a) { return `rgba(${hexToRgbStr(hex)}, ${a})`; }

// Apply one plot's customisation to its live Plotly graph
function applyChartPrefs(key) {
    const m = CHART_META[key], gd = document.getElementById(m.el);
    if (!gd || !gd.data) return;
    const p = chartPref(key);
    const lay = {
        'xaxis.showgrid': !!p.grid, 'yaxis.showgrid': !!p.grid,
        'xaxis.gridcolor': PLOT_GRID_COLOR, 'yaxis.gridcolor': PLOT_GRID_COLOR
    };
    if (m.kind !== 'heatmap') {
        const fixed = p.yMode === 'fixed' && isFinite(p.yMin) && isFinite(p.yMax) && p.yMin !== null && p.yMax !== null && p.yMin < p.yMax;
        if (fixed)                     lay['yaxis.range'] = [p.yMin, p.yMax];
        else if (p.yMode === 'default' && m.yDefault) lay['yaxis.range'] = m.yDefault.slice();
        else                           lay['yaxis.autorange'] = true;
    }
    Plotly.relayout(gd, lay);
    if (m.kind === 'line') {
        const st = { 'line.color': p.color, 'line.width': p.width };
        if (key === 'vagalProxy') st.fillcolor = hexA(p.color, 0.08);
        Plotly.restyle(gd, st, [0]);
    } else if (m.kind === 'scatter') {
        Plotly.restyle(gd, { 'marker.color': p.color, 'marker.size': p.size }, [0]);
        Plotly.restyle(gd, { visible: !!p.ellipse }, [1]);
        Plotly.restyle(gd, { visible: !!p.identity }, [2]);
    } else if (m.kind === 'heatmap') {
        Plotly.restyle(gd, { colorscale: p.colorscale }, [0]);
    }
}
function applyAllChartPrefs() { Object.keys(CHART_META).forEach(applyChartPrefs); }

// Optional time window for the time-series plots (display only — data are untouched)
function sliceWindow(key, x, y) {
    const w = chartPref(key).win;
    if (!w || !x.length) return [x, y];
    const last = x[x.length - 1];
    let i = x.length - 1;
    while (i > 0 && x[i - 1] >= last - w) i--;
    return [x.slice(i), y.slice(i)];
}

// ── Download ─────────────────────────────────────────────────────────────
function chartToCSV(key) {
    const m = CHART_META[key], gd = document.getElementById(m.el), t = gd.data[0];
    const rows = [];
    if (m.kind === 'heatmap') {
        rows.push('time_s,frequency_hz,log10_power');
        (t.z || []).forEach((row, fi) => (row || []).forEach((v, ti) => rows.push(`${t.x[ti]},${t.y[fi]},${v}`)));
    } else if (key === 'poincare') {
        rows.push('rr_n_ms,rr_n_plus_1_ms');
        (t.x || []).forEach((v, i) => rows.push(`${v},${t.y[i]}`));
    } else {
        rows.push(`time_s,${m.ylab}`);
        (t.x || []).forEach((v, i) => rows.push(`${v},${t.y[i]}`));
    }
    return rows.join('\n');
}

async function downloadChart(key, fmt) {
    const m = CHART_META[key], gd = document.getElementById(m.el);
    if (!gd || !gd.data) return;
    const base = `${document.getElementById('filename').value || 'cardiotrace'}_${key}`;
    if (fmt === 'csv') { downloadFile(chartToCSV(key), `${base}.csv`, 'text/csv'); return; }
    const light = appSettings.exportLight !== false;
    try {
        if (light) await Plotly.relayout(gd, {
            paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', 'font.color': '#111827',
            'xaxis.color': '#111827', 'yaxis.color': '#111827'
        });
        await Plotly.downloadImage(gd, {
            format: fmt, filename: base,
            width: Math.max(gd.clientWidth, 900), height: Math.max(gd.clientHeight, 520),
            scale: fmt === 'png' ? 3 : 1
        });
    } finally {
        if (light) updateChartThemes();              // back to the on-screen look (+ per-plot prefs)
    }
}

// ── Popover (download menu / settings) ───────────────────────────────────
let _cpOpenFor = null;
let _cpAnchor = null;
function closeChartPopover() {
    const pop = document.getElementById('chartPopover');
    pop.classList.remove('open');
    document.querySelectorAll('.chart-tools.is-open').forEach(t => t.classList.remove('is-open'));
    _cpOpenFor = null;
    _cpAnchor = null;
}
function placeChartPopover(anchor) {
    const pop = document.getElementById('chartPopover');
    if (window.innerWidth <= 600) { pop.style.left = pop.style.top = ''; return; }     // CSS bottom sheet
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
}
function openChartPopover(key, mode, anchor) {
    const tag = key + ':' + mode;
    if (_cpOpenFor === tag) { closeChartPopover(); return; }
    closeChartPopover();
    const pop = document.getElementById('chartPopover');
    pop.innerHTML = mode === 'menu' ? chartMenuHTML(key) : chartSettingsHTML(key);
    pop.dataset.key = key; pop.dataset.mode = mode;
    pop.classList.add('open');
    anchor.closest('.chart-tools').classList.add('is-open');
    _cpOpenFor = tag;
    _cpAnchor = anchor;
    placeChartPopover(anchor);
}

function chartMenuHTML(key) {
    const m = CHART_META[key];
    return `<div class="cp-title">${m.label}</div>
        <div class="cp-menu">
            <button type="button" data-dl="png">🖼️ PNG image<span>${appSettings.exportLight !== false ? 'white background' : 'as shown'}</span></button>
            <button type="button" data-dl="svg">✒️ SVG vector<span>for journals</span></button>
            <button type="button" data-dl="csv">📄 CSV data<span>plotted values</span></button>
        </div>`;
}

function chartSettingsHTML(key) {
    const m = CHART_META[key], p = chartPref(key);
    const row = (label, ctl) => `<div class="cp-row"><label>${label}</label>${ctl}</div>`;
    let h = `<div class="cp-title">${m.label} · settings</div>`;
    if (m.kind === 'line') {
        h += row('Colour', `<input type="color" data-f="color" value="${p.color}">`);
        h += row('Line width', `<span class="cp-range"><input type="range" data-f="width" min="1" max="4" step="0.5" value="${p.width}"><b>${p.width}</b></span>`);
    } else if (m.kind === 'scatter') {
        h += row('Point colour', `<input type="color" data-f="color" value="${p.color}">`);
        h += row('Point size', `<span class="cp-range"><input type="range" data-f="size" min="2" max="12" step="1" value="${p.size}"><b>${p.size}</b></span>`);
        h += row('SD1/SD2 ellipse', `<input type="checkbox" data-f="ellipse" ${p.ellipse ? 'checked' : ''}>`);
        h += row('Identity line', `<input type="checkbox" data-f="identity" ${p.identity ? 'checked' : ''}>`);
    } else {
        h += row('Colour scale', `<select data-f="colorscale">${COLORSCALES.map(c => `<option ${c === p.colorscale ? 'selected' : ''}>${c}</option>`).join('')}</select>`);
    }
    h += row('Grid lines', `<input type="checkbox" data-f="grid" ${p.grid ? 'checked' : ''}>`);
    if (m.kind !== 'heatmap') {
        h += row('Y axis', `<select data-f="yMode">
            <option value="default" ${p.yMode === 'default' ? 'selected' : ''}>Default</option>
            <option value="auto" ${p.yMode === 'auto' ? 'selected' : ''}>Auto-fit</option>
            <option value="fixed" ${p.yMode === 'fixed' ? 'selected' : ''}>Fixed</option></select>`);
        h += `<div class="cp-row cp-yrange" ${p.yMode === 'fixed' ? '' : 'hidden'}><label>Min / Max</label>
            <span><input type="number" data-f="yMin" step="any" value="${p.yMin ?? ''}" placeholder="min"><input type="number" data-f="yMax" step="any" value="${p.yMax ?? ''}" placeholder="max"></span></div>`;
    }
    if (m.win) {
        h += row('Time window', `<select data-f="win">${WINDOW_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === p.win ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
    }
    h += `<div class="cp-actions"><button type="button" class="btn btn-secondary" data-act="reset">↺ Reset plot</button><button type="button" class="btn btn-primary" data-act="close">Done</button></div>`;
    return h;
}

function initChartTools() {
    Object.entries(CHART_META).forEach(([key, m]) => {
        const box = document.getElementById(m.el)?.closest('.chart-container');
        if (!box || box.querySelector('.chart-tools')) return;
        const t = document.createElement('div');
        t.className = 'chart-tools';
        t.innerHTML = `<button type="button" class="ct-btn" data-act="menu" title="Download plot" aria-label="Download ${m.label}">⬇</button>` +
                      `<button type="button" class="ct-btn" data-act="cfg" title="Plot settings" aria-label="${m.label} settings">⚙</button>`;
        t.addEventListener('click', e => {
            const b = e.target.closest('.ct-btn'); if (!b) return;
            e.stopPropagation();
            openChartPopover(key, b.dataset.act === 'menu' ? 'menu' : 'settings', b);
        });
        box.appendChild(t);
    });

    const pop = document.getElementById('chartPopover');
    pop.addEventListener('click', e => {
        const key = pop.dataset.key;
        const dl = e.target.closest('[data-dl]');
        if (dl) { closeChartPopover(); downloadChart(key, dl.dataset.dl); return; }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'close') closeChartPopover();
        if (act.dataset.act === 'reset') {
            delete appSettings.chartPrefs[key]; saveSettings();
            applyChartPrefs(key); CHART_META[key].upd && CHART_META[key].upd();
            pop.innerHTML = chartSettingsHTML(key);
        }
    });
    const onField = e => {
        const f = e.target.dataset.f; if (!f) return;
        const key = pop.dataset.key, el = e.target;
        let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : parseFloat(el.value))
              : (f === 'width' || f === 'size' || f === 'win') ? parseFloat(el.value) : el.value;
        saveChartPref(key, { [f]: v });
        if (el.type === 'range') el.nextElementSibling.textContent = v;
        if (f === 'yMode') pop.querySelector('.cp-yrange').hidden = v !== 'fixed';
        if ((f === 'yMin' || f === 'yMax') && chartPref(key).yMode !== 'fixed') return;
        applyChartPrefs(key);
        if (f === 'win' && CHART_META[key].upd) CHART_META[key].upd();
    };
    pop.addEventListener('input', onField);
    pop.addEventListener('change', onField);

    document.addEventListener('pointerdown', e => {
        if (!_cpOpenFor) return;
        if (e.target.closest('#chartPopover') || e.target.closest('.chart-tools')) return;
        closeChartPopover();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChartPopover(); });
    window.addEventListener('resize', closeChartPopover);
    // Follow the anchor while the page scrolls (also layout-driven scrolls while a setting is being edited);
    // close only when the anchor has left the screen.
    document.addEventListener('scroll', () => {
        if (!_cpOpenFor || window.innerWidth <= 600 || !_cpAnchor) return;
        const r = _cpAnchor.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) closeChartPopover(); else placeChartPopover(_cpAnchor);
    }, true);
}

// ═══════════════════════════════════════════════════════════════════════
// Report contents — choose which sections the HTML report includes
// ═══════════════════════════════════════════════════════════════════════
const REPORT_SECTIONS = [
    { id: 'kpis',           label: 'Summary cards',          group: 'Overview' },
    { id: 'interpretation', label: 'Interpretation banner',  group: 'Overview', sri: true },
    { id: 'rr',             label: 'RR intervals plot',      group: 'Plots' },
    { id: 'rmssd',          label: 'Rolling RMSSD plot',     group: 'Plots' },
    { id: 'spectrogram',    label: 'Wavelet spectrogram',    group: 'Plots' },
    { id: 'poincare',       label: 'Poincaré plot',          group: 'Plots' },
    { id: 'hr',             label: 'Heart rate + zones',     group: 'Plots' },
    { id: 'vagal',          label: 'Vagal proxy plot',       group: 'Plots' },
    { id: 'timeDomain',     label: 'Time-domain table',      group: 'Tables' },
    { id: 'freqDomain',     label: 'Frequency-domain table', group: 'Tables' },
    { id: 'events',         label: 'Event log',              group: 'Tables' },
    { id: 'metadata',       label: 'Session metadata',       group: 'Tables' },
    { id: 'sriBreakdown',   label: 'SRI breakdown',          group: 'SRI', sri: true },
    { id: 'references',     label: 'SRI reference scale',    group: 'SRI', sri: true },
    { id: 'notes',          label: 'Methods notes',          group: 'Notes' }
];
const REPORT_PRESETS = {
    all:        () => REPORT_SECTIONS.map(s => s.id),
    essentials: () => ['kpis', 'rr', 'spectrogram', 'poincare', 'timeDomain', 'freqDomain', 'metadata'],
    charts:     () => ['rr', 'rmssd', 'spectrogram', 'poincare', 'hr', 'vagal'],
    tables:     () => ['kpis', 'timeDomain', 'freqDomain', 'events', 'metadata']
};

// Is a section included right now? (missing key = on; SRI sections follow the SRI switch)
function reportOn(id) {
    const def = REPORT_SECTIONS.find(s => s.id === id);
    if (def && def.sri && appSettings.showSRI === false) return false;
    return appSettings.report.sections[id] !== false;
}

function renderReportOptions() {
    const box = document.getElementById('reportOptionsList');
    if (!box) return;
    document.querySelectorAll('#reportScaleGroup .sett-chip').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.val) === (appSettings.report.scale || 4)));
    let lastGroup = '';
    box.innerHTML = REPORT_SECTIONS.filter(s => !(s.sri && appSettings.showSRI === false)).map(s => {
        const head = s.group !== lastGroup ? `<div class="rep-group">${s.group}</div>` : '';
        lastGroup = s.group;
        return `${head}<label class="rep-item"><input type="checkbox" data-sec="${s.id}" ${reportOn(s.id) ? 'checked' : ''}><span>${s.label}</span></label>`;
    }).join('');
}

function openReportOptions() {
    renderReportOptions();
    document.getElementById('reportOptionsPanel').classList.add('active');
    document.getElementById('reportOptionsOverlay').classList.add('active');
    document.getElementById('reportGenerateBtn').disabled = rrIntervals.length === 0;
}
function closeReportOptions() {
    document.getElementById('reportOptionsPanel').classList.remove('active');
    document.getElementById('reportOptionsOverlay').classList.remove('active');
}

function initReportOptions() {
    renderReportOptions();
    document.getElementById('reportOptionsBtn').addEventListener('click', openReportOptions);
    document.getElementById('settingsReportBtn').addEventListener('click', () => { closeSettings(); openReportOptions(); });
    document.getElementById('reportOptionsClose').addEventListener('click', closeReportOptions);
    document.getElementById('reportOptionsDone').addEventListener('click', closeReportOptions);
    document.getElementById('reportOptionsOverlay').addEventListener('click', closeReportOptions);
    document.getElementById('reportGenerateBtn').addEventListener('click', () => { closeReportOptions(); generatePDFReport(); });
    document.getElementById('reportOptionsList').addEventListener('change', e => {
        const id = e.target.dataset.sec; if (!id) return;
        appSettings.report.sections[id] = e.target.checked;
        saveSettings();
    });
    document.getElementById('reportScaleGroup').addEventListener('click', e => {
        const b = e.target.closest('.sett-chip'); if (!b) return;
        appSettings.report.scale = parseInt(b.dataset.val); saveSettings(); renderReportOptions();
    });
    document.getElementById('reportPresets').addEventListener('click', e => {
        const b = e.target.closest('[data-preset]'); if (!b) return;
        const on = new Set(REPORT_PRESETS[b.dataset.preset]());
        REPORT_SECTIONS.forEach(s => { appSettings.report.sections[s.id] = on.has(s.id); });
        saveSettings(); renderReportOptions();
    });
}

// ══════════════════════════════════════════════════════════════════════════
// Artifact panel — preview, re-clean stored sessions, choose the live method
// ══════════════════════════════════════════════════════════════════════════
let _artTarget = { kind: 'none' };   // { kind: 'session', id } | { kind: 'batch', ids } | { kind: 'live' } | { kind: 'none' }
let _artPreviewSrc = null;           // { rr, times, label } raw series used for the preview

function artPanelCfg() { return { ...appSettings.artifactRetro, centered: appSettings.artifactRetro.method === 'median' }; }

// "Last minute" stats of a clean series, as stored in stats.avgRR / stats.rmssd by live saves
function windowStatsOf(rr, ts, windowSecs = 60) {
    if (!rr.length) return { avgRR: null, rmssd: null };
    const from = ts[ts.length - 1] - windowSecs;
    let n = 0, sum = 0, prev = null, sq = 0, pairs = 0;
    for (let i = 0; i < rr.length; i++) {
        if (ts[i] < from) continue;
        n++; sum += rr[i];
        if (prev !== null) { sq += (rr[i] - prev) ** 2; pairs++; }
        prev = rr[i];
    }
    return { avgRR: n ? sum / n : null, rmssd: pairs ? Math.sqrt(sq / pairs) : null };
}

function updateArtifactSettingsSummary() {
    const el = document.getElementById('artifactLiveSummary');
    if (el) el.textContent = `Live: ${describeArtifactCfg(liveArtifactCfg())}.` +
        (isConnected ? ' Changes apply from the next recording.' : '');
    document.querySelectorAll('#artifactGroup .sett-chip').forEach(btn =>
        btn.classList.toggle('active', appSettings.artifactMethod === 'delta' && parseInt(btn.dataset.val) === appSettings.artifactThreshold));
}

async function openArtifactPanel(target = null) {
    _artTarget = target || (isConnected ? { kind: 'live' } : (shownSessionId != null ? { kind: 'session', id: shownSessionId } : { kind: 'none' }));
    _artPreviewSrc = null;
    const tEl = document.getElementById('artifactTarget');
    if (_artTarget.kind === 'session') {
        const s = await loadSession(_artTarget.id);
        if (s) _artPreviewSrc = { rr: s.rawRRIntervals?.length ? s.rawRRIntervals : s.rrIntervals, times: s.rawRRIntervals?.length ? s.rawTimestamps : s.timestamps };
        tEl.textContent = `Session: ${s?.filename || ''} — preview and apply to this stored session.`;
    } else if (_artTarget.kind === 'batch') {
        const s = await loadSession(_artTarget.ids[0]);
        if (s) _artPreviewSrc = { rr: s.rawRRIntervals?.length ? s.rawRRIntervals : s.rrIntervals, times: s.rawRRIntervals?.length ? s.rawTimestamps : s.timestamps };
        tEl.textContent = `${_artTarget.ids.length} selected session(s) — preview shows "${s?.filename || ''}".`;
    } else if (_artTarget.kind === 'live') {
        _artPreviewSrc = { rr: rawRRIntervals.slice(), times: rawTimestamps.slice() };
        tEl.textContent = 'Live recording — preview on the data received so far. Stored sessions can be re-cleaned after disconnecting.';
    } else {
        tEl.textContent = 'No session shown: open one from History (or select sessions in Export) to re-clean it. You can still choose the live method.';
    }
    renderArtifactPanel();
    document.getElementById('artifactPanel').classList.add('active');
    document.getElementById('artifactOverlay').classList.add('active');
}
function closeArtifactPanel() {
    document.getElementById('artifactPanel').classList.remove('active');
    document.getElementById('artifactOverlay').classList.remove('active');
}

function renderArtifactPanel() {
    const cfg = artPanelCfg();
    const mark = (sel, val) => document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', String(b.dataset.val) === String(val)));
    mark('#artMethodGroup .sett-chip', cfg.method);
    mark('#artDeltaGroup .sett-chip', cfg.deltaMs);
    mark('#artPercentGroup .sett-chip', cfg.percent);
    mark('#artLevelGroup .sett-chip', cfg.level);
    mark('#artCorrectionGroup .sett-chip', cfg.correction);
    document.getElementById('artIterative').checked = cfg.iterative !== false;
    document.querySelectorAll('#artifactPanel .art-param').forEach(el => el.classList.toggle('is-active', el.dataset.for === cfg.method));
    document.getElementById('artifactDescription').textContent = describeArtifactCfg(cfg);

    const apply = document.getElementById('artifactApplyBtn');
    apply.disabled = !(_artTarget.kind === 'session' || _artTarget.kind === 'batch');
    apply.textContent = _artTarget.kind === 'batch' ? `Apply to ${_artTarget.ids.length} session(s)` : 'Apply to this session';
    const live = document.getElementById('artifactLiveBtn');
    live.disabled = !ARTIFACT_METHODS[cfg.method].live;
    live.title = live.disabled ? 'The automatic method needs the following beats: retrospective only' : 'Use this detection method for the next recordings (artifacts are removed live)';

    const sum = document.getElementById('artifactSummary');
    const src = _artPreviewSrc;
    if (!src || !src.rr || src.rr.length < 4) {
        sum.textContent = 'No data to preview.';
        try { Plotly.purge('artifactPreviewChart'); } catch (e) { /* not drawn yet */ }
        return;
    }
    const res = applyArtifactCorrection(src.rr, src.times, cfg);
    const n = src.rr.length, f = res.flagged.length;
    const c = res.counts;
    const detail = cfg.method === 'lipponen'
        ? `ectopic ${c.ectopic} · missed ${c.missed} · extra ${c.extra} · long/short ${c.longshort}${c.iterations > 1 ? ` · ${c.iterations} passes` : ''}`
        : `out of range ${c.outOfRange} · excessive deviation ${c.deviation}`;
    sum.innerHTML = `<b>${n}</b> raw intervals · <b>${f}</b> flagged (${(f / n * 100).toFixed(1)} %) — ${escapeHTML(detail)}<br>` +
        `Result: <b>${res.rr.length}</b> intervals (${cfg.correction === 'interpolate' ? 'corrected' : 'artifacts removed'})`;
    const [rx, ry] = decimateXY(src.times, src.rr);
    const [cx, cy] = decimateXY(res.times, res.rr);
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const fg = isLight ? '#4b5563' : '#9ca3af';
    Plotly.react('artifactPreviewChart', [
        { x: rx, y: ry, type: 'scatter', mode: 'lines', name: 'Raw', line: { color: 'rgba(156,163,175,0.9)', width: 1, dash: 'dot' } },
        { x: cx, y: cy, type: 'scatter', mode: 'lines', name: 'Clean', line: { color: getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim() || '#6366f1', width: 1.5 } },
        { x: res.flagged.map(k => src.times[k]), y: res.flagged.map(k => src.rr[k]), type: 'scatter', mode: 'markers', name: 'Flagged',
          marker: { color: '#ef4444', size: 7, symbol: 'x' } }
    ], {
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', margin: { t: 8, r: 8, l: 44, b: 30 }, autosize: true,
        font: { color: fg, family: 'Inter, sans-serif', size: 10 }, showlegend: true,
        legend: { orientation: 'h', y: 1.12, x: 0, bgcolor: 'rgba(0,0,0,0)' },
        xaxis: { title: '', color: fg, showgrid: false, zeroline: false }, yaxis: { title: 'RR (ms)', color: fg, showgrid: false, zeroline: false }
    }, { responsive: true, displayModeBar: false });
}

// Re-clean one stored session from its raw stream (raw is never changed); returns a short result line
async function reprocessSession(id, cfg) {
    if (isLiveSession(id)) throw new Error('it is being recorded');
    const s = await loadSession(id);
    if (!s) throw new Error('not found');
    const raw  = s.rawRRIntervals?.length ? s.rawRRIntervals : s.rrIntervals;     // very old sessions: clean = raw
    const rawT = s.rawRRIntervals?.length ? s.rawTimestamps : s.timestamps;
    const res = applyArtifactCorrection(raw, rawT, cfg);
    if (res.rr.length < 2) throw new Error('fewer than 2 intervals would remain');
    const win = windowStatsOf(res.rr, res.times);
    const sri = res.rr.length >= 50 ? calculateSRI(res.rr, res.times) : null;
    await updateSession(id, {
        rrIntervals: res.rr, timestamps: res.times, rawRRIntervals: raw, rawTimestamps: rawT,
        stats: { samples: res.rr.length, avgRR: win.avgRR, rmssd: win.rmssd },
        sri: sri ? sri.score : 0, sriComponents: sri ? sri.components : { rmssd: 0, lfhf: 0, hrRecovery: 0 }, peakHR: sri ? sri.peakHR : 0,
        artifactFilter: { ...cfg, appliedAt: new Date().toISOString(), flagged: res.flagged.length, counts: res.counts }
    });
    return `✓ ${s.filename || id}: ${res.flagged.length} of ${raw.length} flagged → ${res.rr.length} intervals`;
}

async function applyArtifactPanel() {
    const cfg = artPanelCfg();
    const ids = _artTarget.kind === 'batch' ? _artTarget.ids : _artTarget.kind === 'session' ? [_artTarget.id] : [];
    if (!ids.length) return;
    if (ids.length > 1 && !confirm(`Re-clean ${ids.length} sessions with:\n${describeArtifactCfg(cfg)}?\n\nRaw data are kept; this can be redone with another method.`)) return;
    const lines = [];
    for (const id of ids) {
        try { lines.push(await reprocessSession(id, cfg)); } catch (e) { lines.push(`✗ session ${id}: ${e.message || e}`); }
    }
    closeArtifactPanel();
    await updateHistoryBadge();
    if (shownSessionId != null && ids.includes(shownSessionId) && !isConnected) await restoreSession(shownSessionId);
    if (currentTab === 'history') await renderHistory();
    if (currentTab === 'export') await renderExportTab();
    if (currentTab === 'analyze') await renderAnalyzeTab();
    const failed = lines.filter(l => l.startsWith('✗')).length;
    notify(ids.length > 1 ? `Re-cleaned ${ids.length - failed} of ${ids.length} sessions` : (failed ? 'Re-cleaning failed' : 'Session re-cleaned'),
        failed ? 'warn' : 'success', { detail: lines });
}

function useArtifactPanelForLive() {
    const cfg = artPanelCfg();
    if (!ARTIFACT_METHODS[cfg.method].live) return;
    appSettings.artifactMethod = cfg.method;
    appSettings.artifactThreshold = cfg.deltaMs;
    appSettings.artifactPercent = cfg.percent;
    appSettings.artifactMedianLevel = cfg.level;
    saveSettings();
    updateArtifactSettingsSummary();
    notify(`Live artifact filter set${isConnected ? ' — it applies from the next recording' : ''}`, 'success', { detail: [describeArtifactCfg(liveArtifactCfg())] });
}

function initArtifactPanel() {
    const setRetro = patch => { appSettings.artifactRetro = { ...appSettings.artifactRetro, ...patch }; saveSettings(); renderArtifactPanel(); };
    const chips = (id, fn) => document.getElementById(id).addEventListener('click', e => { const b = e.target.closest('.sett-chip'); if (b) fn(b.dataset.val); });
    chips('artMethodGroup', v => setRetro({ method: v }));
    chips('artDeltaGroup', v => setRetro({ deltaMs: parseInt(v) }));
    chips('artPercentGroup', v => setRetro({ percent: parseInt(v) }));
    chips('artLevelGroup', v => setRetro({ level: v }));
    chips('artCorrectionGroup', v => setRetro({ correction: v }));
    document.getElementById('artIterative').addEventListener('change', e => setRetro({ iterative: e.target.checked }));
    document.getElementById('artifactClose').addEventListener('click', closeArtifactPanel);
    document.getElementById('artifactOverlay').addEventListener('click', closeArtifactPanel);
    document.getElementById('artifactApplyBtn').addEventListener('click', applyArtifactPanel);
    document.getElementById('artifactLiveBtn').addEventListener('click', useArtifactPanelForLive);
    document.getElementById('artifactBtn').addEventListener('click', () => openArtifactPanel());
    document.getElementById('artifactMoreBtn').addEventListener('click', () => { closeSettings(); openArtifactPanel(); });
    document.getElementById('exportArtifactBtn').addEventListener('click', () => {
        if (exportSelectedIds.size) openArtifactPanel({ kind: 'batch', ids: [...exportSelectedIds] });
    });
    updateArtifactSettingsSummary();
}

// ══════════════════════════════════════════════════════════════════════════
// Record-tab context banner: what am I looking at, and what can I do next?
//   nothing yet  → short "get started" guide        live → hidden (status, timer and charts say it)
//   saved session → name, date, duration, source, artifact filter + Artifacts / Report / Close
// ══════════════════════════════════════════════════════════════════════════
function updateSessionBanner() {
    const el = document.getElementById('sessionBanner');
    const hasData = rrIntervals.length > 0 || rawRRIntervals.length > 0;
    const viewing = !isConnected && shownSessionId != null && hasData;
    if (resetBtn) {
        resetBtn.textContent = viewing ? '✕ Close Session' : 'Reset Session';
        resetBtn.classList.toggle('btn-danger', !viewing);
        resetBtn.classList.toggle('btn-secondary', viewing);
        resetBtn.title = viewing ? 'Close the saved session (it stays in History)' : 'Clear the data of the current recording';
        resetBtn.disabled = !isConnected && !hasData;
    }
    if (!el) return;
    if (isConnected) { el.hidden = true; return; }
    if (viewing) {
        const m = shownSessionMeta || {};
        const source = sessionImportInfo ? `📥 imported (${sessionImportInfo.format || 'file'})`
                     : sessionDeviceInfo ? `${sessionDeviceInfo.source === 'ppg' ? '⌚' : '🫀'} ${describeRRSource(sessionDeviceInfo)}` : '';
        const filt = sessionArtifactCfg ? `🧹 ${ARTIFACT_METHODS[sessionArtifactCfg.method]?.label || ''}` : '';
        el.className = 'session-banner session-banner--stored';
        el.innerHTML = `<div class="sb-main"><span class="sb-icon">📂</span><div class="sb-text">
                <div class="sb-title">Saved session · <b>${escapeHTML(m.name || '')}</b></div>
                <div class="sb-meta">${[m.subject ? `👤 ${m.subject}` : '', m.startTime ? new Date(m.startTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '',
                    formatDuration(m.duration || 0), source, filt].filter(Boolean).map(escapeHTML).join(' · ')}</div></div></div>
            <div class="sb-actions">
                <button class="btn btn-secondary" data-act="artifacts" type="button">🧹 Artifacts</button>
                <button class="btn btn-secondary" data-act="report" type="button">📄 Report</button>
                <button class="btn btn-secondary" data-act="close" type="button">✕ Close</button>
            </div>`;
        el.hidden = false;
        return;
    }
    if (!hasData) {
        el.className = 'session-banner session-banner--guide';
        el.innerHTML = `<div class="sb-steps">
                <div class="sb-step"><span>1</span><p>Choose the <b>subject</b> and, optionally, a <b>protocol</b></p></div>
                <div class="sb-step"><span>2</span><p><b>Connect</b> a Bluetooth heart-rate sensor that sends RR intervals (e.g. Polar H10)</p></div>
                <div class="sb-step"><span>3</span><p><b>Mark events</b> while recording — the session is auto-saved</p></div>
                <div class="sb-step"><span>4</span><p><b>Disconnect</b> to finish; review it in History, Analyze or Export</p></div>
            </div>
            <div class="sb-actions">
                <button class="btn btn-secondary" data-act="history" type="button">📋 Open a saved session</button>
                <button class="btn btn-secondary" data-act="import" type="button">📥 Import RR files</button>
            </div>`;
        el.hidden = false;
        return;
    }
    el.hidden = true;
}
function initSessionBanner() {
    document.getElementById('sessionBanner')?.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'artifacts') openArtifactPanel();
        else if (act === 'report') generatePDFReport();
        else if (act === 'close') performSessionReset(false);
        else if (act === 'history') switchTab('history');
        else if (act === 'import') document.getElementById('importRRFile')?.click();
    });
    updateSessionBanner();
}

// ── History table selection bar ─────────────────────────────────────────
function updateHistorySelectionBar() {
    const bar = document.getElementById('historySelectionBar');
    if (!bar) return;
    const n = historySelectedIds.size;
    bar.hidden = n === 0;
    document.getElementById('historySelCount').textContent = `${n} selected`;
}
async function deleteSelectedHistorySessions() {
    const ids = [...historySelectedIds];
    const live = ids.filter(id => isLiveSession(id));
    const del = ids.filter(id => !isLiveSession(id));
    if (!del.length) { notify('The selected session is being recorded. Disconnect first, then delete it.', 'warn'); return; }
    if (!confirm(`Delete ${del.length} session(s)? This cannot be undone.` + (live.length ? '\n(The session being recorded is kept.)' : ''))) return;
    for (const id of del) await deleteSession(id);
    del.forEach(id => historySelectedIds.delete(id));
    if (!isConnected && del.includes(shownSessionId)) await performSessionReset(false);
    await renderHistoryTable();
    await updateHistoryBadge();
    notify(`Deleted ${del.length} session(s)`, 'success');
}
function initHistorySelection() {
    document.getElementById('histSelDownload')?.addEventListener('click', () => bulkDownloadSessions({ ids: new Set(historySelectedIds) }));
    document.getElementById('histSelArtifacts')?.addEventListener('click', () => {
        if (historySelectedIds.size) openArtifactPanel({ kind: 'batch', ids: [...historySelectedIds] });
    });
    document.getElementById('histSelDelete')?.addEventListener('click', deleteSelectedHistorySessions);
    document.getElementById('histSelClear')?.addEventListener('click', () => { historySelectedIds.clear(); renderHistoryTable(); });
}

// Initialize on page load
(async () => {
    try {
        loadSettings();
        applyAppearance();
        initCustomizationControls();
        initChartTools();
        initReportOptions();
        initArtifactPanel();
        initSessionBanner();
        initHistorySelection();

        try {
            await initDB();
        } catch (e) {
            // Blocked storage / some private modes: keep the app usable (live view, exports), say what is missing
            console.error('IndexedDB unavailable:', e);
            notify('Session history is not available in this browser (storage is blocked or disabled). ' +
                  'You can still record, but sessions are NOT saved automatically: export each recording before closing the page.', 'error', { persist: true });
        }
        await updateHistoryBadge();
        loadTheme();
        updateChartThemes();            // also applies per-plot customisation
        initChartPlaceholders();
        applySettings();
        initGrid();

        if (document.getElementById('sriGauge')) {
            drawSRIGauge(0);
            updateSRI();
            initGaugeResponsiveness();
        }

        updateSubjectChipDisplay();
        updateProtocolChipDisplay();
        updateModesAvailability();

        console.log('✓ App initialized');
    } catch (error) {
        console.error('Initialization failed:', error);
    }
})();

// Show (icon + text) or remove (icon = null) a placeholder on one chart
function setChartPlaceholder(id, icon, text = '') {
    const el = document.getElementById(id);
    if (!el) return;
    let ph = el.querySelector('.chart-placeholder');
    if (!icon) { if (ph) ph.remove(); el.classList.remove('chart-blurred'); return; }
    if (!ph) { ph = document.createElement('div'); ph.className = 'chart-placeholder'; el.appendChild(ph); }
    ph.innerHTML = `<div class="chart-placeholder-icon">${icon}</div><div class="chart-placeholder-text">${escapeHTML(text)}</div>`;
    el.classList.add('chart-blurred');
}

// Initialize chart placeholders
function initChartPlaceholders() {
    const placeholders = [
        { id: 'ecgChart',          icon: '〰️', text: 'The ECG appears here while recording with a Polar sensor' },
        { id: 'rrChart',           icon: '💓', text: 'Waiting for data — connect a sensor or open a saved session' },
        { id: 'poincareChart',     icon: '⬚',  text: 'Waiting for data — connect a sensor or open a saved session' },
        { id: 'rollingRMSSDChart', icon: '⏱️', text: 'Chart available after 30 seconds' },
        { id: 'psdChart',          icon: '🌊', text: 'Spectrogram available after 50 RR intervals' },
        { id: 'hrChart',           icon: '💓', text: 'Waiting for data — connect a sensor or open a saved session' },
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
