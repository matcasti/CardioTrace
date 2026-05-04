import ActivityKit
import SwiftUI
import WidgetKit

struct CardioTraceLiveActivityView: View {
    let state: CardioTraceAttributes.ContentState

    private var sriColor: Color {
        switch state.sriScore {
        case 75...: return Color(red: 0.06, green: 0.73, blue: 0.51)
        case 55..<75: return Color(red: 0.13, green: 0.83, blue: 0.93)
        case 35..<55: return Color(red: 0.96, green: 0.62, blue: 0.04)
        default:      return Color(red: 0.94, green: 0.27, blue: 0.27)
        }
    }

    private var elapsed: String {
        let t = Int(state.recordingTime)
        return String(format: "%02d:%02d", t / 60, t % 60)
    }

    var body: some View {
        HStack(spacing: 16) {
            // Heart rate
            VStack(spacing: 2) {
                Image(systemName: "heart.fill")
                    .foregroundStyle(.red)
                    .font(.caption)
                Text("\(state.heartRate)")
                    .font(.system(size: 22, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                Text("BPM")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
            }

            Divider().frame(height: 36).opacity(0.3)

            // RMSSD
            VStack(spacing: 2) {
                Text(state.rmssd > 0 ? String(format: "%.0f", state.rmssd) : "—")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text("RMSSD ms")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }

            Divider().frame(height: 36).opacity(0.3)

            // SRI
            VStack(spacing: 2) {
                Text(state.sriScore > 0 ? "\(state.sriScore)" : "—")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(sriColor)
                Text("SRI · \(state.sriLabel)")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(sriColor.opacity(0.8))
            }

            Spacer()

            // Timer
            VStack(alignment: .trailing, spacing: 2) {
                Image(systemName: "record.circle")
                    .foregroundStyle(.red)
                    .font(.caption2)
                Text(elapsed)
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(red: 0.05, green: 0.07, blue: 0.12))
    }
}

struct CardioTraceActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CardioTraceAttributes.self) { context in
            CardioTraceLiveActivityView(state: context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Image(systemName: "heart.fill").foregroundStyle(.red)
                        Text("\(context.state.heartRate)")
                            .font(.system(size: 28, weight: .black, design: .rounded))
                            .foregroundStyle(.white)
                        Text("BPM")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(context.state.sriScore > 0
                             ? "SRI \(context.state.sriScore)"
                             : "SRI —")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(
                                context.state.sriScore >= 75
                                    ? Color(red: 0.06, green: 0.73, blue: 0.51)
                                    : context.state.sriScore >= 55
                                        ? Color(red: 0.13, green: 0.83, blue: 0.93)
                                        : Color(red: 0.96, green: 0.62, blue: 0.04)
                            )
                        Text(context.state.sriLabel)
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Label(
                            String(format: "RMSSD  %.0f ms", context.state.rmssd),
                            systemImage: "waveform.path.ecg"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        Spacer()
                        let t = Int(context.state.recordingTime)
                        Text(String(format: "⏱ %02d:%02d", t / 60, t % 60))
                            .font(.system(.caption, design: .monospaced, weight: .bold))
                            .foregroundStyle(.red.opacity(0.8))
                    }
                }
            } compactLeading: {
                Image(systemName: "heart.fill")
                    .foregroundStyle(.red)
                    .font(.caption)
            } compactTrailing: {
                Text("\(context.state.heartRate)")
                    .font(.system(size: 14, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                    .monospacedDigit()
            } minimal: {
                Image(systemName: "heart.fill")
                    .foregroundStyle(.red)
            }
        }
    }
}
