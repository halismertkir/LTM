import XCTest
@testable import LTMKit

/// Drives `StreamClient` with a fake socket: ordering, resume, buffering, fatal errors, end.
final class StreamClientTests: XCTestCase {
    let streamId = "3f0e9c9e-4f2b-4d5e-9a57-0d2f5f0f6a11"

    private func configuration(maxBufferedBytes: Int = 2 * 1024 * 1024) -> StreamClient.Configuration {
        var config = StreamClient.Configuration(
            url: URL(string: "wss://ltm.example.com/api/v1/ingest/ws")!,
            token: "device_token_0123456789",
            streamId: streamId,
            source: .mic,
            mode: .audio,
            audioFormat: .pcm16kMono,
            language: "en"
        )
        config.pingInterval = 3_600
        config.readyTimeout = 2
        config.closeTimeout = 2
        config.maxBufferedBytes = maxBufferedBytes
        config.backoff = BackoffPolicy(baseDelay: 0.01, multiplier: 1, maxDelay: 0.02, jitter: 0)
        return config
    }

    private var readyJSON: String {
        #"{"type":"ready","streamId":"\#(streamId)","serverTimeMs":1763000000000,"resumed":false}"#
    }

    private struct SentFrame {
        var seq: UInt32
        var time: Double
        var discontinuity: Bool
    }

    private func frames(_ socket: FakeSocket) -> [SentFrame] {
        socket.sentBinary.compactMap { data in
            guard let header = FrameEncoder.decodeHeader(data) else { return nil }
            return SentFrame(seq: header.seq, time: header.captureTimeMs, discontinuity: header.discontinuity)
        }
    }

    func testHelloFirstThenFramesInOrderAfterReady() async throws {
        let socket = FakeSocket()
        let client = StreamClient(configuration: configuration(), connector: FakeConnector([socket]))
        await client.start()

        let helloSent = await eventually { socket.sentFrames.count == 1 }
        XCTAssertTrue(helloSent)
        let hello = jsonObject(try XCTUnwrap(socket.sentTexts.first))
        XCTAssertEqual(hello["type"] as? String, "hello")
        XCTAssertEqual(hello["protocol"] as? Int, 1)
        XCTAssertEqual(hello["streamId"] as? String, streamId)
        XCTAssertEqual(hello["token"] as? String, "device_token_0123456789")
        XCTAssertEqual(hello["source"] as? String, "mic")
        XCTAssertEqual((hello["audio"] as? [String: Any])?["codec"] as? String, "pcm_s16le")

        await client.sendAudio(Data([1, 0]), captureTimeMs: 1_000, discontinuity: false)
        await client.sendAudio(Data([2, 0]), captureTimeMs: 1_200, discontinuity: false)
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(socket.sentFrames.count, 1, "nothing is sent before ready")

        socket.serverSends(readyJSON)
        await client.sendAudio(Data([3, 0]), captureTimeMs: 1_400, discontinuity: true)
        let allSent = await eventually { socket.sentBinary.count == 3 }
        XCTAssertTrue(allSent)
        XCTAssertEqual(frames(socket).map(\.seq), [0, 1, 2])
        XCTAssertEqual(frames(socket).map(\.time), [1_000, 1_200, 1_400])
        XCTAssertEqual(frames(socket).map(\.discontinuity), [false, false, true])
        let state = await client.state
        XCTAssertEqual(state, .ready(resumed: false))
        await client.cancel()
    }

