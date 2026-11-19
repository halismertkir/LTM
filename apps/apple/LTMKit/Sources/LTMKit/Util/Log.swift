import Foundation
import os

/// Unified logging categories. Transcript text and tokens are never logged.
public enum Log {
    static let subsystem = "app.ltm"

    public static let api = Logger(subsystem: subsystem, category: "api")
    public static let stream = Logger(subsystem: subsystem, category: "stream")
    public static let audio = Logger(subsystem: subsystem, category: "audio")
    public static let upload = Logger(subsystem: subsystem, category: "upload")
    public static let capture = Logger(subsystem: subsystem, category: "capture")
    public static let watch = Logger(subsystem: subsystem, category: "watch")
    public static let speech = Logger(subsystem: subsystem, category: "speech")
}
