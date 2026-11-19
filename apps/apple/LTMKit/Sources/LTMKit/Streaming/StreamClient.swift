import Foundation
import os

/// One ingest stream over the WebSocket (`packages/protocol/src/ws.ts`).
///
/// Lifecycle per connection: send `hello` → wait for `ready` → send queued frames /
/// transcripts in order, `ping` every `pingInterval` → on `end`, wait for `closed`.
/// When the socket drops the client reconnects with exponential back-off plus jitter and
/// resumes the *same* `streamId`; audio produced meanwhile waits in a bounded in-memory
/// buffer (oldest frames are dropped first, and the next frame is flagged DISCONTINUITY).
/// Errors that a reconnect cannot fix (`unauthorized`, `consent_required`, `ingest_paused`,
/// `unsupported_protocol`, `forbidden`) end the stream with `.failed`.
public actor StreamClient {
    public struct Configuration: Sendable {
        public var url: URL
        public var token: String
        public var streamId: String
        public var source: AudioSource
        public var mode: StreamMode
        public var audioFormat: AudioFormat?
        public var language: String?
        public var context: StreamContext?
        public var pingInterval: Double = 15
        public var readyTimeout: Double = 10
        public var closeTimeout: Double = 5
        /// Upper bound of audio/transcripts held while disconnected (~65 s of 16 kHz PCM).
        public var maxBufferedBytes: Int = 2 * 1024 * 1024
        public var backoff = BackoffPolicy()

        public init(
            url: URL,
            token: String,
            streamId: String,
            source: AudioSource,
            mode: StreamMode,
            audioFormat: AudioFormat? = nil,
            language: String? = nil,
            context: StreamContext? = nil
        ) {
            self.url = url
            self.token = token
            self.streamId = streamId
            self.source = source
            self.mode = mode
            self.audioFormat = audioFormat
            self.language = language
            self.context = context
        }
    }

    public enum State: Sendable, Equatable {
        case idle
        case connecting(attempt: Int)
        case ready(resumed: Bool)
        case waitingToReconnect(attempt: Int, delay: Double)
        case closed
        case failed(LTMError)
    }

    public enum Event: Sendable, Equatable {
        case state(State)
        case segment(LiveSegment)
        /// Estimated server-minus-device clock offset from a ping round trip, in ms.
        case clockOffset(Double)
        /// A non-fatal `error` message from the server.
        case serverError(code: ErrorCode, message: String)
        /// Frames dropped because the offline buffer was full.
        case droppedFrames(Int)
    }

    // MARK: Internal types

    private enum Payload: Sendable {
        case frame(data: Data, captureTimeMs: Double)
        case transcript(text: String)

        var byteCount: Int {
            switch self {
            case .frame(let data, _): return data.count + FrameEncoder.headerBytes
            case .transcript(let text): return text.utf8.count
            }
        }

        var isFrame: Bool {
            if case .frame = self { return true }
            return false
        }
    }

    private struct Item: Sendable {
        let id: UInt64
        let payload: Payload
        var discontinuity: Bool
        /// Assigned on the first send attempt and reused on retries so a frame keeps its seq.
        var seq: UInt32?
    }

    enum Failure: Error {
        case fatal(LTMError)
        case transient(String)
    }

    private enum SessionSignal: Sendable {
        case closedByServer
        case writerStopped
        case pingStopped
    }

    private enum Outcome {
        case finished
        case fatal(LTMError)
        case transient(reachedReady: Bool)
    }

    // MARK: State

    public let configuration: Configuration
    public nonisolated let events: AsyncStream<Event>
    private let eventContinuation: AsyncStream<Event>.Continuation
    private let connector: any WebSocketConnector
    private let sleeper: any Sleeper
    private let now: @Sendable () -> Date
    private let random: @Sendable () -> Double

    public private(set) var state: State = .idle
    private var queue: [Item] = []
    private var queuedBytes = 0
    private var nextItemId: UInt64 = 0
    private var nextSeq: UInt32 = 0
    private var inFlightId: UInt64?
    private var control: [String] = []
    private var connection: (any WebSocketConnection)?
    private var writerSignal: AsyncStream<Void>.Continuation?
    private var runTask: Task<Void, Never>?
    private var stopRequested = false
    private var endRequested = false
    private var endSent = false
    private var finished = false
    private var finishWaiters: [CheckedContinuation<Void, Never>] = []
    private var droppedSinceReport = 0
    private var closeConfirmed = false

    public init(
        configuration: Configuration,
        connector: any WebSocketConnector,
        sleeper: any Sleeper = TaskSleeper(),
        now: @escaping @Sendable () -> Date = { Date() },
        random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
    ) {
        self.configuration = configuration
        self.connector = connector
        self.sleeper = sleeper
        self.now = now
        self.random = random
        var continuation: AsyncStream<Event>.Continuation?
        self.events = AsyncStream(bufferingPolicy: .bufferingNewest(256)) { continuation = $0 }
        // The build closure runs synchronously inside AsyncStream.init.
        self.eventContinuation = continuation!
    }

    // MARK: Public API

    /// Starts connecting. Idempotent.
    public func start() {
        guard runTask == nil, !finished else { return }
        runTask = Task { await self.run() }
    }

    /// Queues one block of 16-bit PCM. `captureTimeMs` is the device-clock time of its first sample.
    public func sendAudio(_ pcm: Data, captureTimeMs: Double, discontinuity: Bool) {
        guard !finished, !endRequested else { return }
        enqueue(.frame(data: pcm, captureTimeMs: captureTimeMs), discontinuity: discontinuity)
    }

    /// Queues on-device transcript segments (`mode: "transcript"` streams).
    public func sendTranscript(_ segments: [TranscriptSegment]) {
        guard !finished, !endRequested, !segments.isEmpty else { return }
        // The protocol caps one message at 200 segments.
        var start = 0
        while start < segments.count {
            let slice = Array(segments[start..<min(start + 200, segments.count)])
            if let text = try? LTMJSON.encodeString(ClientTranscript(segments: slice)) {
                enqueue(.transcript(text: text), discontinuity: false)
            }
            start += 200
        }
    }

    /// Flushes what is queued, sends `end` and waits for `closed` (bounded by
    /// `closeTimeout`). Returns true when the server confirmed `closed`; otherwise the
    /// caller may end the stream over REST (`POST /ingest/streams/:id/end`).
    @discardableResult
    public func finish() async -> Bool {
        guard !finished else { return closeConfirmed }
        endRequested = true
        writerSignal?.yield(())
        let timeout = configuration.closeTimeout
        let sleeper = self.sleeper
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.waitUntilFinished() }
            group.addTask {
                do {
                    try await sleeper.sleep(seconds: timeout)
                    await self.cancel()
                } catch {
                    // Cancelled because the stream closed in time.
                }
            }
            _ = await group.next()
            group.cancelAll()
        }
        return closeConfirmed
    }

    /// Stops immediately without sending `end` (the server finalises after a grace period).
    public func cancel() {
        stopRequested = true
        if let connection { teardown(connection) }
        runTask?.cancel()
        finishRun(.closed)
    }

    /// Bytes waiting to be sent.
    public var bufferedBytes: Int { queuedBytes }

    // MARK: Queue

    private func enqueue(_ payload: Payload, discontinuity: Bool) {
        nextItemId &+= 1
        queue.append(Item(id: nextItemId, payload: payload, discontinuity: discontinuity, seq: nil))
        queuedBytes += payload.byteCount
        trimBuffer()
        writerSignal?.yield(())
    }

    /// Drops the oldest frames (never the one being sent) until the buffer fits.
    private func trimBuffer() {
        var dropped = 0
        while queuedBytes > configuration.maxBufferedBytes {
            guard let index = queue.firstIndex(where: { $0.id != inFlightId && $0.payload.isFrame }) else { break }
            let removed = queue.remove(at: index)
            queuedBytes -= removed.payload.byteCount
            dropped += 1
            if let next = queue[index...].firstIndex(where: { $0.payload.isFrame }) {
                queue[next].discontinuity = true
            }
        }
        if dropped > 0 {
            droppedSinceReport += dropped
            Log.stream.notice("offline buffer full, dropped \(dropped) frame(s)")
            emit(.droppedFrames(dropped))
        }
    }

    // MARK: Run loop

    private func run() async {
        var attempt = 0
        while !stopRequested && !finished {
            setState(.connecting(attempt: attempt))
            let outcome = await connectOnce()
            if stopRequested || finished { break }
            switch outcome {
            case .finished:
                finishRun(.closed)
                return
            case .fatal(let error):
                Log.stream.error("stream failed: \(String(describing: error), privacy: .public)")
                finishRun(.failed(error))
                return
            case .transient(let reachedReady):
                attempt = reachedReady ? 1 : attempt + 1
                let delay = configuration.backoff.delay(forAttempt: attempt, random: random())
                setState(.waitingToReconnect(attempt: attempt, delay: delay))
                do {
                    try await sleeper.sleep(seconds: delay)
                } catch {
                    // Cancelled: the loop condition decides.
                }
            }
        }
        finishRun(.closed)
    }

    private func connectOnce() async -> Outcome {
        let conn: any WebSocketConnection
        do {
            conn = try connector.connect(url: configuration.url)
        } catch {
            return .transient(reachedReady: false)
        }
        connection = conn
        var reachedReady = false
        do {
            let hello = try helloJSON()
            try await conn.send(.text(hello))
            let resumed = try await awaitReady(conn)
            reachedReady = true
            endSent = false
            setState(.ready(resumed: resumed))
            try await runSession(conn)
            teardown(conn)
            return .finished
        } catch let failure as Failure {
            teardown(conn)
            switch failure {
            case .fatal(let error): return .fatal(error)
            case .transient: return .transient(reachedReady: reachedReady)
            }
        } catch {
            teardown(conn)
            if let failure = Self.failure(forCloseCode: conn.closeCode), case .fatal(let error) = failure {
                return .fatal(error)
            }
            return .transient(reachedReady: reachedReady)
        }
    }

    private func helloJSON() throws -> String {
        let hello = ClientHello(
            token: configuration.token,
            streamId: configuration.streamId,
            source: configuration.source,
            mode: configuration.mode,
            audio: configuration.mode == .audio ? (configuration.audioFormat ?? .pcm16kMono) : nil,
            clientTimeMs: EpochMs.from(now()),
            language: configuration.language,
            context: configuration.context
        )
        return try LTMJSON.encodeString(hello)
    }

    /// Receives until `ready`, bounded by `readyTimeout`.
    private func awaitReady(_ conn: any WebSocketConnection) async throws -> Bool {
        let timeout = configuration.readyTimeout
        let sleeper = self.sleeper
        return try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask { try await StreamClient.receiveUntilReady(conn) }
            group.addTask {
                try await sleeper.sleep(seconds: timeout)
                conn.close()
                throw Failure.transient("ready timeout")
            }
            defer { group.cancelAll() }
            guard let resumed = try await group.next() else { throw Failure.transient("no ready") }
            return resumed
        }
    }

    private static func receiveUntilReady(_ conn: any WebSocketConnection) async throws -> Bool {
        while true {
            let frame: WebSocketFrame
            do {
                frame = try await conn.receive()
            } catch {
                if let failure = failure(forCloseCode: conn.closeCode) { throw failure }
                throw Failure.transient("socket closed before ready")
            }
            guard case .text(let text) = frame, let decoded = try? ServerMessage.decode(text) else { continue }
            switch decoded {
            case .ready(_, _, let resumed):
                return resumed
            case .error(let code, let message, let fatal):
                if let failure = failure(code: code, message: message, fatal: fatal) { throw failure }
            default:
                continue
            }
        }
    }

    /// Runs writer, reader and pinger until the server confirms `closed` (normal end) or
    /// something fails. Always tears the connection down before returning so no child
    /// task is left waiting.
    private func runSession(_ conn: any WebSocketConnection) async throws {
        var signalContinuation: AsyncStream<Void>.Continuation?
        let signals = AsyncStream<Void>(bufferingPolicy: .bufferingNewest(1)) { signalContinuation = $0 }
        writerSignal = signalContinuation
        let pingInterval = configuration.pingInterval
        let sleeper = self.sleeper

        try await withThrowingTaskGroup(of: SessionSignal.self) { group in
            group.addTask { try await self.receiveLoop(conn) }
            group.addTask { try await self.writeLoop(conn, signals: signals) }
            group.addTask {
                while !Task.isCancelled {
                    try await sleeper.sleep(seconds: pingInterval)
                    await self.enqueuePing()
                }
                return .pingStopped
            }
            do {
                let first = try await group.next()
                await self.teardown(conn)
                group.cancelAll()
                switch first {
                case .closedByServer:
                    if await self.endRequested {
                        await self.markCloseConfirmed()
                        return
                    }
                    throw Failure.transient("server closed the stream")
                default:
                    throw Failure.transient("session stopped")
                }
            } catch {
                await self.teardown(conn)
                group.cancelAll()
                throw error
            }
        }
    }

    private func receiveLoop(_ conn: any WebSocketConnection) async throws -> SessionSignal {
        while true {
            let frame: WebSocketFrame
            do {
                frame = try await conn.receive()
            } catch {
                if let failure = Self.failure(forCloseCode: conn.closeCode) { throw failure }
                throw Failure.transient("socket closed")
            }
            guard case .text(let text) = frame, let decoded = try? ServerMessage.decode(text) else { continue }
            switch decoded {
            case .segment(let segment):
                emit(.segment(segment))
            case .pong(let clientTimeMs, let serverTimeMs):
                let receivedMs = now().timeIntervalSince1970 * 1000
                let midpoint = (clientTimeMs + receivedMs) / 2
                emit(.clockOffset(serverTimeMs - midpoint))
            case .error(let code, let message, let fatal):
                if let failure = Self.failure(code: code, message: message, fatal: fatal) { throw failure }
                emit(.serverError(code: code, message: message))
            case .closed:
                return .closedByServer
            case .ready, .unknown:
                continue
            }
        }
    }

    private func writeLoop(_ conn: any WebSocketConnection, signals: AsyncStream<Void>) async throws -> SessionSignal {
        try await drain(conn)
        for await _ in signals {
            guard isCurrent(conn) else { break }
            try await drain(conn)
        }
        return .writerStopped
    }

    /// Sends control messages first, then queued items in order, then `end` once the
    /// queue is empty and an end was requested.
    private func drain(_ conn: any WebSocketConnection) async throws {
        while isCurrent(conn) {
            if !control.isEmpty {
                let message = control.removeFirst()
                try await conn.send(.text(message))
                continue
            }
            guard var item = queue.first else {
                if endRequested && !endSent {
                    endSent = true
                    let end = try LTMJSON.encodeString(ClientEnd())
                    try await conn.send(.text(end))
                }
                return
            }
            // Only audio frames carry a seq; transcript messages must not leave gaps in it.
            if item.seq == nil && item.payload.isFrame {
                item.seq = nextSeq
                nextSeq &+= 1
                queue[0].seq = item.seq
            }
            inFlightId = item.id
            let frame: WebSocketFrame
            switch item.payload {
            case .frame(let data, let captureTimeMs):
                frame = .binary(FrameEncoder.encode(seq: item.seq ?? 0, captureTimeMs: captureTimeMs, discontinuity: item.discontinuity, payload: data))
            case .transcript(let text):
                frame = .text(text)
            }
            do {
                try await conn.send(frame)
            } catch {
                inFlightId = nil
                throw Failure.transient("send failed")
            }
            inFlightId = nil
            if let first = queue.first, first.id == item.id {
                queue.removeFirst()
                queuedBytes -= first.payload.byteCount
            }
        }
    }

    private func markCloseConfirmed() {
        closeConfirmed = true
    }

    private func enqueuePing() {
        guard connection != nil else { return }
        if let text = try? LTMJSON.encodeString(ClientPing(clientTimeMs: EpochMs.from(now()))) {
            control.append(text)
            writerSignal?.yield(())
        }
    }

    private func isCurrent(_ conn: any WebSocketConnection) -> Bool {
        guard let connection else { return false }
        return connection === conn
    }

    private func teardown(_ conn: any WebSocketConnection) {
        guard isCurrent(conn) else { return }
        connection = nil
        control.removeAll()
        inFlightId = nil
        writerSignal?.finish()
        writerSignal = nil
        conn.close()
    }

    // MARK: Completion

    private func waitUntilFinished() async {
        if finished { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            if finished {
                continuation.resume()
            } else {
                finishWaiters.append(continuation)
            }
        }
    }

    private func finishRun(_ finalState: State) {
        guard !finished else { return }
        finished = true
        stopRequested = true
        setState(finalState)
        eventContinuation.finish()
        let waiters = finishWaiters
        finishWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    private func setState(_ newState: State) {
        guard newState != state else { return }
        state = newState
        emit(.state(newState))
    }

    private func emit(_ event: Event) {
        eventContinuation.yield(event)
    }

    // MARK: Error classification

    /// Errors after which reconnecting cannot help.
    static let terminalCodes: Set<ErrorCode> = [
        .unauthorized, .forbidden, .consentRequired, .ingestPaused, .unsupportedProtocol,
    ]

    static func failure(code: ErrorCode, message: String, fatal: Bool) -> Failure? {
        if terminalCodes.contains(code) {
            return .fatal(.server(code: code, message: message, status: nil))
        }
        if fatal && (code == .badRequest || code == .unsupportedCodec) {
            // The same hello would be rejected again.
            return .fatal(.server(code: code, message: message, status: nil))
        }
        return fatal ? .transient(message) : nil
    }

    static func failure(forCloseCode code: Int?) -> Failure? {
        switch code {
        case LTMCloseCode.unauthorized:
            return .fatal(.server(code: .unauthorized, message: "socket closed: unauthorized", status: nil))
        case LTMCloseCode.forbidden:
            return .fatal(.server(code: .forbidden, message: "socket closed: forbidden", status: nil))
        case LTMCloseCode.protocolError:
            return .fatal(.server(code: .badRequest, message: "socket closed: protocol error", status: nil))
        default:
            return nil
        }
    }
}
