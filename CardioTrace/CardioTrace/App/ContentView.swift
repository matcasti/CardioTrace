//
//  ContentView.swift
//  CardioTrace
//
//  Created by Matías Castillo Aguilar on 03-05-26.
//

import SwiftUI
import SwiftData

struct ContentView: View {
    @EnvironmentObject var vm: SessionViewModel
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Monitor", systemImage: "heart.fill") }

            ChartsView()
                .tabItem { Label("Charts", systemImage: "waveform.path.ecg") }

            HistoryView()
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
        }
        .tint(Color(hex: "#6366f1"))
        .onAppear { vm.modelContext = modelContext }
    }
}
