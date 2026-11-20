import LTMKit
import SwiftUI

/// Ask: a local thread of questions; every question is one `/ask` call over the chosen
/// time span. Answers cite their evidence as [1], [2], … — each opens its source.
@MainActor
struct AskView: View {
    @EnvironmentObject private var store: MemoryStore
    @State private var question = ""
    @State private var scope: AskScope = .week
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ReaderGate {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 18) {
                                if store.thread.isEmpty {
                                    Text(L("ask.intro"))
                                        .foregroundStyle(.secondary)
                                        .padding(.top, 24)
                                }
                                ForEach(store.thread) { turn in
                                    AskTurnView(turn: turn) {
                                        Task { await store.ask(turn.question, scope: turn.scope) }
                                    }
                                    .id(turn.id)
                                }
                            }
                            .padding()
                        }
                        .onChange(of: store.thread.count) { _, _ in
                            if let last = store.thread.last {
                                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                            }
                        }
                    }
                    Divider()
                    composer
                }
            }
            .navigationTitle(L("tab.ask"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L("ask.clear")) { store.clearThread() }
                        .disabled(store.thread.isEmpty)
                }
            }
            .readerDestinations()
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            Picker(L("ask.scope"), selection: $scope) {
                Text(L("ask.scope.today")).tag(AskScope.today)
                Text(L("ask.scope.week")).tag(AskScope.week)
                Text(L("ask.scope.all")).tag(AskScope.all)
            }
            .pickerStyle(.segmented)
            HStack(alignment: .bottom) {
                TextField(L("ask.placeholder"), text: $question, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(L("ask.send"))
            }
        }
        .padding()
    }

    private func send() {
        let text = question
        question = ""
        focused = false
        Task { await store.ask(text, scope: scope) }
    }
}

@MainActor
struct AskTurnView: View {
    let turn: AskTurn
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Spacer(minLength: 40)
                Text(turn.question)
                    .padding(10)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
            }
            if turn.isLoading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(L("ask.thinking")).foregroundStyle(.secondary)
                }
            } else if let error = turn.error {
                VStack(alignment: .leading, spacing: 6) {
                    ErrorBanner(error: error)
                    Button(L("common.retry"), action: retry).buttonStyle(.bordered)
                }
            } else if let answer = turn.answer {
                MarkdownView(markdown: answer.answer)
                if !answer.citations.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("ask.sources")).font(.caption.bold()).foregroundStyle(.secondary)
                        ForEach(answer.citations.indices, id: \.self) { index in
                            CitationRow(number: index + 1, hit: answer.citations[index])
                        }
                    }
                }
            }
        }
    }
}

@MainActor
struct CitationRow: View {
    let number: Int
    let hit: SearchHit

    var body: some View {
        switch Citations.target(of: hit) {
        case .conversation(let id):
            NavigationLink(value: ReaderRoute.conversation(id)) { label }
        case .memory(let id):
            NavigationLink(value: ReaderRoute.memory(id)) { label }
        case .none:
            label
        }
    }

    private var label: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("[\(number)]").font(.caption.bold().monospacedDigit())
            VStack(alignment: .leading, spacing: 2) {
                if let title = hit.title {
                    Text(title).font(.caption.bold())
                }
                Text(hit.snippet).font(.caption).lineLimit(3)
                if let atMs = hit.atMs {
                    Text(ReaderFormat.dateTime(atMs)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .foregroundStyle(Color.primary)
    }
}
