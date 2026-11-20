import Foundation

/// `GET /events` payloads (`zLiveEvent`). Unknown or malformed events decode to
/// `.unknown` instead of failing, so a newer server never breaks an older app.
public enum LiveEvent: Sendable, Equatable {
    case streamStarted(StreamInfo)
    case streamEnded(streamId: String)
    case segment(streamId: String, deviceId: String, segment: LiveSegment)
    case conversationUpdated(ConversationSummary)
    case conversationDeleted(conversationId: String)
    case memoryCreated(Memory)
    case dayUpdated(DaySummary)
    case capturePaused(ingestPaused: Bool)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, stream, streamId, deviceId, segment, conversation, conversationId, memory, day, ingestPaused
    }

    /// Decodes one `data:` payload. Never throws: anything unexpected is `.unknown`.
    public static func decode(_ data: Data) -> LiveEvent {
        (try? LTMJSON.decode(LiveEventBox.self, from: data).event) ?? .unknown(type: Self.typeName(in: data) ?? "")
    }

    public static func decode(_ text: String) -> LiveEvent {
        decode(Data(text.utf8))
    }

    private static func typeName(in data: Data) -> String? {
        struct TypeOnly: Decodable { let type: String }
        return try? LTMJSON.decode(TypeOnly.self, from: data).type
    }

    fileprivate init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "stream_started":
            self = try .streamStarted(c.decode(StreamInfo.self, forKey: .stream))
        case "stream_ended":
            self = try .streamEnded(streamId: c.decode(String.self, forKey: .streamId))
        case "segment":
            self = try .segment(
                streamId: c.decode(String.self, forKey: .streamId),
                deviceId: c.decode(String.self, forKey: .deviceId),
                segment: c.decode(LiveSegment.self, forKey: .segment)
            )
        case "conversation_updated":
            self = try .conversationUpdated(c.decode(ConversationSummary.self, forKey: .conversation))
        case "conversation_deleted":
            self = try .conversationDeleted(conversationId: c.decode(String.self, forKey: .conversationId))
        case "memory_created":
            self = try .memoryCreated(c.decode(Memory.self, forKey: .memory))
        case "day_updated":
            self = try .dayUpdated(c.decode(DaySummary.self, forKey: .day))
        case "capture_paused":
            self = try .capturePaused(ingestPaused: c.decode(Bool.self, forKey: .ingestPaused))
        default:
            self = .unknown(type: type)
        }
    }
}

private struct LiveEventBox: Decodable {
    let event: LiveEvent
    init(from decoder: Decoder) throws {
        event = try LiveEvent(from: decoder)
    }
}

// MARK: - Server-sent events

/// One dispatched SSE event.
public struct SSEMessage: Sendable, Equatable {
    /// `event:` field; "message" when absent (LTM never sets one).
    public var event: String
    public var data: String
    public var id: String?

    public init(event: String = "message", data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Splits a byte stream into lines on LF, CRLF or a lone CR (per the SSE spec), keeping
/// empty lines — they terminate events. (`URLSession.AsyncBytes.lines` drops empty lines,
/// which is why the client splits bytes itself.)
public struct SSELineSplitter: Sendable {
    private var buffer: [UInt8] = []
    private var lastWasCR = false

    public init() {}

    public mutating func feed(_ byte: UInt8) -> String? {
        if lastWasCR {
            lastWasCR = false
            if byte == 0x0A { return nil } // the LF of a CRLF pair
        }
        switch byte {
        case 0x0A:
            return takeLine()
        case 0x0D:
            lastWasCR = true
            return takeLine()
        default:
            buffer.append(byte)
            return nil
        }
    }

    public mutating func feed<S: Sequence>(_ bytes: S) -> [String] where S.Element == UInt8 {
        var lines: [String] = []
        for byte in bytes {
            if let line = feed(byte) { lines.append(line) }
        }
        return lines
    }

    private mutating func takeLine() -> String {
        let line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        return line
    }
}

/// The SSE field parser (WHATWG "event stream interpretation"), line by line.
public struct SSEParser: Sendable {
    private var dataLines: [String] = []
    private var eventName = ""
    private var hasData = false
    public private(set) var lastEventId: String?
    /// Reconnection delay requested by the server (`retry:`), in milliseconds.
    public private(set) var retryMs: Int?

    public init() {}

    /// Feeds one line (without its terminator). Returns an event when a blank line ends one.
    public mutating func feed(line: String) -> SSEMessage? {
        if line.isEmpty {
            defer {
                dataLines.removeAll()
                eventName = ""
                hasData = false
            }
            guard hasData else { return nil }
            return SSEMessage(event: eventName.isEmpty ? "message" : eventName, data: dataLines.joined(separator: "\n"), id: lastEventId)
        }
        if line.hasPrefix(":") { return nil } // comment / heartbeat
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "data":
            dataLines.append(String(value))
            hasData = true
        case "event":
            eventName = String(value)
        case "id":
            if !value.contains("\0") { lastEventId = String(value) }
        case "retry":
            if let ms = Int(value), ms >= 0 { retryMs = ms }
        default:
            break
        }
        return nil
    }
}
