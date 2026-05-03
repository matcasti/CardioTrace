//
//  CardioTraceApp.swift
//  CardioTrace
//
//  Created by Matías Castillo Aguilar on 03-05-26.
//

import SwiftUI
import SwiftData

@main
struct CardioTraceApp: App {
    @StateObject private var vm = SessionViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vm)
        }
        .modelContainer(for: HRVSession.self)
    }
}
