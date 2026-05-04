import SwiftUI
import Charts

// MARK: – Chart host
struct ChartsView: View {
    @EnvironmentObject var vm: SessionViewModel

    /// When recording show a 90-second sliding window; otherwise show all.
    private var xDomain: ClosedRange<Double>? {
        guard vm.isConnected, let last = vm.chartTimestamps.last, last > 90 else { return nil }
        return (last - 90)...last
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                ChartCard(title: "ECG Signal", icon: "waveform.path.ecg") {
                    ECGChartView(samples: vm.ecgSamples, times: vm.ecgTimes)
                }
                ChartCard(title: "RR Intervals", icon: "heart.fill") {
                    RRChartView(rr: vm.chartRR,
                                times: vm.chartTimestamps,
                                markers: vm.eventMarkers,
                                xDomain: xDomain)
                }
                ChartCard(title: "Rolling RMSSD (1 min)", icon: "chart.line.uptrend.xyaxis") {
                    if vm.chartRollingRMSSD.isEmpty {
                        PlaceholderOverlay(icon: "⏱️", text: "Available after 30 seconds")
                    } else {
                        RollingRMSSDChart(data: vm.chartRollingRMSSD,
                                          markers: vm.eventMarkers,
                                          xDomain: xDomain)
                    }
                }
                ChartCard(title: "Poincaré Plot", icon: "chart.dots.scatter") {
                    if vm.chartRR.count < 2 {
                        PlaceholderOverlay(icon: "📊", text: "Need more data")
                    } else {
                        PoincareChart(rr: vm.chartRR)
                    }
                }
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
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
    }
}

// MARK: – Card wrapper
struct ChartCard<Content: View>: View {
    let title: String
    let icon:  String
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: icon)
                .font(.subheadline.weight(.bold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
                .padding(.bottom, 2)
            content()
                .frame(height: 160)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.07), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}

// MARK: – ECG
struct ECGChartView: View {
    let samples: [Double]; let times: [Double]
    private var points: [(x: Double, y: Double)] {
        guard !samples.isEmpty else { return [] }
        let minT = times.first ?? 0
        return zip(times, samples).map { ($0.0 - minT, $0.1) }
    }
    var body: some View {
        if points.isEmpty {
            PlaceholderOverlay(icon: "📡", text: "ECG not supported on this device")
        } else {
            Chart {
                ForEach(Array(points.enumerated()), id: \.offset) { _, pt in
                    LineMark(x: .value("s", pt.x), y: .value("µV", pt.y))
                        .foregroundStyle(Color(hex: "#6366f1"))
                        .lineStyle(StrokeStyle(lineWidth: 1.2))
                        .interpolationMethod(.linear)
                }
            }
            .chartXAxis(.hidden).chartYAxis(.hidden)
            .chartBackground { _ in
                Color(hex: "#6366f1").opacity(0.04)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }
}

// MARK: – RR Intervals
struct RRChartView: View {
    let rr: [Double]; let times: [Double]
    let markers: [EventMarker]
    var xDomain: ClosedRange<Double>?

    struct Pt: Identifiable { var id = UUID(); var x, y: Double }
    private var points: [Pt] { zip(times, rr).map { Pt(x: $0.0, y: $0.1) } }

    var body: some View {
        Chart {
            ForEach(points) { pt in
                AreaMark(x: .value("s", pt.x), y: .value("ms", pt.y))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Color(hex: "#ec4899").opacity(0.35), .clear],
                            startPoint: .top, endPoint: .bottom)
                    )
                    .interpolationMethod(.linear)
                LineMark(x: .value("s", pt.x), y: .value("ms", pt.y))
                    .foregroundStyle(Color(hex: "#ec4899"))
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                    .interpolationMethod(.linear)
            }
            ForEach(markers) { m in
                RuleMark(x: .value("Event", m.time))
                    .foregroundStyle(Color(hex: "#22d3ee").opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    .annotation(position: .top, alignment: .leading) {
                        Text(m.type)
                            .font(.system(size: 9, weight: .bold))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Color(hex: "#22d3ee").opacity(0.18))
                            .foregroundStyle(Color(hex: "#22d3ee"))
                            .clipShape(Capsule())
                    }
            }
        }
        .chartXAxisLabel("Time (s)", alignment: .trailing)
        .chartYAxisLabel("ms")
        .chartXAxis { AxisMarks(stroke: StrokeStyle(lineWidth: 0.4)) }
        .chartYAxis { AxisMarks(stroke: StrokeStyle(lineWidth: 0.4)) }
        .if(xDomain != nil) { $0.chartXScale(domain: xDomain!) }
        .animation(.easeInOut(duration: 0.4), value: points.count)
    }
}

// MARK: – Rolling RMSSD
struct RollingRMSSDChart: View {
    let data: [(time: Double, value: Double)]; let markers: [EventMarker]
    var xDomain: ClosedRange<Double>?

    struct Pt: Identifiable { var id = UUID(); var x, y: Double }
    private var points: [Pt] { data.map { Pt(x: $0.time, y: $0.value) } }

