import SwiftUI

// MARK: – Root container (tab-based page flow)
struct OnboardingView: View {
    let onComplete: () -> Void
    @State private var page = 0
    @AppStorage("userAge")      private var userAge      = 30
    @AppStorage("researchMode") private var researchMode = false

    var body: some View {
        TabView(selection: $page) {
            OnboardingWelcomePage().tag(0)
            OnboardingHRVPage().tag(1)
            OnboardingDevicePage().tag(2)
            OnboardingPersonalizePage(
                userAge: $userAge,
                researchMode: $researchMode,
                onComplete: onComplete
            ).tag(3)
        }
        .tabViewStyle(.page)
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .ignoresSafeArea()
    }
}

// MARK: – Page 1: Welcome
private struct OnboardingWelcomePage: View {
    @State private var pulse = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(hex: "#08080f"), Color(hex: "#12062a")],
                startPoint: .top, endPoint: .bottom
            ).ignoresSafeArea()

            VStack(spacing: 36) {
                Spacer()

                // Pulsing heart
                ZStack {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .stroke(Color(hex: "#6366f1").opacity(0.18 - Double(i) * 0.04),
                                    lineWidth: 1.5)
                            .frame(width: CGFloat(110 + i * 44),
                                   height: CGFloat(110 + i * 44))
                            .scaleEffect(pulse ? 1.12 : 1.0)
                            .animation(
                                .easeInOut(duration: 1.6)
                                    .repeatForever(autoreverses: true)
                                    .delay(Double(i) * 0.28),
                                value: pulse
                            )
                    }
                    Text("❤️")
                        .font(.system(size: 62))
                        .scaleEffect(pulse ? 1.1 : 0.92)
                        .animation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true),
                                   value: pulse)
                }
                .onAppear { pulse = true }

                VStack(spacing: 10) {
                    Text("CardioTrace")
                        .font(.system(size: 40, weight: .black, design: .rounded))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [Color(hex: "#6366f1"), Color(hex: "#ec4899"), Color(hex: "#22d3ee")],
                                startPoint: .leading, endPoint: .trailing
                            )
                        )
                    Text("Professional HRV analysis\nfor athletes and researchers")
                        .font(.title3)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                VStack(spacing: 10) {
                    OnboardingFeaturePill(icon: "waveform.path.ecg",
                                          text: "Real-time beat-to-beat analysis")
                    OnboardingFeaturePill(icon: "chart.bar.xaxis",
                                          text: "Stress Recovery Index (SRI)")
                    OnboardingFeaturePill(icon: "doc.richtext",
                                          text: "Clinical-grade PDF reports")
                    OnboardingFeaturePill(icon: "chart.xyaxis.line",
                                          text: "Frequency domain spectral analysis")
                }

                Spacer()

                Text("Swipe to continue →")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 52)
            }
            .padding(.horizontal, 30)
        }
    }
}

// MARK: – Page 2: What is HRV?
private struct OnboardingHRVPage: View {
    var body: some View {
        ZStack {
            Color(.systemGroupedBackground).ignoresSafeArea()
            ScrollView {
                VStack(spacing: 22) {
                    Spacer().frame(height: 56)
                    VStack(spacing: 8) {
                        Text("📊").font(.system(size: 52))
                        Text("What is HRV?")
                            .font(.system(size: 30, weight: .black, design: .rounded))
                        Text("Heart Rate Variability")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    OnboardingExplainerCard(icon: "❤️", title: "Beat-to-beat variation",
                        body: "Your heart doesn't beat at perfectly regular intervals — and that's healthy. The variation between beats reflects how well your autonomic nervous system is functioning.")
                    OnboardingExplainerCard(icon: "🧠", title: "Autonomic nervous system balance",
                        body: "HRV reflects the balance between sympathetic (fight-or-flight) and parasympathetic (rest-and-digest) branches. Higher HRV generally indicates better recovery capacity.")
                    OnboardingExplainerCard(icon: "📈", title: "Why it matters",
                        body: "Low HRV correlates with stress, fatigue, and overtraining. High HRV indicates cardiovascular fitness and autonomic resilience. Trends over days matter more than single readings.")
                    OnboardingExplainerCard(icon: "🔬", title: "Key metrics",
                        body: "RMSSD measures short-term parasympathetic activity. LF/HF ratio reflects sympathovagal balance. The SRI combines these into a single 0–100 recovery score.")
                    Spacer().frame(height: 56)
                }
                .padding(.horizontal, 22)
            }
        }
    }
}

// MARK: – Page 3: Device setup
private struct OnboardingDevicePage: View {
    private let steps: [(String, String, String)] = [
        ("drop.fill",            "Wet the electrodes",
         "Moisten the inside of the strap before putting it on — this ensures good skin contact."),
        ("figure.arms.open",     "Position the strap",
         "Place it directly below the pectoral muscles, snug but comfortable."),
        ("wave.3.right",         "Tap Connect in the app",
         "Go to the Monitor tab and tap 'Connect Device'. The app scans for nearby HR monitors."),
        ("antenna.radiowaves.left.and.right", "Wait for calibration",
         "The first 8 seconds are a calibration window — data collection begins automatically after."),
    ]

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground).ignoresSafeArea()
            ScrollView {
                VStack(spacing: 20) {
                    Spacer().frame(height: 56)
                    VStack(spacing: 8) {
                        Text("📡").font(.system(size: 52))
                        Text("Connect your device")
                            .font(.system(size: 28, weight: .black, design: .rounded))
                        Text("Polar H10 chest strap recommended")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                        OnboardingStepRow(number: idx + 1, icon: step.0,
                                          title: step.1, detail: step.2)
                    }
                    Text("Any Bluetooth HR monitor broadcasting RR interval data is supported, including Polar H9, Garmin HRM-Pro, and compatible chest straps.")
                        .font(.caption).foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center).padding(.horizontal)
                    Spacer().frame(height: 56)
                }
                .padding(.horizontal, 22)
            }
        }
    }
}

