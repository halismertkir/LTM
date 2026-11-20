import XCTest
@testable import LTMKit

/// Literal JSON as the zod schemas in packages/protocol describe it.
final class ReaderDTOTests: XCTestCase {
    static let summaryJSON = #"""
    {"id":"c1","status":"open","startMs":1763600000000,"endMs":1763600900000.5,"title":"Sprint planning","summary":"We planned.",
     "topics":["sprint"],"participants":["Ayşe"],"language":"tr","deviceIds":["d1","d2"],"utteranceCount":42,
     "openActionItems":1,"interim":true,"updatedAt":"2026-11-20T10:15:00.000Z"}
    """#

    func testConversationSummary() throws {
        let summary = try LTMJSON.decode(ConversationSummary.self, from: Data(Self.summaryJSON.utf8))
        XCTAssertEqual(summary.status, .open)
        XCTAssertTrue(summary.interim)
        XCTAssertTrue(summary.isLive)
        XCTAssertEqual(summary.endMs, 1_763_600_900_000.5)
        XCTAssertEqual(summary.deviceIds, ["d1", "d2"])
        // A server without `interim` still decodes.
        let old = try LTMJSON.decode(ConversationSummary.self, from: Data(Self.summaryJSON.replacingOccurrences(of: #""interim":true,"#, with: "").utf8))
        XCTAssertFalse(old.interim)
    }

    func testConversationDetailComposesSummary() throws {
        let json = Self.summaryJSON.dropLast() + #"""
        ,"notes":"# Notes\n- one","decisions":["Ship Friday"],
         "actionItems":[{"id":"a1","text":"Write tests","owner":"me","due":"2026-11-21","done":false}],
         "utterances":[{"id":"u1","startMs":1,"endMs":2,"text":"Merhaba","speaker":"self","language":"tr",
                        "deviceIds":["d1","d2"],"sources":["mic","ambient"],"origin":"server_stt"}],
         "memoryIds":["m1"],"statusDetail":null}
        """#
        let detail = try LTMJSON.decode(ConversationDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.id, "c1")
        XCTAssertEqual(detail.conversation.title, "Sprint planning")
        XCTAssertEqual(detail.actionItems, [ActionItem(id: "a1", text: "Write tests", owner: "me", due: "2026-11-21", done: false)])
        XCTAssertEqual(detail.utterances.first?.sources, ["mic", "ambient"])
        XCTAssertEqual(detail.memoryIds, ["m1"])
        XCTAssertNil(detail.statusDetail)
    }

    func testDayDetailAndActionItems() throws {
        let json = #"""
        {"date":"2026-11-20","status":"ready","headline":"Planning day","summary":"Mostly planning.","conversationCount":2,
         "speechMinutes":95,"openActionItems":1,"updatedAt":null,"timeZone":"Europe/Istanbul","digest":"**Good** day",
         "highlights":["Sprint planned"],"decisions":["Ship Friday"],"people":["Ayşe"],
         "conversations":[\#(Self.summaryJSON)],
         "actionItems":[{"id":"a1","text":"Write tests","owner":null,"due":null,"done":false,"conversationId":"c1","conversationTitle":"Sprint planning"}],
         "statusDetail":null}
        """#
        let detail = try LTMJSON.decode(DayDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.id, "2026-11-20")
        XCTAssertEqual(detail.day.headline, "Planning day")
        XCTAssertEqual(detail.day.speechMinutes, 95)
        XCTAssertNil(detail.day.updatedAt)
        XCTAssertEqual(detail.timeZone, "Europe/Istanbul")
        XCTAssertEqual(detail.conversations.map(\.id), ["c1"])
        XCTAssertEqual(detail.actionItems.first?.item.text, "Write tests")
        XCTAssertEqual(detail.actionItems.first?.conversationId, "c1")
        XCTAssertEqual(detail.actionItems.first?.conversationTitle, "Sprint planning")
    }

    func testPagesMemoriesSearchAskStreamsDevice() throws {
        let page = try LTMJSON.decode(Page<Memory>.self, from: Data(#"""
        {"items":[{"id":"m1","kind":"preference","content":"Prefers async updates.","importance":3,"subjects":[],
                   "sourceConversationId":null,"origin":"manual","occurredAt":null,"createdAt":"a","updatedAt":"b"}],"nextCursor":"abc"}
        """#.utf8))
        XCTAssertEqual(page.items.first?.kind, .preference)
        XCTAssertEqual(page.nextCursor, "abc")
        XCTAssertNil(try LTMJSON.decode(Page<DaySummary>.self, from: Data(#"{"items":[],"nextCursor":null}"#.utf8)).nextCursor)

        let ask = try LTMJSON.decode(AskResponse.self, from: Data(#"""
        {"answer":"Friday [1].","citations":[{"type":"conversation","id":"c1","conversationId":"c1","title":"Planning",
          "snippet":"ship friday","score":0.9,"atMs":1763600000000}]}
        """#.utf8))
        XCTAssertEqual(ask.citations.first?.type, .conversation)

        let search = try LTMJSON.decode(SearchResponse.self, from: Data(#"""
        {"hits":[{"type":"utterance","id":"u1","conversationId":"c1","title":null,"snippet":"x","score":0.5,"atMs":null}],"mode":"keyword"}
        """#.utf8))
        XCTAssertNil(search.hits.first?.atMs)

        let streams = try LTMJSON.decode([StreamInfo].self, from: Data(#"""
        [{"id":"s1","deviceId":"d1","deviceName":"iPhone","source":"mic","mode":"audio","startedAt":"x","endedAt":null,"active":true,"context":null,"statusDetail":null}]
        """#.utf8))
        XCTAssertTrue(streams[0].active)

        let device = try LTMJSON.decode(Device.self, from: Data(#"""
        {"id":"d1","name":"iPhone","kind":"iphone","access":"memory","platform":"iOS 18","appVersion":"0.2.0","priority":null,
         "createdAt":"x","lastSeenAt":null,"online":true}
        """#.utf8))
        XCTAssertEqual(device.access, .memory)
        let legacy = try LTMJSON.decode(Device.self, from: Data(#"""
        {"id":"d1","name":"iPhone","kind":"iphone","platform":null,"appVersion":null,"priority":null,"createdAt":"x","lastSeenAt":null,"online":false}
        """#.utf8))
        XCTAssertNil(legacy.access)
    }

    func testRequestBodies() throws {
        assertJSONEqual(try LTMJSON.encode(ActionItemUpdate(done: true)), #"{"done":true}"#)
        assertJSONEqual(try LTMJSON.encode(MemoryCreate(kind: .person, content: "Ayşe leads design.", importance: 4, subjects: ["Ayşe"])),
                        #"{"kind":"person","content":"Ayşe leads design.","importance":4,"subjects":["Ayşe"]}"#)
        assertJSONEqual(try LTMJSON.encode(AskRequest(question: "What did we decide?", from: 1_763_596_800_000)),
                        #"{"question":"What did we decide?","from":1763596800000}"#)
        assertJSONEqual(try LTMJSON.encode(SearchRequest(query: "friday", limit: 10, types: [.memory])),
                        #"{"query":"friday","limit":10,"types":["memory"]}"#)
        assertJSONEqual(try LTMJSON.encode(CapturePause(paused: true)), #"{"paused":true}"#)
        XCTAssertEqual(try LTMJSON.decode(CapturePauseState.self, from: Data(#"{"ingestPaused":true}"#.utf8)), CapturePauseState(ingestPaused: true))
    }

    func testQueryEncodingEscapesPlusAndAmpersand() throws {
        let server = try XCTUnwrap(ServerConfig.parse("https://ltm.example.com"))
        let url = server.apiURL(LTMRoute.conversations, query: [("q", "c++ & ayşe=1"), ("limit", "30")])
        XCTAssertEqual(url.absoluteString, "https://ltm.example.com/api/v1/conversations?q=c%2B%2B%20%26%20ay%C5%9Fe%3D1&limit=30")
        XCTAssertEqual(server.apiURL(LTMRoute.memories, query: []).absoluteString, "https://ltm.example.com/api/v1/memories")
        XCTAssertEqual(LTMRoute.actionItem(conversationId: "c/1", itemId: "a?1"), "/conversations/c%2F1/action-items/a%3F1")
        XCTAssertEqual(LTMRoute.day("2026-11-20"), "/days/2026-11-20")
    }

    func testDayDates() {
        let istanbul = TimeZone(identifier: "Europe/Istanbul")!
        // 2026-11-19 22:30 UTC is already the 20th in Istanbul (UTC+3).
        let date = Date(timeIntervalSince1970: 1_795_127_400)
        XCTAssertEqual(DayDate.string(for: date, timeZone: istanbul), "2026-11-20")
        XCTAssertEqual(DayDate.string(for: date, timeZone: TimeZone(identifier: "UTC")!), "2026-11-19")
        XCTAssertEqual(DayDate.date(from: "2026-11-20", timeZone: istanbul).map { DayDate.string(for: $0, timeZone: istanbul) }, "2026-11-20")
        XCTAssertNil(DayDate.date(from: "20-11"))
    }
}

final class ReaderLogicTests: XCTestCase {
    private func memory(_ id: String) -> Memory { Memory(id: id, kind: .fact, content: id) }

    func testPagedListRefreshLoadMoreAndStaleResponses() {
        var list = PagedList<Memory>()
        XCTAssertNil(list.beginLoadMore(), "nothing to load before the first page")
        let first = list.beginRefresh()
        XCTAssertTrue(list.apply(Page(items: [memory("a"), memory("b"), memory("a")], nextCursor: "c1"), generation: first, replace: true))
        XCTAssertEqual(list.items.map(\.id), ["a", "b"], "duplicates within a page are dropped")
        let more = try! XCTUnwrap(list.beginLoadMore())
        XCTAssertEqual(more.cursor, "c1")
        XCTAssertNil(list.beginLoadMore(), "one load at a time")
        // A refresh starts while the page is in flight: the old page must be discarded.
        let second = list.beginRefresh()
        XCTAssertFalse(list.apply(Page(items: [memory("old")], nextCursor: nil), generation: more.generation, replace: false))
        XCTAssertTrue(list.apply(Page(items: [memory("b"), memory("c")], nextCursor: nil), generation: second, replace: true))
        XCTAssertEqual(list.items.map(\.id), ["b", "c"])
        XCTAssertTrue(list.reachedEnd)
        XCTAssertNil(list.beginLoadMore())

        list.upsert(memory("z"))
        XCTAssertEqual(list.items.map(\.id), ["z", "b", "c"])
        list.remove(id: "b")
        XCTAssertEqual(list.items.map(\.id), ["z", "c"])
        let failing = list.beginRefresh()
        list.fail(.transport("x"), generation: failing)
        XCTAssertEqual(list.error, .transport("x"))
        XCTAssertFalse(list.isLoading)
        XCTAssertEqual(list.items.map(\.id), ["z", "c"], "a failed refresh keeps what was shown")
    }

    func testSortedUpsert() {
        var list = PagedList<DaySummary>()
        let generation = list.beginRefresh()
        list.apply(Page(items: [DaySummary(date: "2026-11-20", status: .ready), DaySummary(date: "2026-11-18", status: .ready)], nextCursor: nil),
                   generation: generation, replace: true)
        list.upsert(DaySummary(date: "2026-11-19", status: .pending), before: { $0.date > $1.date })
        XCTAssertEqual(list.items.map(\.date), ["2026-11-20", "2026-11-19", "2026-11-18"])
    }

    func testCitations() {
        XCTAssertEqual(Citations.referenced(in: "We ship Friday [2], as agreed [1][2]. See [1, 3] and [9] and [x].", count: 3), [2, 1, 3])
        XCTAssertEqual(Citations.referenced(in: "No sources.", count: 0), [])
        XCTAssertEqual(Citations.target(of: SearchHit(type: .utterance, id: "u1", conversationId: "c1", snippet: "")), .conversation(id: "c1"))
        XCTAssertEqual(Citations.target(of: SearchHit(type: .memory, id: "m1", snippet: "")), .memory(id: "m1"))
        XCTAssertEqual(Citations.target(of: SearchHit(type: .conversation, id: "c2", snippet: "")), .conversation(id: "c2"))
        XCTAssertEqual(Citations.target(of: SearchHit(type: .utterance, id: "u2", snippet: "")), .none)
    }

    func testMarkdownBlocks() {
        let blocks = MarkdownBlocks.parse("""
        # Summary
        We **planned** the sprint
        and agreed on scope.

        ## Next
        - Write tests
          - nested
        1. Ship
        2) Review
        > quoted
        ---
        ```
        code line
        ```
        #nohash
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "Summary"),
            .paragraph(text: "We **planned** the sprint and agreed on scope."),
            .heading(level: 2, text: "Next"),
            .bullet(text: "Write tests", depth: 0),
            .bullet(text: "nested", depth: 1),
            .numbered(number: 1, text: "Ship"),
            .numbered(number: 2, text: "Review"),
            .quote(text: "quoted"),
            .rule,
            .code(text: "code line"),
            .paragraph(text: "#nohash"),
        ])
        XCTAssertEqual(MarkdownBlocks.parse(""), [])
    }

    func testAskScopeRanges() {
        let utc = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_795_170_600) // 2026-11-20 10:30 UTC
        XCTAssertEqual(AskScope.today.range(now: now, timeZone: utc).from, 1_795_132_800_000)
        XCTAssertEqual(AskScope.week.range(now: now, timeZone: utc).from, 1_795_170_600_000 - 7 * 86_400_000)
        XCTAssertNil(AskScope.all.range(now: now, timeZone: utc).from)
    }
}

