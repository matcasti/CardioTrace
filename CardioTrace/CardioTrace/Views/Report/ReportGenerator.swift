//
//  ReportGenerator.swift
//  CardioTrace
//
//  Created by Matías Castillo Aguilar on 03-05-26.
//

import SwiftUI
import UIKit

// ─────────────────────────────────────────────────────────────────────────────
// MARK: - Public API
// ─────────────────────────────────────────────────────────────────────────────

@MainActor
enum ReportGenerator {

    /// Generate from a saved HRVSession (History screen)
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

    /// Generate from the live SessionViewModel (Dashboard screen)
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
                CGSize(width: 300, height: 300)) : nil,

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
    // Pre-computed so PDFBuilder stays off the HRVEngine
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
// MARK: - PDF Builder (UIKit drawing, UIKit coordinate system)
// ─────────────────────────────────────────────────────────────────────────────

private final class PDFBuilder {

    let data:   ReportData
    let charts: ChartImages

    // A4 in points
    let page    = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)
    let margin: CGFloat = 40
    var cw:     CGFloat { page.width - margin * 2 }   // 515.2 pt

    // Palette
    let cPrimary   = UIColor(white: 0.08, alpha: 1)
    let cSecondary = UIColor(white: 0.35, alpha: 1)
    let cTertiary  = UIColor(white: 0.62, alpha: 1)
    let cLight     = UIColor(white: 0.85, alpha: 1)
    let cVeryLight = UIColor(white: 0.96, alpha: 1)
    let cAccent    = UIColor(red: 0.388, green: 0.400, blue: 0.945, alpha: 1)
    let cSuccess   = UIColor(red: 0.063, green: 0.725, blue: 0.506, alpha: 1)
    let cWarning   = UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1)
    let cDanger    = UIColor(red: 0.937, green: 0.267, blue: 0.267, alpha: 1)
    let cCyan      = UIColor(red: 0.133, green: 0.827, blue: 0.933, alpha: 1)

    init(data: ReportData, charts: ChartImages) {
        self.data   = data
        self.charts = charts
    }

    // MARK: – Entry point

    func build() -> URL? {
        let renderer = UIGraphicsPDFRenderer(bounds: page)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(sanitize(data.filename) + "_report.pdf")
        do {
            try renderer.writePDF(to: url) { ctx in
                ctx.beginPage(); coverPage();     pageFooter(n: 1, of: 4)
                ctx.beginPage(); metricsPage();   pageFooter(n: 2, of: 4)
                ctx.beginPage(); chartsPage();    pageFooter(n: 3, of: 4)
                ctx.beginPage(); referencePage(); pageFooter(n: 4, of: 4)
            }
            return url
        } catch {
            print("❌ PDF render error: \(error)")
            return nil
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 1: Cover
    // ─────────────────────────────────────────────────────────────────────────

    private func coverPage() {
        // Grey header band
        fillRect(CGRect(x: 0, y: 0, width: page.width, height: 88), color: cVeryLight)

        var y: CGFloat = 26
        drawText("CARDIAC AUTONOMIC FUNCTION REPORT",
                 at: y, font: .systemFont(ofSize: 20, weight: .black),
                 color: cPrimary, alignment: .center)
        y += 25
        drawLine(from: CGPoint(x: page.width / 2 - 55, y: y),
                 to:   CGPoint(x: page.width / 2 + 55, y: y),
                 color: cAccent, width: 1.5)
        y += 8
        drawText("Heart Rate Variability Analysis",
                 at: y, font: .systemFont(ofSize: 11),
                 color: cSecondary, alignment: .center)

        // Session info box
        y = 106
        let infoRows: [(String, String)] = [
            ("Date",     data.createdAt.formatted(date: .long, time: .shortened)),
            ("Duration", formatDuration(data.duration)),
            ("Samples",  "\(data.rrIntervals.count) clean / \(data.rawCount) raw"),
            ("Quality",  String(format: "%.1f%%", data.dataQuality)),
            ("Tags",     data.tags.isEmpty ? "None" : data.tags.joined(separator: ", "))
        ]
        let infoH: CGFloat = 16 + CGFloat(infoRows.count) * 13 + 10
        fillRect(CGRect(x: margin, y: y, width: cw, height: infoH),
                 color: .white, stroke: cLight, cornerRadius: 6)
        var iy = y + 10
        drawText("SESSION DETAILS",
                 at: iy, x: margin + 10,
                 font: .systemFont(ofSize: 8, weight: .bold), color: cAccent)
        iy += 14
        for (lbl, val) in infoRows {
            drawText(lbl + ":", at: iy, x: margin + 10,
                     font: .systemFont(ofSize: 9), color: cTertiary, maxWidth: 80)
            drawText(val, at: iy, x: margin + 96,
                     font: .systemFont(ofSize: 9, weight: .semibold),
                     color: cSecondary, maxWidth: cw - 106)
            iy += 13
        }

        // Key metrics banner
        y = y + infoH + 12
        fillRect(CGRect(x: 0, y: y, width: page.width, height: 56), color: cAccent)
        let metricW = page.width / 4
        let kms: [(String, String)] = [
            ("SRI",    data.sriScore > 0 ? "\(data.sriScore) / 100" : "--"),
            ("RMSSD",  data.rmssdFull > 0 ? fmt("%.1f ms", data.rmssdFull) : "--"),
            ("LF/HF",  data.psd != nil    ? fmt("%.2f", data.psd!.lfhfRatio) : "--"),
            ("Avg HR", data.avgHR > 0     ? fmt("%.0f bpm", data.avgHR) : "--")
        ]
        for (i, (label, value)) in kms.enumerated() {
            let kx = CGFloat(i) * metricW
            drawText(value, at: y + 10, x: kx,
                     font: .systemFont(ofSize: 15, weight: .black),
                     color: .white, maxWidth: metricW, alignment: .center)
            drawText(label, at: y + 30, x: kx,
                     font: .systemFont(ofSize: 8),
                     color: UIColor.white.withAlphaComponent(0.75),
                     maxWidth: metricW, alignment: .center)
        }

        // Clinical interpretation box
        y = y + 68
        let interp = buildInterpretation()
        let boxH   = textHeight(interp, font: .systemFont(ofSize: 10), width: cw - 20) + 36
        fillRect(CGRect(x: margin, y: y, width: cw, height: boxH),
                 color: cVeryLight, stroke: cLight, cornerRadius: 6)
        drawText("CLINICAL INTERPRETATION",
                 at: y + 10, x: margin + 10,
                 font: .systemFont(ofSize: 8, weight: .bold), color: cAccent)
        drawText(interp,
                 at: y + 26, x: margin + 10,
                 font: .systemFont(ofSize: 10), color: cSecondary, maxWidth: cw - 20)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 2: Metrics
    // ─────────────────────────────────────────────────────────────────────────

    private func metricsPage() {
        pageHeader()
        var y: CGFloat = 52

        // Time domain
        y = sectionTitle("TIME DOMAIN ANALYSIS", at: y)
        drawText("Overall autonomic nervous system activity and beat-to-beat variability.",
                 at: y, font: .italicSystemFont(ofSize: 9), color: cTertiary)
        y += 14
        y = kvTable([
            ("Mean RR Interval",  data.meanRR    > 0 ? fmt("%.1f ms",  data.meanRR)    : "--"),
            ("Average Heart Rate",data.avgHR     > 0 ? fmt("%.0f bpm", data.avgHR)     : "--"),
            ("SDNN",              data.sdnn      > 0 ? fmt("%.1f ms",  data.sdnn)      : "--"),
            ("RMSSD",             data.rmssdFull > 0 ? fmt("%.1f ms",  data.rmssdFull) : "--"),
            ("pNN50",             fmt("%.1f%%", data.pnn50)),
        ], startY: y)

        // Heart rate
        y += 10
        y = sectionTitle("HEART RATE METRICS", at: y)
        y = kvTable([
            ("Minimum HR", data.minHR  > 0 ? fmt("%.0f bpm", data.minHR)  : "--"),
            ("Maximum HR", data.maxHR  > 0 ? fmt("%.0f bpm", data.maxHR)  : "--"),
            ("HR Range",   data.maxHR > 0 && data.minHR > 0
                ? fmt("%.0f bpm", data.maxHR - data.minHR) : "--"),
            ("Peak HR",    data.peakHR > 0 ? fmt("%.0f bpm", data.peakHR) : "--"),
        ], startY: y)

        // Frequency domain
        y += 10
        y = sectionTitle("FREQUENCY DOMAIN ANALYSIS", at: y)
        drawText("Sympathetic / parasympathetic balance via Lomb–Scargle spectral analysis.",
                 at: y, font: .italicSystemFont(ofSize: 9), color: cTertiary)
        y += 14
        if let psd = data.psd {
            let total = max(psd.totalPower, 1)
            y = kvTable([
                ("VLF (0.003–0.04 Hz)", fmt("%.1f ms² · %.0f%%", psd.vlfPower, psd.vlfPower/total*100)),
                ("LF  (0.04–0.15 Hz)",  fmt("%.1f ms² · %.0f%%", psd.lfPower,  psd.lfPower/total*100)),
                ("HF  (0.15–0.40 Hz)",  fmt("%.1f ms² · %.0f%%", psd.hfPower,  psd.hfPower/total*100)),
                ("Total Power",          fmt("%.1f ms²",           psd.totalPower)),
                ("LF/HF Ratio",          fmt("%.2f",               psd.lfhfRatio)),
            ], startY: y)
        } else {
            drawText("Insufficient data — 50 or more RR intervals required for spectral analysis.",
                     at: y, font: .systemFont(ofSize: 10), color: cTertiary)
            y += 14
        }

        // SRI breakdown
        y += 10
        y = sectionTitle("STRESS RECOVERY INDEX", at: y)
        y = kvTable([
            ("Composite SRI Score",   data.sriScore > 0 ? "\(data.sriScore) / 100" : "--"),
            ("RMSSD Component (35%)", data.sriComponents.rmssd > 0
                ? fmt("%.1f ms",  data.sriComponents.rmssd) : "--"),
            ("LF/HF Component (35%)", data.sriComponents.lfhf > 0
                ? fmt("%.2f",     data.sriComponents.lfhf)  : "--"),
            ("HR Recovery    (30%)",  data.sriComponents.hrRecovery > 0
                ? fmt("%.1f%%",   data.sriComponents.hrRecovery)  : "--"),
        ], startY: y)

        // Events (abbreviated list)
        if !data.eventMarkers.isEmpty {
            y += 10
            y = sectionTitle("EVENTS (\(data.eventMarkers.count))", at: y)
            for marker in data.eventMarkers.prefix(12) {
                drawText(String(format: "%6.1fs  %@", marker.time, marker.label),
                         at: y, x: margin + 8,
                         font: .monospacedSystemFont(ofSize: 9, weight: .regular),
                         color: cSecondary)
                y += 12
            }
            if data.eventMarkers.count > 12 {
                drawText("… and \(data.eventMarkers.count - 12) more events",
                         at: y, x: margin + 8,
                         font: .systemFont(ofSize: 9), color: cTertiary)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 3: Charts A — RR, Poincaré, RMSSD
    // ─────────────────────────────────────────────────────────────────────────

    private func chartsPage() {
        pageHeader()
        var y: CGFloat = 52

        if let img = charts.rr {
            drawText("RR INTERVALS",
                     at: y, font: .systemFont(ofSize: 9, weight: .bold), color: cAccent)
            y += 12
            drawText("Beat-to-beat sequence — variation reflects autonomic activity.",
                     at: y, font: .italicSystemFont(ofSize: 8), color: cTertiary)
            y += 10
            embedImage(img, at: y, height: 150)
            y += 158
        }

        if let img = charts.poincare {
            drawText("POINCARÉ PLOT",
                     at: y, font: .systemFont(ofSize: 9, weight: .bold), color: cAccent)
            y += 12
            drawText("Consecutive RR pairs — wider cloud = higher short-term variability (SD1).",
                     at: y, font: .italicSystemFont(ofSize: 8), color: cTertiary)
            y += 10
            // Square, horizontally centred
            let sz: CGFloat = 190
            let px = margin + (cw - sz) / 2
            fillRect(CGRect(x: px - 3, y: y - 3, width: sz + 6, height: sz + 6),
                     color: .white, stroke: cLight, cornerRadius: 4)
            img.draw(in: CGRect(x: px, y: y, width: sz, height: sz))
            y += sz + 8
        }

        if let img = charts.rmssd {
            drawText("ROLLING RMSSD (1-min window)",
                     at: y, font: .systemFont(ofSize: 9, weight: .bold), color: cAccent)
            y += 12
            drawText("Parasympathetic trend across the session. Stable or rising = good recovery.",
                     at: y, font: .italicSystemFont(ofSize: 8), color: cTertiary)
            y += 10
            embedImage(img, at: y, height: 130)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Page 4: PSD + Reference + Clinical
    // ─────────────────────────────────────────────────────────────────────────

    private func referencePage() {
        pageHeader()
        var y: CGFloat = 52

        if let img = charts.psd {
            drawText("POWER SPECTRAL DENSITY",
                     at: y, font: .systemFont(ofSize: 9, weight: .bold), color: cAccent)
            y += 12
            drawText("Frequency domain: VLF (grey) · LF (indigo) · HF (pink). Normalised to 100%.",
                     at: y, font: .italicSystemFont(ofSize: 8), color: cTertiary)
            y += 10
            embedImage(img, at: y, height: 150)
            y += 160
        }

        // Reference table
        y = sectionTitle("REFERENCE RANGES", at: y)
        y = referenceTable(
            headers: ["Metric", "Excellent", "Good", "Fair", "Poor"],
            rows: [
                ["RMSSD",     "> 50 ms",  "30–50 ms",  "20–30 ms",  "< 20 ms"],
                ["SDNN",      "> 100 ms", "50–100 ms", "25–50 ms",  "< 25 ms"],
                ["LF/HF",     "0.5–1.5", "1.5–2.5",   "2.5–3.5",   "> 3.5"],
                ["SRI Score", "75–100",  "55–74",      "35–54",     "0–34"],
            ],
            startY: y)

        // Session vs reference
        y += 10
        y = sectionTitle("YOUR SESSION", at: y)
        y = comparisonTable([
            ("RMSSD", data.rmssdFull > 0 ? fmt("%.1f ms", data.rmssdFull) : "--",
             rangeLabel(data.rmssdFull, [50, 30, 20])),
            ("SDNN",  data.sdnn > 0 ? fmt("%.1f ms", data.sdnn) : "--",
             rangeLabel(data.sdnn, [100, 50, 25])),
            ("LF/HF", data.psd != nil ? fmt("%.2f", data.psd!.lfhfRatio) : "--",
             data.psd != nil ? lfhfLabel(data.psd!.lfhfRatio) : "--"),
            ("SRI",   data.sriScore > 0 ? "\(data.sriScore)" : "--",
             sriLabel(data.sriScore)),
        ], startY: y)

        // Clinical notes
        y += 10
        y = sectionTitle("CLINICAL CONSIDERATIONS", at: y)
        for note in [
            "Interpret results within the appropriate clinical context alongside patient history.",
            "Minimum 2–5 minutes of stable recording recommended for reliable short-term HRV.",
            "Key confounders: age, medications, fitness, time of day, hydration, stress.",
            "Data quality ≥ 95% is recommended for reliable clinical interpretation.",
            "For clinical decisions always consult a qualified healthcare professional.",
            "CardioTrace is for research and educational use only — not a medical device.",
        ] {
            let line = "•  " + note
            let h = textHeight(line, font: .systemFont(ofSize: 9), width: cw - 8)
            drawText(line, at: y, x: margin + 4,
                     font: .systemFont(ofSize: 9), color: cSecondary, maxWidth: cw - 8)
            y += h + 5
        }

        // Sign-off
        y += 10
        drawLine(from: CGPoint(x: margin, y: y),
                 to:   CGPoint(x: margin + cw, y: y), color: cLight)
        y += 8
        drawText(
            "Generated by CardioTrace · " +
            Date().formatted(date: .abbreviated, time: .shortened) +
            " · Research & Educational Use Only",
            at: y, font: .systemFont(ofSize: 7.5), color: cTertiary, alignment: .center
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Shared layout components
    // ─────────────────────────────────────────────────────────────────────────

    private func pageHeader() {
        drawLine(from: CGPoint(x: margin, y: 38),
                 to:   CGPoint(x: page.width - margin, y: 38), color: cLight)
        drawText("CARDIAC AUTONOMIC FUNCTION REPORT",
                 at: 18, font: .systemFont(ofSize: 7.5), color: cTertiary)
        drawText(data.createdAt.formatted(date: .abbreviated, time: .omitted),
                 at: 18, font: .systemFont(ofSize: 7.5), color: cTertiary,
                 maxWidth: cw, alignment: .right)
    }

    private func pageFooter(n: Int, of total: Int) {
        let fy = page.height - 24
        drawLine(from: CGPoint(x: margin, y: fy - 5),
                 to:   CGPoint(x: page.width - margin, y: fy - 5), color: cLight)
        drawText("CardioTrace · Educational Use Only",
                 at: fy, font: .systemFont(ofSize: 7), color: cTertiary, alignment: .center)
        drawText("Page \(n) of \(total)",
                 at: fy, font: .systemFont(ofSize: 7), color: cTertiary,
                 maxWidth: cw, alignment: .right)
    }

    @discardableResult
    private func sectionTitle(_ title: String, at y: CGFloat) -> CGFloat {
        drawText(title, at: y,
                 font: .systemFont(ofSize: 10, weight: .bold), color: cPrimary)
        let lineY = y + 14
        drawLine(from: CGPoint(x: margin, y: lineY),
                 to:   CGPoint(x: margin + 36, y: lineY), color: cAccent, width: 1.2)
        return lineY + 8
    }

    @discardableResult
    private func kvTable(_ pairs: [(String, String)], startY: CGFloat) -> CGFloat {
        var y = startY
        for (i, (label, value)) in pairs.enumerated() {
            fillRect(CGRect(x: margin, y: y, width: cw, height: 18),
                     color: i % 2 == 0 ? cVeryLight : .white)
            drawText(label, at: y + 3, x: margin + 6,
                     font: .systemFont(ofSize: 9), color: cTertiary, maxWidth: 175)
            drawText(value, at: y + 3, x: margin + 185,
                     font: .systemFont(ofSize: 9, weight: .semibold),
                     color: cSecondary, maxWidth: cw - 191)
            y += 18
        }
        return y + 4
    }

    @discardableResult
    private func referenceTable(headers: [String], rows: [[String]], startY: CGFloat) -> CGFloat {
        let colW = cw / CGFloat(headers.count)
        var y = startY

        fillRect(CGRect(x: margin, y: y, width: cw, height: 18),
                 color: cVeryLight, stroke: cLight)
        for (i, h) in headers.enumerated() {
            drawText(h, at: y + 3, x: margin + CGFloat(i) * colW + 4,
                     font: .systemFont(ofSize: 8, weight: .bold), color: cPrimary,
                     maxWidth: colW - 8)
        }
        y += 18

        // Column 0 = label (secondary), 1–4 = status colours
        let cols: [UIColor] = [cSecondary, cSuccess, cCyan, cWarning, cDanger]
        for (ri, row) in rows.enumerated() {
            fillRect(CGRect(x: margin, y: y, width: cw, height: 16),
                     color: ri % 2 == 0 ? .white : cVeryLight, stroke: cLight)
            for (ci, cell) in row.enumerated() {
                drawText(cell, at: y + 2, x: margin + CGFloat(ci) * colW + 4,
                         font: .systemFont(ofSize: 8,
                                           weight: ci > 0 ? .semibold : .regular),
                         color: cols[min(ci, cols.count - 1)],
                         maxWidth: colW - 8)
            }
            y += 16
        }
        return y
    }

    @discardableResult
    private func comparisonTable(_ rows: [(String, String, String)],
                                 startY: CGFloat) -> CGFloat {
        var y = startY
        for (i, (metric, value, rating)) in rows.enumerated() {
            fillRect(CGRect(x: margin, y: y, width: cw, height: 18),
                     color: i % 2 == 0 ? cVeryLight : .white)
            drawText(metric, at: y + 3, x: margin + 6,
                     font: .systemFont(ofSize: 9), color: cTertiary, maxWidth: 90)
            drawText(value, at: y + 3, x: margin + 100,
                     font: .systemFont(ofSize: 9, weight: .semibold),
                     color: cSecondary, maxWidth: 100)
            drawText(rating, at: y + 3, x: margin + 210,
                     font: .systemFont(ofSize: 9, weight: .bold),
                     color: ratingColor(rating), maxWidth: cw - 216)
            y += 18
        }
        return y + 4
    }

    private func embedImage(_ img: UIImage, at y: CGFloat, height: CGFloat) {
        let r = CGRect(x: margin, y: y, width: cw, height: height)
        fillRect(r.insetBy(dx: -3, dy: -3), color: .white, stroke: cLight, cornerRadius: 4)
        img.draw(in: r)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: – Drawing primitives
    // ─────────────────────────────────────────────────────────────────────────

    @discardableResult
    private func drawText(_ str: String, at y: CGFloat, x: CGFloat? = nil,
                          font: UIFont, color: UIColor,
                          maxWidth: CGFloat? = nil,
                          alignment: NSTextAlignment = .left) -> CGFloat {
        let style = NSMutableParagraphStyle()
        style.alignment     = alignment
        style.lineBreakMode = .byWordWrapping
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: color, .paragraphStyle: style
        ]
        let ns  = NSAttributedString(string: str, attributes: attrs)
        let bnd = ns.boundingRect(
            with: CGSize(width: maxWidth ?? cw, height: 4_000),
            options: .usesLineFragmentOrigin, context: nil)
        ns.draw(in: CGRect(x: x ?? margin, y: y,
                           width: maxWidth ?? cw, height: ceil(bnd.height)))
        return ceil(bnd.height)
    }

    private func drawLine(from p1: CGPoint, to p2: CGPoint,
                          color: UIColor, width: CGFloat = 0.5) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.saveGState()
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(width)
        ctx.move(to: p1); ctx.addLine(to: p2); ctx.strokePath()
        ctx.restoreGState()
    }

    private func fillRect(_ r: CGRect, color: UIColor,
                          stroke: UIColor? = nil, cornerRadius: CGFloat = 0) {
        let path = UIBezierPath(roundedRect: r, cornerRadius: cornerRadius)
        color.setFill(); path.fill()
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
        default:      parts.append("Insufficient data for SRI interpretation.")
        }
        if let lfhf = data.psd?.lfhfRatio {
            if lfhf > 2.5 {
                parts.append(fmt("High sympathetic dominance (LF/HF %.2f) — active stress.", lfhf))
            } else if lfhf < 1 {
                parts.append(fmt("Parasympathetic dominance (LF/HF %.2f) — recovery state.", lfhf))
            }
        }
        if data.rmssdFull > 0 && data.rmssdFull < 20 {
            parts.append("Low RMSSD (< 20 ms) indicates reduced vagal activity.")
        } else if data.rmssdFull > 50 {
            parts.append("High RMSSD (> 50 ms) reflects excellent parasympathetic function.")
        }
        return parts.joined(separator: " ")
    }

    private func rangeLabel(_ v: Double, _ t: [Double]) -> String {
        guard v > 0, t.count >= 3 else { return "--" }
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
        return "--"
    }

    private func ratingColor(_ r: String) -> UIColor {
        switch r {
        case "Excellent": return cSuccess
        case "Good":      return cCyan
        case "Fair":      return cWarning
        case "Poor":      return cDanger
        default:          return cTertiary
        }
    }
}
