#if canImport(Combine)
import Combine
#endif
import Foundation

/// View model of the reader tabs (Today, Timeline, Ask, Memories).
///
/// Plain Swift state with in-memory caches; on Apple platforms it is an
/// `ObservableObject` the SwiftUI views observe. Lists use pull-to-refresh semantics
/// (`refresh…` replaces, `loadMore…` appends), details are cached and re-fetched when a
/// live event says they changed. A `403 forbidden` anywhere switches `access` to
/// `.captureOnly`, which the UI explains instead of showing errors.
@MainActor
public final class MemoryStore: ObservableObject {
    public enum Access: Sendable, Equatable {
        case unknown
        case checking
        /// Paired with `access: "memory"`: the reader works.
        case memory
        /// Paired with `access: "capture"`: capture works, reading needs a web-app change.
        case captureOnly
        case unavailable(LTMError)
    }

    @Published public private(set) var access: Access = .unknown
    /// Today's digest; `.loaded(nil)` means the server has nothing for today yet.
    @Published public private(set) var today: Loadable<DayDetail?> = .idle
    @Published public private(set) var days = PagedList<DaySummary>()
    @Published public private(set) var dayDetails: [String: DayDetail] = [:]
    @Published public private(set) var conversations = PagedList<ConversationSummary>()
    @Published public private(set) var conversationQuery = ""
    @Published public private(set) var conversationDetails: [String: ConversationDetail] = [:]
    /// Memories extracted from a conversation, by conversation id.
    @Published public private(set) var linkedMemories: [String: [Memory]] = [:]
    @Published public private(set) var memories = PagedList<Memory>()
    @Published public private(set) var memoryQuery = ""
    @Published public private(set) var memoryKind: MemoryKind?
    @Published public private(set) var thread: [AskTurn] = []
    @Published public private(set) var ingestPaused: Bool?
    @Published public private(set) var liveStatus: LiveEventClient.Status = .stopped
    /// Latest recognised text from any device (live `segment` events).
    @Published public private(set) var liveCaption: String?
    @Published public private(set) var activeStreamIds: Set<String> = []
    @Published public private(set) var lastError: LTMError?

    /// Called when the account-wide pause changes (server response or live event).
    public var onCapturePaused: ((Bool) -> Void)?

    private let api: () -> (any MemoryAPI)?
    private let pageSize: Int
    private let now: () -> Date
    private let timeZone: TimeZone
    private var staleConversations: Set<String> = []
    private var staleDays: Set<String> = []
    private var liveClient: LiveEventClient?
    private var liveTask: Task<Void, Never>?

    public init(
        api: @escaping () -> (any MemoryAPI)?,
        pageSize: Int = 30,
        now: @escaping () -> Date = { Date() },
        timeZone: TimeZone = .current
    ) {
        self.api = api
        self.pageSize = pageSize
        self.now = now
        self.timeZone = timeZone
    }

    public var todayDate: String { DayDate.string(for: now(), timeZone: timeZone) }

    public var canRead: Bool { access == .memory }

    // MARK: Access

    /// Asks `/devices/self` what this device may do.
    public func checkAccess() async {
        guard let api = api() else {
            access = .unavailable(.notPaired)
            return
        }
        access = .checking
        do {
            let device = try await api.deviceSelf()
            // A server that predates device access sends no `access`: try to read and let a
            // 403 decide.
            access = device.access == .capture ? .captureOnly : .memory
        } catch {
            let error = LTMError.from(error)
            access = error.code == .forbidden ? .captureOnly : .unavailable(error)
        }
    }

    /// Records an error; a 403 means the device is capture-only.
    @discardableResult
    private func note(_ error: Error) -> LTMError {
        let error = LTMError.from(error)
        if error.code == .forbidden {
            access = .captureOnly
        } else if error.isUnauthorized {
            access = .unavailable(error)
        }
        if error != .cancelled { lastError = error }
        return error
    }

    public func clearError() {
        lastError = nil
    }

    // MARK: Today and days

    public func loadToday() async {
        guard let api = api() else { return }
        let date = todayDate
        today = .loading(previous: today.value ?? nil)
        do {
            let detail = try await api.day(date: date)
            dayDetails[date] = detail
            staleDays.remove(date)
            today = .loaded(detail)
        } catch {
            let error = LTMError.from(error)
            if error.code == .notFound || error == .unexpectedStatus(404) {
                today = .loaded(nil)
            } else {
                today = .failed(note(error), previous: today.value ?? nil)
            }
        }
    }

