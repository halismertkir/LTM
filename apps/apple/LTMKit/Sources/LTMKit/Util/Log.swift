import Foundation
#if canImport(os)
import os
#endif

/// How an interpolated value may appear in logs. Private values are redacted in release
/// builds. Transcript text and tokens are never logged at all.
public enum LogPrivacy: Sendable {
    case `public`
    case `private`
}

/// A log line built with string interpolation, mirroring `os.Logger`'s
/// `\(value, privacy: .public)` syntax so call sites read the same on every platform.
public struct LogMessage: ExpressibleByStringInterpolation, Sendable {
    public struct StringInterpolation: StringInterpolationProtocol {
        var text = ""

        public init(literalCapacity: Int, interpolationCount: Int) {
            text.reserveCapacity(literalCapacity + interpolationCount * 8)
        }

        public mutating func appendLiteral(_ literal: String) {
            text += literal
        }

        public mutating func appendInterpolation<T>(_ value: T, privacy: LogPrivacy = .private) {
            #if DEBUG
            text += String(describing: value)
            #else
            text += privacy == .public ? String(describing: value) : "<private>"
            #endif
        }

        /// Numbers carry no personal data; log them as-is.
        public mutating func appendInterpolation<T: BinaryInteger>(_ value: T) {
            text += String(value)
        }
    }

    public let text: String

    public init(stringLiteral value: String) {
        text = value
    }

    public init(stringInterpolation: StringInterpolation) {
        text = stringInterpolation.text
    }
}

/// Thin logger: `os.Logger` on Apple platforms, stderr elsewhere (Linux tests).
public struct LTMLogger: Sendable {
    public let category: String
    #if canImport(os)
    private let logger: Logger
    #endif

    public init(category: String) {
        self.category = category
        #if canImport(os)
        logger = Logger(subsystem: Log.subsystem, category: category)
        #endif
    }

    public func debug(_ message: LogMessage) { write(message, level: "debug") }
    public func info(_ message: LogMessage) { write(message, level: "info") }
    public func notice(_ message: LogMessage) { write(message, level: "notice") }
    public func error(_ message: LogMessage) { write(message, level: "error") }

    private func write(_ message: LogMessage, level: String) {
        #if canImport(os)
        // The message was already redacted by `LogMessage`, so it is public here.
        switch level {
        case "debug": logger.debug("\(message.text, privacy: .public)")
        case "info": logger.info("\(message.text, privacy: .public)")
        case "notice": logger.notice("\(message.text, privacy: .public)")
        default: logger.error("\(message.text, privacy: .public)")
        }
        #else
        if level == "debug" { return }
        FileHandle.standardError.write(Data("[\(category)] \(level): \(message.text)\n".utf8))
        #endif
    }
}

/// Logging categories. Transcript text and tokens are never logged.
public enum Log {
    static let subsystem = "app.ltm"

    public static let api = LTMLogger(category: "api")
    public static let stream = LTMLogger(category: "stream")
    public static let audio = LTMLogger(category: "audio")
    public static let upload = LTMLogger(category: "upload")
    public static let capture = LTMLogger(category: "capture")
    public static let watch = LTMLogger(category: "watch")
    public static let speech = LTMLogger(category: "speech")
    public static let reader = LTMLogger(category: "reader")
}