    var body: some View {
        Chart {
            ForEach(points) { pt in
                AreaMark(x: .value("s", pt.x), y: .value("RMSSD", pt.y))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Color(hex: "#22d3ee").opacity(0.35), .clear],
                            startPoint: .top, endPoint: .bottom)
                    )
                    .interpolationMethod(.catmullRom)
                LineMark(x: .value("s", pt.x), y: .value("RMSSD", pt.y))
                    .foregroundStyle(Color(hex: "#22d3ee"))
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                    .interpolationMethod(.catmullRom)
            }
            ForEach(markers) { m in
                RuleMark(x: .value("Event", m.time))
                    .foregroundStyle(Color(hex: "#22d3ee").opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
            }
        }
        .chartXAxisLabel("Time (s)", alignment: .trailing)
        .chartYAxisLabel("ms")
        .chartXAxis { AxisMarks(stroke: StrokeStyle(lineWidth: 0.4)) }
        .chartYAxis { AxisMarks(stroke: StrokeStyle(lineWidth: 0.4)) }
        .if(xDomain != nil) { $0.chartXScale(domain: xDomain!) }
        .animation(.easeInOut(duration: 0.6), value: points.count)
    }
}

// MARK: – Poincaré
struct PoincareChart: View {
    let rr: [Double]
    struct Pt: Identifiable { var id = UUID(); var x, y: Double }
    private var points: [Pt] {
        guard rr.count >= 2 else { return [] }
        return (0..<rr.count - 1).map { Pt(x: rr[$0], y: rr[$0 + 1]) }
    }
    var body: some View {
        Chart {
            ForEach(points) { pt in
                PointMark(x: .value("RR(n)", pt.x), y: .value("RR(n+1)", pt.y))
                    .foregroundStyle(
                        LinearGradient(colors: [Color(hex: "#a78bfa"), Color(hex: "#6366f1")],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .symbolSize(18)
            }
        }
        .chartXAxisLabel("RR(n) ms")
        .chartYAxisLabel("RR(n+1) ms")
        .chartXAxis { AxisMarks(stroke: StrokeStyle(lineWidth: 0.4)) }
        .chartYAxis { AxisMarks(stroke: StrokeStyle(lineWidth: 0.4)) }
    }
}

// MARK: – PSD
struct PSDChart: View {
    let result: PSDResult

    private struct BPt: Identifiable { var id = UUID(); var f, p: Double; var band: String }
    private var pts: [BPt] {
        let total = max(result.totalPower, 1)
        return zip(result.frequencies, result.power).map { f, p in
            BPt(f: f, p: (p / total) * 100,
                band: f < 0.04 ? "VLF" : f < 0.15 ? "LF" : "HF")
        }
    }
    private func color(_ b: String) -> Color {
        switch b { case "VLF": return Color(hex: "#9ca3af")
                   case "LF":  return Color(hex: "#6366f1")
                   default:    return Color(hex: "#ec4899") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                bandPill("VLF", result.vlfPower, "#9ca3af")
                bandPill("LF",  result.lfPower,  "#6366f1")
                bandPill("HF",  result.hfPower,  "#ec4899")
                Spacer()
                Text("LF/HF \(String(format: "%.2f", result.lfhfRatio))")
                    .font(.caption.weight(.bold)).foregroundStyle(Color(hex: "#22d3ee"))
            }
            Chart {
                ForEach(pts) { pt in
                    AreaMark(x: .value("Hz", pt.f), y: .value("%", pt.p))
                        .foregroundStyle(color(pt.band).opacity(0.28))
                    LineMark(x: .value("Hz", pt.f), y: .value("%", pt.p))
                        .foregroundStyle(color(pt.band))
                        .lineStyle(StrokeStyle(lineWidth: 1.8))
                }
            }
            .chartXScale(domain: 0...0.4)
            .chartXAxisLabel("Frequency (Hz)", alignment: .trailing)
            .chartYAxisLabel("Power (%)")
            .chartXAxis { AxisMarks(values: [0, 0.04, 0.15, 0.4],
                                    stroke: StrokeStyle(lineWidth: 0.4)) }
            .chartYAxis { AxisMarks(stroke: StrokeStyle(lineWidth: 0.4)) }
        }
    }

    private func bandPill(_ l: String, _ p: Double, _ hex: String) -> some View {
        let pct = result.totalPower > 0 ? p / result.totalPower * 100 : 0
        return HStack(spacing: 4) {
            Circle().fill(Color(hex: hex)).frame(width: 7, height: 7)
            Text("\(l) (\(String(format: "%.0f", pct))%)")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(Color(hex: hex))
        }
    }
}

// MARK: – Placeholder
struct PlaceholderOverlay: View {
    let icon, text: String
    var body: some View {
        VStack(spacing: 8) {
            Text(icon).font(.largeTitle).opacity(0.3)
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: – Conditional modifier helper
extension View {
    @ViewBuilder func `if`<T: View>(_ condition: Bool, transform: (Self) -> T) -> some View {
        if condition { transform(self) } else { self }
    }
}