// MARK: - MemoryStore against a fake API

final class FakeMemoryAPI: MemoryAPI, @unchecked Sendable {
    struct State {
        var device = Device(id: "d1", name: "iPhone", kind: "iphone", access: .memory, platform: nil, appVersion: nil,
                            priority: nil, createdAt: "", lastSeenAt: nil, online: true)
        var forbidden = false
        var days: [String: DayDetail] = [:]
        var conversationPages: [String?: Page<ConversationSummary>] = [:]
        var details: [String: ConversationDetail] = [:]
        var memories: [Memory] = []
        var failActionItems = false
        var askAnswer = AskResponse(answer: "Friday [1].", citations: [SearchHit(type: .conversation, id: "c1", snippet: "")])
        var calls: [String] = []
        var paused = false
    }

    let state = LockedBox(State())

    private func record(_ call: String) throws {
        let forbidden: Bool = state.withValue { value in
            value.calls.append(call)
            return value.forbidden
        }
        if forbidden && call != "deviceSelf" { throw LTMError.server(code: .forbidden, message: "capture only", status: 403) }
    }

    func deviceSelf() async throws -> Device {
        try record("deviceSelf")
        return state.get().device
    }

    func conversations(query: String?, from: Int64?, to: Int64?, limit: Int, cursor: String?) async throws -> Page<ConversationSummary> {
        try record("conversations q=\(query ?? "") cursor=\(cursor ?? "")")
        return state.get().conversationPages[cursor] ?? Page(items: [], nextCursor: nil)
    }