    public func refreshDays() async {
        guard let api = api() else { return }
        let generation = days.beginRefresh()
        do {
            let page = try await api.days(from: nil, to: nil, limit: pageSize, cursor: nil)
            days.apply(page, generation: generation, replace: true)
        } catch {
            days.fail(note(error), generation: generation)
        }
    }

    public func loadMoreDays() async {
        guard let api = api(), let request = days.beginLoadMore() else { return }
        do {
            let page = try await api.days(from: nil, to: nil, limit: pageSize, cursor: request.cursor)
            days.apply(page, generation: request.generation, replace: false)
        } catch {
            days.fail(note(error), generation: request.generation)
        }
    }

    /// A day's detail, cached unless `force` or a live event marked it stale.
    @discardableResult
    public func day(_ date: String, force: Bool = false) async -> DayDetail? {
        if !force, !staleDays.contains(date), let cached = dayDetails[date] { return cached }
        guard let api = api() else { return dayDetails[date] }
        do {
            let detail = try await api.day(date: date)
            dayDetails[date] = detail
            staleDays.remove(date)
            if date == todayDate { today = .loaded(detail) }
            return detail
        } catch {
            note(error)
            return dayDetails[date]
        }
    }

    // MARK: Conversations

    public func searchConversations(_ query: String) async {
        conversationQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        await refreshConversations()
    }

    public func refreshConversations() async {
        guard let api = api() else { return }
        let generation = conversations.beginRefresh()
        let query = conversationQuery
        do {
            let page = try await api.conversations(query: query.isEmpty ? nil : query, from: nil, to: nil, limit: pageSize, cursor: nil)
            conversations.apply(page, generation: generation, replace: true)
        } catch {
            conversations.fail(note(error), generation: generation)
        }
    }

    public func loadMoreConversations() async {
        guard let api = api(), let request = conversations.beginLoadMore() else { return }
        let query = conversationQuery
        do {
            let page = try await api.conversations(query: query.isEmpty ? nil : query, from: nil, to: nil, limit: pageSize, cursor: request.cursor)
            conversations.apply(page, generation: request.generation, replace: false)
        } catch {
            conversations.fail(note(error), generation: request.generation)
        }
    }

    /// Loads more when `item` is near the end of the list (infinite scrolling).
    public func conversationAppeared(_ item: ConversationSummary) async {
        guard let index = conversations.items.firstIndex(where: { $0.id == item.id }),
              index >= conversations.items.count - 5 else { return }
        await loadMoreConversations()
    }

    @discardableResult
    public func conversation(_ id: String, force: Bool = false) async -> ConversationDetail? {
        if !force, !staleConversations.contains(id), let cached = conversationDetails[id] { return cached }
        guard let api = api() else { return conversationDetails[id] }
        do {
            let detail = try await api.conversation(id: id)
            conversationDetails[id] = detail
            staleConversations.remove(id)
            if !detail.memoryIds.isEmpty || linkedMemories[id] == nil {
                await loadLinkedMemories(conversationId: id)
            }
            return detail
        } catch {
            note(error)
            return conversationDetails[id]
        }
    }

    public func loadLinkedMemories(conversationId: String) async {
        guard let api = api() else { return }
        do {
            let page = try await api.memories(query: nil, kind: nil, conversationId: conversationId, limit: 50, cursor: nil)
            linkedMemories[conversationId] = page.items
        } catch {
            note(error)
        }
    }

    /// Ticks an action item everywhere it is shown, then on the server; rolls back on failure.
    public func setActionItem(conversationId: String, itemId: String, done: Bool) async {
        guard let api = api() else { return }
        applyActionItem(conversationId: conversationId, itemId: itemId, done: done)
        do {
            let updated = try await api.updateActionItem(conversationId: conversationId, itemId: itemId, update: ActionItemUpdate(done: done))
            applyActionItem(conversationId: conversationId, itemId: itemId, done: updated.done)
        } catch {
            applyActionItem(conversationId: conversationId, itemId: itemId, done: !done)
            note(error)
        }
    }

