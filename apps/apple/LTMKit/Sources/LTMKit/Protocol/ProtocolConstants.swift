import Foundation

/// Constants mirrored from `packages/protocol/src/common.ts`, `frames.ts` and `rest.ts`.
public enum LTMProtocol {
    /// Servers accept exactly this version in `hello` and report it from `/version`.
    public static let version = 1
    /// Every REST and WebSocket route lives under this prefix.
    public static let apiPrefix = "/api/v1"

    /// Sample rate the clients produce for live audio (the server resamples anything else,
    /// but 16 kHz mono is what it is tuned for).
    public static let sampleRate: Double = 16_000
    public static let channels = 1
    /// Recommended payload duration of one binary frame.
    public static let recommendedFrameMs: Double = 200
    /// Hard cap on one binary WebSocket message (header + payload).
    public static let maxFrameBytes = 256 * 1024
    /// Upper bound for one uploaded chunk.
    public static let maxChunkBytes = 25 * 1024 * 1024
}

/// REST routes relative to `LTMProtocol.apiPrefix` (see `ROUTES` in rest.ts).
public enum LTMRoute {
    public static let version = "/version"
    public static let me = "/me"
    public static let devicePair = "/devices/pair"
    public static let deviceSelf = "/devices/self"
    public static let consents = "/consents"
    public static let consentWithdraw = "/consents/withdraw"
    public static let ingestWebSocket = "/ingest/ws"
    public static let ingestChunks = "/ingest/chunks"
    public static let ingestTranscripts = "/ingest/transcripts"

    public static func ingestStreamEnd(_ streamId: String) -> String {
        "/ingest/streams/\(streamId)/end"
    }
}

/// WebSocket close codes used by the server (`WS_CLOSE` in ws.ts).
public enum LTMCloseCode {
    public static let normal = 1000
    public static let protocolError = 4400
    public static let unauthorized = 4401
    public static let forbidden = 4403
    public static let helloTimeout = 4408
}
