import SwiftUI

struct SettingsView: View {
    @AppStorage("userAge")               private var userAge               = 30
    @AppStorage("researchMode")          private var researchMode          = false
    @AppStorage("calibrationDuration")   private var calibrationDuration   = 8
    @AppStorage("showRawDataByDefault")  private var showRawDataByDefault  = false
    @AppStorage("hasCompletedOnboarding") private var hasCompletedOnboarding = true

    @State private var showResetConfirm = false

    var body: some View {
        NavigationStack {
            Form {

                // MARK: Profile
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Your Age", systemImage: "person.circle")
                            .font(.subheadline.weight(.semibold))
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(userAge)")
                                .font(.system(size: 32, weight: .black, design: .rounded))
                                .foregroundStyle(Color(hex: "#6366f1"))
                            Text("years")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Slider(value: Binding(get: { Double(userAge) },
                                              set: { userAge = Int($0) }),
                               in: 18...80, step: 1)
                        .tint(Color(hex: "#6366f1"))
                        Text("Estimated max HR: \(220 - userAge) bpm · Used for HR zone calculation")
                            .font(.caption).foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 4)
                } header: { Text("Profile") }

                // MARK: Usage mode
                Section {
                    Toggle(isOn: $researchMode) {
                        VStack(alignment: .leading, spacing: 3) {
                            Label("Research Mode", systemImage: "flask")
                            Text("Extended metrics, higher precision, full export metadata")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .tint(Color(hex: "#6366f1"))

                    if researchMode {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Enabled in research mode:")
                                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            ForEach(researchFeatureList, id: \.self) { f in
                                Label(f, systemImage: "checkmark")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } header: { Text("Usage Mode") }
                  footer: { Text("Research Mode adds SD1/SD2 Poincaré metrics, sympathovagal proxy chart, and RMSSD/SDNN ratio plots to the Charts tab.") }

                // MARK: Recording
                Section {
                    Picker("Calibration Duration", selection: $calibrationDuration) {
                        Text("8 seconds (default)").tag(8)
                        Text("15 seconds").tag(15)
                        Text("30 seconds (clinical)").tag(30)
                    }
                    Toggle(isOn: $showRawDataByDefault) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Include Raw Data by Default")
                            Text("Pre-selects 'Include raw data' in the export sheet")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .tint(Color(hex: "#6366f1"))
                } header: { Text("Recording") }
                  footer: { Text("Longer calibration periods improve baseline accuracy, particularly in clinical or research contexts.") }

                // MARK: HRV reference
                Section {
                    ForEach(referenceRows, id: \.0) { label, value, hex in
                        HStack {
                            Circle().fill(Color(hex: hex)).frame(width: 8, height: 8)
                            Text(label)
                            Spacer()
                            Text(value).foregroundStyle(.secondary).font(.subheadline.weight(.semibold))
                        }
                    }
                } header: { Text("RMSSD Reference Ranges") }
                  footer: { Text("Based on ESC Task Force guidelines (1996). Individual baselines vary significantly with age, sex, and training status.") }

                // MARK: About
                Section {
                    LabeledContent("Version",
                                   value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                    Button("Replay Onboarding") { showResetConfirm = true }
                        .foregroundStyle(Color(hex: "#6366f1"))
                    Link("ESC HRV Standards (1996)",
                         destination: URL(string: "https://doi.org/10.1161/01.CIR.93.5.1043/")!)
                    Link("Polar H10 Setup Guide",
                         destination: URL(string: "https://www.polar.com/en/sensors/h10-heart-rate-sensor")!)
                } header: { Text("About") }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .confirmationDialog("Replay onboarding?",
                                isPresented: $showResetConfirm,
                                titleVisibility: .visible) {
                Button("Replay") { hasCompletedOnboarding = false }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private var researchFeatureList: [String] {[
        "SD1 / SD2 Poincaré metrics",
        "Sympathovagal proxy chart",
        "RMSSD / SDNN ratio over time",
        "pNN50, SDNN in session detail",
        "Full metadata in CSV exports",
    ]}

    private var referenceRows: [(String, String, String)] {[
        ("Excellent", "> 50 ms",  "#10b981"),
        ("Good",      "30–50 ms", "#22d3ee"),
        ("Fair",      "20–30 ms", "#f59e0b"),
        ("Poor",      "< 20 ms",  "#ef4444"),
    ]}
}
