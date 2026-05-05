import SwiftUI
import SwiftData
import Charts

// MARK: – Root
struct TrendsView: View {
    @Query(sort: \HRVSession.createdAt, order: .reverse) private var sessions: [HRVSession]
    @AppStorage("researchMode") private var researchMode = false

    // Async-computed so heavy SD1/SD2 work leaves the main thread
    @State private var sd1sd2Data: [(date: Date, sd1: Double, sd2: Double)] = []

    private var last30: [HRVSession] {
        let cutoff = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
        return sessions.filter { $0.createdAt >= cutoff }.reversed()
    }

    var body: some View {
        NavigationStack {
            Group {
                if sessions.isEmpty {
                    ContentUnavailableView(
                        "No Data Yet",
                        systemImage: "chart.line.uptrend.xyaxis",
                        description: Text("Complete sessions to see trends and insights.")
                    )
                } else {
                    scrollContent
                }
            }
            .navigationTitle("Trends & Insights")
            .navigationBarTitleDisplayMode(.large)
            .task(id: sessions.count) { await computeSD1SD2() }
        }
    }

    private var scrollContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                summaryGrid
                sriTrendCard
                rmssdTrendCard
                if researchMode { sd1sd2TrendCard }
                frequencyCard
                insightsCard
            }
            .padding(.horizontal)
            .padding(.bottom, 32)
        }
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
    }

    // MARK: – Summary grid (2×2)

    private var summaryGrid: some View {
        let l7 = Array(sessions.prefix(7))
        let avgSRI    = average(l7.filter { $0.sriScore > 0 }.map { Double($0.sriScore) })
        let bestSRI   = sessions.map { $0.sriScore }.max() ?? 0
        let avgRMSSD  = average(l7.filter { $0.rmssd > 0 }.map { $0.rmssd })

        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            TrendSummaryCard(label: "7-Day Avg SRI",
                             value: avgSRI > 0 ? String(format: "%.0f", avgSRI) : "--",
                             unit: "/ 100", trend: sriTrend, color: "#6366f1")
            TrendSummaryCard(label: "All-Time Best SRI",
                             value: bestSRI > 0 ? "\(bestSRI)" : "--",
                             unit: "/ 100", trend: nil, color: "#10b981")
            TrendSummaryCard(label: "7-Day Avg RMSSD",
                             value: avgRMSSD > 0 ? String(format: "%.1f", avgRMSSD) : "--",
                             unit: "ms", trend: rmssdTrend, color: "#ec4899")
            TrendSummaryCard(label: "Session Streak",
                             value: "\(streak)",
                             unit: streak == 1 ? "day" : "days", trend: nil, color: "#22d3ee")
        }
    }

    // MARK: – SRI Trend

    private var sriTrendCard: some View {
        let data = last30.filter { $0.sriScore > 0 }
        return TrendChartCard(title: "SRI — 30 Days", icon: "heart.text.square") {
            if data.isEmpty {
                PlaceholderOverlay(icon: "📊", text: "Record sessions to see your SRI trend")
            } else {
                Chart {
                    // Colour zones
                    RectangleMark(yStart: .value("", 75), yEnd: .value("", 100))
                        .foregroundStyle(Color(hex: "#10b981").opacity(0.07))
                    RectangleMark(yStart: .value("", 55), yEnd: .value("", 74))
                        .foregroundStyle(Color(hex: "#22d3ee").opacity(0.06))
                    RectangleMark(yStart: .value("", 35), yEnd: .value("", 54))
                        .foregroundStyle(Color(hex: "#f59e0b").opacity(0.06))

                    // Main line
                    ForEach(data) { s in
                        LineMark(x: .value("Date", s.createdAt), y: .value("SRI", s.sriScore))
                            .foregroundStyle(Color(hex: "#6366f1"))
                            .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                            .interpolationMethod(.catmullRom)
                        PointMark(x: .value("Date", s.createdAt), y: .value("SRI", s.sriScore))
                            .foregroundStyle(sriDotColor(s.sriScore))
                            .symbolSize(28)
                    }
                    // 3-session rolling avg
                    ForEach(rollingAvg(data.map { (date: $0.createdAt, v: Double($0.sriScore)) }),
                            id: \.0) { date, val in
                        LineMark(x: .value("Date", date), y: .value("Avg", val))
                            .foregroundStyle(Color.secondary.opacity(0.45))
                            .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 5]))
                            .interpolationMethod(.catmullRom)
                    }
                }
                .chartYScale(domain: 0...100)
                .chartXAxis { AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                    AxisGridLine(); AxisValueLabel(format: .dateTime.month().day())
                }}
                .chartYAxis { AxisMarks(values: [0, 35, 55, 75, 100]) { _ in
                    AxisGridLine(); AxisValueLabel()
                }}
            }
        }
    }

    // MARK: – RMSSD Trend

    private var rmssdTrendCard: some View {
        let data = last30.filter { $0.rmssd > 0 }
        return TrendChartCard(title: "RMSSD — 30 Days", icon: "waveform.path.ecg") {
            if data.isEmpty {
                PlaceholderOverlay(icon: "📊", text: "Record sessions to see your RMSSD trend")
            } else {
                Chart {
                    ForEach(data) { s in
                        AreaMark(x: .value("Date", s.createdAt), y: .value("RMSSD", s.rmssd))
                            .foregroundStyle(LinearGradient(
                                colors: [Color(hex: "#ec4899").opacity(0.28), .clear],
                                startPoint: .top, endPoint: .bottom))
                            .interpolationMethod(.catmullRom)
                        LineMark(x: .value("Date", s.createdAt), y: .value("RMSSD", s.rmssd))
                            .foregroundStyle(Color(hex: "#ec4899"))
                            .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                            .interpolationMethod(.catmullRom)
                    }
                    RuleMark(y: .value("", 50))
                        .foregroundStyle(Color(hex: "#10b981").opacity(0.55))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                        .annotation(position: .top, alignment: .trailing) {
                            Text("Excellent (50 ms)").font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(Color(hex: "#10b981"))
                        }
                    RuleMark(y: .value("", 20))
                        .foregroundStyle(Color(hex: "#f59e0b").opacity(0.55))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                        .annotation(position: .top, alignment: .trailing) {
                            Text("Fair (20 ms)").font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(Color(hex: "#f59e0b"))
                        }
                }
                .chartXAxis { AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                    AxisGridLine(); AxisValueLabel(format: .dateTime.month().day())
                }}
                .chartYAxisLabel("ms")
            }
        }
    }

    // MARK: – SD1/SD2 Trend (research mode)

    private var sd1sd2TrendCard: some View {
        TrendChartCard(title: "SD1 / SD2 — 30 Days", icon: "chart.dots.scatter") {
            if sd1sd2Data.isEmpty {
                PlaceholderOverlay(icon: "⏳", text: "Computing…")
            } else {
                Chart {
                    ForEach(sd1sd2Data, id: \.date) { pt in
                        LineMark(x: .value("Date", pt.date), y: .value("SD1", pt.sd1))
                            .foregroundStyle(Color(hex: "#ec4899"))
                            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                            .interpolationMethod(.catmullRom)
                        LineMark(x: .value("Date", pt.date), y: .value("SD2", pt.sd2))
                            .foregroundStyle(Color(hex: "#6366f1"))
                            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                            .interpolationMethod(.catmullRom)
                    }
                }
                .chartForegroundStyleScale([
                    "SD1 (short-term vagal)": Color(hex: "#ec4899"),
                    "SD2 (overall autonomic)": Color(hex: "#6366f1")
                ])
                .chartLegend(position: .top, alignment: .leading)
                .chartXAxis { AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                    AxisGridLine(); AxisValueLabel(format: .dateTime.month().day())
                }}
                .chartYAxisLabel("ms")
            }
        }
    }

    // MARK: – Session frequency (14-day bar chart)

    private var frequencyCard: some View {
        TrendChartCard(title: "Session Frequency — 14 Days", icon: "calendar") {
            Chart {
                ForEach(frequencyBins, id: \.0) { date, count in
                    BarMark(x: .value("Day", date, unit: .day),
                            y: .value("Sessions", count))
                        .foregroundStyle(LinearGradient(
                            colors: [Color(hex: "#6366f1"), Color(hex: "#a78bfa")],
                            startPoint: .bottom, endPoint: .top))
                        .cornerRadius(4)
                }
            }
            .chartXAxis { AxisMarks(values: .stride(by: .day, count: 3)) { _ in
                AxisGridLine(); AxisValueLabel(format: .dateTime.month().day())
            }}
            .chartYAxis { AxisMarks(values: .stride(by: 1)) { _ in
                AxisGridLine(); AxisValueLabel()
            }}
        }
    }

    // MARK: – Insights

    private var insightsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Insights", systemImage: "lightbulb.fill")
                .font(.headline.weight(.bold))
            ForEach(insights, id: \.text) { i in
                HStack(alignment: .top, spacing: 10) {
                    Text(i.icon).font(.body)
                    Text(i.text).font(.subheadline).foregroundStyle(i.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 3)
            }
        }
        .padding(16)
        .background(.regularMaterial)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    // MARK: – Computed helpers

    private func average(_ arr: [Double]) -> Double {
        guard !arr.isEmpty else { return 0 }
        return arr.reduce(0, +) / Double(arr.count)
    }

    private var sriTrend: TrendDirection {
        trendFor(recent: Array(sessions.prefix(7)).filter { $0.sriScore > 0 }.map { Double($0.sriScore) },
                 older:  Array(sessions.dropFirst(7).prefix(7)).filter { $0.sriScore > 0 }.map { Double($0.sriScore) },
                 threshold: 3)
    }

    private var rmssdTrend: TrendDirection {
        trendFor(recent: Array(sessions.prefix(7)).filter { $0.rmssd > 0 }.map { $0.rmssd },
                 older:  Array(sessions.dropFirst(7).prefix(7)).filter { $0.rmssd > 0 }.map { $0.rmssd },
                 threshold: 2)
    }

    private func trendFor(recent: [Double], older: [Double], threshold: Double) -> TrendDirection {
        guard !recent.isEmpty, !older.isEmpty else { return .neutral }
        let r = average(recent), o = average(older)
        if r > o + threshold { return .up }
        if r < o - threshold { return .down }
        return .neutral
    }

    private var streak: Int {
        let cal = Calendar.current
        var count = 0
        var day = cal.startOfDay(for: Date())
        for _ in 0..<365 {
            guard sessions.contains(where: { cal.isDate($0.createdAt, inSameDayAs: day) }) else { break }
            count += 1
            day = cal.date(byAdding: .day, value: -1, to: day) ?? day
        }
        return count
    }

    private func rollingAvg(_ pts: [(date: Date, v: Double)]) -> [(Date, Double)] {
        guard pts.count >= 3 else { return [] }
        return pts.enumerated().map { i, pt in
            let window = pts[max(0, i - 2)...i].map { $0.v }
            return (pt.date, average(window))
        }
    }

    private var frequencyBins: [(Date, Int)] {
        let cal = Calendar.current
        let cutoff = cal.date(byAdding: .day, value: -14, to: Date()) ?? Date()
        var counts: [Date: Int] = [:]
        sessions.filter { $0.createdAt >= cutoff }.forEach {
            counts[cal.startOfDay(for: $0.createdAt), default: 0] += 1
        }
        var result: [(Date, Int)] = []
        var d = cal.startOfDay(for: cutoff)
        let today = cal.startOfDay(for: Date())
        while d <= today {
            result.append((d, counts[d] ?? 0))
            d = cal.date(byAdding: .day, value: 1, to: d) ?? d
        }
        return result
    }

    private func sriDotColor(_ s: Int) -> Color {
        switch s {
        case 75...: return Color(hex: "#10b981")
        case 55..<75: return Color(hex: "#22d3ee")
        case 35..<55: return Color(hex: "#f59e0b")
        default: return Color(hex: "#ef4444")
        }
    }

    private var insights: [TrendInsight] {
        var out: [TrendInsight] = []
        switch sriTrend {
        case .up:   out.append(.init(icon: "📈", text: "Your SRI has been improving over the past two weeks — great work.", color: Color(hex: "#10b981")))
        case .down: out.append(.init(icon: "📉", text: "Your SRI is declining recently. Prioritise sleep, hydration, and stress reduction.", color: Color(hex: "#f59e0b")))
        case .neutral: out.append(.init(icon: "➡️", text: "Your SRI is stable. Consistent daily readings build a more reliable baseline.", color: .secondary))
        }
        if streak >= 7 {
            out.append(.init(icon: "🔥", text: "\(streak)-day recording streak. Consistency is the most important factor in HRV monitoring.", color: Color(hex: "#f59e0b")))
        }
        let r7RMSSD = Array(sessions.prefix(7)).filter { $0.rmssd > 0 }.map { $0.rmssd }
        if !r7RMSSD.isEmpty {
            let avg = average(r7RMSSD)
            if avg < 20 {
                out.append(.init(icon: "⚠️", text: "Recent RMSSD is below 20 ms — reduced vagal tone. Ensure adequate recovery before intense training.", color: Color(hex: "#ef4444")))
            } else if avg > 50 {
                out.append(.init(icon: "🌟", text: "RMSSD above 50 ms reflects excellent parasympathetic activity.", color: Color(hex: "#10b981")))
            }
        }
        if sessions.count >= 3 {
            let recentSRI = Array(sessions.prefix(3)).filter { $0.sriScore > 0 }
            if recentSRI.allSatisfy({ $0.sriScore < 35 }) {
                out.append(.init(icon: "🛌", text: "Three consecutive poor SRI readings suggest accumulated fatigue. Consider an active recovery day.", color: Color(hex: "#ef4444")))
            }
        }
        return out
    }

    // MARK: – Background computation

    @MainActor
    private func computeSD1SD2() async {
        let snap = last30.filter { $0.rmssd > 0 }
        sd1sd2Data = snap.map { s in
            (date: s.createdAt,
             sd1: HRVEngine.shared.calculateSD1(s.rrIntervals),
             sd2: HRVEngine.shared.calculateSD2(s.rrIntervals))
        }
    }
}

