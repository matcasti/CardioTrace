import SwiftUI
import SwiftData

@main
struct CardioTraceApp: App {
    @StateObject private var vm = SessionViewModel()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("hasCompletedOnboarding") private var hasCompletedOnboarding = false

    var body: some Scene {
        WindowGroup {
            // ADD: gate on onboarding
            if hasCompletedOnboarding {
                ContentView()
                    .environmentObject(vm)
                    .onAppear { NotificationManager.shared.requestPermission() }
            } else {
                OnboardingView { hasCompletedOnboarding = true }
            }
        }
        .modelContainer(for: HRVSession.self)
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .background: vm.handleBackground()
            case .active:     vm.handleForeground()
            default:          break
            }
        }
    }
}
