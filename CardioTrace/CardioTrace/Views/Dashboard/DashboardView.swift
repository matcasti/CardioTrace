import SwiftUI

// MARK: – Root dashboard
struct DashboardView: View {
    @EnvironmentObject var vm: SessionViewModel
    @State private var showEventSheet  = false
    @State private var showExportSheet = false
    @State private var showSRIInfo     = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if vm.isCalibrating {
                        CalibrationBanner(progress: vm.calibrationProgress)
                    }
                    ConnectionCard(showExport: $showExportSheet)
                    StatsGridView()
                    SRISectionView(showInfo: $showSRIInfo)
                    if vm.isConnected {
                        RecordingCard(showEventSheet: $showEventSheet)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 32)
            }
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
            .navigationTitle("❤️ CardioTrace")
            .navigationBarTitleDisplayMode(.large)
            .sheet(isPresented: $showEventSheet) {
                EventMarkerSheet().environmentObject(vm)
            }
            .sheet(isPresented: $showExportSheet) {
                ExportSheet().environmentObject(vm)
            }
            .sheet(isPresented: $showSRIInfo) {
                SRIInfoSheet()
            }
            .sheet(isPresented: $vm.showDevicePicker) {
                DevicePickerSheet().environmentObject(vm)
            }
        }
    }
}

// MARK: – Calibration banner
struct CalibrationBanner: View {
    let progress: Double

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .symbolEffect(.variableColor.iterative)
                Text("Calibrating sensor…")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(Int(progress * 8))s / 8s")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: progress)
                .tint(Color(hex: "#f59e0b"))
        }
        .padding()
        .background(Color(hex: "#f59e0b").opacity(0.12))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(hex: "#f59e0b").opacity(0.35), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: – Connection card
struct ConnectionCard: View {
    @EnvironmentObject var vm: SessionViewModel
    @Binding var showExport: Bool

