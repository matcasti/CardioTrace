import SwiftUI
import SwiftData

@main
struct CardioTraceApp: App {
    @StateObject private var vm = SessionViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vm)
                .onAppear {
                    NotificationManager.shared.requestPermission()
                }
        }
        .modelContainer(for: HRVSession.self)
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .background:
                vm.handleBackground()
            case .active:
                vm.handleForeground()
            default:
                break
            }
        }
    }
}