    private func applyActionItem(conversationId: String, itemId: String, done: Bool) {
        if var detail = conversationDetails[conversationId],
           let index = detail.actionItems.firstIndex(where: { $0.id == itemId }) {
            let wasDone = detail.actionItems[index].done
            detail.actionItems[index].done = done
            if wasDone != done { detail.conversation.openActionItems += done ? -1 : 1 }
            conversationDetails[conversationId] = detail
        }
        for (date, var detail) in dayDetails {
            guard let index = detail.actionItems.firstIndex(where: { $0.id == itemId && $0.conversationId == conversationId }) else { continue }
            detail.actionItems[index].item.done = done
            dayDetails[date] = detail
            if date == todayDate { today = .loaded(detail) }
        }
    }

    // MARK: Memories

    public func setMemoryFilter(query: String, kind: MemoryKind?) async {
        memoryQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        memoryKind = kind
        await refreshMemories()
    }

    public func refreshMemories() async {
        guard let api = api() else { return }
        let generation = memories.beginRefresh()
        let query = memoryQuery
        do {
            let page = try await api.memories(query: query.isEmpty ? nil : query, kind: memoryKind, conversationId: nil, limit: pageSize, cursor: nil)
            memories.apply(page, generation: generation, replace: true)
        } catch {
            memories.fail(note(error), generation: generation)
        }
    }

    public func loadMoreMemories() async {
        guard let api = api(), let request = memories.beginLoadMore() else { return }
        let query = memoryQuery
        do {
            let page = try await api.memories(query: query.isEmpty ? nil : query, kind: memoryKind, conversationId: nil, limit: pageSize, cursor: request.cursor)
            memories.apply(page, generation: request.generation, replace: false)
        } catch {
            memories.fail(note(error), generation: request.generation)
        }
    }

    public func memoryAppeared(_ memory: Memory) async {
        guard let index = memories.items.firstIndex(where: { $0.id == memory.id }),
              index >= memories.items.count - 5 else { return }
        await loadMoreMemories()
    }

    public func addMemory(_ create: MemoryCreate) async throws {
        guard let api = api() else { throw LTMError.notPaired }
        do {
            let memory = try await api.createMemory(create)
            insert(memory)
        } catch {
            throw note(error)
        }
    }

    /// A memory from any loaded list, for citation targets.
    public func memory(id: String) -> Memory? {
        if let memory = memories.items.first(where: { $0.id == id }) { return memory }
        for list in linkedMemories.values {
            if let memory = list.first(where: { $0.id == id }) { return memory }
        }
        return nil
    }

    private func insert(_ memory: Memory) {
        if matchesFilter(memory) { memories.upsert(memory) }
        if let conversationId = memory.sourceConversationId, var linked = linkedMemories[conversationId],
           !linked.contains(where: { $0.id == memory.id }) {
            linked.append(memory)
            linkedMemories[conversationId] = linked
        }
    }