    var body: some View {
        VStack(spacing: 14) {
            HStack {
                Label("Connection", systemImage: "antenna.radiowaves.left.and.right")
                    .font(.headline.weight(.bold))
                Spacer()
                if vm.isConnected { SignalBadge(quality: vm.signalQuality) }
            }

            HStack(spacing: 10) {
                ConnectionStatusBadge(state: vm.connectionState)
                if vm.batteryLevel > 0 { BatteryView(level: vm.batteryLevel) }
                if vm.isConnected      { HRZoneBadge(zone: vm.hrZone) }
                Spacer()
            }

            HStack(spacing: 10) {
                if !vm.isConnected {
                    Button { vm.connect() } label: {
                        Label("Connect Device", systemImage: "wave.3.right")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(hex: "#6366f1"))
                } else {
                    Button(role: .destructive) { vm.disconnect() } label: {
                        Label("Disconnect", systemImage: "xmark.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button { showExport = true } label: {
                        Label("Export", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(Color(hex: "#6366f1"))
                }
            }

            if vm.isConnected {
                HStack {
                    Text("Data Quality")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(String(format: "%.1f%%", vm.dataQuality))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(qualityColor(vm.dataQuality))
                }
                .padding(10)
                .background(.thinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding()
        .background(.ultraThinMaterial)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    private func qualityColor(_ q: Double) -> Color {
        q >= 95 ? Color(hex: "#10b981") : q >= 80 ? Color(hex: "#f59e0b") : Color(hex: "#ef4444")
    }
}

// MARK: – Connection status badge
struct ConnectionStatusBadge: View {
    let state: ConnectionState

    private var color: Color {
        switch state {
        case .connected:             return Color(hex: "#22d3ee")
        case .calibrating:           return Color(hex: "#f59e0b")
        case .scanning, .connecting: return Color(hex: "#6366f1")
        default:                     return .secondary
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 9, height: 9)
            Text(state.displayLabel)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
    }
}

// MARK: – Signal bars badge
struct SignalBadge: View {
    let quality: SignalQuality

    private var color: Color {
        switch quality {
        case .excellent: return Color(hex: "#10b981")
        case .good:      return Color(hex: "#22d3ee")
        case .fair:      return Color(hex: "#f59e0b")
        case .poor:      return Color(hex: "#ef4444")
        default:         return .secondary
        }
    }
    private func active(_ i: Int) -> Bool {
        switch quality {
        case .excellent: return true
        case .good:      return i <= 3
        case .fair:      return i <= 2
        case .poor:      return i <= 1
        default:         return false
        }
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(1...4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(active(i) ? color : Color.secondary.opacity(0.2))
                    .frame(width: 3, height: CGFloat(i) * 4 + 2)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(color.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: – Battery inline widget
struct BatteryView: View {
    let level: Int
    private var color: Color { level <= 20 ? Color(hex: "#ef4444") : Color(hex: "#10b981") }

    var body: some View {
        HStack(spacing: 4) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2).stroke(.secondary, lineWidth: 1)
                    .frame(width: 22, height: 11)
                RoundedRectangle(cornerRadius: 1).fill(color)
                    .frame(width: max(2, 20 * CGFloat(level) / 100), height: 9)
                    .padding(.leading, 1)
            }
            Text("\(level)%").font(.caption2.weight(.semibold)).foregroundStyle(color)
        }
    }
}

// MARK: – HR zone pill
struct HRZoneBadge: View {
    let zone: HRZone
    var body: some View {
        Text(zone.rawValue)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Color(hex: zone.colorHex).opacity(0.15))
            .foregroundStyle(Color(hex: zone.colorHex))
            .clipShape(Capsule())
    }
}

// MARK: – 2×2 stats grid
struct StatsGridView: View {
    @EnvironmentObject var vm: SessionViewModel

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
            StatCard(label: "Heart Rate",
                     value: vm.heartRate > 0 ? "\(vm.heartRate)" : "--",
                     unit: "BPM", gradient: ["#6366f1", "#ec4899"],
                     isActive: vm.isConnected)

            StatCard(label: "RMSSD (1 min)",
                     value: vm.rmssd > 0 ? String(format: "%.1f", vm.rmssd) : "--",
                     unit: "ms", gradient: ["#ec4899", "#f97316"])

            StatCard(label: "RR Intervals",
                     value: "\(vm.rrIntervals.count)",
                     unit: "", gradient: ["#22d3ee", "#6366f1"])

            StatCard(label: "Avg RR (1 min)",
                     value: vm.avgRR > 0 ? String(format: "%.1f", vm.avgRR) : "--",
                     unit: "ms", gradient: ["#10b981", "#22d3ee"])
        }
    }
}

struct StatCard: View {
    let label:    String
    let value:    String
    let unit:     String
    let gradient: [String]
    var isActive: Bool = false   // enables pulsing glow (used for the live HR card)

    @State private var glowing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.caption.weight(.bold)).textCase(.uppercase).kerning(0.5)
                .foregroundStyle(.secondary)

            HStack(alignment: .lastTextBaseline, spacing: 3) {
                Text(value)
                    .font(.system(size: 34, weight: .black, design: .rounded))
                    .foregroundStyle(LinearGradient(
                        colors: gradient.map { Color(hex: $0) },
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                    .contentTransition(.numericText())
                    .animation(.spring(duration: 0.4), value: value)
                if !unit.isEmpty {
                    Text(unit).font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.ultraThinMaterial)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 20))
        // Pulsing glow halo when actively recording
        .shadow(
            color: isActive ? Color(hex: gradient[0]).opacity(glowing ? 0.55 : 0.10) : .clear,
            radius: glowing ? 18 : 4,
            x: 0, y: 0
        )
        .animation(
            isActive ? .easeInOut(duration: 1.2).repeatForever(autoreverses: true) : .default,
            value: glowing
        )
        .onAppear   { glowing = isActive }
        .onChange(of: isActive) { _, active in glowing = active }
    }
}

// MARK: – SRI section
struct SRISectionView: View {
    @EnvironmentObject var vm: SessionViewModel
    @Binding var showInfo: Bool

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Stress Recovery Index").font(.headline.weight(.bold))
                    Text("Real-time autonomic balance").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { showInfo = true } label: {
                    Image(systemName: "info.circle").foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 20) {
                SRIGaugeView(score: vm.sriScore)
                    .frame(width: 150, height: 150)

                VStack(alignment: .leading, spacing: 8) {
                    SRIMetricRow(label: "RMSSD",
                                 value: vm.sriScore > 0 ? String(format: "%.1f ms", vm.sriComponents.rmssd) : "--")
                    SRIMetricRow(label: "LF/HF",
                                 value: vm.sriScore > 0 ? String(format: "%.2f", vm.sriComponents.lfhf) : "--")
                    SRIMetricRow(label: "HR Recovery",
                                 value: vm.sriScore > 0 ? String(format: "%.1f%%", vm.sriComponents.hrRecovery) : "--")
                }
                .frame(maxWidth: .infinity)
            }

            SRIStatusView(score: vm.sriScore)
        }
        .padding()
        .background(.ultraThinMaterial)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}

struct SRIMetricRow: View {
    let label: String; let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(.secondary)
            Text(value).font(.system(.body, design: .rounded, weight: .bold))
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial).clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: – Recording card
struct RecordingCard: View {
    @EnvironmentObject var vm: SessionViewModel
    @Binding var showEventSheet: Bool
    @State private var tagText  = ""
    @State private var recBlink = false   // drives the blinking REC dot

    var body: some View {
        VStack(spacing: 14) {
            HStack {
                Label("Recording", systemImage: "record.circle").font(.headline.weight(.bold))
                Spacer()
                // ── Blinking REC badge + monospaced timer ──
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color(hex: "#ef4444"))
                        .frame(width: 7, height: 7)
                        .opacity(recBlink ? 1 : 0.2)
                        .animation(
                            .easeInOut(duration: 0.75).repeatForever(autoreverses: true),
                            value: recBlink
                        )
                    Text(formattedTime(vm.recordingTime))
                        .font(.system(.subheadline, design: .monospaced, weight: .bold))
                        .foregroundStyle(Color(hex: "#ec4899"))
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Color(hex: "#ec4899").opacity(0.10))
                .overlay(
                    Capsule().stroke(Color(hex: "#ec4899").opacity(0.30), lineWidth: 1)
                )
                .clipShape(Capsule())
            }
            .onAppear { recBlink = true }

            HStack(spacing: 10) {
                Button { showEventSheet = true } label: {
                    Label("Mark Event", systemImage: "mappin").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered).tint(Color(hex: "#22d3ee"))

                Button(role: .destructive) { vm.resetSession() } label: {
                    Label("Reset", systemImage: "arrow.counterclockwise").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }

            // Tag input
            HStack(spacing: 8) {
                TextField("Add session tag…", text: $tagText)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.done)
                    .onSubmit { commitTag() }
                Button("+ Tag", action: commitTag)
                    .buttonStyle(.bordered).tint(Color(hex: "#6366f1"))
            }

            if !vm.sessionTags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(vm.sessionTags, id: \.self) { tag in
                            TagChip(tag: tag) { vm.removeTag(tag) }
                        }
                    }
                }
            }

