import Foundation

// Mirrors of the REST DTOs in `packages/protocol/src/rest.ts` that the Apple clients use.
// Decoding is lenient where the server may evolve (kinds/roles as String), strict where
// the field is part of the contract we rely on.

/// `GET /version` (public).
public struct VersionInfo: Codable, Sendable, Equatable {
    public var name: String
    public var version: String
    public var protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case name
        case version
        case protocolVersion = "protocol"
    }

    public init(name: String, version: String, protocolVersion: Int) {
        self.name = name
        self.version = version
        self.protocolVersion = protocolVersion
    }
}

public struct User: Codable, Sendable, Equatable {
    public var id: String
    public var email: String
    public var displayName: String
    /// "owner" or "member".
    public var role: String
    /// "en" or "tr".
    public var locale: String
    public var createdAt: String
}

public struct Device: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    /// Raw `DeviceKind` value; kept as String so an unknown kind does not break decoding.
    public var kind: String
    public var platform: String?
    public var appVersion: String?
    public var priority: Int?
    public var createdAt: String
    public var lastSeenAt: String?
    public var online: Bool
}

/// `POST /devices/pair` body.
public struct PairRequest: Codable, Sendable, Equatable {
    public var code: String
    public var name: String
    public var kind: DeviceKind
    public var platform: String?
    public var appVersion: String?

    public init(code: String, name: String, kind: DeviceKind, platform: String? = nil, appVersion: String? = nil) {
        self.code = code
        self.name = name
        self.kind = kind
        self.platform = platform
        self.appVersion = appVersion
    }
}

/// `POST /devices/pair` response.
public struct PairResponse: Codable, Sendable, Equatable {
    public struct PairedUser: Codable, Sendable, Equatable {
        public var id: String
        public var displayName: String
        public var locale: String
    }

    public var device: Device
    /// Long-lived device token; shown once, stored in the Keychain.
    public var token: String
    public var user: PairedUser
}

public struct ConsentRequirement: Codable, Sendable, Equatable {
    public var type: ConsentType
    public var version: String
    public var accepted: Bool

    public init(type: ConsentType, version: String, accepted: Bool) {
        self.type = type
        self.version = version
        self.accepted = accepted
    }
}

public struct ConsentRecord: Codable, Sendable, Equatable {
    public var type: ConsentType
    public var version: String
    public var acceptedAt: String
    public var via: String?
}

/// `GET /consents`, also embedded in `Me`.
public struct ConsentState: Codable, Sendable, Equatable {
    /// True when every currently required document is accepted at its current version.
    public var satisfied: Bool
    public var required: [ConsentRequirement]
    public var records: [ConsentRecord]

    public init(satisfied: Bool, required: [ConsentRequirement], records: [ConsentRecord] = []) {
        self.satisfied = satisfied
        self.required = required
        self.records = records
    }
}

/// `POST /consents` body.
public struct ConsentAccept: Codable, Sendable, Equatable {
    public struct Item: Codable, Sendable, Equatable {
        public var type: ConsentType
        public var version: String

        public init(type: ConsentType, version: String) {
            self.type = type
            self.version = version
        }
    }

    public var accept: [Item]

    public init(accept: [Item]) { self.accept = accept }
}

/// `POST /consents/withdraw` body.
public struct ConsentWithdraw: Codable, Sendable, Equatable {
    public var types: [ConsentType]
    public init(types: [ConsentType]) { self.types = types }
}

/// `GET /me`.
public struct Me: Codable, Sendable, Equatable {
    public struct Principal: Codable, Sendable, Equatable {
        /// "user" or "device".
        public var type: String
        public var deviceId: String?
    }

    public var user: User
    public var principal: Principal
    public var consent: ConsentState
    public var ingestPaused: Bool
}

/// Multipart field `meta` of `POST /ingest/chunks` (`zChunkMeta`).
public struct ChunkMeta: Codable, Sendable, Equatable {
    public var streamId: String
    /// Monotonic per stream, starts at 0. `(streamId, seq)` is the idempotency key.
    public var seq: Int
    public var source: AudioSource
    /// Device-clock epoch ms of the first sample in the chunk.
    public var startMs: Int64
    public var durationMs: Int64
    /// Device clock "now" when the upload is attempted. Refreshed on every attempt.
    public var clientTimeMs: Int64
    public var language: String?
    public var context: StreamContext?
    /// Wire name `final`: marks the last chunk of the stream.
    public var isFinal: Bool?

    enum CodingKeys: String, CodingKey {
        case streamId, seq, source, startMs, durationMs, clientTimeMs, language, context
        case isFinal = "final"
    }

    public init(
        streamId: String,
        seq: Int,
        source: AudioSource,
        startMs: Int64,
        durationMs: Int64,
        clientTimeMs: Int64,
        language: String? = nil,
        context: StreamContext? = nil,
        isFinal: Bool? = nil
    ) {
        self.streamId = streamId
        self.seq = seq
        self.source = source
        self.startMs = startMs
        self.durationMs = durationMs
        self.clientTimeMs = clientTimeMs
        self.language = language
        self.context = context
        self.isFinal = isFinal
    }
}

public struct ChunkAccepted: Codable, Sendable, Equatable {
    public var streamId: String
    public var seq: Int
    /// False when this `(streamId, seq)` had already been stored.
    public var created: Bool
}

/// `POST /ingest/transcripts` body (`zTranscriptBatch`).
public struct TranscriptBatch: Codable, Sendable, Equatable {
    public var streamId: String
    public var source: AudioSource
    public var clientTimeMs: Int64
    public var segments: [TranscriptSegment]
    public var context: StreamContext?
    /// Wire name `final`.
    public var isFinal: Bool?

    enum CodingKeys: String, CodingKey {
        case streamId, source, clientTimeMs, segments, context
        case isFinal = "final"
    }

    public init(
        streamId: String,
        source: AudioSource,
        clientTimeMs: Int64,
        segments: [TranscriptSegment],
        context: StreamContext? = nil,
        isFinal: Bool? = nil
    ) {
        self.streamId = streamId
        self.source = source
        self.clientTimeMs = clientTimeMs
        self.segments = segments
        self.context = context
        self.isFinal = isFinal
    }
}

public struct TranscriptAccepted: Codable, Sendable, Equatable {
    public var streamId: String
    public var accepted: Int
    public var duplicates: Int
}
