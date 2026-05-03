import Foundation
import SwiftData
import Combine
import SwiftUI

@MainActor
final class SessionViewModel: ObservableObject {

    // MARK: – Connection
    @Published var connectionState: ConnectionState = .idle
    @Published var heartRate:       Int             = 0
    @Published var batteryLevel:    Int             = 0
    @Published var signalQuality:   SignalQuality   = .unknown
    @Published var ecgSupported:    Bool            = false

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

    private let CALIBRATION_SECS = 8.0
    private let ECG_BUFFER       = 650

    private var calibTimer:  Timer?
    private var recTimer:    Timer?
    private var saveTimer:   Timer?
    private var metricsTimer: Timer?

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

        bt.rrPublisher
            .sink { [weak self] (rr, _) in self?.handleRR(rr) }
            .store(in: &cancellables)

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
            guard let self = self else { return }
            elapsed += 0.1
            self.calibrationProgress = min(1, elapsed / self.CALIBRATION_SECS)
            if elapsed >= self.CALIBRATION_SECS {
                self.calibTimer?.invalidate()
                self.calibrationStartWall = Date()
                self.isCalibrating = false
                self.connectionState = .connected
                self.startTimers()
                self.createNewSession()
            }
        }
    }

    private func startTimers() {
        // Recording clock
        recTimer?.invalidate()
        recTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, let start = self.calibrationStartWall else { return }
            self.recordingTime = -start.timeIntervalSinceNow
        }
        // Metrics refresh (every 2 s)
        metricsTimer?.invalidate()
        metricsTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshMetrics()
        }
        // Auto-save every 10 s
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.persistSession()
        }
    }

    private func stopAllTimers() {
        [calibTimer, recTimer, metricsTimer, saveTimer].forEach { $0?.invalidate() }
        calibTimer = nil; recTimer = nil; metricsTimer = nil; saveTimer = nil
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
        }

        dataQuality = rrIntervals.isEmpty ? 100 :
            (Double(rrIntervals.count) / Double(rawRRIntervals.count)) * 100
    }

    private func handleECG(_ samples: [Int32]) {
        guard !isCalibrating else { return }
        let now = Date().timeIntervalSince1970
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
        guard rrIntervals.count >= 2 else { return }

        let now   = timestamps.last ?? 0
        let pairs = zip(rrIntervals, timestamps).filter { $0.1 >= now - 60 }
        let rec   = pairs.map { $0.0 }

        if !rec.isEmpty { avgRR = engine.calculateMeanRR(rec) }
        if rec.count >= 2 { rmssd = engine.calculateRMSSD(rec) }

        rollingRMSSD = engine.rollingRMSSD(rr: rrIntervals, times: timestamps)

        let rrSnap = rrIntervals
        let tsSnap = timestamps
        Task.detached(priority: .utility) { [weak self] in
            guard let self = self else { return }
            let psd = self.engine.calculatePSD(rr: rrSnap, times: tsSnap)
            let sri = self.engine.calculateSRI(rr: rrSnap, times: tsSnap, psdResult: psd)
            await MainActor.run {
                self.psdResult = psd
                if let s = sri {
                    self.sriScore      = s.score
                    self.sriComponents = s.components
                    if s.peakHR > self.peakHR { self.peakHR = s.peakHR }
                }
            }
        }
    }

    // MARK: – Public commands

    func connect() {
        resetData()
        bt.startScan()
    }

    func disconnect() {
        persistSession()
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
        dataQuality = session.dataQuality
        currentSession = session

        Task.detached(priority: .utility) { [weak self] in
            guard let self = self else { return }
            let psd = self.engine.calculatePSD(rr: self.rrIntervals, times: self.timestamps)
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
    }

    var hrZone: HRZone { HRZone.forHR(heartRate) }
}