    func conversation(id: String) async throws -> ConversationDetail {
        try record("conversation \(id)")
        guard let detail = state.get().details[id] else { throw LTMError.server(code: .notFound, message: "", status: 404) }
        return detail
    }

    func updateActionItem(conversationId: String, itemId: String, update: ActionItemUpdate) async throws -> ActionItem {
        try record("actionItem \(itemId) done=\(update.done ?? false)")
        if state.get().failActionItems { throw LTMError.transport("offline") }
        return ActionItem(id: itemId, text: "", done: update.done ?? false)
    }

    func memories(query: String?, kind: MemoryKind?, conversationId: String?, limit: Int, cursor: String?) async throws -> Page<Memory> {
        try record("memories q=\(query ?? "") kind=\(kind?.rawValue ?? "") conversation=\(conversationId ?? "")")
        let all = state.get().memories
        return Page(items: all.filter { (kind == nil || $0.kind == kind) && (conversationId == nil || $0.sourceConversationId == conversationId) }, nextCursor: nil)
    }

    func createMemory(_ memory: MemoryCreate) async throws -> Memory {
        try record("createMemory")
        return Memory(id: "new", kind: memory.kind, content: memory.content, importance: memory.importance, subjects: memory.subjects)
    }

    func search(_ request: SearchRequest) async throws -> SearchResponse {
        try record("search")
        return SearchResponse(hits: [], mode: "keyword")
    }

