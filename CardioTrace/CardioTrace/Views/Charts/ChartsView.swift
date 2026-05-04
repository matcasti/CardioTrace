import SwiftUI
import Charts

// MARK: – Chart host – scrollable collection of all HRV charts
struct ChartsView: View {
    @EnvironmentObject var vm: SessionViewModel
    @State private var selectedChart = 0

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                // ECG
                ChartCard(title: "ECG Signal", icon: "waveform.path.ecg") {
                    ECGChartView(samples: vm.ecgSamples, times: vm.ecgTimes)
                }

                // RR Intervals
                ChartCard(title: "RR Intervals", icon: "heart.fill") {
                    RRChartView(rr: vm.rrIntervals, times: vm.timestamps,
                                markers: vm.eventMarkers)
                }

                // Rolling RMSSD
                ChartCard(title: "Rolling RMSSD (1 min)", icon: "chart.line.uptrend.xyaxis") {
                    if vm.rollingRMSSD.isEmpty {
                        PlaceholderOverlay(icon: "⏱️", text: "Available after 30 seconds")
                    } else {
                        RollingRMSSDChart(data: vm.rollingRMSSD, markers: vm.eventMarkers)
                    }
                }

                // Poincaré
                ChartCard(title: "Poincaré Plot", icon: "chart.dots.scatter") {
                    if vm.rrIntervals.count < 2 {
                        PlaceholderOverlay(icon: "📊", text: "Need more data")
                    } else {
                        PoincareChart(rr: vm.rrIntervals)
                    }
                }

                // PSD
                ChartCard(title: "Power Spectral Density", icon: "waveform") {
                    if let psd = vm.psdResult {
                        PSDChart(result: psd)
                    } else {
                        PlaceholderOverlay(icon: "📊", text: "Available after 50 RR intervals")
                    }
                }
            }
            .padding()
        }
        .background(Color(.systemBackground))
    }
}

// MARK: – Card wrapper
struct ChartCard<Content: View>: View {
    let title:   String
    let icon:    String
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: icon)
                .font(.headline.weight(.bold))
                .foregroundStyle(.primary)

            content()
                .frame(height: 200)
        }
        .padding()
        .background(.ultraThinMaterial)
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}

// MARK: – ECG
struct ECGChartView: View {
    let samples: [Double]
    let times:   [Double]

    private var points: [(x: Double, y: Double)] {
        guard !samples.isEmpty else { return [] }
        let minT = times.first ?? 0
        return zip(times, samples).map { (x: $0.0 - minT, y: $0.1) }
    }

    var body: some View {
        if points.isEmpty {
            PlaceholderOverlay(icon: "📡",
                               text: "ECG not available — device may not support streaming")
        } else {
            Chart {
                ForEach(Array(points.enumerated()), id: \.offset) { (_, pt) in
                    LineMark(
                        x: .value("Time", pt.x),
                        y: .value("µV",   pt.y)
                    )
                    .foregroundStyle(Color(hex: "#6366f1"))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .interpolationMethod(.linear)   // preserves QRS spike shape
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
        }
    }
}

// MARK: – RR Intervals
struct RRChartView: View {
    let rr:      [Double]
    let times:   [Double]
    let markers: [EventMarker]

    struct Point: Identifiable {
        var id = UUID(); var x, y: Double
    }

    private var points: [Point] {
        zip(times, rr).map { Point(x: $0.0, y: $0.1) }
    }

    var body: some View {
        Chart {
            ForEach(points) { pt in
                LineMark(x: .value("s", pt.x), y: .value("ms", pt.y))
                    .foregroundStyle(Color(hex: "#ec4899"))
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .interpolationMethod(.cardinal)
            }
            ForEach(markers) { m in
                RuleMark(x: .value("Event", m.time))
                    .foregroundStyle(Color(hex: "#22d3ee").opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: [4, 4]))
                    .annotation(position: .top) {
                        Text(m.type)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 4)
                            .background(Color(hex: "#22d3ee").opacity(0.15))
                            .clipShape(Capsule())
                    }
            }
        }
        .chartXAxisLabel("Time (s)")
        .chartYAxisLabel("ms")
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
        .chartYAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
    }
}

// MARK: – Rolling RMSSD
struct RollingRMSSDChart: View {
    let data:    [(time: Double, value: Double)]
    let markers: [EventMarker]

