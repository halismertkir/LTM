import Foundation

// Mirrors of `packages/protocol/src/common.ts`. Field names match the zod schemas exactly.
// Timestamps the client *sends* are integral epoch milliseconds (`Int64`); timestamps the
// client *receives* are decoded as `Double` because the schema allows fractional numbers.

/// Where the audio physically came from. The phone reports `mic`, the watch `ambient`.
public enum AudioSource: String, Codable, Sendable, CaseIterable {
    case tab
    case mic
    case system
    case ambient
}

public enum DeviceKind: String, Codable, Sendable {
    case browserExtension = "browser_extension"
    case iphone
    case appleWatch = "apple_watch"
    case web
    case desktop
    case other
}

public enum StreamMode: String, Codable, Sendable {
    case audio
    case transcript
}

public enum SpeakerHint: String, Codable, Sendable {
    /// Wire value "self" (named `wearer` because `.self` is reserved for metatypes).
    case wearer = "self"
    case other
    case unknown
}

/// Error codes of the error envelope and of WebSocket `error` messages.
///
/// A string-backed struct instead of an enum so that a code added by a newer server
/// decodes instead of failing the whole response.
public struct ErrorCode: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let badRequest = ErrorCode("bad_request")
    public static let unauthorized = ErrorCode("unauthorized")
    public static let forbidden = ErrorCode("forbidden")
    public static let notFound = ErrorCode("not_found")
    public static let conflict = ErrorCode("conflict")
    public static let rateLimited = ErrorCode("rate_limited")
    public static let payloadTooLarge = ErrorCode("payload_too_large")
    public static let unsupportedProtocol = ErrorCode("unsupported_protocol")
    public static let unsupportedCodec = ErrorCode("unsupported_codec")
    public static let consentRequired = ErrorCode("consent_required")
    public static let ingestPaused = ErrorCode("ingest_paused")
    public static let setupRequired = ErrorCode("setup_required")
    public static let providerNotConfigured = ErrorCode("provider_not_configured")
    public static let providerError = ErrorCode("provider_error")
    public static let internalError = ErrorCode("internal")
}

/// Consent document types (`zConsentType`). String-backed for forward compatibility.
public struct ConsentType: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let recordingResponsibility = ConsentType("recording_responsibility")
    public static let dataProcessing = ConsentType("data_processing")
    public static let thirdPartyAI = ConsentType("third_party_ai")
}

/// Free-form context for the note-taking model (`zStreamContext`).
public struct StreamContext: Codable, Sendable, Equatable {
    public var title: String?
    public var app: String?

    public init(title: String? = nil, app: String? = nil) {
        self.title = title
        self.app = app
    }
}

/// A piece of recognised speech with absolute device-clock timestamps (`zTranscriptSegment`).
/// This is the outgoing form (on-device recognition → server).
public struct TranscriptSegment: Codable, Sendable, Equatable {
    /// Client-generated id, unique within the stream; makes re-delivery idempotent.
    public var id: String?
    public var startMs: Int64
    public var endMs: Int64
    public var text: String
    /// 0...1 when the recogniser reports one.
    public var confidence: Double?
    /// BCP-47-ish tag such as "en" or "tr-TR" (hyphen, never underscore).
    public var language: String?
    public var speaker: SpeakerHint?

    public init(
        id: String? = nil,
        startMs: Int64,
        endMs: Int64,
        text: String,
        confidence: Double? = nil,
        language: String? = nil,
        speaker: SpeakerHint? = nil
    ) {
        self.id = id
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
        self.confidence = confidence
        self.language = language
        self.speaker = speaker
    }
}

/// A segment as echoed by the server (`segment` WebSocket message): transcript segment
/// plus `origin`. Decoded leniently (numbers as Double, enums as String).
public struct LiveSegment: Decodable, Sendable, Equatable {
    public var id: String?
    public var startMs: Double
    public var endMs: Double
    public var text: String
    public var confidence: Double?
    public var language: String?
    public var speaker: String?
    /// "server_stt" or "edge_stt".
    public var origin: String

    public init(
        id: String? = nil,
        startMs: Double,
        endMs: Double,
        text: String,
        confidence: Double? = nil,
        language: String? = nil,
        speaker: String? = nil,
        origin: String
    ) {
        self.id = id
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
        self.confidence = confidence
        self.language = language
        self.speaker = speaker
        self.origin = origin
    }
}

/// Body of every non-2xx REST response (`zErrorResponse`). `details` is ignored.
public struct ErrorResponse: Decodable, Sendable, Equatable {
    public struct Body: Decodable, Sendable, Equatable {
        public var code: ErrorCode
        public var message: String
    }

    public var error: Body
}