// MARK: – Supporting types
enum TrendDirection { case up, down, neutral }
struct TrendInsight { let icon: String; let text: String; let color: Color }

struct TrendSummaryCard: View {
    let label: String; let value: String; let unit: String
    let trend: TrendDirection?; let color: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(.system(size: 10, weight: .semibold))
                    .textCase(.uppercase).kerning(0.3).foregroundStyle(.secondary)
                Spacer()
                if let t = trend { trendBadge(t) }
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(Color(hex: color))
                Text(unit).font(.caption.weight(.medium)).foregroundStyle(.tertiary)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.06), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private func trendBadge(_ t: TrendDirection) -> some View {
        let (name, col): (String, Color) = {
            switch t {
            case .up:      return ("arrow.up.right",   Color(hex: "#10b981"))
            case .down:    return ("arrow.down.right", Color(hex: "#ef4444"))
            case .neutral: return ("arrow.right",      .secondary)
            }
        }()
        Image(systemName: name).font(.caption.weight(.bold)).foregroundStyle(col)
    }
}

struct TrendChartCard<Content: View>: View {
    let title: String; let icon: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: icon).font(.system(size: 12, weight: .semibold)).foregroundStyle(.tertiary)
                Text(title).font(.system(size: 13, weight: .semibold)).textCase(.uppercase)
                    .kerning(0.3).foregroundStyle(.secondary)
            }
            content().frame(height: 185)
        }
        .padding(16).background(.regularMaterial)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.primary.opacity(0.05), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .shadow(color: .black.opacity(0.03), radius: 6, x: 0, y: 2)
    }
}
