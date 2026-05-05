import SwiftUI
import SwiftData

// MARK: – Root history screen
struct HistoryView: View {
    @Query(sort: \HRVSession.createdAt, order: .reverse) private var sessions: [HRVSession]
    @EnvironmentObject var vm: SessionViewModel
    @Environment(\.modelContext) private var modelContext

    @State private var searchText   = ""
    @State private var selectedTag  = ""
    @State private var sortOrder    = SortOrder.newest
    @State private var selectedSession: HRVSession?
    @State private var sessionToRename: HRVSession? = nil
    @State private var renameText = ""

    enum SortOrder: String, CaseIterable, Identifiable {
        case newest   = "Newest First"
        case oldest   = "Oldest First"
        case longest  = "Longest Duration"
        case shortest = "Shortest Duration"
        var id: String { rawValue }
    }

    // All tags that appear in any session
    private var allTags: [String] {
        Array(Set(sessions.flatMap { $0.tags })).sorted()
    }

    private var filtered: [HRVSession] {
        var result = sessions

        if !searchText.isEmpty {
            result = result.filter {
                $0.filename.localizedCaseInsensitiveContains(searchText)
            }
        }
        if !selectedTag.isEmpty {
            result = result.filter { $0.tags.contains(selectedTag) }
        }
        switch sortOrder {
        case .newest:   break                             // @Query already newest-first
        case .oldest:   result = result.reversed()
        case .longest:  result = result.sorted { $0.duration > $1.duration }
        case .shortest: result = result.sorted { $0.duration < $1.duration }
        }
        return result
    }

    var body: some View {
        NavigationStack {
            Group {
                if sessions.isEmpty {
                    emptyState
                } else {
                    sessionList
                }
            }
            .navigationTitle("Session History")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $searchText, prompt: "Search sessions…")
            .toolbar { toolbarContent }
            .navigationDestination(item: $selectedSession) { session in
                SessionDetailView(session: session)
                    .environmentObject(vm)
            }
        }
    }

    // MARK: – Sub-views

    private var emptyState: some View {
        ContentUnavailableView(
            "No Sessions Yet",
            systemImage: "chart.line.uptrend.xyaxis",
            description: Text("Connect a Polar H10 and record a session\nto see it here.")
        )
    }

    private var sessionList: some View {
        ScrollView {
            // Tag filter strip
            if !allTags.isEmpty {
                tagStrip
                    .padding(.horizontal)
                    .padding(.top, 4)
            }

            // Session count
            HStack {
                Text("\(filtered.count) session\(filtered.count == 1 ? "" : "s")")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal)
            .padding(.top, 8)

            // Cards
            LazyVStack(spacing: 12) {
                ForEach(filtered) { session in
                    SessionCardView(session: session) {
                        delete(session)
                    } onRename: {
                        renameText = session.filename
                        sessionToRename = session
                    }
                        .onTapGesture { selectedSession = session }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                delete(session)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                restore(session)
                            } label: {
                                Label("Restore", systemImage: "arrow.counterclockwise")
                            }
                            .tint(Color(hex: "#6366f1"))
                        }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
        .alert("Rename Session", isPresented: Binding(
            get: { sessionToRename != nil },
            set: { if !$0 { sessionToRename = nil } }
        )) {
            TextField("Name", text: $renameText)
            Button("Save") { commitRename() }
            Button("Cancel", role: .cancel) { sessionToRename = nil }
        }
    }

    private var tagStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                TagFilterChip(label: "All", selected: selectedTag.isEmpty) {
                    selectedTag = ""
                }
                ForEach(allTags, id: \.self) { tag in
                    TagFilterChip(label: tag, selected: selectedTag == tag) {
                        selectedTag = selectedTag == tag ? "" : tag
                    }
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("Sort", selection: $sortOrder) {
                    ForEach(SortOrder.allCases) { o in
                        Text(o.rawValue).tag(o)
                    }
                }
            } label: {
                Label("Sort", systemImage: "arrow.up.arrow.down")
            }
        }
    }

    // MARK: – Actions

    private func delete(_ session: HRVSession) {
        if selectedSession?.id == session.id { selectedSession = nil }
        modelContext.delete(session)
        try? modelContext.save()
    }

    private func commitRename() {
        guard let s = sessionToRename else { return }
        let name = renameText.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        s.filename = name
        try? modelContext.save()
        sessionToRename = nil
    }

    private func restore(_ session: HRVSession) {
        vm.restoreSession(session)
    }
}