            TextField("Session name…", text: $vm.sessionFilename)
                .textFieldStyle(.roundedBorder)
        }
        .padding()
        .background(.ultraThinMaterial)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    private func commitTag() {
        let t = tagText.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        vm.addTag(t); tagText = ""
    }

    private func formattedTime(_ s: Double) -> String {
        String(format: "⏱ %02d:%02d", Int(s) / 60, Int(s) % 60)
    }
}

struct TagChip: View {
    let tag: String; let onRemove: () -> Void
    var body: some View {
        HStack(spacing: 4) {
            Text(tag).font(.caption.weight(.semibold))
            Button(action: onRemove) { Image(systemName: "xmark").font(.caption2) }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Color(hex: "#6366f1").opacity(0.15))
        .foregroundStyle(Color(hex: "#6366f1"))
        .clipShape(Capsule())
    }
}

// MARK: – Event marker sheet
struct EventMarkerSheet: View {
    @EnvironmentObject var vm: SessionViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var annotation = ""

    private let eventTypes: [(String, String)] = [
        ("Start","🏁"),("Exercise","💪"),("Rest","😌"),("Peak","⚡"),
        ("Recovery","🔄"),("Breathe","🫁"),("Note","📝"),("Custom","✨")
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Select Event Type")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 10) {
                        ForEach(eventTypes, id: \.0) { type, icon in
                            let selected = vm.selectedEventType == type
                            Button { vm.selectedEventType = type } label: {
                                VStack(spacing: 4) {
                                    Text(icon).font(.title2)
                                    Text(type).font(.caption2.weight(.semibold))
                                }
                                .frame(maxWidth: .infinity).padding(.vertical, 10)
                                .background(selected ? Color(hex: "#6366f1").opacity(0.2) : Color.secondary.opacity(0.08))
                                .overlay(RoundedRectangle(cornerRadius: 12)
                                    .stroke(selected ? Color(hex: "#6366f1") : Color.clear, lineWidth: 2))
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                            }
                            .foregroundStyle(selected ? Color(hex: "#6366f1") : .primary)
                        }
                    }

