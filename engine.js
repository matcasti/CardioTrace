
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
    psd: 0
};
const CHART_UPDATE_INTERVAL = 100; // ms
let isConnected = false;
let ecgSupported = false;
let sessionStartTime = Date.now();
let calibrationStartTime = null;
let timerInterval = null;
let autoSaveInterval = null;
let currentSessionId = null;
let lastPSDResult = null; // Store last PSD calculation for reuse
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

    ['ecgChart', 'rrChart', 'rollingRMSSDChart', 'poincareChart', 'psdChart'].forEach(id => {
        Plotly.relayout(id, updateLayout);
    });
}

// Calculate HR zones
function getHRZone(hr, age = 30) {
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
    const maxDiff = 300; // Max change between consecutive RR intervals (ms)

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
    return ((cleanedLength / originalLength) * 100).toFixed(1);
}

// Lomb-Scargle periodogram implementation
function lombScarglePeriodogram(times, values, frequencies) {
    const n = times.length;
    if (n < 2 || frequencies.length < 2) return frequencies.map(() => 0);

    // --- 1) Demean values (important)
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const y = values.map(v => v - mean); // y in ms

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

// Update PSD chart
function updatePSDChart() {
    const psdChart = document.getElementById('psdChart');
    let placeholder = psdChart.querySelector('.chart-placeholder');

    if (rrIntervals.length < 50) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'chart-placeholder';
            placeholder.innerHTML = `
                <div class="chart-placeholder-icon">📊</div>
                <div class="chart-placeholder-text">Chart available after 50 RR intervals</div>
            `;
            psdChart.appendChild(placeholder);
        }
        psdChart.classList.add('chart-blurred');
        return;
    } else {
        if (placeholder) placeholder.remove();
        psdChart.classList.remove('chart-blurred');
    }

    const { freq, power } = calculatePSD(rrIntervals, timestamps);

    if (freq.length === 0 || power.length === 0) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'chart-placeholder';
            placeholder.innerHTML = `
                <div class="chart-placeholder-icon">⚠️</div>
                <div class="chart-placeholder-text">Insufficient valid data for PSD calculation</div>
            `;
            psdChart.appendChild(placeholder);
        }
        psdChart.classList.add('chart-blurred');
        return;
    }

    // Calculate band powers with improved integration
    const vlfPower = integrateBandPower(freq, power, 0.003, 0.04);
    const lfPower = integrateBandPower(freq, power, 0.04, 0.15);
    const hfPower = integrateBandPower(freq, power, 0.15, 0.4);
    const totalPower = integrateBandPower(freq, power, 0.003, 0.4);


    // build bin areas by trapezoid attribution (handles nonuniform spacing)
    const binAreas = new Array(power.length).fill(0);
    for (let i = 1; i < freq.length; i++) {
      const df = freq[i] - freq[i - 1];
      if (!isFinite(df) || df <= 0) continue;
      const avgDensity = 0.5 * (power[i] + power[i - 1]); // ms^2/Hz
      const area = avgDensity * df;                       // ms^2
      // distribute half to left bin and half to right bin for smoother plotting
      binAreas[i - 1] += area * 0.5;
      binAreas[i]     += area * 0.5;
    }

    // normalize so sum(binAreas) == 1 (unitless fractions)
    const totalIntegrated = totalPower || binAreas.reduce((s, a) => s + a, 0) || 1;
    const normalized = binAreas.map(a => a / totalIntegrated); // sums ≈ 1
    const powerNormalized = normalized.map(n => n * 100);        // sums ≈ 100

    // band percentages for annotations
    const vlfPct = (vlfPower / totalPower) * 100;
    const lfPct  = (lfPower  / totalPower) * 100;
    const hfPct  = (hfPower  / totalPower) * 100;

    // Calculate LF/HF ratio with safety checks
    const lfhfRatio = (hfPower > 0 && isFinite(lfPower) && isFinite(hfPower))
        ? (lfPower / hfPower)
        : 0;

    // STORE the PSD result for SRI calculation to use
    lastPSDResult = {
        freq,
        power,
        lfPower,
        hfPower,
        lfhfRatio,
        vlfPower,
        totalPower,
        dataLength: rrIntervals.length,
        timestampsLength: timestamps.length
    };

    // Validate all power values
    const isValidPower = (val) => isFinite(val) && val >= 0;

    // Mark VLF, LF, and HF bands
    const shapes = [
        {
            type: 'rect',
            xref: 'x', yref: 'paper',
            x0: 0.003, x1: 0.04,
            y0: 0, y1: 1,
            fillcolor: 'rgba(156, 163, 175, 0.15)',
            line: { width: 0 }
        },
        {
            type: 'rect',
            xref: 'x', yref: 'paper',
            x0: 0.04, x1: 0.15,
            y0: 0, y1: 1,
            fillcolor: 'rgba(99, 102, 241, 0.15)',
            line: { width: 0 }
        },
        {
            type: 'rect',
            xref: 'x', yref: 'paper',
            x0: 0.15, x1: 0.4,
            y0: 0, y1: 1,
            fillcolor: 'rgba(236, 72, 153, 0.15)',
            line: { width: 0 }
        }
    ];

    const annotations = [
        {
            x: 0.02, y: 1.08, yref: 'paper',
            text: `VLF (${isValidPower(vlfPower) ? vlfPct.toFixed(1) : '0.0'}%)`,
            showarrow: false,
            font: { size: 12, color: '#9ca3af', weight: 1000 },
            xanchor: 'center'
        },
        {
            x: 0.095, y: 1.08, yref: 'paper',
            text: `LF (${isValidPower(lfPower) ? lfPct.toFixed(1) : '0.0'}%)`,
            showarrow: false,
            font: { size: 12, color: '#6366f1', weight: 1000 },
            xanchor: 'center'
        },
        {
            x: 0.275, y: 1.08, yref: 'paper',
            text: `HF (${isValidPower(hfPower) ? hfPct.toFixed(1) : '0.0'}%)`,
            showarrow: false,
            font: { size: 12, color: '#ec4899', weight: 1000 },
            xanchor: 'center'
        },
        {
            x: 0.40, y: 1.08, yref: 'paper',
            text: `LF/HF: ${isValidPower(lfhfRatio) ? lfhfRatio.toFixed(2) : '0.00'}`,
            showarrow: false,
            font: { size: 12, color: '#22d3ee', weight: 1000 },
            xanchor: 'right'
        }
    ];

    Plotly.update('psdChart', {
        x: [freq],
        y: [powerNormalized]
    }, {
        shapes: shapes,
        annotations: annotations
    }, [0]);
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
            duration: Math.floor((Date.now() - (sessionData.startTime || calibrationStartTime || sessionStartTime)) / 1000),
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
async function autoSaveSession() {
    if (!isConnected || rrIntervals.length === 0) return;

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
    }
}

