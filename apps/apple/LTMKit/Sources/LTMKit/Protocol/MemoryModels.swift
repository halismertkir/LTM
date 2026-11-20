import Foundation

// Reader DTOs (`packages/protocol/src/rest.ts`: conversations, memories, search, ask,
// days, streams, capture pause). Decoded leniently: enums the server may extend are
// string-backed structs, so a newer server never breaks an older app.
//
// Schemas that `extend` another one on the server are composed here: the base object is
// decoded from the same JSON object, then the extra fields.

/// What a device token may do (`zDeviceAccess`).
public struct DeviceAccess: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
    public var description: String { rawValue }

    /// Capture only (the default).
    public static let capture = DeviceAccess("capture")
    /// Capture plus reading conversations, days and memories, search, ask, live events.
    public static let memory = DeviceAccess("memory")
}

/// `{ items, nextCursor }` (`zPage`).
public struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    public var items: [Item]
    public var nextCursor: String?

    public init(items: [Item], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

extension Page: Equatable where Item: Equatable {}

public struct ConversationStatus: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let open = ConversationStatus("open")
    public static let processing = ConversationStatus("processing")
    public static let ready = ConversationStatus("ready")
    public static let transcriptOnly = ConversationStatus("transcript_only")
}

public struct ConversationSummary: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var status: ConversationStatus
    public var startMs: Double
    public var endMs: Double
    public var title: String?
    /// One-paragraph abstract.
    public var summary: String?
    public var topics: [String]
    public var participants: [String]
    public var language: String?
    public var deviceIds: [String]
    public var utteranceCount: Int
    public var openActionItems: Int
    /// Still open, but already carrying notes written from what was heard so far.
    public var interim: Bool
    public var updatedAt: String

    public init(
        id: String, status: ConversationStatus, startMs: Double, endMs: Double, title: String?, summary: String?,
        topics: [String] = [], participants: [String] = [], language: String? = nil, deviceIds: [String] = [],
        utteranceCount: Int = 0, openActionItems: Int = 0, interim: Bool = false, updatedAt: String = ""
    ) {
        self.id = id
        self.status = status
        self.startMs = startMs
        self.endMs = endMs
        self.title = title
        self.summary = summary
        self.topics = topics
        self.participants = participants
        self.language = language
        self.deviceIds = deviceIds
        self.utteranceCount = utteranceCount
        self.openActionItems = openActionItems
        self.interim = interim
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, status, startMs, endMs, title, summary, topics, participants, language, deviceIds
        case utteranceCount, openActionItems, interim, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(ConversationStatus.self, forKey: .status)
        startMs = try c.decode(Double.self, forKey: .startMs)
        endMs = try c.decode(Double.self, forKey: .endMs)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        topics = try c.decodeIfPresent([String].self, forKey: .topics) ?? []
        participants = try c.decodeIfPresent([String].self, forKey: .participants) ?? []
        language = try c.decodeIfPresent(String.self, forKey: .language)
        deviceIds = try c.decodeIfPresent([String].self, forKey: .deviceIds) ?? []
        utteranceCount = try c.decodeIfPresent(Int.self, forKey: .utteranceCount) ?? 0
        openActionItems = try c.decodeIfPresent(Int.self, forKey: .openActionItems) ?? 0
        // Older servers do not send `interim`.
        interim = try c.decodeIfPresent(Bool.self, forKey: .interim) ?? false
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    }

    /// "Live · notes so far" in the UI.
    public var isLive: Bool { status == .open }
}

public struct Utterance: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var startMs: Double
    public var endMs: Double
    public var text: String
    /// "self", "other" or "unknown".
    public var speaker: String
    public var language: String?
    /// Devices that heard this utterance (the first one supplied the text).
    public var deviceIds: [String]
    /// Raw `AudioSource` values ("tab", "mic", ...).
    public var sources: [String]
    /// "server_stt" or "edge_stt".
    public var origin: String
}

public struct ActionItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String
    public var owner: String?
    /// YYYY-MM-DD if one was mentioned.
    public var due: String?
    public var done: Bool

    public init(id: String, text: String, owner: String? = nil, due: String? = nil, done: Bool) {
        self.id = id
        self.text = text
        self.owner = owner
        self.due = due
        self.done = done
    }
}

/// `PATCH /conversations/:id/action-items/:itemId`.
public struct ActionItemUpdate: Codable, Sendable, Equatable {
    public var done: Bool?
    public var text: String?

    public init(done: Bool? = nil, text: String? = nil) {
        self.done = done
        self.text = text
    }
}

/// `zConversationDetail` = summary + notes, decisions, action items, transcript, memories.
public struct ConversationDetail: Decodable, Sendable, Equatable, Identifiable {
    public var conversation: ConversationSummary
    /// Markdown.
    public var notes: String?
    public var decisions: [String]
    public var actionItems: [ActionItem]
    public var utterances: [Utterance]
    public var memoryIds: [String]
    public var statusDetail: String?

