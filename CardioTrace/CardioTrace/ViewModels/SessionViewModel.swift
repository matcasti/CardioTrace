import Foundation
import SwiftData
import Combine
import SwiftUI
import UIKit

@MainActor
final class SessionViewModel: ObservableObject {

    // MARK: – Connection
    @Published var connectionState: ConnectionState = .idle
    @Published var heartRate:       Int             = 0
    @Published var batteryLevel:    Int             = 0
    @Published var signalQuality:   SignalQuality   = .unknown
    @Published var ecgSupported:    Bool            = false
    @Published var showDevicePicker = false
    @Published var discoveredDevices: [DiscoveredDevice] = []

    // MARK: – Session data
    @Published var rrIntervals:    [Double] = []
    @Published var timestamps:     [Double] = []
    @Published var rawRRIntervals: [Double] = []
    @Published var rawTimestamps:  [Double] = []
    @Published var eventMarkers:   [EventMarker] = []
    @Published var sessionTags:    [String]  = []

    // MARK: – ECG (ring buffer, max 5 s at 130 Hz)
    @Published var ecgSamples:     [Double] = []
    @Published var ecgTimes:       [Double] = []

    // MARK: – Computed metrics
    @Published var rmssd:        Double         = 0
    @Published var avgRR:        Double         = 0
    @Published var sriScore:     Int            = 0
    @Published var sriComponents: SRIComponents = .init(rmssd: 0, lfhf: 0, hrRecovery: 0)
    @Published var peakHR:       Double         = 0
    @Published var psdResult:    PSDResult?     = nil
    @Published var rollingRMSSD: [(time: Double, value: Double)] = []
    @Published var dataQuality:  Double         = 100

    // MARK: – Chart display data (decimated, updated every 2 s)
    @Published var chartRR: [Double] = []
    @Published var chartTimestamps: [Double] = []
    @Published var chartRollingRMSSD: [(time: Double, value: Double)] = []

    private var metricsTask:      Task<Void, Never>?          = nil
    private var backgroundTaskID: UIBackgroundTaskIdentifier  = .invalid
    private var isInBackground                                = false

    // MARK: – Session state
    @Published var isCalibrating:      Bool   = false
    @Published var calibrationProgress: Double = 0
    @Published var recordingTime:       Double = 0
    @Published var sessionFilename:     String = ""
    @Published var selectedEventType:   String = "Note"

    var isConnected: Bool { connectionState.isConnected }

    // MARK: – Persistence
    var modelContext: ModelContext?
    private var currentSession: HRVSession?

    // MARK: – Private
    private let bt      = BluetoothManager.shared
    private let engine  = HRVEngine.shared
    private var cancellables = Set<AnyCancellable>()

    private var calibrationStartWall: Date?   // wall-clock when calibration ended
    private var lastValidRR: Double?

    @AppStorage("calibrationDuration") private var calibrationDurationSetting = 8
    private var CALIBRATION_SECS: Double { Double(calibrationDurationSetting) }
    private let ECG_BUFFER       = 650

    private var calibTimer:    Timer?
    private var recTimer:      Timer?
    private var saveTimer:     Timer?
    private var metricsTimer:  Timer?
    private var liveActivityTimer: Timer?

    init() { setupSubscriptions() }

    // MARK: – Subscriptions

