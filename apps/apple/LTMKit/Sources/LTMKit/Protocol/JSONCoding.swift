import Foundation

/// JSON helpers shared by REST, WebSocket and on-disk persistence.
///
/// `JSONEncoder`/`JSONDecoder` are not `Sendable`, so callers get a fresh instance instead
/// of a shared static one.
public enum LTMJSON {
    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        // Sorted keys make bodies deterministic (useful for tests and debugging);
        // unescaped slashes keep URLs in payloads readable. Neither changes semantics.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    public static func makeDecoder() -> JSONDecoder {
        JSONDecoder()
    }

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        try makeEncoder().encode(value)
    }

    public static func encodeString<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try encode(value), as: UTF8.self)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try makeDecoder().decode(type, from: data)
    }
}

/// Wall-clock helpers. All wire timestamps are device-clock epoch milliseconds.
public enum EpochMs {
    public static func now() -> Int64 {
        from(Date())
    }

    public static func from(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    public static func rounded(_ ms: Double) -> Int64 {
        Int64(ms.rounded())
    }

    public static func date(_ ms: Double) -> Date {
        Date(timeIntervalSince1970: ms / 1000)
    }
}
