//
//  ReportGenerator.swift
//  CardioTrace
//

import SwiftUI
import UIKit

// ─────────────────────────────────────────────────────────────────────────────
// MARK: - Public API
// ─────────────────────────────────────────────────────────────────────────────

@MainActor
enum ReportGenerator {

    static func generate(session: HRVSession) async -> URL? {
        let engine  = HRVEngine.shared
        let rr      = session.rrIntervals
        let ts      = session.timestamps
        let psd     = engine.calculatePSD(rr: rr, times: ts)
        let rolling = engine.rollingRMSSD(rr: rr, times: ts)

        let data = ReportData(
            filename:      session.filename,
            createdAt:     session.createdAt,
            duration:      session.duration,
            rrIntervals:   rr,
            timestamps:    ts,
            eventMarkers:  session.eventMarkers,
            tags:          session.tags,
            dataQuality:   session.dataQuality,
            rawCount:      session.rawRRIntervals.count,
            psd:           psd,
            sriScore:      session.sriScore,
            sriComponents: SRIComponents(
                rmssd:      session.sriComponentRMSSD,
                lfhf:       session.sriComponentLFHF,
                hrRecovery: session.sriComponentHRRecovery
            ),
            peakHR:        session.peakHR,
            rollingRMSSD:  rolling,
            meanRR:        engine.calculateMeanRR(rr),
            sdnn:          engine.calculateSDNN(rr),
            rmssdFull:     engine.calculateRMSSD(rr),
            pnn50:         engine.calculatePNN50(rr)
        )
        return renderPDF(data)
    }

    static func generate(vm: SessionViewModel) async -> URL? {
        let engine = HRVEngine.shared
        let rr     = vm.rrIntervals
        let ts     = vm.timestamps

        let data = ReportData(
            filename:      vm.sessionFilename.isEmpty ? "session" : vm.sessionFilename,
            createdAt:     Date(),
            duration:      vm.recordingTime,
            rrIntervals:   rr,
            timestamps:    ts,
            eventMarkers:  vm.eventMarkers,
            tags:          vm.sessionTags,
            dataQuality:   vm.dataQuality,
            rawCount:      vm.rawRRIntervals.count,
            psd:           vm.psdResult,
            sriScore:      vm.sriScore,
            sriComponents: vm.sriComponents,
            peakHR:        vm.peakHR,
            rollingRMSSD:  vm.rollingRMSSD,
            meanRR:        engine.calculateMeanRR(rr),
            sdnn:          engine.calculateSDNN(rr),
            rmssdFull:     engine.calculateRMSSD(rr),
            pnn50:         engine.calculatePNN50(rr)
        )
        return renderPDF(data)
    }

    // MARK: – Private

    private static func renderPDF(_ data: ReportData) -> URL? {
        let charts = ChartImages(
            rr: data.rrIntervals.count >= 2 ? snapshot(
                RRChartView(rr: data.rrIntervals,
                            times: data.timestamps,
                            markers: data.eventMarkers),
                CGSize(width: 515, height: 160)) : nil,

            poincare: data.rrIntervals.count >= 2 ? snapshot(
                PoincareChart(rr: data.rrIntervals),
                CGSize(width: 260, height: 260)) : nil,

            psd: data.psd.map {
                snapshot(PSDChart(result: $0), CGSize(width: 515, height: 160))
            },

            rmssd: data.rollingRMSSD.isEmpty ? nil : snapshot(
                RollingRMSSDChart(data: data.rollingRMSSD,
                                  markers: data.eventMarkers),
                CGSize(width: 515, height: 140))
        )
        return PDFBuilder(data: data, charts: charts).build()
    }

    private static func snapshot<V: View>(_ view: V, _ size: CGSize) -> UIImage {
        let r = ImageRenderer(
            content: view
                .frame(width: size.width, height: size.height)
                .background(Color(.systemBackground))
        )
        r.scale = 2
        return r.uiImage ?? UIImage()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MARK: - Data containers
// ─────────────────────────────────────────────────────────────────────────────

struct ReportData {
    let filename:      String
    let createdAt:     Date
    let duration:      Double
    let rrIntervals:   [Double]
    let timestamps:    [Double]
    let eventMarkers:  [EventMarker]
    let tags:          [String]
    let dataQuality:   Double
    let rawCount:      Int
    let psd:           PSDResult?
    let sriScore:      Int
    let sriComponents: SRIComponents
    let peakHR:        Double
    let rollingRMSSD:  [(time: Double, value: Double)]
    let meanRR:        Double
    let sdnn:          Double
    let rmssdFull:     Double
    let pnn50:         Double

    var avgHR: Double { meanRR > 0 ? 60_000 / meanRR : 0 }
    var minHR: Double { rrIntervals.map { 60_000 / $0 }.min() ?? 0 }
    var maxHR: Double { rrIntervals.map { 60_000 / $0 }.max() ?? 0 }
}

struct ChartImages {
    let rr:       UIImage?
    let poincare: UIImage?
    let psd:      UIImage?
    let rmssd:    UIImage?
}

// ─────────────────────────────────────────────────────────────────────────────
// MARK: - PDF Builder — complete redesign
// ─────────────────────────────────────────────────────────────────────────────

private final class PDFBuilder {

    let data:   ReportData
    let charts: ChartImages

    // A4
    let page   = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)
    let margin: CGFloat = 40
    var cw:     CGFloat { page.width - margin * 2 }

    // ── Design tokens ────────────────────────────────────────────────────────
    // Neutrals
    let ink       = UIColor(white: 0.08, alpha: 1)         // headlines
    let body      = UIColor(white: 0.25, alpha: 1)         // body text
    let subtle    = UIColor(white: 0.50, alpha: 1)         // labels / captions
    let hairline  = UIColor(white: 0.82, alpha: 1)         // dividers
    let surface   = UIColor(white: 0.97, alpha: 1)         // card fills
    let white     = UIColor.white

    // Brand
    let brand     = UIColor(red: 0.388, green: 0.400, blue: 0.945, alpha: 1)  // indigo
    let brandDark = UIColor(red: 0.278, green: 0.290, blue: 0.835, alpha: 1)

    // Status
    let green     = UIColor(red: 0.063, green: 0.725, blue: 0.506, alpha: 1)
    let cyan      = UIColor(red: 0.133, green: 0.827, blue: 0.933, alpha: 1)
    let amber     = UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1)
    let red       = UIColor(red: 0.937, green: 0.267, blue: 0.267, alpha: 1)