                    HStack(spacing: 10) {
                        TextField("Add note (optional)…", text: $annotation)
                            .textFieldStyle(.roundedBorder)
                        Button("Add") {
                            vm.addEventMarker(annotation: annotation)
                            annotation = ""
                            dismiss()
                        }
                        .buttonStyle(.borderedProminent).tint(Color(hex: "#6366f1"))
                    }

                    if !vm.eventMarkers.isEmpty {
                        Divider()
                        Text("Recent Events")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(vm.eventMarkers.suffix(5).reversed()) { marker in
                            HStack {
                                Text(String(format: "%.1fs", marker.time))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(Color(hex: "#22d3ee"))
                                Text(marker.label).font(.caption)
                                Spacer()
                                Button {
                                    vm.eventMarkers.removeAll { $0.id == marker.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                }
                            }
                            .padding(10).background(.thinMaterial)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Mark Event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: – Export sheet
struct ExportSheet: View {
    @EnvironmentObject var vm: SessionViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var includeRaw = false
    @State private var rrOnly     = false
    @State private var shareURL: URL?
    @State private var isGeneratingReport = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Format") {
                    Toggle("RR intervals only (.txt)", isOn: $rrOnly)
                    Toggle("Include raw (uncleaned) data", isOn: $includeRaw).disabled(rrOnly)
                }
                Section {
                    Button {
                        shareURL = writeToTemp()
                    } label: {
                        Label("Share / Save File", systemImage: "square.and.arrow.up")
                    }

                    Button {
                        UIPasteboard.general.string = rrOnly
                            ? vm.exportTXT(includeRaw: includeRaw)
                            : vm.exportCSV(includeRaw: includeRaw)
                        dismiss()
                    } label: {
                        Label("Copy to Clipboard", systemImage: "doc.on.clipboard")
                    }

                    Button {
                        isGeneratingReport = true
                        Task {
                            shareURL = await ReportGenerator.generate(vm: vm)
                            isGeneratingReport = false
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if isGeneratingReport {
                                ProgressView()
                            } else {
                                Label("Generate PDF Report", systemImage: "doc.richtext")
                            }
                        }
                    }
                    .disabled(isGeneratingReport || vm.rrIntervals.isEmpty)
                }
            }
            .navigationTitle("Export Data")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .sheet(item: $shareURL) { url in
                ShareSheet(items: [url])
            }
        }
        .presentationDetents([.medium])
    }

    private func writeToTemp() -> URL {
        let content = rrOnly ? vm.exportTXT(includeRaw: includeRaw) : vm.exportCSV(includeRaw: includeRaw)
        let ext  = rrOnly ? "txt" : "csv"
        let name = (vm.sessionFilename.isEmpty ? "polar-h10-data" : vm.sessionFilename) + ".\(ext)"
        let url  = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try? content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}

extension URL: @retroactive Identifiable { public var id: String { absoluteString } }

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

// MARK: – SRI info sheet (stub — Sprint 3 expands)
struct SRIInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Group {
                        SRIInfoBlock(title: "What is SRI?",
                            content: "The Stress Recovery Index (SRI) is a composite score (0–100) that quantifies your autonomic nervous system balance and recovery capacity. Higher scores indicate better stress resilience and parasympathetic activity.")
                        SRIInfoBlock(title: "Components",
                            content: "35% RMSSD · 35% LF/HF Ratio · 30% HR Recovery Rate")
                        SRIInfoBlock(title: "Interpretation",
                            content: "75–100 Excellent · 55–74 Good · 35–54 Fair · 0–34 Poor")
                    }
                    .padding(.horizontal)
                }
                .padding(.vertical)
            }
            .navigationTitle("About SRI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

struct SRIInfoBlock: View {
    let title: String; let content: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline.weight(.bold))
            Text(content).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

struct DevicePickerSheet: View {
    @EnvironmentObject var vm: SessionViewModel

    var body: some View {
        NavigationStack {
            List {
                if vm.discoveredDevices.isEmpty {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Scanning for Polar devices…")
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(vm.discoveredDevices) { device in
                        Button {
                            vm.selectDevice(device)
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: "sensor.fill")
                                    .font(.title3)
                                    .foregroundStyle(Color(hex: "#6366f1"))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(device.name)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    Text(device.id.uuidString.prefix(8).uppercased())
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
            .navigationTitle("Select Device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { vm.cancelConnect() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