// MARK: – Page 4: Personalize
private struct OnboardingPersonalizePage: View {
    @Binding var userAge: Int
    @Binding var researchMode: Bool
    let onComplete: () -> Void

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground).ignoresSafeArea()
            ScrollView {
                VStack(spacing: 24) {
                    Spacer().frame(height: 56)
                    VStack(spacing: 8) {
                        Text("⚙️").font(.system(size: 52))
                        Text("Personalize")
                            .font(.system(size: 30, weight: .black, design: .rounded))
                        Text("You can change these later in Settings")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }

                    // Age picker
                    VStack(alignment: .leading, spacing: 14) {
                        Label("Your Age", systemImage: "person.circle")
                            .font(.headline.weight(.bold))
                        Text("Used to calculate accurate maximum HR and training zones.")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(userAge)")
                                .font(.system(size: 36, weight: .black, design: .rounded))
                                .foregroundStyle(Color(hex: "#6366f1"))
                            Text("years · Est. max HR \(220 - userAge) bpm")
                                .font(.caption).foregroundStyle(.tertiary)
                        }
                        Slider(value: Binding(get: { Double(userAge) },
                                              set: { userAge = Int($0) }),
                               in: 18...80, step: 1)
                        .tint(Color(hex: "#6366f1"))
                    }
                    .padding(16)
                    .background(.regularMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                    // Mode selection
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Usage Mode", systemImage: "flask")
                            .font(.headline.weight(.bold))
                        OnboardingModeCard(
                            selected: !researchMode, icon: "❤️",
                            title: "Personal Monitoring",
                            description: "Clear interpretations and simplified metrics. Best for wellness and self-tracking."
                        ) { researchMode = false }
                        OnboardingModeCard(
                            selected: researchMode, icon: "🔬",
                            title: "Research Mode",
                            description: "Extended metrics (SD1, SD2, pNN50, sympathovagal chart), higher decimal precision, and full CSV metadata."
                        ) { researchMode = true }
                    }
                    .padding(16)
                    .background(.regularMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                    Button(action: onComplete) {
                        Text("Get Started")
                            .font(.headline.weight(.bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .background(
                                LinearGradient(
                                    colors: [Color(hex: "#6366f1"), Color(hex: "#ec4899")],
                                    startPoint: .leading, endPoint: .trailing
                                )
                            )
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                    Spacer().frame(height: 40)
                }
                .padding(.horizontal, 22)
            }
        }
    }
}

// MARK: – Shared sub-views
private struct OnboardingFeaturePill: View {
    let icon: String; let text: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(Color(hex: "#6366f1")).frame(width: 22)
            Text(text).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
            Spacer()
        }
        .padding(.horizontal, 18).padding(.vertical, 13)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct OnboardingExplainerCard: View {
    let icon: String; let title: String; let body: String
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(icon).font(.title2)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline.weight(.bold))
                Text(body).font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

private struct OnboardingStepRow: View {
    let number: Int; let icon: String; let title: String; let detail: String
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                Circle().fill(Color(hex: "#6366f1")).frame(width: 32, height: 32)
                Text("\(number)").font(.system(size: 14, weight: .black)).foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: icon).foregroundStyle(Color(hex: "#6366f1")).font(.caption)
                    Text(title).font(.subheadline.weight(.bold))
                }
                Text(detail).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(14).background(.regularMaterial).clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct OnboardingModeCard: View {
    let selected: Bool; let icon: String; let title: String
    let description: String; let onSelect: () -> Void
    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .top, spacing: 12) {
                Text(icon).font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.subheadline.weight(.bold)).foregroundStyle(.primary)
                    Text(description).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color(hex: "#6366f1") : .secondary)
                    .font(.title3)
            }
            .padding(14)
            .background(selected ? Color(hex: "#6366f1").opacity(0.1) : Color.secondary.opacity(0.06))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .stroke(selected ? Color(hex: "#6366f1") : Color.clear, lineWidth: 2))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}
