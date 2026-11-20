import LTMKit
import SwiftUI

/// Today: the day's digest (headline, summary, highlights, decisions, people, open action
/// items), the day's conversations, and a compact capture control.
@MainActor
struct TodayView: View {
    @EnvironmentObject private var store: MemoryStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    CompactCaptureControl()
                }
                ReaderGate {
                    todayContent
                }
            }
            .navigationTitle(L("tab.today"))
            .refreshable { await store.loadToday() }
            .task {
                if store.canRead, store.today == .idle { await store.loadToday() }
            }
            .onChange(of: store.access) { _, access in
                if access == .memory, store.today == .idle {
                    Task { await store.loadToday() }
                }
            }
            .readerDestinations()
        }
    }

    @ViewBuilder
    private var todayContent: some View {
        switch store.today {
        case .idle, .loading(previous: nil):
            Section { ProgressView().frame(maxWidth: .infinity) }
        case .loading(let previous), .failed(_, let previous):
            if let error = store.today.error {
                Section { ErrorBanner(error: error) }
            }
            if let detail = previous ?? nil {
                DayContent(detail: detail)
            }
        case .loaded(let detail):
            if let detail {
                DayContent(detail: detail)
            } else {
                Section {
                    Text(L("today.empty"))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// The sections of a day (used by Today and by a day picked in the Timeline).
@MainActor
struct DayContent: View {
    let detail: DayDetail

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(detail.day.headline ?? ReaderFormat.dayTitle(detail.day.date))
                    .font(.title3.bold())
                if let summary = detail.day.summary {
                    Text(summary)
                }
                HStack(spacing: 12) {
                    Label(LF("reader.conversationCount", detail.day.conversationCount), systemImage: "bubble.left.and.bubble.right")
                    Label(ReaderFormat.minutes(detail.day.speechMinutes), systemImage: "waveform")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if detail.day.status == .pending {
                    Label(L("day.pending"), systemImage: "hourglass")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if detail.day.status == .unavailable {
                    Text(detail.statusDetail ?? L("day.unavailable"))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            .padding(.vertical, 4)
        }

        if !detail.highlights.isEmpty {
            Section(L("day.highlights")) {
                ForEach(detail.highlights, id: \.self) { Text(MarkdownView.inline($0)) }
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
                ForEach(detail.actionItems) { entry in
                    ActionItemRow(item: entry.item, conversationId: entry.conversationId, conversationTitle: entry.conversationTitle)
                }
            }
        }
        if !detail.people.isEmpty {
            Section(L("day.people")) {
                Text(detail.people.joined(separator: ", "))
            }
        }
        if let digest = detail.digest, !digest.isEmpty {
            Section(L("day.digest")) {
                MarkdownView(markdown: digest)
            }
        }
        Section(L("day.conversations")) {
            if detail.conversations.isEmpty {
                Text(L("day.noConversations")).foregroundStyle(.secondary)
            }
            ForEach(detail.conversations) { conversation in
                NavigationLink(value: ReaderRoute.conversation(conversation.id)) {
                    ConversationRow(conversation: conversation)
                }
            }
        }
    }
}

/// A past day from the Timeline.
@MainActor
struct DayDetailView: View {
    @EnvironmentObject private var store: MemoryStore
    let date: String

    var body: some View {
        List {
            if let detail = store.dayDetails[date] {
                DayContent(detail: detail)
            } else if let error = store.lastError {
                Section { ErrorBanner(error: error) }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(ReaderFormat.dayTitle(date))
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.day(date) }
        .refreshable { await store.day(date, force: true) }
    }
}

/// Capture stays one tap away on every reader screen: state, start/stop, live caption,
/// and (with memory access) the account-wide pause.
@MainActor
struct CompactCaptureControl: View {
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @EnvironmentObject private var store: MemoryStore
    @State private var pauseError: String?

    private var color: Color {
        switch coordinator.state {
        case .listening: return .red
        case .paused: return .orange
        case .error: return .yellow
        default: return .gray
        }
    }

    private var title: String {
        switch coordinator.state {
        case .listening: return L("state.listening")
        case .paused(.server): return L("state.pausedServer")
        case .paused: return L("state.paused")
        case .error: return L("state.error")
        case .idle: return L("state.idle")
        case .notPaired: return L("state.notPaired")
        case .consentRequired: return L("state.consentRequired")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle().fill(color).frame(width: 12, height: 12).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).font(.headline)
                    if let since = coordinator.listeningSince {
                        Text(since, style: .timer)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                captureButton
            }
            if let caption = coordinator.liveCaption ?? store.liveCaption {
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if store.canRead {
                Toggle(L("capture.accountPause"), isOn: Binding(
                    get: { store.ingestPaused ?? coordinator.isIngestPaused },
                    set: { paused in
                        Task {
                            do {
                                try await store.setCapturePaused(paused)
                                pauseError = nil
                            } catch {
                                pauseError = ErrorText.describe(error)
                            }
                        }
                    }
                ))
                .font(.subheadline)
                if let pauseError {
                    Text(pauseError).font(.caption).foregroundStyle(.red)
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var captureButton: some View {
        switch coordinator.state {
        case .idle:
            Button {
                Task { await coordinator.start() }
            } label: {
                Label(L("main.start"), systemImage: "mic.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(coordinator.isBusy)
        case .listening:
            Button(role: .destructive) {
                Task { await coordinator.stop() }
            } label: {
                Label(L("main.stop"), systemImage: "stop.fill")
            }
            .buttonStyle(.bordered)
        case .paused(.user):
            Button {
                Task { await coordinator.resume() }
            } label: {
                Label(L("main.resume"), systemImage: "play.fill")
            }
            .buttonStyle(.bordered)
        default:
            EmptyView()
        }
    }
}
