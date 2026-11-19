import Foundation

/// One durable unit of store-and-forward work.
public struct UploadJob: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: Codable, Sendable, Equatable {
        /// `POST /ingest/chunks`; the audio file sits next to the job record.
        case chunk(meta: ChunkMeta, mimeType: String, fileExtension: String)
        /// `POST /ingest/transcripts`.
        case transcripts(batch: TranscriptBatch)
        /// `POST /ingest/streams/:streamId/end`, sent after every other job of the stream.
        case streamEnd(streamId: String)
    }

    public enum State: String, Codable, Sendable {
        case pending
        case inFlight
        /// Given to the phone over WatchConnectivity (watch only); deleted once delivered.
        case handedOff
    }

    public var id: String
    /// Whose token uploads it (the phone uploads watch chunks with the watch's token).
    public var role: DeviceRole
    public var kind: Kind
    public var createdAtMs: Int64
    public var attempts: Int
    /// Not retried before this time (back-off).
    public var notBeforeMs: Int64
    public var state: State
    public var lastError: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        role: DeviceRole,
        kind: Kind,
        createdAtMs: Int64,
        attempts: Int = 0,
        notBeforeMs: Int64 = 0,
        state: State = .pending,
        lastError: String? = nil
    ) {
        self.id = id
        self.role = role
        self.kind = kind
        self.createdAtMs = createdAtMs
        self.attempts = attempts
        self.notBeforeMs = notBeforeMs
        self.state = state
        self.lastError = lastError
    }

    public var streamId: String {
        switch kind {
        case .chunk(let meta, _, _): return meta.streamId
        case .transcripts(let batch): return batch.streamId
        case .streamEnd(let streamId): return streamId
        }
    }

    public var hasAudio: Bool {
        if case .chunk = kind { return true }
        return false
    }

    public var isStreamEnd: Bool {
        if case .streamEnd = kind { return true }
        return false
    }

    /// Order within a stream: chunks by seq, other jobs by creation time.
    var sequenceKey: Int {
        if case .chunk(let meta, _, _) = kind { return meta.seq }
        return Int.max
    }
}