    func ask(_ request: AskRequest) async throws -> AskResponse {
        try record("ask from=\(request.from.map(String.init) ?? "")")
        return state.get().askAnswer
    }

    func days(from: String?, to: String?, limit: Int, cursor: String?) async throws -> Page<DaySummary> {
        try record("days")
        return Page(items: state.get().days.values.map(\.day).sorted { $0.date > $1.date }, nextCursor: nil)
    }

    func day(date: String) async throws -> DayDetail {
        try record("day \(date)")
        guard let detail = state.get().days[date] else { throw LTMError.server(code: .notFound, message: "", status: 404) }
        return detail
    }

    func streams(activeOnly: Bool) async throws -> [StreamInfo] {
        try record("streams")
        return []
    }

    func setCapturePaused(_ paused: Bool) async throws -> CapturePauseState {
        try record("pause \(paused)")
        state.withValue { $0.paused = paused }
        return CapturePauseState(ingestPaused: paused)
    }
}

final class MemoryStoreTests: XCTestCase {
    let utc = TimeZone(identifier: "UTC")!
    let now = Date(timeIntervalSince1970: 1_795_170_600) // 2026-11-20 10:30 UTC

    private func summary(_ id: String, startMs: Double, title: String = "t", interim: Bool = false) -> ConversationSummary {
        ConversationSummary(id: id, status: interim ? .open : .ready, startMs: startMs, endMs: startMs + 1, title: title, summary: nil, interim: interim)
    }

