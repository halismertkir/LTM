import Foundation

// Payloads exchanged between the iPhone app and the watch app over WatchConnectivity.
// Each is Codable and travels as JSON `Data` under one key, because WatchConnectivity
// dictionaries only accept property-list types.

/// Phone → watch, via `updateApplicationContext` (latest state wins, delivered when the
/// watch app next runs).
public struct WatchContext: Codable, Sendable, Equatable {
    public var serverOrigin: String?
    /// The WATCH's own device token (paired with `kind: "apple_watch"`), not the phone's.
    public var watchToken: String?
    public var watchDeviceId: String?
    /// What the server granted the watch device (optional: older phones do not send it).
    public var watchAccess: DeviceAccess?
    /// The phone un-paired the watch: delete the local token.
    public var watchUnpaired: Bool
    public var consentSatisfied: Bool
    public var ingestPaused: Bool
    public var languageHint: String?
    /// Device-clock ms when the phone produced this context.
    public var updatedAtMs: Int64

    public init(
        serverOrigin: String?,
        watchToken: String?,
        watchDeviceId: String?,
        watchUnpaired: Bool,
        consentSatisfied: Bool,
        ingestPaused: Bool,
        languageHint: String?,
        updatedAtMs: Int64,
        watchAccess: DeviceAccess? = nil
    ) {
        self.serverOrigin = serverOrigin
        self.watchToken = watchToken
        self.watchDeviceId = watchDeviceId
        self.watchAccess = watchAccess
        self.watchUnpaired = watchUnpaired
        self.consentSatisfied = consentSatisfied
        self.ingestPaused = ingestPaused
        self.languageHint = languageHint
        self.updatedAtMs = updatedAtMs
    }
}

/// Phone → watch (`sendMessage` with reply): pair yourself with this code.
public struct WatchPairCommand: Codable, Sendable, Equatable {
    public var serverOrigin: String
    public var code: String

    public init(serverOrigin: String, code: String) {
        self.serverOrigin = serverOrigin
        self.code = code
    }
}

/// Watch → phone: outcome of `WatchPairCommand` (as the reply, and again via
/// `transferUserInfo` so the phone learns the token even if the reply was lost).
public struct WatchPairResult: Codable, Sendable, Equatable {
    public var ok: Bool
    public var token: String?
    public var deviceId: String?
    public var access: DeviceAccess?
    public var errorCode: String?
    public var errorMessage: String?
    /// The watch could not reach the server at all (the phone may pair on its behalf).
    public var transportFailure: Bool

    public init(ok: Bool, token: String? = nil, deviceId: String? = nil, access: DeviceAccess? = nil, errorCode: String? = nil, errorMessage: String? = nil, transportFailure: Bool = false) {
        self.ok = ok
        self.token = token
        self.deviceId = deviceId
        self.access = access
        self.errorCode = errorCode
        self.errorMessage = errorMessage
        self.transportFailure = transportFailure
    }
}

public enum WatchMessageKey {
    public static let kind = "kind"
    public static let payload = "payload"
    public static let context = "context"
    /// `UploadJob` JSON in a file transfer's metadata or a user-info transfer.
    public static let job = "job"
    /// Original queue job id on the watch, to confirm deletion after the transfer.
    public static let jobId = "jobId"
}

public enum WatchMessageKind {
    public static let pair = "pair"
    public static let pairResult = "pairResult"
    public static let requestContext = "requestContext"
}

/// Encodes/decodes payloads to the plist-safe form used on the wire.
public enum WatchCoding {
    public static func encode<T: Encodable>(_ value: T) -> Data? {
        try? LTMJSON.encode(value)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from value: Any?) -> T? {
        guard let data = value as? Data else { return nil }
        return try? LTMJSON.decode(type, from: data)
    }
}