    init(data: ReportData, charts: ChartImages) {
        self.data   = data
        self.charts = charts
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Entry point
    // ─────────────────────────────────────────────────────────────────────────

    func build() -> URL? {
        let renderer = UIGraphicsPDFRenderer(bounds: page)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(sanitize(data.filename) + "_report.pdf")
        do {
            try renderer.writePDF(to: url) { ctx in
                ctx.beginPage(); drawCoverPage()
                ctx.beginPage(); drawMetricsPage()
                ctx.beginPage(); drawChartsPage()
                ctx.beginPage(); drawReferencePage()
            }
            return url
        } catch {
            return nil
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 1: Cover
    // ─────────────────────────────────────────────────────────────────────────

    private func drawCoverPage() {
        // ── Hero band (full-bleed dark header) ───────────────────────────────
        let heroH: CGFloat = 148
        fillRect(CGRect(x: 0, y: 0, width: page.width, height: heroH), color: ink)

        // Subtle brand accent stripe at very top
        fillRect(CGRect(x: 0, y: 0, width: page.width, height: 4), color: brand)

        // App name
        text("CardioTrace",
             x: margin, y: 22, width: cw,
             font: .systemFont(ofSize: 26, weight: .black),
             color: white, align: .left)

        // Subtitle
        text("Cardiac Autonomic Function Report",
             x: margin, y: 54, width: cw,
             font: .systemFont(ofSize: 11, weight: .medium),
             color: white.withAlphaComponent(0.55), align: .left)

        // Thin separator inside hero
        hline(y: 80, color: white.withAlphaComponent(0.12))

        // Session date & name row
        let dateStr = data.createdAt.formatted(date: .long, time: .shortened)
        text(dateStr,
             x: margin, y: 92, width: cw,
             font: .systemFont(ofSize: 10, weight: .semibold),
             color: white.withAlphaComponent(0.75), align: .left)
        text(data.filename,
             x: margin, y: 92, width: cw,
             font: .systemFont(ofSize: 10, weight: .bold),
             color: brand.withAlphaComponent(0.9), align: .right)

        // Duration / samples / quality row
        let meta = "\(formatDuration(data.duration))  ·  \(data.rrIntervals.count) intervals  ·  \(String(format: "%.1f", data.dataQuality))% quality"
        text(meta,
             x: margin, y: 112, width: cw,
             font: .systemFont(ofSize: 9),
             color: white.withAlphaComponent(0.45), align: .left)

        // ── Key-metric pills row ──────────────────────────────────────────────
        let pillY: CGFloat = heroH + 20
        let pillData: [(String, String, UIColor)] = [
            ("SRI Score",  data.sriScore > 0 ? "\(data.sriScore)" : "—",         sriColor(data.sriScore)),
            ("RMSSD",      data.rmssdFull > 0 ? fmt("%.1f ms", data.rmssdFull) : "—", rmssdColor(data.rmssdFull)),
            ("LF/HF",      data.psd != nil ? fmt("%.2f", data.psd!.lfhfRatio) : "—", lfhfColor(data.psd?.lfhfRatio ?? 0)),
            ("Avg HR",     data.avgHR > 0 ? fmt("%.0f bpm", data.avgHR) : "—",   body),
        ]
        drawMetricPillRow(pillData, y: pillY)

        // ── Interpretation card ───────────────────────────────────────────────
        let interpY: CGFloat = pillY + 82
        drawInterpretationCard(y: interpY)

        // ── Two-column info block ─────────────────────────────────────────────
        let infoY: CGFloat = interpY + textHeight(buildInterpretation(),
                                                  font: .systemFont(ofSize: 10),
                                                  width: cw - 32) + 66
        drawTwoColInfo(y: infoY)

        // ── SRI gauge (right column, below pills) ─────────────────────────────
        drawSRIBreakdownCard(y: infoY + 120)

        // Footer
        drawFooter(page: 1, total: 4)
    }

    // ── Metric pill row ───────────────────────────────────────────────────────
    private func drawMetricPillRow(_ items: [(String, String, UIColor)], y: CGFloat) {
        let gap:   CGFloat = 10
        let w      = (cw - gap * CGFloat(items.count - 1)) / CGFloat(items.count)

        for (i, (label, value, color)) in items.enumerated() {
            let x = margin + CGFloat(i) * (w + gap)
            // Card background
            roundRect(CGRect(x: x, y: y, width: w, height: 66),
                      radius: 10, fill: surface, stroke: hairline)
            // Colour accent left bar
            fillRect(CGRect(x: x, y: y, width: 3, height: 66),
                     color: color, cornerRadius: 10)
            // Value
            text(value, x: x + 12, y: y + 11, width: w - 20,
                 font: .systemFont(ofSize: 20, weight: .black),
                 color: color, align: .left)
            // Label
            text(label.uppercased(), x: x + 12, y: y + 44, width: w - 20,
                 font: .systemFont(ofSize: 8, weight: .semibold),
                 color: subtle, align: .left)
        }
    }

    // ── Interpretation card ───────────────────────────────────────────────────
    private func drawInterpretationCard(y: CGFloat) {
        let interp = buildInterpretation()
        let innerW = cw - 32
        let textH  = textHeight(interp, font: .systemFont(ofSize: 10), width: innerW)
        let cardH  = textH + 44

        roundRect(CGRect(x: margin, y: y, width: cw, height: cardH),
                  radius: 10, fill: surface, stroke: hairline)

        // Label pill at top-left inside card
        let labelW: CGFloat = 130
        roundRect(CGRect(x: margin + 14, y: y + 12, width: labelW, height: 18),
                  radius: 4, fill: brand.withAlphaComponent(0.12))
        text("CLINICAL INTERPRETATION",
             x: margin + 14, y: y + 14, width: labelW,
             font: .systemFont(ofSize: 7, weight: .bold),
             color: brand, align: .center)

        text(interp,
             x: margin + 16, y: y + 36, width: innerW,
             font: .systemFont(ofSize: 10),
             color: body, align: .left)
    }

    // ── Two-column info block ─────────────────────────────────────────────────
    private func drawTwoColInfo(y: CGFloat) {
        let colW   = (cw - 12) / 2
        let leftX  = margin
        let rightX = margin + colW + 12

        // Left column header
        sectionLabel("SESSION DETAILS", x: leftX, y: y)
        let leftRows: [(String, String)] = [
            ("Date",     data.createdAt.formatted(date: .abbreviated, time: .shortened)),
            ("Duration", formatDuration(data.duration)),
            ("Samples",  "\(data.rrIntervals.count) clean / \(data.rawCount) raw"),
            ("Quality",  fmt("%.1f%%", data.dataQuality)),
        ]
        var ly = y + 18
        for (k, v) in leftRows {
            ly = inlineKV(k, v, x: leftX, y: ly, width: colW)
        }

        // Tags
        if !data.tags.isEmpty {
            ly = inlineKV("Tags", data.tags.joined(separator: ", "),
                          x: leftX, y: ly, width: colW)
        }

        // Right column header
        sectionLabel("HEART RATE", x: rightX, y: y)
        let rightRows: [(String, String)] = [
            ("Average",  data.avgHR > 0  ? fmt("%.0f bpm", data.avgHR)  : "—"),
            ("Minimum",  data.minHR > 0  ? fmt("%.0f bpm", data.minHR)  : "—"),
            ("Maximum",  data.maxHR > 0  ? fmt("%.0f bpm", data.maxHR)  : "—"),
            ("Peak",     data.peakHR > 0 ? fmt("%.0f bpm", data.peakHR) : "—"),
        ]
        var ry = y + 18
        for (k, v) in rightRows {
            ry = inlineKV(k, v, x: rightX, y: ry, width: colW)
        }
    }

    // ── SRI Breakdown mini-card ───────────────────────────────────────────────
    private func drawSRIBreakdownCard(y: CGFloat) {
        let cardH: CGFloat = 90
        roundRect(CGRect(x: margin, y: y, width: cw, height: cardH),
                  radius: 10, fill: surface, stroke: hairline)
        sectionLabel("STRESS RECOVERY INDEX BREAKDOWN", x: margin + 14, y: y + 10)

        let cols: [(String, String, String, UIColor)] = [
            ("Composite Score", data.sriScore > 0 ? "\(data.sriScore) / 100" : "—",
             sriLabel(data.sriScore), sriColor(data.sriScore)),
            ("RMSSD (35%)", data.sriComponents.rmssd > 0 ? fmt("%.1f ms", data.sriComponents.rmssd) : "—",
             "", body),
            ("LF/HF (35%)", data.sriComponents.lfhf > 0 ? fmt("%.2f", data.sriComponents.lfhf) : "—",
             "", body),
            ("HR Recovery (30%)", data.sriComponents.hrRecovery > 0 ? fmt("%.1f%%", data.sriComponents.hrRecovery) : "—",
             "", body),
        ]
        let colW = cw / CGFloat(cols.count)
        for (i, (label, value, rating, color)) in cols.enumerated() {
            let cx = margin + CGFloat(i) * colW + 10
            text(value, x: cx, y: y + 32, width: colW - 16,
                 font: .systemFont(ofSize: 14, weight: .black),
                 color: color, align: .left)
            if !rating.isEmpty {
                text(rating, x: cx, y: y + 50, width: colW - 16,
                     font: .systemFont(ofSize: 8, weight: .bold),
                     color: color, align: .left)
            }
            text(label.uppercased(), x: cx, y: y + 68, width: colW - 16,
                 font: .systemFont(ofSize: 7),
                 color: subtle, align: .left)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 2: Metrics
    // ─────────────────────────────────────────────────────────────────────────

    private func drawMetricsPage() {
        drawPageHeader(title: "HRV Metrics")
        var y: CGFloat = 64

        // Time domain
        y = drawSectionHeader("Time Domain Analysis", subtitle: "Overall autonomic nervous system activity and beat-to-beat variability.", y: y)
        y = drawMetricTable([
            ("Mean RR Interval",  data.meanRR    > 0 ? fmt("%.1f ms",  data.meanRR)    : "—", ""),
            ("Average Heart Rate",data.avgHR     > 0 ? fmt("%.0f bpm", data.avgHR)     : "—", ""),
            ("SDNN",              data.sdnn      > 0 ? fmt("%.1f ms",  data.sdnn)      : "—",
             rangeLabel(data.sdnn, [100, 50, 25])),
            ("RMSSD",             data.rmssdFull > 0 ? fmt("%.1f ms",  data.rmssdFull) : "—",
             rangeLabel(data.rmssdFull, [50, 30, 20])),
            ("pNN50",             fmt("%.1f%%", data.pnn50),                              ""),
        ], startY: y)

        y += 18
        y = drawSectionHeader("Frequency Domain Analysis",
                              subtitle: "Sympathetic/parasympathetic balance via Lomb–Scargle spectral analysis.", y: y)

        if let psd = data.psd {
            let total = max(psd.totalPower, 1)
            y = drawMetricTable([
                ("VLF  (0.003–0.04 Hz)", fmt("%.1f ms²", psd.vlfPower),
                 fmt("%.0f%%", psd.vlfPower/total*100)),
                ("LF   (0.04–0.15 Hz)",  fmt("%.1f ms²", psd.lfPower),
                 fmt("%.0f%%", psd.lfPower/total*100)),
                ("HF   (0.15–0.40 Hz)",  fmt("%.1f ms²", psd.hfPower),
                 fmt("%.0f%%", psd.hfPower/total*100)),
                ("Total Power",           fmt("%.1f ms²", psd.totalPower), ""),
                ("LF/HF Ratio",           fmt("%.3f", psd.lfhfRatio),
                 lfhfLabel(psd.lfhfRatio)),
            ], startY: y)
        } else {
            text("Insufficient data — 50 or more RR intervals required.",
                 x: margin + 8, y: y,
                 font: .italicSystemFont(ofSize: 9), color: subtle)
            y += 16
        }

        y += 18
        y = drawSectionHeader("Stress Recovery Index",
                              subtitle: "Composite autonomic recovery score weighted across three HRV domains.", y: y)
        y = drawMetricTable([
            ("Composite SRI Score",    data.sriScore > 0 ? "\(data.sriScore) / 100" : "—",
             sriLabel(data.sriScore)),
            ("RMSSD Component (35%)",  data.sriComponents.rmssd > 0 ? fmt("%.1f ms",  data.sriComponents.rmssd) : "—", ""),
            ("LF/HF Component (35%)",  data.sriComponents.lfhf  > 0 ? fmt("%.2f",     data.sriComponents.lfhf)  : "—", ""),
            ("HR Recovery    (30%)",   data.sriComponents.hrRecovery > 0 ? fmt("%.1f%%", data.sriComponents.hrRecovery) : "—", ""),
        ], startY: y)

        // Events
        if !data.eventMarkers.isEmpty {
            y += 18
            y = drawSectionHeader("Recorded Events (\(data.eventMarkers.count))", y: y)
            y = drawEventsBlock(startY: y)
        }

        drawFooter(page: 2, total: 4)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 3: Charts
    // ─────────────────────────────────────────────────────────────────────────

    private func drawChartsPage() {
        drawPageHeader(title: "Visual Analysis")
        var y: CGFloat = 64

        if let img = charts.rr {
            y = drawChartBlock(img: img,
                               title: "RR Intervals",
                               caption: "Beat-to-beat sequence — variability reflects autonomic activity. Vertical markers indicate recorded events.",
                               height: 148, y: y)
            y += 16
        }

        if let img = charts.psd {
            y = drawChartBlock(img: img,
                               title: "Power Spectral Density",
                               caption: "Frequency domain: VLF (grey) · LF (indigo) · HF (pink). Normalised to 100% total power.",
                               height: 148, y: y)
            y += 16
        }

        // Poincaré + RMSSD side by side if both available
        if let rmssdImg = charts.rmssd, let poincareImg = charts.poincare {
            y = drawDualChartRow(
                leftImg: poincareImg, leftTitle: "Poincaré Plot",
                leftCaption: "Wider cloud = higher short-term variability (SD1).",
                rightImg: rmssdImg,  rightTitle: "Rolling RMSSD  (1-min window)",
                rightCaption: "Parasympathetic trend. Rising = improved recovery.",
                y: y)
        } else if let img = charts.poincare {
            y = drawChartBlock(img: img, title: "Poincaré Plot",
                               caption: "Consecutive RR pairs. Wider cloud = higher SD1 (short-term vagal).",
                               height: 180, y: y, square: true)
        } else if let img = charts.rmssd {
            y = drawChartBlock(img: img, title: "Rolling RMSSD (1-min window)",
                               caption: "Parasympathetic trend across the session. Stable or rising = good recovery.",
                               height: 130, y: y)
        }

        drawFooter(page: 3, total: 4)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 4: Reference & Clinical
    // ─────────────────────────────────────────────────────────────────────────

    private func drawReferencePage() {
        drawPageHeader(title: "Reference & Clinical Notes")
        var y: CGFloat = 64

        // ── Reference table ───────────────────────────────────────────────────
        y = drawSectionHeader("Reference Ranges", y: y)
        y = drawColorReferenceTable(y: y)

        // ── Your session comparison ───────────────────────────────────────────
        y += 18
        y = drawSectionHeader("Session Results vs. Reference", y: y)
        y = drawComparisonCards(y: y)

        // ── Clinical notes ────────────────────────────────────────────────────
        y += 18
        y = drawSectionHeader("Clinical Considerations", y: y)
        y = drawClinicalNotes(y: y)

        // ── Sign-off ──────────────────────────────────────────────────────────
        y += 8
        hline(y: y, color: hairline)
        y += 10
        text("Generated by CardioTrace · \(Date().formatted(date: .abbreviated, time: .shortened)) · For research and educational use only — not a medical device.",
             x: margin, y: y, width: cw,
             font: .systemFont(ofSize: 7.5), color: subtle, align: .center)

        drawFooter(page: 4, total: 4)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Reusable layout components
    // ─────────────────────────────────────────────────────────────────────────

    private func drawPageHeader(title: String) {
        // Thin top accent bar
        fillRect(CGRect(x: 0, y: 0, width: page.width, height: 3), color: brand)
        // Title row
        text("CardioTrace",
             x: margin, y: 14, width: 100,
             font: .systemFont(ofSize: 8, weight: .black),
             color: brand, align: .left)
        text(title,
             x: margin + 110, y: 14, width: cw - 200,
             font: .systemFont(ofSize: 8, weight: .semibold),
             color: subtle, align: .left)
        text(data.createdAt.formatted(date: .abbreviated, time: .omitted),
             x: margin, y: 14, width: cw,
             font: .systemFont(ofSize: 8), color: subtle, align: .right)
        // Divider
        hline(y: 34, color: hairline)
    }

    // Section header with accent dot + rule
    @discardableResult
    private func drawSectionHeader(_ title: String,
                                   subtitle: String? = nil,
                                   y: CGFloat) -> CGFloat {
        var cy = y
        // Accent dot
        fillRect(CGRect(x: margin, y: cy + 2, width: 4, height: 12),
                 color: brand, cornerRadius: 2)
        text(title,
             x: margin + 12, y: cy, width: cw - 12,
             font: .systemFont(ofSize: 11, weight: .bold),
             color: ink, align: .left)
        cy += 16
        if let sub = subtitle {
            text(sub, x: margin + 12, y: cy, width: cw - 12,
                 font: .italicSystemFont(ofSize: 8.5), color: subtle, align: .left)
            cy += 14
        }
        return cy + 4
    }

    // Section label (small caps style)
    private func sectionLabel(_ title: String, x: CGFloat, y: CGFloat) {
        text(title,
             x: x, y: y, width: 200,
             font: .systemFont(ofSize: 7.5, weight: .bold),
             color: brand, align: .left)
    }

    // Inline key / value row — returns next Y
    @discardableResult
    private func inlineKV(_ key: String, _ value: String,
                          x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let rowH: CGFloat = 18
        text(key, x: x, y: y + 3, width: 90,
             font: .systemFont(ofSize: 8.5), color: subtle, align: .left)
        text(value, x: x + 94, y: y + 3, width: width - 94,
             font: .systemFont(ofSize: 8.5, weight: .semibold), color: body, align: .left)
        return y + rowH
    }

    // Striped 3-column metric table → (name, value, tag)
    @discardableResult
    private func drawMetricTable(_ rows: [(String, String, String)],
                                 startY: CGFloat) -> CGFloat {
        let rowH: CGFloat = 20
        let col1: CGFloat = margin
        let col2: CGFloat = margin + 195
        let col3: CGFloat = margin + 360
        var y = startY

        for (i, (name, value, tag)) in rows.enumerated() {
            let fill = i % 2 == 0 ? surface : white
            fillRect(CGRect(x: margin, y: y, width: cw, height: rowH), color: fill)

            text(name, x: col1 + 8, y: y + 4, width: 180,
                 font: .systemFont(ofSize: 9), color: subtle, align: .left)
            text(value, x: col2, y: y + 4, width: 155,
                 font: .systemFont(ofSize: 9, weight: .semibold), color: body, align: .left)

            if !tag.isEmpty {
                let tagColor = ratingUIColor(tag)
                // Pill background
                roundRect(CGRect(x: col3 - 2, y: y + 4, width: 70, height: 13),
                          radius: 6, fill: tagColor.withAlphaComponent(0.12))
                text(tag, x: col3, y: y + 5, width: 68,
                     font: .systemFont(ofSize: 8, weight: .bold),
                     color: tagColor, align: .center)
            }
            y += rowH
        }
        // Bottom border
        hline(y: y, color: hairline, from: margin, to: margin + cw)
        return y + 6
    }

    // Chart block with title + caption
    @discardableResult
    private func drawChartBlock(img: UIImage,
                                title: String,
                                caption: String,
                                height: CGFloat,
                                y: CGFloat,
                                square: Bool = false) -> CGFloat {
        var cy = y
        // Title
        text(title,
             x: margin, y: cy, width: cw,
             font: .systemFont(ofSize: 9, weight: .bold),
             color: ink, align: .left)
        cy += 14
        // Chart frame
        let chartRect = CGRect(x: margin, y: cy, width: cw, height: height)
        roundRect(chartRect.insetBy(dx: -3, dy: -3),
                  radius: 6, fill: surface, stroke: hairline)
        if square {
            let sz = min(cw, height)
            let cx = margin + (cw - sz) / 2
            img.draw(in: CGRect(x: cx, y: cy, width: sz, height: sz))
            cy += sz
        } else {
            img.draw(in: chartRect)
            cy += height
        }
        cy += 6
        // Caption
        text(caption,
             x: margin, y: cy, width: cw,
             font: .italicSystemFont(ofSize: 7.5), color: subtle, align: .left)
        return cy + 14
    }

    // Side-by-side chart pair
    @discardableResult
    private func drawDualChartRow(leftImg: UIImage,  leftTitle: String,  leftCaption: String,
                                  rightImg: UIImage, rightTitle: String, rightCaption: String,
                                  y: CGFloat) -> CGFloat {
        let colW = (cw - 12) / 2
        var cy = y

        // Titles
        text(leftTitle,  x: margin,           y: cy, width: colW,
             font: .systemFont(ofSize: 9, weight: .bold), color: ink, align: .left)
        text(rightTitle, x: margin + colW + 12, y: cy, width: colW,
             font: .systemFont(ofSize: 9, weight: .bold), color: ink, align: .left)
        cy += 14

        let h: CGFloat = 160
        // Left image
        let leftRect  = CGRect(x: margin,           y: cy, width: colW, height: h)
        let rightRect = CGRect(x: margin + colW + 12, y: cy, width: colW, height: h)
        roundRect(leftRect.insetBy(dx: -3, dy: -3),  radius: 6, fill: surface, stroke: hairline)
        roundRect(rightRect.insetBy(dx: -3, dy: -3), radius: 6, fill: surface, stroke: hairline)
        leftImg.draw(in: CGRect(x: margin, y: cy, width: colW, height: colW)) // square
        rightImg.draw(in: rightRect)
        cy += h + 6

        // Captions
        text(leftCaption,  x: margin,           y: cy, width: colW,
             font: .italicSystemFont(ofSize: 7.5), color: subtle, align: .left)
        text(rightCaption, x: margin + colW + 12, y: cy, width: colW,
             font: .italicSystemFont(ofSize: 7.5), color: subtle, align: .left)

        return cy + 14
    }

    // Colour reference table
    @discardableResult
    private func drawColorReferenceTable(y: CGFloat) -> CGFloat {
        let headers = ["Metric", "Excellent", "Good", "Fair", "Poor"]
        let rows: [[String]] = [
            ["RMSSD",     "> 50 ms",   "30–50 ms",  "20–30 ms",  "< 20 ms"],
            ["SDNN",      "> 100 ms",  "50–100 ms", "25–50 ms",  "< 25 ms"],
            ["LF/HF",     "0.5–1.5",  "1.5–2.5",   "2.5–3.5",   "> 3.5"],
            ["SRI Score", "75–100",   "55–74",      "35–54",     "0–34"],
        ]
        let colColors: [UIColor] = [subtle, green, cyan, amber, red]
        let cols     = headers.count
        let colW     = cw / CGFloat(cols)
        var cy       = y
        let rowH: CGFloat = 18

        // Header row
        fillRect(CGRect(x: margin, y: cy, width: cw, height: rowH), color: ink)
        for (i, h) in headers.enumerated() {
            let col: UIColor = i == 0 ? white : colColors[i]
            text(h, x: margin + CGFloat(i) * colW + 6, y: cy + 4, width: colW - 10,
                 font: .systemFont(ofSize: 8, weight: .bold),
                 color: col, align: .left)
        }
        cy += rowH

        for (ri, row) in rows.enumerated() {
            let bg = ri % 2 == 0 ? surface : white
            fillRect(CGRect(x: margin, y: cy, width: cw, height: rowH), color: bg)
            for (ci, cell) in row.enumerated() {
                let col = ci == 0 ? body : colColors[ci]
                text(cell, x: margin + CGFloat(ci) * colW + 6, y: cy + 4, width: colW - 10,
                     font: .systemFont(ofSize: 8.5, weight: ci == 0 ? .regular : .semibold),
                     color: col, align: .left)
            }
            cy += rowH
        }
        hline(y: cy, color: hairline)
        return cy + 8
    }

    // Session comparison cards
    @discardableResult
    private func drawComparisonCards(y: CGFloat) -> CGFloat {
        let items: [(String, String, String)] = [
            ("RMSSD", data.rmssdFull > 0 ? fmt("%.1f ms", data.rmssdFull) : "—",
             rangeLabel(data.rmssdFull, [50, 30, 20])),
            ("SDNN",  data.sdnn > 0 ? fmt("%.1f ms", data.sdnn) : "—",
             rangeLabel(data.sdnn, [100, 50, 25])),
            ("LF/HF", data.psd != nil ? fmt("%.2f", data.psd!.lfhfRatio) : "—",
             data.psd != nil ? lfhfLabel(data.psd!.lfhfRatio) : "—"),
            ("SRI",   data.sriScore > 0 ? "\(data.sriScore)" : "—",
             sriLabel(data.sriScore)),
        ]
        let gap:  CGFloat = 10
        let cardW = (cw - gap * CGFloat(items.count - 1)) / CGFloat(items.count)
        let cardH: CGFloat = 60

        for (i, (metric, value, rating)) in items.enumerated() {
            let x = margin + CGFloat(i) * (cardW + gap)
            let rc = ratingUIColor(rating)
            roundRect(CGRect(x: x, y: y, width: cardW, height: cardH),
                      radius: 8, fill: surface, stroke: hairline)
            // Top colour stripe
            fillRect(CGRect(x: x, y: y, width: cardW, height: 3),
                     color: rc, cornerRadius: 8)
            // Value
            text(value, x: x + 8, y: y + 10, width: cardW - 16,
                 font: .systemFont(ofSize: 16, weight: .black),
                 color: rc, align: .center)
            // Rating
            if !rating.isEmpty && rating != "—" {
                text(rating, x: x + 8, y: y + 32, width: cardW - 16,
                     font: .systemFont(ofSize: 8, weight: .bold),
                     color: rc, align: .center)
            }
            // Metric label
            text(metric.uppercased(), x: x + 8, y: y + 46, width: cardW - 16,
                 font: .systemFont(ofSize: 7), color: subtle, align: .center)
        }
        return y + cardH + 8
    }

    // Events block
    @discardableResult
    private func drawEventsBlock(startY: CGFloat) -> CGFloat {
        var y = startY
        let rowH: CGFloat = 16
        let shown = data.eventMarkers.prefix(14)
        for (i, m) in shown.enumerated() {
            let bg = i % 2 == 0 ? surface : white
            fillRect(CGRect(x: margin, y: y, width: cw, height: rowH), color: bg)
            text(String(format: "%7.1fs", m.time),
                 x: margin + 6, y: y + 2, width: 60,
                 font: .monospacedSystemFont(ofSize: 8.5, weight: .medium),
                 color: cyan, align: .right)
            text(m.label,
                 x: margin + 74, y: y + 2, width: cw - 80,
                 font: .systemFont(ofSize: 8.5), color: body, align: .left)
            y += rowH
        }
        if data.eventMarkers.count > 14 {
            text("… and \(data.eventMarkers.count - 14) more events",
                 x: margin + 6, y: y + 2, width: cw,
                 font: .italicSystemFont(ofSize: 8), color: subtle, align: .left)
            y += 14
        }
        hline(y: y + 4, color: hairline)
        return y + 10
    }

    // Clinical notes
    @discardableResult
    private func drawClinicalNotes(y: CGFloat) -> CGFloat {
        let notes = [
            "Results should be interpreted within the appropriate clinical context alongside patient history and symptomatology.",
            "A minimum recording of 2–5 minutes of stable signal is recommended for reliable short-term HRV analysis.",
            "Key confounders include age, medications, fitness level, time of day, hydration status, and acute psychological stress.",
            "Data quality ≥ 95% is recommended for clinical-grade interpretation. This session recorded \(String(format: "%.1f", data.dataQuality))%.",
            "For clinical decisions, always consult a qualified healthcare professional. CardioTrace is for research and educational use only.",
        ]
        let lineFont = UIFont.systemFont(ofSize: 9)
        var cy = y

        for note in notes {
            let line = "•  \(note)"
            let h = textHeight(line, font: lineFont, width: cw - 12)
            text(line, x: margin + 6, y: cy, width: cw - 12,
                 font: lineFont, color: body, align: .left)
            cy += h + 5
        }
        return cy
    }

    // Page footer
    private func drawFooter(page: Int, total: Int) {
        let fy = self.page.height - 22
        hline(y: fy - 6, color: hairline)
        text("CardioTrace · Research & Educational Use Only",
             x: margin, y: fy, width: cw,
             font: .systemFont(ofSize: 7), color: subtle, align: .center)
        text("Page \(page) of \(total)",
             x: margin, y: fy, width: cw,
             font: .systemFont(ofSize: 7), color: subtle, align: .right)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Drawing primitives
    // ─────────────────────────────────────────────────────────────────────────

    @discardableResult
    private func text(_ str: String,
                      x: CGFloat, y: CGFloat, width: CGFloat,
                      font: UIFont, color: UIColor,
                      align: NSTextAlignment = .left) -> CGFloat {
        let style = NSMutableParagraphStyle()
        style.alignment     = align
        style.lineBreakMode = .byWordWrapping
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: color, .paragraphStyle: style
        ]
        let ns  = NSAttributedString(string: str, attributes: attrs)
        let bnd = ns.boundingRect(with: CGSize(width: width, height: 4_000),
                                  options: .usesLineFragmentOrigin, context: nil)
        ns.draw(in: CGRect(x: x, y: y, width: width, height: ceil(bnd.height)))
        return ceil(bnd.height)
    }

    private func hline(y: CGFloat,
                       color: UIColor = UIColor(white: 0.82, alpha: 1),
                       from: CGFloat? = nil, to: CGFloat? = nil,
                       width: CGFloat = 0.4) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.saveGState()
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(width)
        ctx.move(to: CGPoint(x: from ?? 0, y: y))
        ctx.addLine(to: CGPoint(x: to ?? page.width, y: y))
        ctx.strokePath()
        ctx.restoreGState()
    }

    private func fillRect(_ r: CGRect, color: UIColor, cornerRadius: CGFloat = 0) {
        let path = UIBezierPath(roundedRect: r, cornerRadius: cornerRadius)
        color.setFill(); path.fill()
    }

    private func roundRect(_ r: CGRect, radius: CGFloat,
                           fill: UIColor? = nil, stroke: UIColor? = nil) {
        let path = UIBezierPath(roundedRect: r, cornerRadius: radius)
        if let f = fill   { f.setFill();   path.fill() }
        if let s = stroke { s.setStroke(); path.lineWidth = 0.4; path.stroke() }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Utility
    // ─────────────────────────────────────────────────────────────────────────

    private func textHeight(_ str: String, font: UIFont, width: CGFloat) -> CGFloat {
        let style = NSMutableParagraphStyle(); style.lineBreakMode = .byWordWrapping
        let bnd = NSAttributedString(
            string: str,
            attributes: [.font: font, .paragraphStyle: style])
            .boundingRect(with: CGSize(width: width, height: 4_000),
                          options: .usesLineFragmentOrigin, context: nil)
        return ceil(bnd.height)
    }

    private func fmt(_ format: String, _ args: CVarArg...) -> String {
        String(format: format, arguments: args)
    }

    private func formatDuration(_ s: Double) -> String {
        let t = Int(s)
        if t >= 3600 { return "\(t/3600)h \((t%3600)/60)m" }
        if t >= 60   { return "\(t/60)m \(t%60)s" }
        return "\(t)s"
    }

    private func sanitize(_ s: String) -> String {
        s.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|"))
         .joined(separator: "_")
    }

    private func buildInterpretation() -> String {
        var parts: [String] = []
        switch data.sriScore {
        case 75...:   parts.append("Excellent autonomic function with strong parasympathetic activity.")
        case 55..<75: parts.append("Good cardiovascular adaptation and adequate recovery capacity.")
        case 35..<55: parts.append("Moderate stress detected — consider relaxation techniques.")
        case 1..<35:  parts.append("Significant autonomic imbalance — prioritise rest and recovery.")
        default:      parts.append("Insufficient data for SRI-based interpretation.")
        }
        if let lfhf = data.psd?.lfhfRatio {
            if lfhf > 2.5 {
                parts.append(fmt("High sympathetic dominance (LF/HF %.2f) — active stress response.", lfhf))
            } else if lfhf < 1.0 {
                parts.append(fmt("Parasympathetic dominance (LF/HF %.2f) — recovery state.", lfhf))
            }
        }
        if data.rmssdFull > 0 && data.rmssdFull < 20 {
            parts.append("Low RMSSD (< 20 ms) indicates reduced vagal tone.")
        } else if data.rmssdFull > 50 {
            parts.append("High RMSSD (> 50 ms) reflects excellent parasympathetic function.")
        }
        return parts.joined(separator: " ")
    }

    // Rating helpers
    private func rangeLabel(_ v: Double, _ t: [Double]) -> String {
        guard v > 0, t.count >= 3 else { return "—" }
        if v >= t[0] { return "Excellent" }
        if v >= t[1] { return "Good" }
        if v >= t[2] { return "Fair" }
        return "Poor"
    }
    private func lfhfLabel(_ v: Double) -> String {
        if v <= 1.5 { return "Excellent" }
        if v <= 2.5 { return "Good" }
        if v <= 3.5 { return "Fair" }
        return "Poor"
    }
    private func sriLabel(_ v: Int) -> String {
        if v >= 75 { return "Excellent" }
        if v >= 55 { return "Good" }
        if v >= 35 { return "Fair" }
        if v > 0   { return "Poor" }
        return "—"
    }

    // Colour helpers
    private func ratingUIColor(_ r: String) -> UIColor {
        switch r {
        case "Excellent": return green
        case "Good":      return cyan
        case "Fair":      return amber
        case "Poor":      return red
        default:          return subtle
        }
    }
    private func sriColor(_ score: Int) -> UIColor {
        switch score {
        case 75...: return green
        case 55..<75: return cyan
        case 35..<55: return amber
        case 1..<35:  return red
        default:      return subtle
        }
    }
    private func rmssdColor(_ v: Double) -> UIColor {
        if v >= 50 { return green }
        if v >= 30 { return cyan }
        if v >= 20 { return amber }
        if v > 0   { return red }
        return subtle
    }
    private func lfhfColor(_ v: Double) -> UIColor {
        if v <= 0 { return subtle }
        return ratingUIColor(lfhfLabel(v))
    }
}
