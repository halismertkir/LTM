import LTMKit
import SwiftUI

/// Destinations pushed inside the reader tabs' navigation stacks.
enum ReaderRoute: Hashable {
    case conversation(String)
    case day(String)
    case memory(String)
}

/// Shared navigation destinations, so every tab can open every kind of item.
struct ReaderDestinations: ViewModifier {
    func body(content: Content) -> some View {
        content.navigationDestination(for: ReaderRoute.self) { route in
            switch route {
            case .conversation(let id):
                ConversationDetailView(id: id)
            case .day(let date):
                DayDetailView(date: date)
            case .memory(let id):
                MemoryDetailView(id: id)
            }
        }
    }
}

extension View {
    func readerDestinations() -> some View {
        modifier(ReaderDestinations())
    }
}

enum ReaderFormat {
    static func time(_ ms: Double) -> String {
        EpochMs.date(ms).formatted(date: .omitted, time: .shortened)
    }

    static func timeRange(_ startMs: Double, _ endMs: Double) -> String {
        "\(time(startMs)) – \(time(endMs))"
    }

    static func dateTime(_ ms: Double) -> String {
        EpochMs.date(ms).formatted(date: .abbreviated, time: .shortened)
    }

    /// "Today", "Yesterday" or the full date of a "YYYY-MM-DD" day.
    static func dayTitle(_ date: String) -> String {
        let today = DayDate.string(for: Date())
        if date == today { return L("reader.today") }
        if date == DayDate.string(for: Date().addingTimeInterval(-86_400)) { return L("reader.yesterday") }
        guard let parsed = DayDate.date(from: date) else { return date }
        return parsed.formatted(date: .complete, time: .omitted)
    }

    static func minutes(_ value: Double) -> String {
        LF("reader.minutes", Int(value.rounded()))
    }

    static func kind(_ kind: MemoryKind) -> String {
        switch kind {
        case .fact: return L("memory.kind.fact")
        case .preference: return L("memory.kind.preference")
        case .person: return L("memory.kind.person")
        case .commitment: return L("memory.kind.commitment")
        case .decision: return L("memory.kind.decision")
        case .event: return L("memory.kind.event")
        case .idea: return L("memory.kind.idea")
        default: return kind.rawValue
        }
    }

    static func speaker(_ hint: String) -> String {
        switch hint {
        case "self": return L("reader.speaker.self")
        case "other": return L("reader.speaker.other")
        default: return L("reader.speaker.unknown")
        }
    }

    static func sourceSymbol(_ source: String) -> String {
        switch source {
        case "tab": return "macwindow"
        case "system": return "speaker.wave.2"
        case "ambient": return "applewatch"
        default: return "mic"
        }
    }

    static func status(_ conversation: ConversationSummary) -> String {
        if conversation.isLive { return conversation.interim ? L("reader.status.liveNotes") : L("reader.status.live") }
        switch conversation.status {
        case .processing: return L("reader.status.processing")
        case .transcriptOnly: return L("reader.status.transcriptOnly")
        default: return L("reader.status.ready")
        }
    }

    static func importance(_ value: Int) -> String {
        String(repeating: "★", count: max(0, min(5, value))) + String(repeating: "☆", count: max(0, 5 - min(5, value)))
    }
}

/// Renders Markdown block by block (headings, lists, quotes, code) with inline styling;
/// any block whose inline Markdown fails to parse is shown as plain text.
@MainActor
struct MarkdownView: View {
    let markdown: String

    var body: some View {
        let blocks = MarkdownBlocks.parse(markdown)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(blocks.indices, id: \.self) { index in
                block(blocks[index])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    @ViewBuilder
    private func block(_ block: MarkdownBlocks.Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(Self.inline(text))
                .font(level <= 1 ? Font.title3.bold() : (level == 2 ? Font.headline : Font.subheadline.bold()))
                .padding(.top, 4)
        case .bullet(let text, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("•")
                Text(Self.inline(text))
            }
            .padding(.leading, CGFloat(depth) * 14)
        case .numbered(let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(number).").monospacedDigit()
                Text(Self.inline(text))
            }
        case .quote(let text):
            Text(Self.inline(text))
                .italic()
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 3)
                }
        case .code(let text):
            Text(text)
                .font(.system(.footnote, design: .monospaced))
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
        case .paragraph(let text):
            Text(Self.inline(text))
        case .rule:
            Divider()
        }
    }
}

/// Shows the reader only when this device may read; explains otherwise.
@MainActor
struct ReaderGate<Content: View>: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: MemoryStore
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        switch store.access {
        case .memory:
            content()
        case .captureOnly:
            CaptureOnlyView()
        case .unknown, .checking:
            ProgressView(L("reader.checkingAccess"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .task {
                    if store.access == .unknown { await model.refreshReader() }
                }
        case .unavailable(let error):
            VStack(spacing: 12) {
                Image(systemName: "wifi.exclamationmark").font(.largeTitle).foregroundStyle(.secondary)
                Text(ErrorText.describe(error)).multilineTextAlignment(.center)
                Button(L("common.retry")) { Task { await model.refreshReader() } }
                    .buttonStyle(.bordered)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The phone was paired with `access: "capture"`: capture works, reading does not.
@MainActor
struct CaptureOnlyView: View {
    @EnvironmentObject private var model: AppModel
    @State private var checking = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.shield")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text(L("reader.captureOnly.title"))
                .font(.title3.bold())
                .multilineTextAlignment(.center)
            Text(L("reader.captureOnly.body"))
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button {
                Task {
                    checking = true
                    await model.refreshReader()
                    checking = false
                }
            } label: {
                if checking { ProgressView() } else { Text(L("common.retry")) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(checking)
            if let server = model.settings.server {
                Link(L("settings.openDashboard"), destination: server.origin)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A tappable action item (ticks on the server, optimistic in the UI).
@MainActor
struct ActionItemRow: View {
    @EnvironmentObject private var store: MemoryStore
    let item: ActionItem
    let conversationId: String
    var conversationTitle: String?

    var body: some View {
        Button {
            Task { await store.setActionItem(conversationId: conversationId, itemId: item.id, done: !item.done) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(item.done ? Color.green : Color.secondary)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.text)
                        .strikethrough(item.done)
                        .foregroundStyle(item.done ? Color.secondary : Color.primary)
                    let meta = [item.owner, item.due.map { LF("reader.due", $0) }, conversationTitle].compactMap { $0 }
                    if !meta.isEmpty {
                        Text(meta.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityValue(item.done ? L("reader.done") : L("reader.open"))
    }
}

@MainActor
struct ConversationRow: View {
    let conversation: ConversationSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(conversation.title ?? L("reader.untitled"))
                    .font(.headline)
                    .lineLimit(2)
                Spacer()
                if conversation.isLive {
                    Text(ReaderFormat.status(conversation))
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.red.opacity(0.15), in: Capsule())
                        .foregroundStyle(.red)
                }
            }
            Text(ReaderFormat.timeRange(conversation.startMs, conversation.endMs))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let summary = conversation.summary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if conversation.openActionItems > 0 {
                Label(LF("reader.openActions", conversation.openActionItems), systemImage: "checklist")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 2)
    }
}

@MainActor
struct ErrorBanner: View {
    let error: LTMError

    var body: some View {
        Label(ErrorText.describe(error), systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.orange)
    }
}