    public var id: String { conversation.id }

    public init(
        conversation: ConversationSummary, notes: String? = nil, decisions: [String] = [], actionItems: [ActionItem] = [],
        utterances: [Utterance] = [], memoryIds: [String] = [], statusDetail: String? = nil
    ) {
        self.conversation = conversation
        self.notes = notes
        self.decisions = decisions
        self.actionItems = actionItems
        self.utterances = utterances
        self.memoryIds = memoryIds
        self.statusDetail = statusDetail
    }

    enum CodingKeys: String, CodingKey {
        case notes, decisions, actionItems, utterances, memoryIds, statusDetail
    }

    public init(from decoder: Decoder) throws {
        conversation = try ConversationSummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        decisions = try c.decodeIfPresent([String].self, forKey: .decisions) ?? []
        actionItems = try c.decodeIfPresent([ActionItem].self, forKey: .actionItems) ?? []
        utterances = try c.decodeIfPresent([Utterance].self, forKey: .utterances) ?? []
        memoryIds = try c.decodeIfPresent([String].self, forKey: .memoryIds) ?? []
        statusDetail = try c.decodeIfPresent(String.self, forKey: .statusDetail)
    }
}

public struct MemoryKind: RawRepresentable, Hashable, Codable, Sendable, CaseIterable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let fact = MemoryKind("fact")
    public static let preference = MemoryKind("preference")
    public static let person = MemoryKind("person")
    public static let commitment = MemoryKind("commitment")
    public static let decision = MemoryKind("decision")
    public static let event = MemoryKind("event")
    public static let idea = MemoryKind("idea")

    public static let allCases: [MemoryKind] = [.fact, .preference, .person, .commitment, .decision, .event, .idea]
}

public struct Memory: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var kind: MemoryKind
    /// One self-contained statement.
    public var content: String
    /// 1 (trivia) … 5 (critical).
    public var importance: Int
    public var subjects: [String]
    public var sourceConversationId: String?
    /// "extracted" or "manual".
    public var origin: String
    public var occurredAt: String?
    public var createdAt: String
    public var updatedAt: String

    public init(
        id: String, kind: MemoryKind, content: String, importance: Int = 3, subjects: [String] = [],
        sourceConversationId: String? = nil, origin: String = "manual", occurredAt: String? = nil,
        createdAt: String = "", updatedAt: String = ""
    ) {
        self.id = id
        self.kind = kind
        self.content = content
        self.importance = importance
        self.subjects = subjects
        self.sourceConversationId = sourceConversationId
        self.origin = origin
        self.occurredAt = occurredAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// `POST /memories`.
public struct MemoryCreate: Codable, Sendable, Equatable {
    public var kind: MemoryKind
    public var content: String
    public var importance: Int
    public var subjects: [String]

    public init(kind: MemoryKind = .fact, content: String, importance: Int = 3, subjects: [String] = []) {
        self.kind = kind
        self.content = content
        self.importance = importance
        self.subjects = subjects
    }
}

public struct SearchHitType: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let memory = SearchHitType("memory")
    public static let conversation = SearchHitType("conversation")
    public static let utterance = SearchHitType("utterance")
}

/// `POST /search`.
public struct SearchRequest: Codable, Sendable, Equatable {
    public var query: String
    public var limit: Int?
    public var types: [SearchHitType]?
    public var from: Int64?
    public var to: Int64?

    public init(query: String, limit: Int? = nil, types: [SearchHitType]? = nil, from: Int64? = nil, to: Int64? = nil) {
        self.query = query
        self.limit = limit
        self.types = types
        self.from = from
        self.to = to
    }
}

public struct SearchHit: Codable, Sendable, Equatable, Identifiable {
    public var type: SearchHitType
    public var id: String
    /// For memories: the source conversation.
    public var conversationId: String?
    public var title: String?
    public var snippet: String
    public var score: Double
    public var atMs: Double?

    public init(type: SearchHitType, id: String, conversationId: String? = nil, title: String? = nil, snippet: String, score: Double = 0, atMs: Double? = nil) {
        self.type = type
        self.id = id
        self.conversationId = conversationId
        self.title = title
        self.snippet = snippet
        self.score = score
        self.atMs = atMs
    }
}

public struct SearchResponse: Codable, Sendable, Equatable {
    public var hits: [SearchHit]
    /// "hybrid" or "keyword".
    public var mode: String
}

/// `POST /ask`.
public struct AskRequest: Codable, Sendable, Equatable {
    public var question: String
    public var from: Int64?
    public var to: Int64?

    public init(question: String, from: Int64? = nil, to: Int64? = nil) {
        self.question = question
        self.from = from
        self.to = to
    }
}

public struct AskResponse: Codable, Sendable, Equatable {
    public var answer: String
    /// Cited as [1], [2], … in `answer`, in this order.
    public var citations: [SearchHit]

