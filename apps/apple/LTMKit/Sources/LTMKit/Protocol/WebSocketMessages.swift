import Foundation

// Mirrors of the ingest WebSocket messages in `packages/protocol/src/ws.ts`.
// Client messages are encode-only (custom `encode(to:)` writes the `type` discriminator),
// server messages are decode-only.

public struct AudioFormat: Codable, Sendable, Equatable {
    /// v1 only knows "pcm_s16le".
    public var codec: String
    public var sampleRate: Int
    public var channels: Int

    public init(codec: String = "pcm_s16le", sampleRate: Int = 16_000, channels: Int = 1) {
        self.codec = codec
        self.sampleRate = sampleRate
        self.channels = channels
    }

    public static let pcm16kMono = AudioFormat()
}

/// First text message on the socket.
public struct ClientHello: Encodable, Sendable, Equatable {
    public var protocolVersion: Int
    public var token: String
    /// Lowercase UUID string.
    public var streamId: String
    public var source: AudioSource
    public var mode: StreamMode
    /// Required when `mode` is `.audio`.
    public var audio: AudioFormat?
    public var clientTimeMs: Int64
    public var language: String?
    public var context: StreamContext?

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case token
        case streamId
        case source
        case mode
        case audio
        case clientTimeMs
        case language
        case context
    }

    public init(
        protocolVersion: Int = LTMProtocol.version,
        token: String,
        streamId: String,
        source: AudioSource,
        mode: StreamMode,
        audio: AudioFormat?,
        clientTimeMs: Int64,
        language: String? = nil,
        context: StreamContext? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.token = token
        self.streamId = streamId
        self.source = source
        self.mode = mode
        self.audio = audio
        self.clientTimeMs = clientTimeMs
        self.language = language
        self.context = context
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("hello", forKey: .type)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(token, forKey: .token)
        try container.encode(streamId, forKey: .streamId)
        try container.encode(source, forKey: .source)
        try container.encode(mode, forKey: .mode)
        try container.encodeIfPresent(audio, forKey: .audio)
        try container.encode(clientTimeMs, forKey: .clientTimeMs)
        try container.encodeIfPresent(language, forKey: .language)
        try container.encodeIfPresent(context, forKey: .context)
    }
}

/// On-device transcripts (`mode: "transcript"` streams). 1...200 segments.
public struct ClientTranscript: Encodable, Sendable, Equatable {
    public var segments: [TranscriptSegment]

    enum CodingKeys: String, CodingKey { case type, segments }

    public init(segments: [TranscriptSegment]) { self.segments = segments }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("transcript", forKey: .type)
        try container.encode(segments, forKey: .segments)
    }
}

public struct ClientPing: Encodable, Sendable, Equatable {
    public var clientTimeMs: Int64

    enum CodingKeys: String, CodingKey { case type, clientTimeMs }

    public init(clientTimeMs: Int64) { self.clientTimeMs = clientTimeMs }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("ping", forKey: .type)
        try container.encode(clientTimeMs, forKey: .clientTimeMs)
    }
}

public struct ClientEnd: Encodable, Sendable, Equatable {
    enum CodingKeys: String, CodingKey { case type }

    public init() {}

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("end", forKey: .type)
    }
}

/// Everything the server may send on the ingest socket.
public enum ServerMessage: Sendable, Equatable {
    case ready(streamId: String, serverTimeMs: Double, resumed: Bool)
    case segment(LiveSegment)
    case pong(clientTimeMs: Double, serverTimeMs: Double)
    case error(code: ErrorCode, message: String, fatal: Bool)
    case closed(streamId: String)
    /// A message type this client does not know (ignored, never fatal).
    case unknown(type: String)

    public static func decode(_ text: String) throws -> ServerMessage {
        try LTMJSON.makeDecoder().decode(ServerMessage.self, from: Data(text.utf8))
    }
}

extension ServerMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type
        case streamId
        case serverTimeMs
        case resumed
        case segment
        case clientTimeMs
        case code
        case message
        case fatal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "ready":
            self = try .ready(
                streamId: container.decode(String.self, forKey: .streamId),
                serverTimeMs: container.decode(Double.self, forKey: .serverTimeMs),
                resumed: container.decode(Bool.self, forKey: .resumed)
            )
        case "segment":
            self = try .segment(container.decode(LiveSegment.self, forKey: .segment))
        case "pong":
            self = try .pong(
                clientTimeMs: container.decode(Double.self, forKey: .clientTimeMs),
                serverTimeMs: container.decode(Double.self, forKey: .serverTimeMs)
            )
        case "error":
            self = try .error(
                code: container.decode(ErrorCode.self, forKey: .code),
                message: container.decodeIfPresent(String.self, forKey: .message) ?? "",
                fatal: container.decodeIfPresent(Bool.self, forKey: .fatal) ?? false
            )
        case "closed":
            self = try .closed(streamId: container.decode(String.self, forKey: .streamId))
        default:
            self = .unknown(type: type)
        }
    }
}
