import LTMKit
import SwiftUI

/// Memories: the durable statements LTM extracted (or you added), filterable by kind,
/// searchable, and with a form to add one.
@MainActor
struct MemoriesView: View {
    @EnvironmentObject private var store: MemoryStore
    @State private var query = ""
    @State private var showAdd = false

    var body: some View {
        NavigationStack {
            ReaderGate {
                List {
                    if let error = store.memories.error {
                        Section { ErrorBanner(error: error) }
                    }
                    if store.memories.loaded && store.memories.items.isEmpty {
                        Text(store.memoryQuery.isEmpty && store.memoryKind == nil ? L("memories.empty") : L("timeline.noResults"))
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.memories.items) { memory in
                        Group {
                            if let conversationId = memory.sourceConversationId {
                                NavigationLink(value: ReaderRoute.conversation(conversationId)) { MemoryRow(memory: memory) }
                            } else {
                                MemoryRow(memory: memory)
                            }
                        }
                        .onAppear { Task { await store.memoryAppeared(memory) } }
                    }
                    if store.memories.isLoading { ProgressView().frame(maxWidth: .infinity) }
                }
                .refreshable { await store.refreshMemories() }
                .searchable(text: $query, prompt: L("memories.search"))
                .onSubmit(of: .search) { Task { await store.setMemoryFilter(query: query, kind: store.memoryKind) } }
                .onChange(of: query) { _, newValue in
                    if newValue.isEmpty, !store.memoryQuery.isEmpty {
                        Task { await store.setMemoryFilter(query: "", kind: store.memoryKind) }
                    }
                }
                .task {
                    if !store.memories.loaded && !store.memories.isLoading { await store.refreshMemories() }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { kindMenu }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showAdd = true
                        } label: {
                            Label(L("memories.add"), systemImage: "plus")
                        }
                    }
                }
                .sheet(isPresented: $showAdd) { AddMemorySheet() }
            }
            .navigationTitle(L("tab.memories"))
            .readerDestinations()
        }
    }

    private var kindMenu: some View {
        Menu {
            Button(L("memories.kind.all")) { Task { await store.setMemoryFilter(query: query, kind: nil) } }
            ForEach(MemoryKind.allCases, id: \.self) { kind in
                Button(ReaderFormat.kind(kind)) { Task { await store.setMemoryFilter(query: query, kind: kind) } }
            }
        } label: {
            Label(store.memoryKind.map(ReaderFormat.kind) ?? L("memories.kind.all"), systemImage: "line.3.horizontal.decrease.circle")
        }
    }
}

@MainActor
struct MemoryRow: View {
    let memory: Memory

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(memory.content)
            HStack(spacing: 8) {
                Text(ReaderFormat.kind(memory.kind))
                    .font(.caption2.bold())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.15), in: Capsule())
                Text(ReaderFormat.importance(memory.importance))
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .accessibilityLabel(LF("memories.importance", memory.importance))
                if !memory.subjects.isEmpty {
                    Text(memory.subjects.joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// A cited memory. Only memories already loaded somewhere in the app can be shown; the
/// device routes have no single-memory GET.
@MainActor
struct MemoryDetailView: View {
    @EnvironmentObject private var store: MemoryStore
    let id: String

    var body: some View {
        List {
            if let memory = store.memory(id: id) {
                Section { MemoryRow(memory: memory) }
                if let conversationId = memory.sourceConversationId {
                    Section {
                        NavigationLink(value: ReaderRoute.conversation(conversationId)) {
                            Label(L("memories.source"), systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                }
            } else {
                Text(L("memories.notLoaded")).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(L("reader.memory"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if store.memory(id: id) == nil, !store.memories.loaded { await store.refreshMemories() }
        }
    }
}

@MainActor
struct AddMemorySheet: View {
    @EnvironmentObject private var store: MemoryStore
    @Environment(\.dismiss) private var dismiss
    @State private var kind: MemoryKind = .fact
    @State private var content = ""
    @State private var importance = 3
    @State private var subjects = ""
    @State private var saving = false
    @State private var errorMessage: String?

    private var trimmed: String { content.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L("memories.content"), text: $content, axis: .vertical)
                        .lineLimit(3...8)
                }
                Section {
                    Picker(L("memories.kind"), selection: $kind) {
                        ForEach(MemoryKind.allCases, id: \.self) { kind in
                            Text(ReaderFormat.kind(kind)).tag(kind)
                        }
                    }
                    Stepper(value: $importance, in: 1...5) {
                        HStack {
                            Text(L("memories.importanceLabel"))
                            Spacer()
                            Text(ReaderFormat.importance(importance)).foregroundStyle(.orange)
                        }
                    }
                    TextField(L("memories.subjects"), text: $subjects)
                        .textInputAutocapitalization(.words)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle(L("memories.add"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("memories.save")) { Task { await save() } }
                        .disabled(trimmed.isEmpty || saving || trimmed.count > 2_000)
                }
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let subjectList = subjects.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .prefix(20)
            .map { String($0.prefix(120)) }
        do {
            try await store.addMemory(MemoryCreate(kind: kind, content: trimmed, importance: importance, subjects: Array(subjectList)))
            dismiss()
        } catch {
            errorMessage = ErrorText.describe(error)
        }
    }
}

/// The phone app's tabs once paired and consented.
@MainActor
struct ReaderTabView: View {
    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label(L("tab.today"), systemImage: "sun.max") }
            TimelineTabView()
                .tabItem { Label(L("tab.timeline"), systemImage: "calendar") }
            AskView()
                .tabItem { Label(L("tab.ask"), systemImage: "questionmark.bubble") }
            MemoriesView()
                .tabItem { Label(L("tab.memories"), systemImage: "lightbulb") }
            MainView()
                .tabItem { Label(L("tab.capture"), systemImage: "mic.circle") }
        }
    }
}