    @MainActor
    private func makeStore(_ api: FakeMemoryAPI) -> MemoryStore {
        let now = self.now
        return MemoryStore(api: { api }, pageSize: 2, now: { now }, timeZone: utc)
    }

    @MainActor
    func testAccessFromDeviceSelfAndForbidden() async {
        let api = FakeMemoryAPI()
        let store = makeStore(api)
        await store.checkAccess()
        XCTAssertEqual(store.access, .memory)

        api.state.withValue { $0.device.access = .capture }
        await store.checkAccess()
        XCTAssertEqual(store.access, .captureOnly)

        // Legacy server: no `access` field, but reading answers 403.
        api.state.withValue { $0.device.access = nil; $0.forbidden = true }
        await store.checkAccess()
        XCTAssertEqual(store.access, .memory)
        await store.refreshConversations()
        XCTAssertEqual(store.access, .captureOnly, "a 403 anywhere means capture-only")
        XCTAssertEqual(store.conversations.error?.code, .forbidden)
    }

    @MainActor
    func testTodayDigestAndMissingDay() async {
        let api = FakeMemoryAPI()
        let store = makeStore(api)
        await store.loadToday()
        XCTAssertEqual(store.today, .loaded(nil), "404 means nothing captured today yet")
        XCTAssertEqual(api.state.get().calls.last, "day 2026-11-20")

        let detail = DayDetail(day: DaySummary(date: "2026-11-20", status: .ready, headline: "Planning"),
                               actionItems: [DayActionItem(item: ActionItem(id: "a1", text: "Tests", done: false), conversationId: "c1")])
        api.state.withValue { $0.days["2026-11-20"] = detail }
        await store.loadToday()
        XCTAssertEqual(store.today.value??.day.headline, "Planning")
    }

    @MainActor
    func testActionItemTickIsOptimisticAndRollsBack() async {
        let api = FakeMemoryAPI()
        let day = DayDetail(day: DaySummary(date: "2026-11-20", status: .ready),
                            actionItems: [DayActionItem(item: ActionItem(id: "a1", text: "Tests", done: false), conversationId: "c1")])
        let conversation = ConversationDetail(conversation: summary("c1", startMs: 1_795_165_200_000), actionItems: [ActionItem(id: "a1", text: "Tests", done: false)])
        api.state.withValue { $0.days["2026-11-20"] = day; $0.details["c1"] = conversation }
        let store = makeStore(api)
        await store.loadToday()
        await store.conversation("c1")

        await store.setActionItem(conversationId: "c1", itemId: "a1", done: true)
        XCTAssertEqual(store.today.value??.actionItems.first?.item.done, true)
        XCTAssertEqual(store.conversationDetails["c1"]?.actionItems.first?.done, true)

        api.state.withValue { $0.failActionItems = true }
        await store.setActionItem(conversationId: "c1", itemId: "a1", done: false)
        XCTAssertEqual(store.today.value??.actionItems.first?.item.done, true, "rolled back after the failure")
        XCTAssertEqual(store.conversationDetails["c1"]?.actionItems.first?.done, true)
        XCTAssertEqual(store.lastError, .transport("offline"))
    }

