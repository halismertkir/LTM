import Foundation

/// One WebSocket message.
public enum WebSocketFrame: Sendable, Equatable {
    case text(String)
    case binary(Data)
}

/// The minimal socket surface `StreamClient` needs, so tests can drive it with a fake.
public protocol WebSocketConnection: AnyObject, Sendable {
    func send(_ frame: WebSocketFrame) async throws
    /// Suspends until the next message; throws once the socket is closed or failed.
    func receive() async throws -> WebSocketFrame
    /// Closes the socket; a pending `receive()` then throws.
    func close()
    /// The close code the peer sent, once known (e.g. 4401).
    var closeCode: Int? { get }
}

public protocol WebSocketConnector: Sendable {
    func connect(url: URL) throws -> any WebSocketConnection
}

/// `URLSessionWebSocketTask`-backed connection.
///
/// Credentials never go into the URL (they would end up in server logs); the token is
/// sent in `hello` instead, as the protocol requires.
public final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    public init(task: URLSessionWebSocketTask) {
        self.task = task
        task.resume()
    }

    public func send(_ frame: WebSocketFrame) async throws {
        switch frame {
        case .text(let text):
            try await task.send(.string(text))
        case .binary(let data):
            try await task.send(.data(data))
        }
    }

    public func receive() async throws -> WebSocketFrame {
        let message = try await task.receive()
        switch message {
        case .string(let text):
            return .text(text)
        case .data(let data):
            return .binary(data)
        @unknown default:
            throw URLError(.cannotParseResponse)
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    public var closeCode: Int? {
        let raw = task.closeCode.rawValue
        return raw == 0 ? nil : raw
    }
}

public struct URLSessionWebSocketConnector: WebSocketConnector {
    private let session: URLSession
    private let userAgent: String

    public init(session: URLSession = .shared, userAgent: String = APIClient.defaultUserAgent) {
        self.session = session
        self.userAgent = userAgent
    }

    public func connect(url: URL) throws -> any WebSocketConnection {
        var request = URLRequest(url: url)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 20
        let task = session.webSocketTask(with: request)
        // Frames are at most 256 KiB; the default 1 MiB limit only matters for receive.
        task.maximumMessageSize = 1 * 1024 * 1024
        return URLSessionWebSocketConnection(task: task)
    }
}
