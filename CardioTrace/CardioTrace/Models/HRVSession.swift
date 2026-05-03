import SwiftData
import Foundation

@Model
final class HRVSession {
    var id: UUID
    var createdAt: Date
    var filename: String
    var duration: Double

    // Large arrays stored as JSON-encoded Data for SwiftData compatibility
    private var _rrIntervals:    Data
    private var _timestamps:     Data
    private var _rawRRIntervals: Data
    private var _rawTimestamps:  Data
    private var _eventMarkers:   Data

    var tags:                [String]
    var avgRR:               Double
    var rmssd:               Double
    var sriScore:            Int
    var peakHR:              Double
    var sriComponentRMSSD:   Double
    var sriComponentLFHF:    Double
    var sriComponentHRRecovery: Double

    // MARK: – Computed accessors
    var rrIntervals: [Double] {
        get { decode(_rrIntervals) ?? [] }
        set { _rrIntervals = encode(newValue) }
    }
    var timestamps: [Double] {
        get { decode(_timestamps) ?? [] }
        set { _timestamps = encode(newValue) }
    }
    var rawRRIntervals: [Double] {
        get { decode(_rawRRIntervals) ?? [] }
        set { _rawRRIntervals = encode(newValue) }
    }
    var rawTimestamps: [Double] {
        get { decode(_rawTimestamps) ?? [] }
        set { _rawTimestamps = encode(newValue) }
    }
    var eventMarkers: [EventMarker] {
        get { decode(_eventMarkers) ?? [] }
        set { _eventMarkers = encode(newValue) }
    }

    var dataQuality: Double {
        let raw = max(rawRRIntervals.count, 1)
        return min(100, (Double(rrIntervals.count) / Double(raw)) * 100)
    }
    var sampleCount: Int { rrIntervals.count }

    init(filename: String = "session") {
        self.id        = UUID()
        self.createdAt = Date()
        self.filename  = filename
        self.duration  = 0
        self._rrIntervals    = Data()
        self._timestamps     = Data()
        self._rawRRIntervals = Data()
        self._rawTimestamps  = Data()
        self._eventMarkers   = Data()
        self.tags             = []
        self.avgRR            = 0
        self.rmssd            = 0
        self.sriScore         = 0
        self.peakHR           = 0
        self.sriComponentRMSSD      = 0
        self.sriComponentLFHF       = 0
        self.sriComponentHRRecovery = 0
    }

    private func encode<T: Encodable>(_ v: T) -> Data {
        (try? JSONEncoder().encode(v)) ?? Data()
    }
    private func decode<T: Decodable>(_ d: Data) -> T? {
        guard !d.isEmpty else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }
}

// MARK: – Supporting types
struct EventMarker: Codable, Identifiable, Hashable {
    var id:         UUID   = UUID()
    var time:       Double
    var type:       String
    var annotation: String

    var label: String { annotation.isEmpty ? type : "\(type): \(annotation)" }
}

struct SRIComponents: Equatable {
    var rmssd:      Double
    var lfhf:       Double
    var hrRecovery: Double
}

struct PSDResult {
    let frequencies: [Double]
    let power:       [Double]   // ms²/Hz
    let lfPower:     Double     // ms²
    let hfPower:     Double
    let vlfPower:    Double
    let lfhfRatio:   Double
    let totalPower:  Double
}

enum HRZone: String, CaseIterable {
    case zone1 = "Zone 1 · Recovery"
    case zone2 = "Zone 2 · Endurance"
    case zone3 = "Zone 3 · Tempo"
    case zone4 = "Zone 4 · Threshold"
    case zone5 = "Zone 5 · Maximum"

    static func forHR(_ hr: Int, age: Int = 30) -> HRZone {
        let pct = Double(hr) / Double(220 - age) * 100
        switch pct {
        case ..<60: return .zone1
        case ..<70: return .zone2
        case ..<80: return .zone3
        case ..<90: return .zone4
        default:    return .zone5
        }
    }

    var colorHex: String {
        switch self {
        case .zone1: return "#6b7280"
        case .zone2: return "#3b82f6"
        case .zone3: return "#10b981"
        case .zone4: return "#f59e0b"
        case .zone5: return "#ef4444"
        }
    }
}
