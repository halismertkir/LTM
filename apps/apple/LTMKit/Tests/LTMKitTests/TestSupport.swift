import Foundation
import XCTest
@testable import LTMKit

/// Compares JSON semantically (key order and number formatting do not matter).
func assertJSONEqual(_ actual: Data, _ expected: String, file: StaticString = #filePath, line: UInt = #line) {
    do {
        let lhs = try JSONSerialization.jsonObject(with: actual) as? NSDictionary
        let rhs = try JSONSerialization.jsonObject(with: Data(expected.utf8)) as? NSDictionary
        XCTAssertNotNil(lhs, "actual is not a JSON object", file: file, line: line)
        XCTAssertNotNil(rhs, "expected is not a JSON object", file: file, line: line)
        XCTAssertEqual(lhs, rhs, "\n\(String(decoding: actual, as: UTF8.self))\n!=\n\(expected)", file: file, line: line)
    } catch {
        XCTFail("invalid JSON: \(error)", file: file, line: line)
    }
}

func jsonObject(_ data: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

func jsonObject(_ text: String) -> [String: Any] {
    jsonObject(Data(text.utf8))
}

/// Polls `condition` until it holds or `timeout` elapses.
func eventually(timeout: Double = 3, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return await condition()
}

func temporaryDirectory(_ name: String = #function) -> URL {
    let safe = name.filter { $0.isLetter || $0.isNumber }
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("LTMKitTests-\(safe)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func silenceSamples(_ count: Int = 3_200, amplitude: Int16 = 30) -> [Int16] {
    (0..<count).map { $0 % 2 == 0 ? amplitude : -amplitude }
}

func toneSamples(_ count: Int = 3_200, amplitude: Double = 8_000) -> [Int16] {
    (0..<count).map { Int16(amplitude * sin(2 * Double.pi * 440 * Double($0) / 16_000)) }
}

// MARK: - Fake WebSocket

final class FakeSocket: WebSocketConnection, @unchecked Sendable {
    private struct State {
        var inbox: [WebSocketFrame] = []
        var waiters: [CheckedContinuation<WebSocketFrame, Error>] = []
        var closed = false
        var sent: [WebSocketFrame] = []
        var closeCode: Int?
    }

    private let state = LockedBox(State())

    var sentFrames: [WebSocketFrame] { state.get().sent }

    var sentTexts: [String] {
        sentFrames.compactMap { frame in
            if case .text(let text) = frame { return text }
            return nil
        }
    }

    var sentBinary: [Data] {
        sentFrames.compactMap { frame in
            if case .binary(let data) = frame { return data }
            return nil
        }
    }

    var isClosed: Bool { state.get().closed }

    var closeCode: Int? { state.get().closeCode }

    func send(_ frame: WebSocketFrame) async throws {
        let closed: Bool = state.withValue { value in
            if value.closed { return true }
            value.sent.append(frame)
            return false
        }
        if closed { throw URLError(.networkConnectionLost) }
    }

    func receive() async throws -> WebSocketFrame {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<WebSocketFrame, Error>) in
            let immediate: Result<WebSocketFrame, Error>? = state.withValue { value in
                if !value.inbox.isEmpty { return .success(value.inbox.removeFirst()) }
                if value.closed { return .failure(URLError(.networkConnectionLost)) }
                value.waiters.append(continuation)
                return nil
            }
            if let immediate { continuation.resume(with: immediate) }
        }
    }

    func close() {
        drop()
    }

    /// Simulates the server pushing a text message.
    func serverSends(_ text: String) {
        let frame = WebSocketFrame.text(text)
        let waiter: CheckedContinuation<WebSocketFrame, Error>? = state.withValue { value in
            if value.closed { return nil }
            if value.waiters.isEmpty {
                value.inbox.append(frame)
                return nil
            }
            return value.waiters.removeFirst()
        }
        waiter?.resume(returning: frame)
    }

    /// Simulates the connection dropping (optionally with a close code).
    func drop(closeCode: Int? = nil) {
        let waiters: [CheckedContinuation<WebSocketFrame, Error>] = state.withValue { value in
            value.closed = true
            if let closeCode { value.closeCode = closeCode }
            let pending = value.waiters
            value.waiters = []
            return pending
        }
        for waiter in waiters { waiter.resume(throwing: URLError(.networkConnectionLost)) }
    }
}

final class FakeConnector: WebSocketConnector, @unchecked Sendable {
    private let sockets: LockedBox<[FakeSocket]>
    private let count = LockedBox(0)

    init(_ sockets: [FakeSocket]) {
        self.sockets = LockedBox(sockets)
    }

    var connectCount: Int { count.get() }

    func connect(url: URL) throws -> any WebSocketConnection {
        count.withValue { $0 += 1 }
        let next: FakeSocket? = sockets.withValue { value in
            value.isEmpty ? nil : value.removeFirst()
        }
        guard let next else { throw URLError(.cannotConnectToHost) }
        return next
    }
}

// MARK: - Fake upload transport

final class FakeTransport: CompletionRelay, UploadTransport {
    private let requests = LockedBox<[UploadRequest]>([])
    private let bodies = LockedBox<[String: Data]>([:])

    var started: [UploadRequest] { requests.get() }

    func body(for jobId: String) -> Data? { bodies.get()[jobId] }

    func start(_ request: UploadRequest) {
        // Capture the body now: the queue deletes it once the attempt completes.
        if let file = request.bodyFile, let data = try? Data(contentsOf: file) {
            bodies.withValue { $0[request.jobId] = data }
        }
        requests.withValue { $0.append(request) }
    }

    func inFlightJobIds() async -> Set<String> { [] }

    func complete(_ jobId: String, status: Int?, body: String = "") {
        deliver(UploadCompletion(jobId: jobId, statusCode: status, body: Data(body.utf8), errorDescription: status == nil ? "offline" : nil))
    }
}
