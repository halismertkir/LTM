import LTMKit
import SwiftUI

/// Timeline: days (newest first) → day detail, or all conversations with search and
/// infinite paging.
@MainActor
struct TimelineTabView: View {
    enum Mode: String, Hashable {
        case days
        case conversations
    }

    @EnvironmentObject private var store: MemoryStore
    @State private var mode: Mode = .days
    @State private var query = ""

    var body: some View {
        NavigationStack {
            ReaderGate {
                List {
                    Section {
                        Picker(L("timeline.mode"), selection: $mode) {
                            Text(L("timeline.days")).tag(Mode.days)
                            Text(L("timeline.conversations")).tag(Mode.conversations)
                        }
                        .pickerStyle(.segmented)
                    }
                    switch mode {
                    case .days: daysSection
                    case .conversations: conversationsSection
                    }
                }
                .refreshable {
                    switch mode {
                    case .days: await store.refreshDays()
                    case .conversations: await store.refreshConversations()
                    }
                }
                .searchable(text: $query, prompt: L("timeline.search"))
                .onSubmit(of: .search) {
                    mode = .conversations
                    Task { await store.searchConversations(query) }
                }
                .onChange(of: query) { _, newValue in
                    if newValue.isEmpty, !store.conversationQuery.isEmpty {
                        Task { await store.searchConversations("") }
                    }
                }
                .task { await loadIfNeeded() }
                .onChange(of: mode) { _, _ in Task { await loadIfNeeded() } }
            }
            .navigationTitle(L("tab.timeline"))
            .readerDestinations()
        }
    }

    private func loadIfNeeded() async {
        switch mode {
        case .days:
            if !store.days.loaded && !store.days.isLoading { await store.refreshDays() }
        case .conversations:
            if !store.conversations.loaded && !store.conversations.isLoading { await store.refreshConversations() }
        }
    }

    @ViewBuilder
    private var daysSection: some View {
        Section {
            if let error = store.days.error { ErrorBanner(error: error) }
            if store.days.loaded && store.days.items.isEmpty {
                Text(L("timeline.noDays")).foregroundStyle(.secondary)
            }
            ForEach(store.days.items) { day in
                NavigationLink(value: ReaderRoute.day(day.date)) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(ReaderFormat.dayTitle(day.date)).font(.headline)
                        if let headline = day.headline {
                            Text(headline).font(.subheadline)
                        }
                        Text("\(LF("reader.conversationCount", day.conversationCount)) · \(ReaderFormat.minutes(day.speechMinutes))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .onAppear {
                    if day.id == store.days.items.last?.id { Task { await store.loadMoreDays() } }
                }
            }
            if store.days.isLoading { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    @ViewBuilder
    private var conversationsSection: some View {
        Section {
            if let error = store.conversations.error { ErrorBanner(error: error) }
            if store.conversations.loaded && store.conversations.items.isEmpty {
                Text(store.conversationQuery.isEmpty ? L("timeline.noConversations") : L("timeline.noResults"))
                    .foregroundStyle(.secondary)
            }
            ForEach(store.conversations.items) { conversation in
                NavigationLink(value: ReaderRoute.conversation(conversation.id)) {
                    ConversationRow(conversation: conversation)
                }
                .onAppear { Task { await store.conversationAppeared(conversation) } }
            }
            if store.conversations.isLoading { ProgressView().frame(maxWidth: .infinity) }
        }
    }
}

/// One conversation: summary, notes, decisions, action items, transcript, memories.
@MainActor
struct ConversationDetailView: View {
    @EnvironmentObject private var store: MemoryStore
    let id: String

    var body: some View {
        List {
            if let detail = store.conversationDetails[id] {
                content(detail)
            } else if let error = store.lastError {
                Section { ErrorBanner(error: error) }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(store.conversationDetails[id]?.conversation.title ?? L("reader.conversation"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.conversation(id) }
        .refreshable { await store.conversation(id, force: true) }
    }

    @ViewBuilder
    private func content(_ detail: ConversationDetail) -> some View {
        let conversation = detail.conversation
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(conversation.title ?? L("reader.untitled")).font(.title3.bold())
                Text("\(ReaderFormat.status(conversation)) · \(ReaderFormat.dateTime(conversation.startMs)) – \(ReaderFormat.time(conversation.endMs))")
                    .font(.caption)
                    .foregroundStyle(conversation.isLive ? Color.red : Color.secondary)
                if !conversation.participants.isEmpty {
                    Label(conversation.participants.joined(separator: ", "), systemImage: "person.2")
                        .font(.caption)
                }
                if !conversation.topics.isEmpty {
                    Label(conversation.topics.joined(separator: ", "), systemImage: "tag")
                        .font(.caption)
                }
                if let summary = conversation.summary {
                    Text(summary).padding(.top, 2)
                }
                if let statusDetail = detail.statusDetail {
                    Text(statusDetail).font(.caption).foregroundStyle(.orange)
                }
            }
            .padding(.vertical, 4)
        }
        if let notes = detail.notes, !notes.isEmpty {
            Section(conversation.interim ? L("reader.notesSoFar") : L("reader.notes")) {
                MarkdownView(markdown: notes)
            }
        }
        if !detail.decisions.isEmpty {
            Section(L("reader.decisions")) {
                ForEach(detail.decisions, id: \.self) { decision in
                    Label { Text(MarkdownView.inline(decision)) } icon: { Image(systemName: "checkmark.seal") }
                }
            }
        }
        if !detail.actionItems.isEmpty {
            Section(L("reader.actionItems")) {
                ForEach(detail.actionItems) { item in
                    ActionItemRow(item: item, conversationId: conversation.id)
                }
            }
        }
        if let memories = store.linkedMemories[conversation.id], !memories.isEmpty {
            Section(L("reader.memories")) {
                ForEach(memories) { memory in
                    MemoryRow(memory: memory)
                }
            }
        }
        Section(LF("reader.transcript", detail.utterances.count)) {
            if detail.utterances.isEmpty {
                Text(L("reader.noTranscript")).foregroundStyle(.secondary)
            }
            ForEach(detail.utterances) { utterance in
                UtteranceRow(utterance: utterance)
            }
        }
    }
}

@MainActor
struct UtteranceRow: View {
    let utterance: Utterance

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(ReaderFormat.time(utterance.startMs))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(ReaderFormat.speaker(utterance.speaker))
                    .font(.caption.bold())
                Spacer()
                ForEach(Array(Set(utterance.sources)).sorted(), id: \.self) { source in
                    Image(systemName: ReaderFormat.sourceSymbol(source))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(source)
                }
                if utterance.deviceIds.count > 1 {
                    Text("×\(utterance.deviceIds.count)")
                        .font(.caption2.bold())
                        .padding(.horizontal, 4)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                        .accessibilityLabel(LF("reader.heardBy", utterance.deviceIds.count))
                }
                if utterance.origin == "edge_stt" {
                    Image(systemName: "iphone")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(L("reader.onDevice"))
                }
            }
            Text(utterance.text)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }
}