    func testReconnectResumesSameStreamAndContinuesSeq() async throws {
        let first = FakeSocket()
        let second = FakeSocket()
        let connector = FakeConnector([first, second])
        let client = StreamClient(configuration: configuration(), connector: connector)
        await client.start()
        _ = await eventually { first.sentFrames.count == 1 }
        first.serverSends(readyJSON)
        await client.sendAudio(Data([1, 0]), captureTimeMs: 1_000, discontinuity: false)
        _ = await eventually { first.sentBinary.count == 1 }

        first.drop()
        await client.sendAudio(Data([2, 0]), captureTimeMs: 1_200, discontinuity: false)
        await client.sendAudio(Data([3, 0]), captureTimeMs: 1_400, discontinuity: false)

        let rehello = await eventually { second.sentTexts.count == 1 }
        XCTAssertTrue(rehello)
        XCTAssertEqual(jsonObject(second.sentTexts[0])["streamId"] as? String, streamId, "same streamId on reconnect")
        XCTAssertEqual(second.sentBinary.count, 0, "buffered until ready")

        second.serverSends(#"{"type":"ready","streamId":"\#(streamId)","serverTimeMs":1,"resumed":true}"#)
        let flushed = await eventually { second.sentBinary.count == 2 }
        XCTAssertTrue(flushed)
        XCTAssertEqual(frames(second).map(\.seq), [1, 2])
        XCTAssertEqual(frames(second).map(\.time), [1_200, 1_400])
        XCTAssertEqual(frames(first).map(\.seq), [0], "no duplicates of delivered frames")
        let state = await client.state
        XCTAssertEqual(state, .ready(resumed: true))
        XCTAssertEqual(connector.connectCount, 2)
        await client.cancel()
    }

    func testOfflineBufferIsBoundedAndFlagsDiscontinuity() async throws {
        let socket = FakeSocket()
        // Room for three 100-byte frames (plus 16-byte headers).
        let client = StreamClient(configuration: configuration(maxBufferedBytes: 3 * 116), connector: FakeConnector([socket]))
        await client.start()
        _ = await eventually { socket.sentFrames.count == 1 }
        for index in 0..<10 {
            await client.sendAudio(Data(repeating: UInt8(index), count: 100), captureTimeMs: Double(index) * 100, discontinuity: false)
        }
        let buffered = await client.bufferedBytes
        XCTAssertEqual(buffered, 3 * 116)

        socket.serverSends(readyJSON)
        let sent = await eventually { socket.sentBinary.count == 3 }
        XCTAssertTrue(sent)
        XCTAssertEqual(frames(socket).map(\.time), [700, 800, 900], "oldest frames were dropped")
        XCTAssertEqual(frames(socket).map(\.discontinuity), [true, false, false])
        XCTAssertEqual(frames(socket).map(\.seq), [0, 1, 2])
        await client.cancel()
    }

    func testFatalErrorStopsWithoutReconnecting() async throws {
        let socket = FakeSocket()
        let connector = FakeConnector([socket, FakeSocket()])
        let client = StreamClient(configuration: configuration(), connector: connector)
        await client.start()
        _ = await eventually { socket.sentFrames.count == 1 }
        socket.serverSends(#"{"type":"error","code":"consent_required","message":"accept the consent documents","fatal":true}"#)

        let failed = await eventually {
            if case .failed = await client.state { return true }
            return false
        }
        XCTAssertTrue(failed)
        let state = await client.state
        XCTAssertEqual(state, .failed(.server(code: .consentRequired, message: "accept the consent documents", status: nil)))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(connector.connectCount, 1)
    }

    func testUnauthorizedCloseCodeIsFatal() async throws {
        let socket = FakeSocket()
        let connector = FakeConnector([socket, FakeSocket()])
        let client = StreamClient(configuration: configuration(), connector: connector)
        await client.start()
        _ = await eventually { socket.sentFrames.count == 1 }
        socket.drop(closeCode: LTMCloseCode.unauthorized)
        let failed = await eventually {
            if case .failed(let error) = await client.state { return error.isUnauthorized }
            return false
        }
        XCTAssertTrue(failed)
        XCTAssertEqual(connector.connectCount, 1)
    }

    func testTransientServerErrorReconnects() async throws {
        let first = FakeSocket()
        let second = FakeSocket()
        let connector = FakeConnector([first, second])
        let client = StreamClient(configuration: configuration(), connector: connector)
        await client.start()
        _ = await eventually { first.sentFrames.count == 1 }
        first.serverSends(#"{"type":"error","code":"internal","message":"restarting","fatal":true}"#)
        let reconnected = await eventually { second.sentTexts.count == 1 }
        XCTAssertTrue(reconnected)
        await client.cancel()
    }

    func testFinishSendsEndAfterQueuedFramesAndWaitsForClosed() async throws {
        let socket = FakeSocket()
        let client = StreamClient(configuration: configuration(), connector: FakeConnector([socket]))
        await client.start()
        _ = await eventually { socket.sentFrames.count == 1 }
        socket.serverSends(readyJSON)
        _ = await eventually { await client.state == .ready(resumed: false) }
        await client.sendAudio(Data([1, 0]), captureTimeMs: 1, discontinuity: false)

        let finishing = Task { await client.finish() }
        let endSent = await eventually { socket.sentTexts.last == #"{"type":"end"}"# }
        XCTAssertTrue(endSent)
        XCTAssertEqual(socket.sentBinary.count, 1, "queued audio goes out before end")
        socket.serverSends(#"{"type":"closed","streamId":"\#(streamId)"}"#)
        let confirmed = await finishing.value
        XCTAssertTrue(confirmed)
        let state = await client.state
        XCTAssertEqual(state, .closed)
    }

    func testFinishTimesOutWhenServerNeverConfirms() async throws {
        let socket = FakeSocket()
        var config = configuration()
        config.closeTimeout = 0.2
        let client = StreamClient(configuration: config, connector: FakeConnector([socket]))
        await client.start()
        _ = await eventually { socket.sentFrames.count == 1 }
        socket.serverSends(readyJSON)
        _ = await eventually { await client.state == .ready(resumed: false) }
        let confirmed = await client.finish()
        XCTAssertFalse(confirmed)
        let state = await client.state
        XCTAssertEqual(state, .closed)
    }

    func testTranscriptModeSendsTranscriptMessages() async throws {
        let socket = FakeSocket()
        var config = configuration()
        config.mode = .transcript
        config.audioFormat = nil
        let client = StreamClient(configuration: config, connector: FakeConnector([socket]))
        await client.start()
        _ = await eventually { socket.sentFrames.count == 1 }
        XCTAssertNil(jsonObject(socket.sentTexts[0])["audio"], "no audio format in transcript mode")
        socket.serverSends(readyJSON)
        await client.sendTranscript([TranscriptSegment(id: "a", startMs: 1, endMs: 2, text: "selam", language: "tr")])
        let sent = await eventually { socket.sentTexts.count == 2 }
        XCTAssertTrue(sent)
        let message = jsonObject(socket.sentTexts[1])
        XCTAssertEqual(message["type"] as? String, "transcript")
        XCTAssertEqual((message["segments"] as? [[String: Any]])?.first?["text"] as? String, "selam")
        await client.cancel()
    }

    func testErrorClassification() {
        XCTAssertNotNil(failureIsFatal(StreamClient.failure(code: .ingestPaused, message: "", fatal: false)))
        XCTAssertNotNil(failureIsFatal(StreamClient.failure(code: .unsupportedProtocol, message: "", fatal: true)))
        XCTAssertNil(StreamClient.failure(code: .badRequest, message: "", fatal: false), "non-fatal bad_request is just reported")
        XCTAssertNil(failureIsFatal(StreamClient.failure(code: .internalError, message: "", fatal: true)), "fatal internal error → reconnect")
        XCTAssertNotNil(failureIsFatal(StreamClient.failure(forCloseCode: 4403)))
        XCTAssertNil(StreamClient.failure(forCloseCode: 4408), "hello timeout is transient")
    }

    private func failureIsFatal(_ failure: StreamClient.Failure?) -> LTMError? {
        if case .fatal(let error) = failure { return error }
        return nil
    }
}