    struct Point: Identifiable { var id = UUID(); var x, y: Double }
    private var points: [Point] { data.map { Point(x: $0.time, y: $0.value) } }

    var body: some View {
        Chart {
            ForEach(points) { pt in
                AreaMark(x: .value("s", pt.x), y: .value("RMSSD", pt.y))
                    .foregroundStyle(
                        LinearGradient(colors: [Color(hex: "#22d3ee").opacity(0.3), .clear],
                                       startPoint: .top, endPoint: .bottom)
                    )
                    .interpolationMethod(.cardinal)
                LineMark(x: .value("s", pt.x), y: .value("RMSSD", pt.y))
                    .foregroundStyle(Color(hex: "#22d3ee"))
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .interpolationMethod(.cardinal)
            }
            ForEach(markers) { m in
                RuleMark(x: .value("Event", m.time))
                    .foregroundStyle(Color(hex: "#22d3ee").opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
            }
        }
        .chartXAxisLabel("Time (s)")
        .chartYAxisLabel("ms")
    }
}

// MARK: – Poincaré
struct PoincareChart: View {
    let rr: [Double]

    struct Point: Identifiable { var id = UUID(); var x, y: Double }
    private var points: [Point] {
        guard rr.count >= 2 else { return [] }
        return (0..<rr.count-1).map { Point(x: rr[$0], y: rr[$0+1]) }
    }

    var body: some View {
        Chart {
            ForEach(points) { pt in
                PointMark(x: .value("RR(n)", pt.x), y: .value("RR(n+1)", pt.y))
                    .foregroundStyle(Color(hex: "#a78bfa").opacity(0.6))
                    .symbolSize(30)
            }
        }
        .chartXAxisLabel("RR(n) ms")
        .chartYAxisLabel("RR(n+1) ms")
    }
}

// MARK: – PSD
struct PSDChart: View {
    let result: PSDResult

    private struct BandPoint: Identifiable {
        var id = UUID(); var freq: Double; var power: Double; var band: String
    }

    private var normalised: [BandPoint] {
        let total = max(result.totalPower, 1)
        return zip(result.frequencies, result.power).map { (f, p) in
            let band: String
            switch f {
            case 0.003..<0.04:  band = "VLF"
            case 0.04..<0.15:   band = "LF"
            default:            band = "HF"
            }
            return BandPoint(freq: f, power: (p / total) * 100, band: band)
        }
    }

    private func bandColor(_ band: String) -> Color {
        switch band {
        case "VLF": return Color(hex: "#9ca3af")
        case "LF":  return Color(hex: "#6366f1")
        default:    return Color(hex: "#ec4899")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Band legend
            HStack(spacing: 16) {
                bandInfo("VLF", power: result.vlfPower, total: result.totalPower, color: "#9ca3af")
                bandInfo("LF",  power: result.lfPower,  total: result.totalPower, color: "#6366f1")
                bandInfo("HF",  power: result.hfPower,  total: result.totalPower, color: "#ec4899")
                Spacer()
                Text("LF/HF \(String(format: "%.2f", result.lfhfRatio))")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color(hex: "#22d3ee"))
            }
            .font(.caption)

            Chart {
                ForEach(normalised) { pt in
                    AreaMark(x: .value("Hz", pt.freq), y: .value("%", pt.power))
                        .foregroundStyle(bandColor(pt.band).opacity(0.3))
                    LineMark(x: .value("Hz", pt.freq), y: .value("%", pt.power))
                        .foregroundStyle(bandColor(pt.band))
                        .lineStyle(StrokeStyle(lineWidth: 2))
                }
            }
            .chartXScale(domain: 0...0.4)
            .chartXAxisLabel("Frequency (Hz)")
            .chartYAxisLabel("Power (%)")
        }
    }

    private func bandInfo(_ label: String, power: Double, total: Double, color: String) -> some View {
        let pct = total > 0 ? (power / total * 100) : 0
        return HStack(spacing: 4) {
            Circle().fill(Color(hex: color)).frame(width: 8, height: 8)
            Text("\(label) (\(String(format: "%.0f", pct))%)")
                .foregroundStyle(Color(hex: color))
                .fontWeight(.semibold)
        }
    }
}

// MARK: – Placeholder
struct PlaceholderOverlay: View {
    let icon: String
    let text: String
    var body: some View {
        VStack(spacing: 8) {
            Text(icon).font(.largeTitle).opacity(0.3)
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