    @MainActor
    func testConversationSearchPagingAndCache() async {
        let api = FakeMemoryAPI()
        api.state.withValue {
            $0.conversationPages[nil] = Page(items: [summary("c3", startMs: 3), summary("c2", startMs: 2)], nextCursor: "p2")
            $0.conversationPages["p2"] = Page(items: [summary("c1", startMs: 1)], nextCursor: nil)
            $0.details["c1"] = ConversationDetail(conversation: summary("c1", startMs: 1), memoryIds: ["m1"])
            $0.memories = [Memory(id: "m1", kind: .fact, content: "x", sourceConversationId: "c1")]
        }
        let store = makeStore(api)
        await store.searchConversations("  planning ")
        XCTAssertEqual(store.conversationQuery, "planning")
        XCTAssertEqual(store.conversations.items.map(\.id), ["c3", "c2"])
        await store.conversationAppeared(store.conversations.items[1])
        XCTAssertEqual(store.conversations.items.map(\.id), ["c3", "c2", "c1"])
        XCTAssertTrue(store.conversations.reachedEnd)
        XCTAssertTrue(api.state.get().calls.contains("conversations q=planning cursor=p2"))

        await store.conversation("c1")
        XCTAssertEqual(store.linkedMemories["c1"]?.map(\.id), ["m1"])
        let callsBefore = api.state.get().calls.count
        await store.conversation("c1")
        XCTAssertEqual(api.state.get().calls.count, callsBefore, "served from the cache")
        store.apply(.conversationUpdated(summary("c1", startMs: 1, title: "Renamed")))
        XCTAssertEqual(store.conversationDetails["c1"]?.conversation.title, "Renamed")
        await store.conversation("c1")
        XCTAssertEqual(api.state.get().calls.count, callsBefore + 2, "a live update marks the detail stale (detail + linked memories)")
    }

    @MainActor
    func testLiveEventsUpdateCaches() async {
        let api = FakeMemoryAPI()
        api.state.withValue {
            $0.conversationPages[nil] = Page(items: [summary("c2", startMs: 2_000)], nextCursor: nil)
            $0.days["2026-11-20"] = DayDetail(day: DaySummary(date: "2026-11-20", status: .ready))
        }
        let store = makeStore(api)
        var pauses: [Bool] = []
        store.onCapturePaused = { pauses.append($0) }
        await store.refreshConversations()
        await store.refreshDays()
        await store.loadToday()

        // A conversation that started today (2026-11-20 10:00 UTC) appears in the list and in today's digest.
        let live = summary("c9", startMs: 1_795_168_800_000, title: "Live", interim: true)
        store.apply(.conversationUpdated(live))
        XCTAssertEqual(store.conversations.items.map(\.id), ["c9", "c2"])
        XCTAssertEqual(store.today.value??.conversations.map(\.id), ["c9"])

        store.apply(.dayUpdated(DaySummary(date: "2026-11-21", status: .pending)))
        XCTAssertEqual(store.days.items.map(\.date), ["2026-11-21", "2026-11-20"])

        store.apply(.capturePaused(ingestPaused: true))
        store.apply(.capturePaused(ingestPaused: true))
        XCTAssertEqual(store.ingestPaused, true)
        XCTAssertEqual(pauses, [true], "only changes are forwarded")

        store.apply(.memoryCreated(Memory(id: "m5", kind: .idea, content: "new idea")))
        await store.refreshMemories()
        store.apply(.memoryCreated(Memory(id: "m6", kind: .idea, content: "another")))
        XCTAssertEqual(store.memories.items.first?.id, "m6")

        store.apply(.conversationDeleted(conversationId: "c9"))
        XCTAssertEqual(store.conversations.items.map(\.id), ["c2"])
        XCTAssertEqual(store.today.value??.conversations, [])

        store.apply(.unknown(type: "future"))
        store.apply(.segment(streamId: "s", deviceId: "d", segment: LiveSegment(startMs: 0, endMs: 1, text: "hello", origin: "server_stt")))
        XCTAssertEqual(store.liveCaption, "hello")
    }

    @MainActor
    func testAskThreadScopeAndPause() async throws {
        let api = FakeMemoryAPI()
        let store = makeStore(api)
        await store.ask("  What did we decide?  ", scope: .today)
        XCTAssertEqual(store.thread.count, 1)
        XCTAssertEqual(store.thread[0].question, "What did we decide?")
        XCTAssertEqual(store.thread[0].answer?.answer, "Friday [1].")
        XCTAssertFalse(store.thread[0].isLoading)
        XCTAssertEqual(api.state.get().calls.last, "ask from=1795132800000")
        await store.ask("   ", scope: .all)
        XCTAssertEqual(store.thread.count, 1, "blank questions are ignored")

        try await store.setCapturePaused(true)
        XCTAssertEqual(store.ingestPaused, true)
        XCTAssertTrue(api.state.get().paused)

        try await store.addMemory(MemoryCreate(kind: .fact, content: "Remember this"))
        XCTAssertEqual(store.memories.items.first?.content, "Remember this")
    }
}
