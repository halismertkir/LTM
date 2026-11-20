import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Opens a streaming HTTP response. Abstracted so the SSE client can be tested with a fake.
public protocol EventByteSource: Sendable {
    /// Returns the HTTP status and the body as chunks of bytes. For non-2xx statuses the
    /// stream may be empty.
    func open(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<[UInt8], Error>)
}

#if canImport(Darwin)
/// `URLSession.bytes(for:)`-backed source. Bytes are re-chunked at line ends; the SSE
/// line splitter does the real framing (AsyncBytes.lines would drop the empty lines that
/// terminate events).
public struct URLSessionEventByteSource: EventByteSource {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func open(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<[UInt8], Error>) {
        let (bytes, response) = try await session.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let chunks = AsyncThrowingStream<[UInt8], Error> { continuation in
            let task = Task {
                var buffer: [UInt8] = []
                do {
                    for try await byte in bytes {
                        buffer.append(byte)
                        if byte == 0x0A || buffer.count >= 4_096 {
                            continuation.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (status, chunks)
    }
}
#endif

/// Follows `GET /events` (server-sent events) and yields typed `LiveEvent`s.
///
/// Reconnects with back-off (honouring the server's `retry:` as a floor) whenever the
/// stream ends or fails. `401` and `403` stop it for good — a capture-only device (or a
/// revoked token) will not get in by retrying.
public actor LiveEventClient {
    public enum Status: Sendable, Equatable {
        case connecting
        case connected
        case waiting(attempt: Int, delay: Double)
        /// 403: this device may not read (paired with `access: "capture"`).
        case forbidden
        /// 401: the token was revoked.
        case unauthorized
        case stopped
    }

    public enum Output: Sendable, Equatable {
        case status(Status)
        case event(LiveEvent)
    }

    public nonisolated let output: AsyncStream<Output>
    private let continuation: AsyncStream<Output>.Continuation
    private let server: ServerConfig
    private let token: String
    private let source: any EventByteSource
    private let sleeper: any Sleeper
    private let backoff: BackoffPolicy
    private let random: @Sendable () -> Double
    private var runTask: Task<Void, Never>?
    private var stopped = false
    public private(set) var status: Status = .stopped

    public init(
        server: ServerConfig,
        token: String,
        source: any EventByteSource,
        sleeper: any Sleeper = TaskSleeper(),
        backoff: BackoffPolicy = BackoffPolicy(baseDelay: 2, multiplier: 2, maxDelay: 60, jitter: 0.2),
        random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
    ) {
        self.server = server
        self.token = token
        self.source = source
        self.sleeper = sleeper
        self.backoff = backoff
        self.random = random
        var created: AsyncStream<Output>.Continuation?
        output = AsyncStream(bufferingPolicy: .bufferingNewest(128)) { created = $0 }
        continuation = created!
    }

    public func start() {
        guard runTask == nil, !stopped else { return }
        runTask = Task { await self.run() }
    }

    public func stop() {
        stopped = true
        runTask?.cancel()
        setStatus(.stopped)
        continuation.finish()
    }

    func makeRequest() -> URLRequest {
        var request = URLRequest(url: server.apiURL(LTMRoute.events))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // A live stream has no natural end; heartbeats arrive every few seconds.
        request.timeoutInterval = 90
        return request
    }

    private func run() async {
        var attempt = 0
        while !stopped && !Task.isCancelled {
            setStatus(.connecting)
            var parser = SSEParser()
            do {
                let (status, chunks) = try await source.open(makeRequest())
                switch status {
                case 200..<300:
                    setStatus(.connected)
                    attempt = 0
                    var splitter = SSELineSplitter()
                    for try await chunk in chunks {
                        for line in splitter.feed(chunk) {
                            if let message = parser.feed(line: line), message.event == "message" {
                                continuation.yield(.event(LiveEvent.decode(message.data)))
                            }
                        }
                    }
                case 401:
                    finish(.unauthorized)
                    return
                case 403:
                    finish(.forbidden)
                    return
                default:
                    break
                }
            } catch {
                // Network failure or the stream broke: reconnect below.
            }
            if stopped || Task.isCancelled { break }
            attempt += 1
            var delay = backoff.delay(forAttempt: attempt, random: random())
            if let retryMs = parser.retryMs { delay = max(delay, Double(retryMs) / 1000) }
            setStatus(.waiting(attempt: attempt, delay: delay))
            do {
                try await sleeper.sleep(seconds: delay)
            } catch {
                break
            }
        }
        if !stopped { finish(.stopped) }
    }

    private func finish(_ final: Status) {
        stopped = true
        setStatus(final)
        continuation.finish()
    }

    private func setStatus(_ newStatus: Status) {
        guard newStatus != status else { return }
        status = newStatus
        continuation.yield(.status(newStatus))
    }
}