    private func matchesFilter(_ memory: Memory) -> Bool {
        if let memoryKind, memory.kind != memoryKind { return false }
        if !memoryQuery.isEmpty {
            let haystack = ([memory.content] + memory.subjects).joined(separator: " ")
            return haystack.range(of: memoryQuery, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
        return true
    }

    // MARK: Ask

    /// Asks one question (one API call per question; the thread is local).
    public func ask(_ question: String, scope: AskScope) async {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let api = api() else { return }
        let turn = AskTurn(question: trimmed, scope: scope, isLoading: true)
        thread.append(turn)
        let range = scope.range(now: now(), timeZone: timeZone)
        do {
            let answer = try await api.ask(AskRequest(question: String(trimmed.prefix(2_000)), from: range.from, to: range.to))
            updateTurn(turn.id) { $0.answer = answer; $0.isLoading = false }
        } catch {
            let error = note(error)
            updateTurn(turn.id) { $0.error = error; $0.isLoading = false }
        }
    }

    public func clearThread() {
        thread.removeAll()
    }

    private func updateTurn(_ id: String, _ body: (inout AskTurn) -> Void) {
        guard let index = thread.firstIndex(where: { $0.id == id }) else { return }
        body(&thread[index])
    }

    // MARK: Capture pause (account-wide kill switch)

    public func setCapturePaused(_ paused: Bool) async throws {
        guard let api = api() else { throw LTMError.notPaired }
        do {
            let state = try await api.setCapturePaused(paused)
            applyPause(state.ingestPaused)
        } catch {
            throw note(error)
        }
    }

    /// Seeds the pause state (e.g. from `/me`).
    public func knownIngestPaused(_ paused: Bool) {
        ingestPaused = paused
    }

    private func applyPause(_ paused: Bool) {
        let changed = ingestPaused != paused
        ingestPaused = paused
        if changed { onCapturePaused?(paused) }
    }

    // MARK: Live events

    /// Follows `/events` with the given client; idempotent.
    public func startLive(_ client: LiveEventClient) {
        guard liveClient == nil else { return }
        liveClient = client
        liveTask = Task { [weak self] in
            await client.start()
            for await output in client.output {
                guard let self else { return }
                switch output {
                case .status(let status):
                    self.liveStatus = status
                    if status == .forbidden { self.access = .captureOnly }
                case .event(let event):
                    self.apply(event)
                }
            }
        }
    }

    public func stopLive() {
        liveTask?.cancel()
        liveTask = nil
        if let client = liveClient {
            Task { await client.stop() }
        }
        liveClient = nil
        liveStatus = .stopped
    }

    public var isLive: Bool { liveClient != nil }

    /// Forgets everything (un-pairing, or pairing with another server).
    public func reset() {
        stopLive()
        access = .unknown
        today = .idle
        days = PagedList()
        dayDetails = [:]
        conversations = PagedList()
        conversationQuery = ""
        conversationDetails = [:]
        linkedMemories = [:]
        memories = PagedList()
        memoryQuery = ""
        memoryKind = nil
        thread = []
        ingestPaused = nil
        liveCaption = nil
        activeStreamIds = []
        lastError = nil
        staleConversations = []
        staleDays = []
    }

    /// Applies one live event to the caches. Unknown events are ignored.
    public func apply(_ event: LiveEvent) {
        switch event {
        case .conversationUpdated(let summary):
            let newestFirst: (ConversationSummary, ConversationSummary) -> Bool = { $0.startMs > $1.startMs }
            conversations.upsert(summary, insertIfMissing: conversationQuery.isEmpty && conversations.loaded, before: newestFirst)
            if var detail = conversationDetails[summary.id] {
                detail.conversation = summary
                conversationDetails[summary.id] = detail
                staleConversations.insert(summary.id)
            }
            let date = DayDate.string(for: EpochMs.date(summary.startMs), timeZone: timeZone)
            if var detail = dayDetails[date] {
                if let index = detail.conversations.firstIndex(where: { $0.id == summary.id }) {
                    detail.conversations[index] = summary
                } else {
                    detail.conversations.append(summary)
                    detail.conversations.sort { $0.startMs < $1.startMs }
                }
                dayDetails[date] = detail
                if date == todayDate { today = .loaded(detail) }
            }
        case .conversationDeleted(let id):
            conversations.remove(id: id)
            conversationDetails[id] = nil
            linkedMemories[id] = nil
            for (date, var detail) in dayDetails where detail.conversations.contains(where: { $0.id == id }) {
                detail.conversations.removeAll { $0.id == id }
                detail.actionItems.removeAll { $0.conversationId == id }
                dayDetails[date] = detail
                if date == todayDate { today = .loaded(detail) }
            }
        case .memoryCreated(let memory):
            insert(memory)
        case .dayUpdated(let summary):
            days.upsert(summary, insertIfMissing: days.loaded, before: { $0.date > $1.date })
            if var detail = dayDetails[summary.date] {
                detail.day = summary
                dayDetails[summary.date] = detail
                staleDays.insert(summary.date)
                if summary.date == todayDate { today = .loaded(detail) }
            }
            if summary.date == todayDate {
                // The digest itself (highlights, action items) is only in the detail.
                Task { await self.day(summary.date, force: true) }
            }
        case .capturePaused(let paused):
            applyPause(paused)
        case .segment(_, _, let segment):
            liveCaption = segment.text
        case .streamStarted(let stream):
            activeStreamIds.insert(stream.id)
        case .streamEnded(let streamId):
            activeStreamIds.remove(streamId)
        case .unknown:
            break
        }
    }
}