// Start auto-save
function startAutoSave() {
    if (autoSaveInterval) clearInterval(autoSaveInterval);
    autoSaveInterval = setInterval(autoSaveSession, 10000);
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

        tagFilter.innerHTML = '<option value="">All Tags</option>';
        Array.from(allTags).sort().forEach(tag => {
            const option = document.createElement('option');
            option.value = tag;
            option.textContent = tag;
            tagFilter.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to update history badge:', error);
    }
}

// Filter and sort sessions
function filterAndSortSessions(sessions) {
    const searchTerm = historySearch.value.toLowerCase();
    const selectedTag = tagFilter.value;
    const sortBy = sortFilter.value;

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
        const tableSearch   = historyTableSearch?.value   ?? historySearch.value;
        const tableTagVal   = historyTableTagFilter?.value ?? tagFilter.value;
        const tableSortVal  = historyTableSortFilter?.value ?? sortFilter.value;
        const filtered = filterAndSortSessions(sessions);

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
            disconnect();
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
        updatePSDChart();
        updateSRI();
        renderAnnotations();
        renderTags();

        closeHistory();
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
        const sessionDate = new Date(sessionStartTime);
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
// REPLACE the existing bulkDownloadSessions function:
async function bulkDownloadSessions() {
    const sessions = await loadSessions();
    const filtered = filterAndSortSessions(sessions);
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
    height: 300,
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

const psdLayout = {
    ...ecgLayout,
    margin: { t: 20, r: 20, l: 50, b: 40 },
    xaxis: { ...ecgLayout.xaxis, title: 'Frequency (Hz)', range: [0, 0.4] },
    yaxis: { ...ecgLayout.yaxis, title: 'Normalized Power (%)' }
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

Plotly.newPlot('poincareChart', [{
    x: [], y: [], type: 'scatter', mode: 'markers',
    marker: { color: '#a78bfa', size: 6, opacity: 0.6 },
    hovertemplate: 'RR(n): %{x:.2f}ms<br>RR(n+1): %{y:.2f}ms<extra></extra>'
}], poincareLayout, plotConfig);

Plotly.newPlot('psdChart', [{
    x: [], y: [], type: 'scatter', mode: 'lines',
    line: { color: '#10b981', width: 2.5 },
    fill: 'tozeroy',
    fillcolor: 'rgba(16, 185, 129, 0.2)',
    hovertemplate: 'Frequency: %{x:.2f}Hz<br>Power: %{y:.2f}%<extra></extra>'
}], psdLayout, plotConfig);

Plotly.update('ecgChart', {x: [[]], y: [[]]}, {}, [0]);
Plotly.update('rrChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
Plotly.update('rollingRMSSDChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
Plotly.update('poincareChart', {x: [[]], y: [[]]}, {}, [0]);
Plotly.update('psdChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);

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
}

historyTableClose.addEventListener('click', closeHistoryTable);
historyTableOverlay.addEventListener('click', closeHistoryTable);

// Wire the in-modal bulk download to use its own format select
historyTableBulkDownloadBtn.addEventListener('click', async () => {
    // Temporarily point bulkFormatSelect.value to modal's select, then restore
    const savedFormat = bulkFormatSelect.value;
    bulkFormatSelect.value = historyTableFormatSelect.value;
    const savedBtn = bulkDownloadBtn;
    // Reuse existing bulkDownloadSessions, swapping button reference temporarily
    await bulkDownloadSessions();
    bulkFormatSelect.value = savedFormat;
});

tagInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addTag();
});

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
    Plotly.update('ecgChart', {x: [[]], y: [[]]}, {}, [0]);
    Plotly.update('rrChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
    Plotly.update('rollingRMSSDChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
    Plotly.update('poincareChart', {x: [[]], y: [[]]}, {}, [0]);
    Plotly.update('psdChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);

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
    try {
        // Reset session if data exists
        if (rrIntervals.length > 0) {
            if (!confirm('Starting a new session will clear current data. Continue?')) return;
            await performSessionReset(false); // false = don't prompt again
            sessionTags = [];
        }

        status.textContent = 'Scanning...';
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [HR_SERVICE] }],
            optionalServices: [PMD_SERVICE, BATTERY_SERVICE]
        });

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
        calibrationEndTime = Date.now() + CALIBRATION_DURATION;
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
        }, CALIBRATION_DURATION);

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
function disconnect() {
    if (confirm('Disconnect device? Data will be saved to history.')) {
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

        Plotly.update('ecgChart', {x: [[]], y: [[]]}, {}, [0]);
        Plotly.update('rrChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
        Plotly.update('rollingRMSSDChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);
        Plotly.update('poincareChart', {x: [[]], y: [[]]}, {}, [0]);
        Plotly.update('psdChart', {x: [[]], y: [[]]}, {shapes: [], annotations: []}, [0]);

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
    // Find this section in handleHRData():
    if (rrPresent) {
        let offset = hrFormat === 0 ? 2 : 3;
        while (offset < value.byteLength) {
            const rr = value.getUint16(offset, true) / 1024 * 1000;

            // REPLACE the entire block with:
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
            updateStats();
            if (shouldUpdateChart('rr')) updateRRChart();
            if (shouldUpdateChart('rmssd')) updateRollingRMSSD();
            if (shouldUpdateChart('poincare')) updatePoincareChart();
            if (shouldUpdateChart('psd')) updatePSDChart();
        }
    }
}

// Validate individual RR interval in real-time
function isValidRRInterval(rr, lastRR = null) {
    const minRR = 250;  // 200 BPM max
    const maxRR = 2000; // 30 BPM min
    const maxDiff = 300; // Max change between consecutive RR intervals (ms)

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

    // Component 2: LF/HF Ratio (35% weight)
    // Use cached PSD result if analyzing the same current session data as the chart
    let lfPower, hfPower, lfhfRatio;

    const isCurrentData = !rrData && !timeData; // Using current session data

    if (isCurrentData && lastPSDResult &&
        lastPSDResult.dataLength === rrIntervals.length &&
        lastPSDResult.timestampsLength === timestamps.length &&
        analysisRR.length === rrIntervals.length &&
        analysisTimes.length === timestamps.length) {
        // Perfect match - reuse the PSD calculation from the chart
        lfPower = lastPSDResult.lfPower;
        hfPower = lastPSDResult.hfPower;
        lfhfRatio = lastPSDResult.lfhfRatio;
    } else {
        // Calculate PSD for historical/different data
        const { freq, power } = calculatePSD(analysisRR, analysisTimes);
        lfPower = integrateBandPower(freq, power, 0.04, 0.15);
        hfPower = integrateBandPower(freq, power, 0.15, 0.4);
        lfhfRatio = (hfPower > 0 && isFinite(lfPower) && isFinite(hfPower)) ? (lfPower / hfPower) : 0;
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
    const peakHRLocal = Math.max(...hrValues);
    const avgHR = hrValues.reduce((a, b) => a + b, 0) / hrValues.length;
    const minHR = Math.min(...hrValues);

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

    // Animated pulse effect for excellent scores (only in dark mode)
    if (score >= 75 && !isLight) {
        const pulseOpacity = 0.3 + Math.sin(Date.now() / 500) * 0.2;
        ctx.globalAlpha = pulseOpacity;
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius + lineWidth / 2 + 5, 0, 2 * Math.PI);
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        ctx.stroke();
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
sriInfoClose.addEventListener('touchstart', closeSRIInfo);
sriInfoOverlay.addEventListener('click', closeSRIInfo);
sriInfoOverlay.addEventListener('touchstart', closeSRIInfo);

// Update stats
function updateStats() {
    samplesValue.textContent = rrIntervals.length;

    // Calculate data quality based on raw data vs cleaned data
    if (rawRRIntervals.length > 0) {
        dataQuality = calculateDataQuality(rawRRIntervals.length, rrIntervals.length);
    } else {
        dataQuality = 100; // No raw data yet, assume 100%
    }

    const currentTime = (Date.now() - sessionStartTime) / 1000;
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

    if (dataQualityValue) dataQualityValue.textContent = `${dataQuality}%`;

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

    const windowDuration = 60;
    rollingRMSSD = [];
    rollingRMSSDTimes = [];

    for (let i = 0; i < rrIntervals.length; i++) {
        const currentTime = timestamps[i];

        // Only start calculating after 30 seconds
        if (currentTime < 30) continue;

        const windowStart = currentTime - windowDuration;
        const windowIndices = [];

        for (let j = 0; j <= i; j++) {
            if (timestamps[j] >= windowStart) windowIndices.push(j);
        }

        if (windowIndices.length >= 2) {
            let sumSquaredDiff = 0;
            let count = 0;
            for (let k = 1; k < windowIndices.length; k++) {
                const idx1 = windowIndices[k - 1];
                const idx2 = windowIndices[k];
                const diff = rrIntervals[idx2] - rrIntervals[idx1];
                sumSquaredDiff += diff * diff;
                count++;
            }
            if (count > 0) {
                rollingRMSSD.push(Math.sqrt(sumSquaredDiff / count));
                rollingRMSSDTimes.push(currentTime);
            }
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
function updatePoincareChart() {
    if (rrIntervals.length < 2) return;
    const rrN = rrIntervals.slice(0, -1);
    const rrN1 = rrIntervals.slice(1);
    Plotly.update('poincareChart', { x: [rrN], y: [rrN1] }, {}, [0]);
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

    // Calculate actual duration from timestamps
    const actualDuration = timestamps.length > 0
        ? Math.floor(timestamps[timestamps.length - 1])
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
        header += `# Event Types: ${[...new Set(eventMarkers.map(e => e.type))].join(', ')}\n`;
    }
    header += `#\n`;

    return header;
}

// Generate Professional PDF Report
async function generatePDFReport() {
    if (rrIntervals.length === 0) {
        alert('No data available for report generation');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');

    // Page dimensions
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 20;
    const contentWidth = pageWidth - (2 * margin);
    let yPos = margin;

    // Enhanced minimalist color palette
    const colors = {
        primary: [20, 20, 20],           // Deep black for headers
        secondary: [60, 60, 60],         // Dark gray for body text
        tertiary: [120, 120, 120],       // Medium gray for labels
        light: [180, 180, 180],          // Light gray for dividers
        veryLight: [245, 245, 245],      // Very light gray for backgrounds
        accent: [99, 102, 241],          // Subtle blue accent (array for RGB)
        accentLight: [147, 150, 255]     // Light blue
    };

    // Helper: Add page with footer
    const addPageWithFooter = () => {
        doc.addPage();
        yPos = margin + 10; // Account for header space
        addMinimalHeader();
    };

    // Helper: Check page break
    const checkPageBreak = (heightNeeded) => {
        if (yPos + heightNeeded > pageHeight - margin - 20) {
            addPageWithFooter();
            return true;
        }
        return false;
    };

    // Helper: Add minimal header (for subsequent pages)
    const addMinimalHeader = () => {
        doc.setDrawColor(...colors.light);
        doc.setLineWidth(0.3);
        doc.line(margin, 22, pageWidth - margin, 22);

        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.tertiary);
        doc.text('CARDIAC AUTONOMIC FUNCTION REPORT', margin, 18);

        const sessionDate = new Date(calibrationStartTime || sessionStartTime);
        doc.text(sessionDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }), pageWidth - margin, 18, { align: 'right' });
    };

    // Helper: Add section header with minimal design
    const addSectionHeader = (title) => {
        checkPageBreak(16);

        yPos += 2;
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colors.primary);
        doc.text(title, margin, yPos);

        yPos += 2;
        doc.setDrawColor(...colors.accent);
        doc.setLineWidth(0.8);
        doc.line(margin, yPos, margin + 30, yPos);

        yPos += 8;
    };

    // Helper: Add key-value pair
    const addKeyValue = (key, value, indent = 0) => {
        checkPageBreak(7);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.tertiary);

        const xStart = margin + indent;
        doc.text(key, xStart, yPos);

        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colors.secondary);
        doc.text(value, xStart + 60, yPos);

        yPos += 6;
    };

    // Helper: Add body text
    const addBodyText = (text, indent = 0) => {
        checkPageBreak(6);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.tertiary);
        const lines = doc.splitTextToSize(text, contentWidth - indent);
        lines.forEach(line => {
            doc.text(line, margin + indent, yPos);
            yPos += 5;
        });
    };

    // Calculate all metrics
    const sessionDate = new Date(calibrationStartTime || sessionStartTime);
    const duration = timestamps.length > 0 ? Math.floor(timestamps[timestamps.length - 1]) : 0;
    const dataQuality = calculateDataQuality(rawRRIntervals.length, rrIntervals.length);

    const avgRR = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
    const sdnn = Math.sqrt(rrIntervals.reduce((sum, rr) => sum + Math.pow(rr - avgRR, 2), 0) / rrIntervals.length);

    let rmssd = 0;
    if (rrIntervals.length > 1) {
        let sumSquaredDiff = 0;
        for (let i = 1; i < rrIntervals.length; i++) {
            sumSquaredDiff += Math.pow(rrIntervals[i] - rrIntervals[i - 1], 2);
        }
        rmssd = Math.sqrt(sumSquaredDiff / (rrIntervals.length - 1));
    }

    const pnn50 = rrIntervals.reduce((count, rr, i) => {
        if (i === 0) return count;
        return count + (Math.abs(rr - rrIntervals[i - 1]) > 50 ? 1 : 0);
    }, 0) / (rrIntervals.length - 1) * 100;

    const psdResult = calculatePSD(rrIntervals, timestamps);
    const vlfPower = integrateBandPower(psdResult.freq, psdResult.power, 0.003, 0.04);
    const lfPower = integrateBandPower(psdResult.freq, psdResult.power, 0.04, 0.15);
    const hfPower = integrateBandPower(psdResult.freq, psdResult.power, 0.15, 0.4);
    const totalPower = vlfPower + lfPower + hfPower;
    const lfhfRatio = hfPower > 0 ? lfPower / hfPower : 0;

    const hrValues = rrIntervals.map(rr => 60000 / rr);
    const avgHR = hrValues.reduce((a, b) => a + b, 0) / hrValues.length;
    const minHR = Math.min(...hrValues);
    const maxHR = Math.max(...hrValues);

    const sriResult = calculateSRI();
    const sriStatus = sriResult ? getSRIStatus(sriResult.score) : null;

    // === ENHANCED COVER PAGE ===
    // Subtle gradient background
    doc.setFillColor(...colors.veryLight);
    doc.rect(0, 0, pageWidth, 80, 'F');

    // Main title
    doc.setFontSize(28);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.primary);
    doc.text('CARDIAC AUTONOMIC', pageWidth / 2, 35, { align: 'center' });
    doc.text('FUNCTION REPORT', pageWidth / 2, 48, { align: 'center' });

    // Accent line
    doc.setDrawColor(...colors.accent);
    doc.setLineWidth(1.2);
    doc.line(pageWidth / 2 - 40, 54, pageWidth / 2 + 40, 54);

    // Subtitle
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.secondary);
    doc.text('Heart Rate Variability Analysis', pageWidth / 2, 64, { align: 'center' });

    // Session info box
    yPos = 90;
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...colors.light);
    doc.setLineWidth(0.3);
    doc.rect(margin, yPos, contentWidth, 45, 'FD');

    yPos += 8;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.primary);
    doc.text('SESSION DETAILS', margin + 8, yPos);

    yPos += 8;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.secondary);

    const sessionInfo = [
        ['Date', sessionDate.toLocaleString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })],
        ['Duration', formatDuration(duration)],
        ['Data Points', rrIntervals.length.toLocaleString() + ' intervals'],
        ['Quality', dataQuality + '%']
    ];

    sessionInfo.forEach(([label, value]) => {
        doc.setTextColor(...colors.tertiary);
        doc.text(label + ':', margin + 8, yPos);
        doc.setTextColor(...colors.secondary);
        doc.setFont('helvetica', 'bold');
        doc.text(value, margin + 50, yPos);
        doc.setFont('helvetica', 'normal');
        yPos += 7;
    });

    // Key metrics at a glance
    yPos = 145;
    doc.setFillColor(99, 102, 241);  // Use RGB values directly
    doc.rect(0, yPos, pageWidth, 50, 'F');

    yPos += 12;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('KEY METRICS', pageWidth / 2, yPos, { align: 'center' });

    yPos += 12;
    const keyMetrics = [
        ['SRI', sriResult ? sriResult.score + '/100' : '--'],
        ['RMSSD', rmssd.toFixed(1) + ' ms'],
        ['LF/HF', lfhfRatio.toFixed(2)],
        ['Avg HR', avgHR.toFixed(0) + ' bpm']
    ];

    const metricWidth = contentWidth / keyMetrics.length;
    keyMetrics.forEach(([label, value], idx) => {
        const xPos = margin + (idx * metricWidth) + (metricWidth / 2);

        doc.setFontSize(18);
        doc.setFont('helvetica', 'bold');
        doc.text(value, xPos, yPos, { align: 'center' });

        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.text(label, xPos, yPos + 7, { align: 'center' });
    });

    // Export high-resolution charts with optimized settings for PDF readability
    // Use larger base dimensions but lower scale to get bigger fonts
    const psdChartImg = await Plotly.toImage('psdChart', {
        format: 'png',
        width: 1400,
        height: 550,
        scale: 1.5
    });


    const poincareImg = await Plotly.toImage('poincareChart', {
        format: 'png',
        width: 1400,
        height: 750,
        scale: 1.5
    });

    const rmssdTrendImg = rollingRMSSD.length > 0 ? await Plotly.toImage('rollingRMSSDChart', {
        format: 'png',
        width: 1400,
        height: 550,
        scale: 1.5
    }) : null;

    // Generator info
    yPos = pageHeight - 35;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.tertiary);
    doc.text('Generated by Polar H10 Monitor', pageWidth / 2, yPos, { align: 'center' });
    doc.setFontSize(7);
    doc.text('Developed by Matías Castillo-Aguilar', pageWidth / 2, yPos + 5, { align: 'center' });

    // === PAGE 2: CLINICAL INTERPRETATION ===
    addPageWithFooter();

    // Clinical summary box
    doc.setFillColor(...colors.veryLight);
    doc.setDrawColor(...colors.light);
    doc.setLineWidth(0.3);

    let interpretation = '';
    if (sriResult) {
        if (sriResult.score >= 75) {
            interpretation = 'Excellent autonomic function with strong parasympathetic activity. ';
        } else if (sriResult.score >= 55) {
            interpretation = 'Good cardiovascular adaptation with adequate recovery capacity. ';
        } else if (sriResult.score >= 35) {
            interpretation = 'Moderate stress response detected. Consider recovery interventions. ';
        } else {
            interpretation = 'Significant autonomic imbalance. Prioritize rest and stress management. ';
        }
    }

    if (lfhfRatio > 2.5) {
        interpretation += 'High sympathetic dominance (LF/HF > 2.5) suggests stress or inadequate recovery. ';
    } else if (lfhfRatio < 1) {
        interpretation += 'Parasympathetic dominance indicates good recovery state. ';
    }

    if (rmssd < 20) {
        interpretation += 'Low RMSSD (<20ms) indicates reduced vagal activity.';
    } else if (rmssd > 50) {
        interpretation += 'High RMSSD (>50ms) reflects excellent parasympathetic function.';
    }

    const interpretationLines = doc.splitTextToSize(interpretation, contentWidth - 30);
    const boxHeight = 23 + (interpretationLines.length * 5);

    doc.rect(margin, yPos, contentWidth, boxHeight, 'FD');

    yPos += 10;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.primary);
    doc.text('CLINICAL INTERPRETATION', margin + 4, yPos);

    yPos += 10;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.secondary);

    interpretationLines.forEach(line => {
        doc.text(line, margin + 4, yPos);
        yPos += 5;
    });

    yPos += 12;

    // Time domain metrics
    addSectionHeader('TIME DOMAIN ANALYSIS');
    addBodyText('Reflects overall autonomic nervous system activity and beat-to-beat variability');
    yPos += 2;

    addKeyValue('Mean RR Interval', avgRR.toFixed(1) + ' ms', 4);
    addKeyValue('SDNN (Standard Deviation)', sdnn.toFixed(1) + ' ms', 4);
    addKeyValue('RMSSD (Root Mean Square)', rmssd.toFixed(1) + ' ms', 4);
    addKeyValue('pNN50 (Percentage)', pnn50.toFixed(1) + ' %', 4);

    yPos += 4;

    // Frequency domain metrics
    addSectionHeader('FREQUENCY DOMAIN ANALYSIS');
    addBodyText('Separates sympathetic and parasympathetic nervous system contributions');
    yPos += 2;

    addKeyValue('VLF Power (0.003-0.04 Hz)', vlfPower.toFixed(1) + ' ms² (' + (vlfPower/totalPower*100).toFixed(1) + '%)', 4);
    addKeyValue('LF Power (0.04-0.15 Hz)', lfPower.toFixed(1) + ' ms² (' + (lfPower/totalPower*100).toFixed(1) + '%)', 4);
    addKeyValue('HF Power (0.15-0.4 Hz)', hfPower.toFixed(1) + ' ms² (' + (hfPower/totalPower*100).toFixed(1) + '%)', 4);
    addKeyValue('Total Power', totalPower.toFixed(1) + ' ms²', 4);
    addKeyValue('LF/HF Ratio', lfhfRatio.toFixed(2), 4);

    yPos += 4;

    // Heart rate metrics
    addSectionHeader('HEART RATE METRICS');

    addKeyValue('Average Heart Rate', avgHR.toFixed(1) + ' bpm', 4);
    addKeyValue('Minimum Heart Rate', minHR.toFixed(0) + ' bpm', 4);
    addKeyValue('Maximum Heart Rate', maxHR.toFixed(0) + ' bpm', 4);
    addKeyValue('Heart Rate Range', (maxHR - minHR).toFixed(0) + ' bpm', 4);

    if (peakHR > 0) {
        addKeyValue('Peak HR (Session)', peakHR.toFixed(0) + ' bpm', 4);
        addKeyValue('HR Recovery Rate', ((peakHR - avgHR) / peakHR * 100).toFixed(1) + ' %', 4);
    }

    // === PAGE 3: VISUALIZATIONS (TWO PLOTS) ===
    addPageWithFooter();

    // PSD Chart (top half)
    addSectionHeader('POWER SPECTRAL DENSITY');
    addBodyText('Frequency domain representation showing autonomic nervous system activity distribution');
    yPos += 3;

    const psdHeight = 60;
    doc.addImage(psdChartImg, 'PNG', margin, yPos, contentWidth, psdHeight);
    yPos += psdHeight + 8;

    // Poincaré Plot (bottom half)
    addSectionHeader('POINCARÉ PLOT');
    addBodyText('Geometric visualization of beat-to-beat RR interval variability');
    yPos += 3;

    const poincareSize = 80;
    doc.addImage(poincareImg, 'PNG', margin, yPos, contentWidth, poincareSize);
    yPos += poincareSize + 8;

    // === PAGE 4: TREND ANALYSIS (if available) ===
    if (rmssdTrendImg) {
        checkPageBreak(90);

        // If we're on the same page as Poincaré, add spacing; otherwise start fresh page
        if (yPos < pageHeight - margin - 90) {
            // Can fit on current page
            yPos += 5;
        } else {
            addPageWithFooter();
        }

        addSectionHeader('HRV TREND ANALYSIS');
        addBodyText('Rolling 1-minute RMSSD showing autonomic activity changes throughout the session');
        yPos += 3;

        const trendHeight = 60;
        doc.addImage(rmssdTrendImg, 'PNG', margin, yPos, contentWidth, trendHeight);
        yPos += trendHeight + 8;
    }

    // === REFERENCE RANGES ===
    checkPageBreak(65);
    addSectionHeader('REFERENCE RANGES');

    const refData = [
        ['Metric', 'Excellent', 'Good', 'Fair', 'Poor'],
        ['RMSSD', '>50 ms', '30-50 ms', '20-30 ms', '<20 ms'],
        ['SDNN', '>100 ms', '50-100 ms', '25-50 ms', '<25 ms'],
        ['LF/HF Ratio', '0.5-1.5', '1.5-2.5', '2.5-3.5', '>3.5'],
        ['SRI Score', '75-100', '55-74', '35-54', '0-34']
    ];

    const colWidths = [42, 32, 32, 32, 32];
    const rowHeight = 8;
    let tableY = yPos;

    doc.setFontSize(9);
    refData.forEach((row, i) => {
        let tableX = margin;
        row.forEach((cell, j) => {
            doc.setDrawColor(...colors.light);
            doc.setLineWidth(0.2);

            if (i === 0) {
                doc.setFillColor(...colors.veryLight);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...colors.primary);
            } else {
                doc.setFillColor(255, 255, 255);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(...colors.secondary);
            }

            doc.rect(tableX, tableY, colWidths[j], rowHeight, 'FD');
            doc.text(cell, tableX + 2, tableY + 5.5);
            tableX += colWidths[j];
        });
        tableY += rowHeight;
    });
    yPos = tableY + 10;

    // === CLINICAL CONSIDERATIONS ===
    checkPageBreak(70);
    addSectionHeader('CLINICAL CONSIDERATIONS');

    const notes = [
        'This report provides objective measurements of cardiac autonomic function based on HRV analysis.',
        'Results should be interpreted in appropriate clinical context alongside patient history.',
        'Factors affecting HRV: age, fitness, medications, time of day, hydration, stress, and health conditions.',
        'For clinical decisions and medical interpretation, consult qualified healthcare professionals.',
        'Data quality >95% recommended for reliable clinical interpretation.'
    ];

    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.secondary);

    notes.forEach(note => {
        checkPageBreak(8);
        const lines = doc.splitTextToSize('• ' + note, contentWidth - 6);
        lines.forEach(line => {
            doc.text(line, margin + 3, yPos);
            yPos += 5;
        });
        yPos += 1;
    });

    // === FOOTER ON ALL PAGES ===
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);

        // Footer separator line
        doc.setDrawColor(...colors.light);
        doc.setLineWidth(0.2);
        doc.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15);

        // Footer content
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.tertiary);

        doc.text('Generated: ' + new Date().toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }), margin, pageHeight - 9);

        doc.text('Page ' + i + ' of ' + pageCount, pageWidth - margin, pageHeight - 9, { align: 'right' });

        doc.setTextColor(...colors.light);
        doc.text('Polar H10 Monitor — Research & Educational Use Only', pageWidth / 2, pageHeight - 9, { align: 'center' });
    }

    // === SAVE PDF ===
    const filename = (document.getElementById('filename').value || 'polar-h10-report') +
                    '_' + sessionDate.toISOString().slice(0, 10) + '.pdf';
    doc.save(filename);

    console.log('✅ Enhanced PDF report generated: ' + filename);
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
        await initDB();
        await updateHistoryBadge();
        loadTheme();

        // Show initial placeholders on all charts
        initChartPlaceholders();

        // Initialize SRI gauge
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
    // Rolling RMSSD placeholder
    const rmssdChart = document.getElementById('rollingRMSSDChart');
    if (!rmssdChart.querySelector('.chart-placeholder')) {
        const placeholder = document.createElement('div');
        placeholder.className = 'chart-placeholder';
        placeholder.innerHTML = `
            <div class="chart-placeholder-icon">⏱️</div>
            <div class="chart-placeholder-text">Chart available after 30 seconds</div>
        `;
        rmssdChart.appendChild(placeholder);
        rmssdChart.classList.add('chart-blurred');
    }

    // PSD placeholder
    const psdChart = document.getElementById('psdChart');
    if (!psdChart.querySelector('.chart-placeholder')) {
        const placeholder = document.createElement('div');
        placeholder.className = 'chart-placeholder';
        placeholder.innerHTML = `
            <div class="chart-placeholder-icon">📊</div>
            <div class="chart-placeholder-text">Chart available after 50 RR intervals</div>
        `;
        psdChart.appendChild(placeholder);
        psdChart.classList.add('chart-blurred');
    }
}