// MARK: – Tag filter chip
struct TagFilterChip: View {
    let label: String
    let selected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(label)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? Color(hex: "#6366f1") : Color(hex: "#6366f1").opacity(0.12))
                .foregroundStyle(selected ? .white : Color(hex: "#6366f1"))
                .clipShape(Capsule())
                .animation(.spring(duration: 0.2), value: selected)
        }
    }
}

// MARK: – Session card
struct SessionCardView: View {
    let session: HRVSession
    var onDelete: (() -> Void)? = nil
    var onRename: (() -> Void)? = nil

    private var sriColor: Color {
        switch session.sriScore {
        case 75...: return Color(hex: "#10b981")
        case 55..<75: return Color(hex: "#22d3ee")
        case 35..<55: return Color(hex: "#f59e0b")
        case 1..<35:  return Color(hex: "#ef4444")
        default:      return .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ── Header row
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.filename)
                        .font(.system(.body, weight: .semibold))
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        Text(session.createdAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("·")
                            .foregroundStyle(.quaternary)
                        Text(formatDuration(session.duration))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                // SRI badge — pill style
                VStack(spacing: 1) {
                    Text(session.sriScore > 0 ? "\(session.sriScore)" : "--")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(sriColor)
                        .monospacedDigit()
                    Text("SRI")
                        .font(.system(size: 9, weight: .semibold))
                        .kerning(0.5)
                        .foregroundStyle(sriColor.opacity(0.6))
                }
                .frame(width: 52)
                .padding(.vertical, 8)
                .background(sriColor.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider().padding(.horizontal, 14)

            // ── Stats row
            HStack(spacing: 0) {
                ForEach([
                    ("Samples", "\(session.sampleCount)"),
                    ("Avg RR", session.avgRR > 0 ? String(format: "%.0f ms", session.avgRR) : "--"),
                    ("RMSSD",  session.rmssd > 0  ? String(format: "%.1f ms", session.rmssd)  : "--"),
                    ("Quality", String(format: "%.0f%%", session.dataQuality))
                ], id: \.0) { label, value in
                    VStack(spacing: 3) {
                        Text(value)
                            .font(.system(.subheadline, design: .rounded, weight: .semibold))
                            .foregroundStyle(.primary)
                            .monospacedDigit()
                        Text(label)
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 10)

            // ── Tags + events (conditional)
            if !session.tags.isEmpty || session.eventMarkers.count > 0 {
                Divider().padding(.horizontal, 14)
                HStack(spacing: 6) {
                    ForEach(session.tags.prefix(3), id: \.self) { tag in
                        Text(tag)
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color(hex: "#6366f1").opacity(0.10))
                            .foregroundStyle(Color(hex: "#6366f1"))
                            .clipShape(Capsule())
                    }
                    Spacer()
                    if session.eventMarkers.count > 0 {
                        Label("\(session.eventMarkers.count)", systemImage: "mappin.circle")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
        }
        .background(.regularMaterial)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.04), radius: 6, x: 0, y: 2)
        .contextMenu {
            Button { onRename?() } label: { Label("Rename", systemImage: "pencil") }
            Divider()
            Button(role: .destructive) { onDelete?() } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func formatDuration(_ s: Double) -> String {
        let t = Int(s)
        if t >= 3600 { return "\(t/3600)h \((t%3600)/60)m" }
        if t >= 60   { return "\(t/60)m \(t%60)s" }
        return "\(t)s"
    }
}

// MARK: – Inline stat pill
struct SessionStatPill: View {
    let label: String; let value: String
    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(.caption, design: .rounded, weight: .bold))
                .foregroundStyle(.primary)
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
