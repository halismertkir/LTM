import XCTest
@testable import LTMKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class SSEParsingTests: XCTestCase {
    private func parse(_ text: String) -> [SSEMessage] {
        var splitter = SSELineSplitter()
        var parser = SSEParser()
        return splitter.feed(Array(text.utf8)).compactMap { parser.feed(line: $0) }
    }

    func testServerFraming() {
        // Exactly what apps/server writes: a comment on connect, heartbeats, data lines.
        let messages = parse(": connected\n\ndata: {\"type\":\"capture_paused\",\"ingestPaused\":true}\n\n: ping\n\n")
        XCTAssertEqual(messages, [SSEMessage(data: #"{"type":"capture_paused","ingestPaused":true}"#)])
    }

    func testLineEndingsAndMultilineData() {
        XCTAssertEqual(parse("data: a\r\ndata: b\r\n\r\n").map(\.data), ["a\nb"])
        XCTAssertEqual(parse("data: x\r\rdata: y\n\n").map(\.data), ["x", "y"], "a lone CR ends a line")
        XCTAssertEqual(parse("data:no-space\n\n").map(\.data), ["no-space"])
        XCTAssertEqual(parse("data\n\n").map(\.data), [""], "a field without colon has an empty value")
    }

    func testEventIdRetryAndIncompleteTail() {
        var splitter = SSELineSplitter()
        var parser = SSEParser()
        let lines = splitter.feed(Array("event: custom\nid: 7\nretry: 5000\ndata: one\n\ndata: unfinished".utf8))
        let messages = lines.compactMap { parser.feed(line: $0) }
        XCTAssertEqual(messages, [SSEMessage(event: "custom", data: "one", id: "7")])
        XCTAssertEqual(parser.retryMs, 5_000)
        XCTAssertEqual(parser.lastEventId, "7")
        // The unfinished event is held back until its blank line arrives.
        let rest = splitter.feed(Array("\n\n".utf8)).compactMap { parser.feed(line: $0) }
        XCTAssertEqual(rest.map(\.data), ["unfinished"])
        XCTAssertEqual(rest.first?.event, "message", "the event name resets after dispatch")
    }

    func testSplitsAcrossChunkBoundariesAndUTF8() {
        var splitter = SSELineSplitter()
        let bytes = Array("data: çğü\r\n\r\n".utf8)
        var lines: [String] = []
        for byte in bytes { if let line = splitter.feed(byte) { lines.append(line) } }
        XCTAssertEqual(lines, ["data: çğü", ""])
    }
}

final class LiveEventDecodingTests: XCTestCase {
    func testKnownEvents() {
        XCTAssertEqual(LiveEvent.decode(#"{"type":"capture_paused","ingestPaused":false}"#), .capturePaused(ingestPaused: false))
        XCTAssertEqual(LiveEvent.decode(#"{"type":"stream_ended","streamId":"s1"}"#), .streamEnded(streamId: "s1"))
        XCTAssertEqual(LiveEvent.decode(#"{"type":"conversation_deleted","conversationId":"c1"}"#), .conversationDeleted(conversationId: "c1"))

        let day = LiveEvent.decode(#"""
        {"type":"day_updated","day":{"date":"2026-11-20","status":"ready","headline":"Planning","summary":"s",
         "conversationCount":3,"speechMinutes":42.5,"openActionItems":2,"updatedAt":"2026-11-20T10:00:00.000Z"}}
        """#)
        XCTAssertEqual(day, .dayUpdated(DaySummary(date: "2026-11-20", status: .ready, headline: "Planning", summary: "s",
                                                   conversationCount: 3, speechMinutes: 42.5, openActionItems: 2, updatedAt: "2026-11-20T10:00:00.000Z")))

        guard case .segment(let streamId, let deviceId, let segment) = LiveEvent.decode(#"""
        {"type":"segment","streamId":"s1","deviceId":"d1","segment":{"startMs":1,"endMs":2,"text":"merhaba","origin":"server_stt"}}
        """#) else { return XCTFail("segment") }
        XCTAssertEqual([streamId, deviceId, segment.text], ["s1", "d1", "merhaba"])

        guard case .memoryCreated(let memory) = LiveEvent.decode(#"""
        {"type":"memory_created","memory":{"id":"m1","kind":"person","content":"Ayşe leads design.","importance":4,"subjects":["Ayşe"],
         "sourceConversationId":"c1","origin":"extracted","occurredAt":null,"createdAt":"x","updatedAt":"y"}}
        """#) else { return XCTFail("memory") }
        XCTAssertEqual(memory.kind, .person)
        XCTAssertEqual(memory.sourceConversationId, "c1")
    }

    func testUnknownAndMalformedEventsNeverFail() {
        XCTAssertEqual(LiveEvent.decode(#"{"type":"brand_new_event","x":1}"#), .unknown(type: "brand_new_event"))
        XCTAssertEqual(LiveEvent.decode(#"{"type":"day_updated","day":"not an object"}"#), .unknown(type: "day_updated"))
        XCTAssertEqual(LiveEvent.decode("not json"), .unknown(type: ""))
    }
}

/// Serves scripted SSE responses, one per connection attempt.
final class FakeEventSource: EventByteSource, @unchecked Sendable {
    struct Response {
        var status: Int
        var chunks: [String]
        /// Keep the stream open after the chunks (until the test ends).
        var holdOpen = false
    }

    private let responses: LockedBox<[Response]>
    private let requests = LockedBox<[URLRequest]>([])

    init(_ responses: [Response]) {
        self.responses = LockedBox(responses)
    }

    var openCount: Int { requests.get().count }
    var lastRequest: URLRequest? { requests.get().last }

    func open(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<[UInt8], Error>) {
        requests.withValue { $0.append(request) }
        let next: Response? = responses.withValue { value in value.isEmpty ? nil : value.removeFirst() }
        guard let next else { throw URLError(.cannotConnectToHost) }
        let stream = AsyncThrowingStream<[UInt8], Error> { continuation in
            for chunk in next.chunks { continuation.yield(Array(chunk.utf8)) }
            if !next.holdOpen { continuation.finish() }
        }
        return (next.status, stream)
    }
}

final class LiveEventClientTests: XCTestCase {
    let server = ServerConfig.parse("https://ltm.example.com")!

    private func client(_ source: FakeEventSource) -> LiveEventClient {
        LiveEventClient(server: server, token: "device_token_0123456789", source: source,
                        backoff: BackoffPolicy(baseDelay: 0.01, multiplier: 1, maxDelay: 0.02, jitter: 0))
    }

    private func collect(_ client: LiveEventClient, until predicate: @escaping ([LiveEventClient.Output]) -> Bool) async -> [LiveEventClient.Output] {
        await client.start()
        var outputs: [LiveEventClient.Output] = []
        let deadline = Date().addingTimeInterval(3)
        for await output in client.output {
            outputs.append(output)
            if predicate(outputs) || Date() > deadline { break }
        }
        return outputs
    }

    func testDeliversEventsAcrossChunksAndReconnects() async {
        let source = FakeEventSource([
            .init(status: 200, chunks: [": connected\n\n", "data: {\"type\":\"capture_pa", "used\",\"ingestPaused\":true}\n", "\n"]),
            .init(status: 200, chunks: ["data: {\"type\":\"stream_ended\",\"streamId\":\"s9\"}\n\n"], holdOpen: true),
        ])
        let live = client(source)
        let outputs = await collect(live) { outputs in
            outputs.contains(.event(.streamEnded(streamId: "s9")))
        }
        let events = outputs.compactMap { output -> LiveEvent? in
            if case .event(let event) = output { return event }
            return nil
        }
        XCTAssertEqual(events, [.capturePaused(ingestPaused: true), .streamEnded(streamId: "s9")])
        XCTAssertEqual(source.openCount, 2, "reconnected after the first stream ended")
        XCTAssertTrue(outputs.contains(.status(.connected)))
        XCTAssertEqual(source.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer device_token_0123456789")
        XCTAssertEqual(source.lastRequest?.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(source.lastRequest?.url?.absoluteString, "https://ltm.example.com/api/v1/events")
        await live.stop()
    }

    func testForbiddenStopsForGood() async {
        let source = FakeEventSource([.init(status: 403, chunks: []), .init(status: 200, chunks: [])])
        let live = client(source)
        let outputs = await collect(live) { $0.contains(.status(.forbidden)) }
        XCTAssertEqual(outputs.last, .status(.forbidden))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(source.openCount, 1)
        let status = await live.status
        XCTAssertEqual(status, .forbidden)
    }

    func testUnauthorizedStops() async {
        let source = FakeEventSource([.init(status: 401, chunks: [])])
        let outputs = await collect(client(source)) { $0.contains(.status(.unauthorized)) }
        XCTAssertEqual(outputs.last, .status(.unauthorized))
    }

    func testRetriesAfterServerErrorAndNetworkFailure() async {
        let source = FakeEventSource([
            .init(status: 503, chunks: []),
            // (second attempt: no response scripted → network error)
        ])
        let live = client(source)
        let outputs = await collect(live) { outputs in
            outputs.filter { if case .status(.waiting) = $0 { return true } else { return false } }.count >= 2
        }
        XCTAssertGreaterThanOrEqual(source.openCount, 2)
        XCTAssertTrue(outputs.contains(.status(.waiting(attempt: 1, delay: 0.01))))
        await live.stop()
    }
}