    private func setupSubscriptions() {
        bt.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] s in self?.handleStateChange(s) }
            .store(in: &cancellables)

        bt.$heartRate.assign(to: \.heartRate, on: self).store(in: &cancellables)
        bt.$batteryLevel.assign(to: \.batteryLevel, on: self).store(in: &cancellables)
        bt.$signalQuality.assign(to: \.signalQuality, on: self).store(in: &cancellables)
        bt.$ecgSupported.assign(to: \.ecgSupported, on: self).store(in: &cancellables)

        bt.$discoveredDevices
            .receive(on: DispatchQueue.main)
            .assign(to: \.discoveredDevices, on: self)
            .store(in: &cancellables)

        // Removed .receive(on: DispatchQueue.main) — that Combine scheduler
        // requires the RunLoop to be spinning, which doesn't happen reliably
        // when backgrounded. Swift Concurrency Tasks are scheduled by the
        // cooperative thread pool and process even during brief BLE wakeups.
        bt.rrPublisher
            .sink { [weak self] (rr, _) in
                Task { @MainActor [weak self] in self?.handleRR(rr) }
            }
            .store(in: &cancellables)

        NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.persistSession()
            }
        }

        bt.ecgPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] samples in self?.handleECG(samples) }
            .store(in: &cancellables)
    }

    // MARK: – State machine

    private func handleStateChange(_ s: ConnectionState) {
        connectionState = s
        switch s {
        case .connecting:
            resetData()
        case .calibrating:
            startCalibration()
        case .connected:
            break   // calibration timer fires the transition
        case .idle, .failed:
            showDevicePicker = false
            stopAllTimers()
        default:
            break
        }
    }

    private func startCalibration() {
        isCalibrating = true
        calibrationProgress = 0
        calibrationStartWall = nil
        lastValidRR = nil
        var elapsed = 0.0
        calibTimer?.invalidate()
        calibTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                elapsed += 0.1
                self.calibrationProgress = min(1, elapsed / self.CALIBRATION_SECS)
                if elapsed >= self.CALIBRATION_SECS {
                    self.calibTimer?.invalidate()
                    self.calibrationStartWall = Date()
                    self.isCalibrating = false
                    self.connectionState = .connected
                    self.startTimers()
                    self.createNewSession()
                    // Start Live Activity immediately — don't wait for the 10-s save timer
                    NotificationManager.shared.postUpdate(
                        hr: self.heartRate,
                        rmssd: 0,
                        sri: 0,
                        duration: 0
                    )
                }
            }
        }
    }

    private func startTimers() {
        // Recording clock
        recTimer?.invalidate()
        recTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let start = self.calibrationStartWall else { return }
                self.recordingTime = -start.timeIntervalSinceNow
            }
        }
        // Metrics refresh (every 2 s)
        metricsTimer?.invalidate()
        metricsTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshMetrics()
            }
        }
        // Auto-save every 10 s
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.persistSession()
            }
        }

        // Live Activity refresh every 2 s
        liveActivityTimer?.invalidate()
        liveActivityTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.isConnected else { return }
                NotificationManager.shared.postUpdate(
                    hr:       self.heartRate,
                    rmssd:    self.rmssd,
                    sri:      self.sriScore,
                    duration: self.recordingTime
                )
            }
        }
    }

    private func stopAllTimers() {
        NotificationManager.shared.remove()
        [calibTimer, recTimer, metricsTimer, saveTimer, liveActivityTimer].forEach { $0?.invalidate() }
        calibTimer = nil; recTimer = nil; metricsTimer = nil; saveTimer = nil; liveActivityTimer = nil
        metricsTask?.cancel()
        metricsTask = nil
        recordingTime = 0
    }

    // MARK: – Data ingestion

    private func handleRR(_ rr: Double) {
        guard !isCalibrating, calibrationStartWall != nil else { return }
        let t = -calibrationStartWall!.timeIntervalSinceNow

        rawRRIntervals.append(rr)
        rawTimestamps.append(t)

        if engine.isValidRR(rr, previous: lastValidRR) {
            rrIntervals.append(rr)
            timestamps.append(t)
            lastValidRR = rr
            let hr = 60000 / rr
            if hr > peakHR { peakHR = hr }

            // Cheap 1-min stats — fine to compute on every beat
            let now = t
            let rec = zip(rrIntervals, timestamps)
                .filter { $0.1 >= now - 60 }.map { $0.0 }
            if !rec.isEmpty   { avgRR = engine.calculateMeanRR(rec) }
            if rec.count >= 2 { rmssd = engine.calculateRMSSD(rec) }
        }

        dataQuality = rrIntervals.isEmpty ? 100 :
            (Double(rrIntervals.count) / Double(rawRRIntervals.count)) * 100
    }

    private func handleECG(_ samples: [Int32]) {
        guard !isCalibrating, let start = calibrationStartWall else { return }
        // Use session-relative time (matches RR timestamp base) instead of wall clock
        let now = -start.timeIntervalSinceNow

        // Gap detection: if the app was backgrounded and BLE resumed, the previous
        // buffer now has a stale segment. Drop it so the chart never draws a
        // straight line across the gap.
        if let lastT = ecgTimes.last, (now - lastT) > 1.0 {
            ecgSamples.removeAll(keepingCapacity: true)
            ecgTimes.removeAll(keepingCapacity: true)
        }

        for (i, s) in samples.enumerated() {
            ecgSamples.append(Double(s))
            ecgTimes.append(now + Double(i) / 130.0)
        }
        if ecgSamples.count > ECG_BUFFER {
            ecgSamples.removeFirst(ecgSamples.count - ECG_BUFFER)
            ecgTimes.removeFirst(ecgTimes.count - ECG_BUFFER)
        }
    }

    // MARK: – Metrics

    private func refreshMetrics() {
        // Skip expensive spectral computation while backgrounded; raw RR data
        // still accumulates via handleRR during brief BLE wakeups.
        guard !isInBackground, rrIntervals.count >= 2 else { return }

        // Cancel any in-flight computation — prevents the old isRefreshing
        // deadlock where a stuck Task kept the flag true forever.
        metricsTask?.cancel()

        let rrSnap = rrIntervals
        let tsSnap = timestamps

        metricsTask = Task.detached(priority: .utility) { [weak self] in
            guard let self, !Task.isCancelled else { return }
            let psd = await self.engine.calculatePSD(rr: rrSnap, times: tsSnap)
            guard !Task.isCancelled else { return }
            let sri = await self.engine.calculateSRI(rr: rrSnap, times: tsSnap,
                                                     psdResult: psd)
            guard !Task.isCancelled else { return }
            let rolling = await self.engine.rollingRMSSD(rr: rrSnap, times: tsSnap)
            guard !Task.isCancelled else { return }
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.updateChartArrays()          // batch chart update every 2 s
                self.psdResult         = psd
                self.rollingRMSSD      = rolling
                self.chartRollingRMSSD = rolling
                if let s = sri {
                    self.sriScore      = s.score
                    self.sriComponents = s.components
                    if s.peakHR > self.peakHR { self.peakHR = s.peakHR }
                }
            }
        }
    }

    /// Keeps chart arrays ≤ maxPoints so SwiftUI Charts never iterates the full buffer.
    private func updateChartArrays(maxPoints: Int = 350) {
        let count = rrIntervals.count
        guard count > 0 else { return }
        if count <= maxPoints {
            chartRR = rrIntervals
            chartTimestamps = timestamps
            return
        }
        let step = count / maxPoints
        var decimatedRR  = [Double](); decimatedRR.reserveCapacity(maxPoints + 1)
        var decimatedTS  = [Double](); decimatedTS.reserveCapacity(maxPoints + 1)
        var i = 0
        while i < count { decimatedRR.append(rrIntervals[i]); decimatedTS.append(timestamps[i]); i += step }
        // Always keep the last real point so live charts feel current
        if let l = rrIntervals.last, let t = timestamps.last { decimatedRR.append(l); decimatedTS.append(t) }
        chartRR = decimatedRR
        chartTimestamps = decimatedTS
    }

    // MARK: – Public commands

    func connect() {
        resetData()
        bt.startScan()
        showDevicePicker = true
    }

    func selectDevice(_ device: DiscoveredDevice) {
        showDevicePicker = false
        bt.connect(to: device)
    }

    func cancelConnect() {
        showDevicePicker = false
        bt.cancelScan()
    }

    func handleBackground() {
        isInBackground = true
        metricsTask?.cancel()   // don't burn CPU on PSD during brief BLE wakeups

        guard isConnected else { return }

        // Request up to 30 s of extra background time so persistSession()
        // can write to SwiftData before the process is suspended.
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(
            withName: "CardioTrace.BackgroundSave"
        ) { [weak self] in
            // Expiration handler — system is about to suspend; do a final save.
            self?.persistSession()
            guard let self, self.backgroundTaskID != .invalid else { return }
            UIApplication.shared.endBackgroundTask(self.backgroundTaskID)
            self.backgroundTaskID = .invalid
        }

        persistSession()

        // Save is synchronous (SwiftData on main actor), so end immediately.
        if backgroundTaskID != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTaskID)
            backgroundTaskID = .invalid
        }
    }

    func handleForeground() {
        isInBackground = false
        // End any lingering background task (safety net).
        if backgroundTaskID != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTaskID)
            backgroundTaskID = .invalid
        }
    }

    func disconnect() {
        persistSession()
        NotificationManager.shared.remove()   // ends Live Activity before data wipe
        bt.disconnect()
        stopAllTimers()
        resetData()
    }

    func resetSession() {
        resetData()
        if connectionState == .connected { startCalibration() }
    }

    func addEventMarker(annotation: String = "") {
        guard !isCalibrating, let start = calibrationStartWall else { return }
        let t = -start.timeIntervalSinceNow
        eventMarkers.append(EventMarker(time: t, type: selectedEventType, annotation: annotation))
    }

    func addTag(_ tag: String) {
        guard !tag.isEmpty, !sessionTags.contains(tag) else { return }
        sessionTags.append(tag)
    }
    func removeTag(_ tag: String) { sessionTags.removeAll { $0 == tag } }

    // MARK: – Export

    func exportCSV(includeRaw: Bool = false) -> String {
        let rr    = includeRaw ? rawRRIntervals : rrIntervals
        let ts    = includeRaw ? rawTimestamps  : timestamps
        var csv   = generateHeader(includeRaw: includeRaw)
        csv += "Timestamp (s),RR Interval (ms),Event Type,Annotation\n"
        for i in 0..<rr.count {
            let t = ts[i]
            let ev = eventMarkers.first { abs($0.time - t) < 0.5 }
            csv += "\(String(format: "%.3f", t)),\(String(format: "%.3f", rr[i])),\(ev?.type ?? ""),\(ev?.annotation ?? "")\n"
        }
        return csv
    }

    func exportTXT(includeRaw: Bool = false) -> String {
        let rr = includeRaw ? rawRRIntervals : rrIntervals
        return rr.map { String(format: "%.3f", $0) }.joined(separator: "\n")
    }

    private func generateHeader(includeRaw: Bool) -> String {
        var h = "# Polar H10 HRV Data Export\n"
        h += "# Generated: \(ISO8601DateFormatter().string(from: Date()))\n"
        h += "# Session: \(sessionFilename)\n"
        h += "# Tags: \(sessionTags.joined(separator: ", "))\n"
        h += "# Data Type: \(includeRaw ? "Raw" : "Clean")\n"
        h += "# RR Count: \(rrIntervals.count) clean / \(rawRRIntervals.count) raw\n"
        h += "# Duration: \(Int(recordingTime))s\n"
        h += "# Calibration: 8s excluded\n#\n"
        return h
    }

    // MARK: – Persistence

    private func createNewSession() {
        guard let ctx = modelContext else { return }
        let s = HRVSession(filename: sessionFilename.isEmpty ? "session" : sessionFilename)
        ctx.insert(s)
        currentSession = s
        try? ctx.save()
    }

    func persistSession() {
        guard let s = currentSession, let ctx = modelContext else { return }
        s.rrIntervals         = rrIntervals
        s.timestamps          = timestamps
        s.rawRRIntervals      = rawRRIntervals
        s.rawTimestamps       = rawTimestamps
        s.eventMarkers        = eventMarkers
        s.tags                = sessionTags
        s.duration            = recordingTime
        s.avgRR               = avgRR
        s.rmssd               = rmssd
        s.sriScore            = sriScore
        s.peakHR              = peakHR
        s.sriComponentRMSSD       = sriComponents.rmssd
        s.sriComponentLFHF        = sriComponents.lfhf
        s.sriComponentHRRecovery  = sriComponents.hrRecovery
        s.filename = sessionFilename.isEmpty ? s.filename : sessionFilename
        try? ctx.save()

        // Keep the lock-screen notification in sync (fires every 10 s from saveTimer)
        NotificationManager.shared.postUpdate(
            hr:       heartRate,
            rmssd:    rmssd,
            sri:      sriScore,
            duration: recordingTime
        )
    }

    func restoreSession(_ session: HRVSession) {
        if isConnected { disconnect() }
        rrIntervals    = session.rrIntervals
        timestamps     = session.timestamps
        rawRRIntervals = session.rawRRIntervals
        rawTimestamps  = session.rawTimestamps
        eventMarkers   = session.eventMarkers
        sessionTags    = session.tags
        sessionFilename = session.filename
        recordingTime  = session.duration
        avgRR          = session.avgRR
        rmssd          = session.rmssd
        sriScore       = session.sriScore
        peakHR         = session.peakHR
        sriComponents  = SRIComponents(
            rmssd:      session.sriComponentRMSSD,
            lfhf:       session.sriComponentLFHF,
            hrRecovery: session.sriComponentHRRecovery
        )
        rollingRMSSD = engine.rollingRMSSD(rr: rrIntervals, times: timestamps)
        updateChartArrays()
        chartRollingRMSSD = rollingRMSSD
        dataQuality = session.dataQuality
        currentSession = session

        Task.detached(priority: .utility) { [weak self] in
            guard let self = self else { return }
            let psd = await self.engine.calculatePSD(rr: self.rrIntervals, times: self.timestamps)
            await MainActor.run { self.psdResult = psd }
        }
    }

    // MARK: – Helpers

    private func resetData() {
        rrIntervals = []; timestamps = []
        rawRRIntervals = []; rawTimestamps = []
        eventMarkers = []; sessionTags = []
        ecgSamples = []; ecgTimes = []
        rollingRMSSD = []
        rmssd = 0; avgRR = 0; sriScore = 0
        sriComponents = .init(rmssd: 0, lfhf: 0, hrRecovery: 0)
        peakHR = 0; psdResult = nil
        lastValidRR = nil; calibrationStartWall = nil
        dataQuality = 100; recordingTime = 0
        currentSession = nil
        chartRR = []; chartTimestamps = []; chartRollingRMSSD = []
        metricsTask?.cancel()
        metricsTask = nil
    }

    @AppStorage("userAge") private var userAge = 30
    var hrZone: HRZone { HRZone.forHR(heartRate, age: userAge) }
}
