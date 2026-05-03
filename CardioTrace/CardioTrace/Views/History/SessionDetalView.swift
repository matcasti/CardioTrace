//
//  SessionDetalView.swift
//  CardioTrace
//
//  Created by Matías Castillo Aguilar on 03-05-26.
//

import SwiftUI
import SwiftData

// MARK: – Full session detail screen
struct SessionDetailView: View {
    let session: HRVSession

    @EnvironmentObject var vm: SessionViewModel
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss

    @State private var showRestoreConfirm = false
    @State private var showDeleteConfirm  = false
    @State private var showShareSheet     = false
    @State private var shareURL:  URL?
    @State private var exportRROnly       = false
    @State private var exportIncludeRaw   = false
    @State private var isRenaming         = false
    @State private var renameText         = ""
    @State private var reportURL:         URL?
    @State private var showReportSheet    = false
    @State private var isGeneratingReport = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                headerCard
                sriCard
                timeDomainCard
                frequencyCard
                if !session.eventMarkers.isEmpty { eventsCard }
                if !session.tags.isEmpty { tagsCard }
                exportCard
                dangerCard
            }
            .padding(.horizontal)
            .padding(.bottom, 32)
        }
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
        .navigationTitle(session.filename)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarItems }
        .sheet(isPresented: $showShareSheet) {
                    if let url = shareURL { ShareSheet(items: [url]) }
        }
        .sheet(isPresented: $showReportSheet) {
            if let url = reportURL { ShareSheet(items: [url]) }
        }
        .alert("Rename Session", isPresented: $isRenaming) {
            TextField("Name", text: $renameText)
            Button("Save") { commitRename() }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Restore Session",
                            isPresented: $showRestoreConfirm,
                            titleVisibility: .visible) {
            Button("Restore", role: .none) { restoreAndPop() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will replace your current live data with this session.")
        }
        .confirmationDialog("Delete Session",
                            isPresented: $showDeleteConfirm,
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) { deleteAndPop() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This action cannot be undone.")
        }
    }

    // MARK: – Cards

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Session Info", systemImage: "info.circle")
                .font(.headline.weight(.bold))

            DetailRow(label: "Date",
                      value: session.createdAt.formatted(
                        date: .long, time: .shortened))
            DetailRow(label: "Duration",  value: formatDuration(session.duration))
            DetailRow(label: "Samples",   value: "\(session.sampleCount) intervals")
            DetailRow(label: "Raw",       value: "\(session.rawRRIntervals.count) intervals")
            DetailRow(label: "Quality",   value: String(format: "%.1f%%", session.dataQuality),
                      valueColor: qualityColor(session.dataQuality))
            DetailRow(label: "Events",    value: "\(session.eventMarkers.count)")
        }
        .cardStyle()
    }

    private var sriCard: some View {
        VStack(spacing: 16) {
            Label("Stress Recovery Index", systemImage: "chart.bar.xaxis")
                .font(.headline.weight(.bold))
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 24) {
                SRIGaugeView(score: session.sriScore)
                    .frame(width: 130, height: 130)

                VStack(alignment: .leading, spacing: 10) {
                    SRIMetricRow(label: "RMSSD",
                                 value: session.rmssd > 0
                                    ? String(format: "%.1f ms", session.sriComponentRMSSD) : "--")
                    SRIMetricRow(label: "LF/HF",
                                 value: session.sriComponentLFHF > 0
                                    ? String(format: "%.2f", session.sriComponentLFHF) : "--")
                    SRIMetricRow(label: "HR Recovery",
                                 value: session.sriComponentHRRecovery > 0
                                    ? String(format: "%.1f%%", session.sriComponentHRRecovery) : "--")
                }
                .frame(maxWidth: .infinity)
            }

            SRIStatusView(score: session.sriScore)
        }
        .cardStyle()
    }

    private var timeDomainCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Time Domain", systemImage: "clock")
                .font(.headline.weight(.bold))

            let rr = session.rrIntervals
            let meanRR  = rr.isEmpty ? 0.0 : rr.reduce(0, +) / Double(rr.count)
            let avgHR   = meanRR > 0 ? 60000 / meanRR : 0
            let sdnn    = HRVEngine.shared.calculateSDNN(rr)
            let rmssd   = HRVEngine.shared.calculateRMSSD(rr)
            let pnn50   = HRVEngine.shared.calculatePNN50(rr)

            DetailRow(label: "Mean RR",  value: String(format: "%.1f ms", meanRR))
            DetailRow(label: "Avg HR",   value: String(format: "%.0f bpm", avgHR))
            DetailRow(label: "SDNN",     value: String(format: "%.1f ms", sdnn))
            DetailRow(label: "RMSSD",    value: String(format: "%.1f ms", rmssd))
            DetailRow(label: "pNN50",    value: String(format: "%.1f%%", pnn50))
            DetailRow(label: "Peak HR",  value: session.peakHR > 0
                ? String(format: "%.0f bpm", session.peakHR) : "--")
        }
        .cardStyle()
    }

    private var frequencyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Frequency Domain", systemImage: "waveform")
                .font(.headline.weight(.bold))

            // Recalculate on the fly from stored intervals
            let psd = HRVEngine.shared.calculatePSD(
                rr: session.rrIntervals,
                times: session.timestamps)

            if let psd = psd {
                let total = max(psd.totalPower, 1)
                DetailRow(label: "VLF",
                          value: String(format: "%.1f ms² (%.0f%%)",
                                        psd.vlfPower, psd.vlfPower/total*100))
                DetailRow(label: "LF",
                          value: String(format: "%.1f ms² (%.0f%%)",
                                        psd.lfPower, psd.lfPower/total*100))
                DetailRow(label: "HF",
                          value: String(format: "%.1f ms² (%.0f%%)",
                                        psd.hfPower, psd.hfPower/total*100))
                DetailRow(label: "Total Power",
                          value: String(format: "%.1f ms²", psd.totalPower))
                DetailRow(label: "LF/HF",
                          value: String(format: "%.2f", psd.lfhfRatio))
            } else {
                Text("Insufficient data for frequency analysis\n(need ≥ 50 intervals)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cardStyle()
    }

    private var eventsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Events (\(session.eventMarkers.count))", systemImage: "mappin.circle")
                .font(.headline.weight(.bold))

            ForEach(session.eventMarkers) { marker in
                HStack(spacing: 10) {
                    Text(String(format: "%.1fs", marker.time))
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(Color(hex: "#22d3ee"))
                        .frame(width: 52, alignment: .trailing)

                    Text(marker.label)
                        .font(.subheadline)
                        .foregroundStyle(.primary)

                    Spacer()
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
                .background(Color.secondary.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .cardStyle()
    }

    private var tagsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Tags", systemImage: "tag")
                .font(.headline.weight(.bold))

            FlowLayout(spacing: 8) {
                ForEach(session.tags, id: \.self) { tag in
                    Text(tag)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Color(hex: "#6366f1").opacity(0.15))
                        .foregroundStyle(Color(hex: "#6366f1"))
                        .clipShape(Capsule())
                }
            }
        }
        .cardStyle()
    }

    private var exportCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Export", systemImage: "square.and.arrow.up")
                .font(.headline.weight(.bold))

            Toggle("RR only (.txt)", isOn: $exportRROnly)
            Toggle("Include raw data", isOn: $exportIncludeRaw).disabled(exportRROnly)

            HStack(spacing: 10) {
                    Button {
                        shareURL = buildExportFile()
                        showShareSheet = true
                    } label: {
                        Label("Share File", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(hex: "#6366f1"))

                    Button {
                        UIPasteboard.general.string = buildExportString()
                    } label: {
                        Label("Copy", systemImage: "doc.on.clipboard")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(Color(hex: "#6366f1"))
                }

                Button {
                    isGeneratingReport = true
                    Task {
                        reportURL = await ReportGenerator.generate(session: session)
                        isGeneratingReport = false
                        showReportSheet = reportURL != nil
                    }
                } label: {
                    HStack(spacing: 8) {
                        if isGeneratingReport {
                            ProgressView().tint(.white)
                            Text("Building Report…")
                        } else {
                            Label("Generate PDF Report", systemImage: "doc.richtext")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(hex: "#10b981"))
                .disabled(isGeneratingReport || session.rrIntervals.isEmpty)
            }
            .cardStyle()
    }

    private var dangerCard: some View {
        VStack(spacing: 10) {
            Button {
                showRestoreConfirm = true
            } label: {
                Label("Restore to Dashboard", systemImage: "arrow.counterclockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(hex: "#6366f1"))

            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                Label("Delete Session", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .cardStyle()
    }

    // MARK: – Toolbar

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    renameText = session.filename
                    isRenaming = true
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Button {
                    showRestoreConfirm = true
                } label: {
                    Label("Restore", systemImage: "arrow.counterclockwise")
                }
                Divider()
                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    // MARK: – Actions

    private func commitRename() {
        let name = renameText.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        session.filename = name
        try? modelContext.save()
    }

    private func restoreAndPop() {
        vm.restoreSession(session)
        dismiss()
    }

    private func deleteAndPop() {
        modelContext.delete(session)
        try? modelContext.save()
        dismiss()
    }

    private func buildExportString() -> String {
        let rr = exportIncludeRaw ? session.rawRRIntervals : session.rrIntervals
        let ts = exportIncludeRaw ? session.rawTimestamps  : session.timestamps
        if exportRROnly { return rr.map { String(format: "%.3f", $0) }.joined(separator: "\n") }
        var csv = "Timestamp (s),RR Interval (ms),Event Type,Annotation\n"
        for i in 0..<rr.count {
            let ev = session.eventMarkers.first { abs($0.time - ts[i]) < 0.5 }
            csv += "\(String(format: "%.3f", ts[i])),\(String(format: "%.3f", rr[i])),\(ev?.type ?? ""),\(ev?.annotation ?? "")\n"
        }
        return csv
    }

    private func buildExportFile() -> URL {
        let content = buildExportString()
        let ext  = exportRROnly ? "txt" : "csv"
        let name = "\(session.filename).\(ext)"
        let url  = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try? content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    // MARK: – Helpers

    private func formatDuration(_ s: Double) -> String {
        let t = Int(s)
        if t >= 3600 { return "\(t/3600)h \((t%3600)/60)m" }
        if t >= 60   { return "\(t/60)m \(t%60)s" }
        return "\(t)s"
    }

    private func qualityColor(_ q: Double) -> Color {
        q >= 95 ? Color(hex: "#10b981") : q >= 80 ? Color(hex: "#f59e0b") : Color(hex: "#ef4444")
    }
}

// MARK: – Detail row
struct DetailRow: View {
    let label:      String
    let value:      String
    var valueColor: Color = .primary

    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(valueColor)
        }
        .padding(.vertical, 3)
    }
}

// MARK: – Flow layout for tags (iOS 16+)
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var height: CGFloat = 0; var x: CGFloat = 0; var rowH: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { height += rowH + spacing; x = 0; rowH = 0 }
            x += size.width + spacing; rowH = max(rowH, size.height)
        }
        return CGSize(width: width, height: height + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX; var y = bounds.minY; var rowH: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX { y += rowH + spacing; x = bounds.minX; rowH = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; rowH = max(rowH, size.height)
        }
    }
}

// MARK: – Card style modifier
private extension View {
    func cardStyle() -> some View {
        self
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}