    public init(answer: String, citations: [SearchHit]) {
        self.answer = answer
        self.citations = citations
    }
}

public struct StreamInfo: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var deviceId: String
    public var deviceName: String
    public var source: String
    public var mode: String
    public var startedAt: String
    public var endedAt: String?
    public var active: Bool
    public var context: StreamContext?
}

/// `POST /capture/pause` body.
public struct CapturePause: Codable, Sendable, Equatable {
    public var paused: Bool
    public init(paused: Bool) { self.paused = paused }
}

public struct CapturePauseState: Codable, Sendable, Equatable {
    public var ingestPaused: Bool
    public init(ingestPaused: Bool) { self.ingestPaused = ingestPaused }
}

public struct DayStatus: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let none = DayStatus("none")
    public static let pending = DayStatus("pending")
    public static let ready = DayStatus("ready")
    public static let unavailable = DayStatus("unavailable")
}

public struct DaySummary: Codable, Sendable, Equatable, Identifiable {
    /// YYYY-MM-DD in the user's time zone.
    public var date: String
    public var status: DayStatus
    public var headline: String?
    public var summary: String?
    public var conversationCount: Int
    public var speechMinutes: Double
    public var openActionItems: Int
    public var updatedAt: String?

    public var id: String { date }

    public init(date: String, status: DayStatus, headline: String? = nil, summary: String? = nil, conversationCount: Int = 0,
                speechMinutes: Double = 0, openActionItems: Int = 0, updatedAt: String? = nil) {
        self.date = date
        self.status = status
        self.headline = headline
        self.summary = summary
        self.conversationCount = conversationCount
        self.speechMinutes = speechMinutes
        self.openActionItems = openActionItems
        self.updatedAt = updatedAt
    }
}

/// An open action item of the day, with the conversation it came from.
public struct DayActionItem: Decodable, Sendable, Equatable, Identifiable {
    public var item: ActionItem
    public var conversationId: String
    public var conversationTitle: String?

    public var id: String { item.id }

    public init(item: ActionItem, conversationId: String, conversationTitle: String? = nil) {
        self.item = item
        self.conversationId = conversationId
        self.conversationTitle = conversationTitle
    }

    enum CodingKeys: String, CodingKey { case conversationId, conversationTitle }

    public init(from decoder: Decoder) throws {
        item = try ActionItem(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        conversationTitle = try c.decodeIfPresent(String.self, forKey: .conversationTitle)
    }
}

/// `GET /days/:date`.
public struct DayDetail: Decodable, Sendable, Equatable, Identifiable {
    public var day: DaySummary
    public var timeZone: String
    /// Markdown digest of the whole day.
    public var digest: String?
    public var highlights: [String]
    public var decisions: [String]
    public var people: [String]
    /// Oldest first.
    public var conversations: [ConversationSummary]
    public var actionItems: [DayActionItem]
    public var statusDetail: String?

    public var id: String { day.date }

    public init(day: DaySummary, timeZone: String = "UTC", digest: String? = nil, highlights: [String] = [], decisions: [String] = [],
                people: [String] = [], conversations: [ConversationSummary] = [], actionItems: [DayActionItem] = [], statusDetail: String? = nil) {
        self.day = day
        self.timeZone = timeZone
        self.digest = digest
        self.highlights = highlights
        self.decisions = decisions
        self.people = people
        self.conversations = conversations
        self.actionItems = actionItems
        self.statusDetail = statusDetail
    }

    enum CodingKeys: String, CodingKey {
        case timeZone, digest, highlights, decisions, people, conversations, actionItems, statusDetail
    }

    public init(from decoder: Decoder) throws {
        day = try DaySummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone) ?? TimeZone.current.identifier
        digest = try c.decodeIfPresent(String.self, forKey: .digest)
        highlights = try c.decodeIfPresent([String].self, forKey: .highlights) ?? []
        decisions = try c.decodeIfPresent([String].self, forKey: .decisions) ?? []
        people = try c.decodeIfPresent([String].self, forKey: .people) ?? []
        conversations = try c.decodeIfPresent([ConversationSummary].self, forKey: .conversations) ?? []
        actionItems = try c.decodeIfPresent([DayActionItem].self, forKey: .actionItems) ?? []
        statusDetail = try c.decodeIfPresent(String.self, forKey: .statusDetail)
    }
}

/// Calendar-day strings ("YYYY-MM-DD") in a given time zone, as the days routes use.
public enum DayDate {
    public static func string(for date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// Midnight at the start of `date`'s day.
    public static func startOfDay(_ date: Date, timeZone: TimeZone = .current) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.startOfDay(for: date)
    }

    /// Parses "YYYY-MM-DD" to noon of that day (noon avoids DST edge cases in display).
    public static func date(from string: String, timeZone: TimeZone = .current) -> Date? {
        let parts = string.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
}
