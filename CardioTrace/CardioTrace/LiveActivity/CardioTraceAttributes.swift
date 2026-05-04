import ActivityKit
import Foundation

struct CardioTraceAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var heartRate:     Int
        var rmssd:         Double
        var sriScore:      Int
        var recordingTime: Double
        var sriLabel:      String   // "Excellent" / "Good" / "Fair" / "Poor" / "—"
    }
    var sessionName: String
}
