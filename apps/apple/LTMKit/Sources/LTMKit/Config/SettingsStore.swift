import Foundation

/// How audio leaves the device.
public enum CaptureTransport: String, Codable, Sendable, CaseIterable {
    /// Live WebSocket, 16 kHz PCM frames (or on-device transcripts).
    case live
    /// Compressed chunks recorded to disk and uploaded over HTTP (store-and-forward).
    case storeAndForward
}

/// Where speech becomes text.
public enum TranscriptionMode: String, Codable, Sendable, CaseIterable {
    /// Audio goes to the LTM server, which runs the configured speech-to-text provider.
    case server
    /// `SFSpeechRecognizer` with on-device recognition only; no audio leaves the phone.
    case onDevice
}

/// The user's capture-transport preference (Settings → Capture mode).
public enum TransportPreference: String, Codable, Sendable, CaseIterable {
    /// Live on Wi-Fi in the foreground, chunks in the background or on cellular.
    case automatic
    case alwaysLive
    case alwaysChunks
}

/// Non-secret settings in UserDefaults. Tokens are in `KeychainStore`.
///
/// `UserDefaults` is thread-safe, so this wrapper can be shared across actors.
public final class SettingsStore: @unchecked Sendable {
    private let defaults: UserDefaults

    private enum Key {
        static let serverOrigin = "ltm.serverOrigin"
        static let deviceId = "ltm.deviceId"
        static let watchDeviceId = "ltm.watchDeviceId"
        static let transcriptionMode = "ltm.transcriptionMode"
        static let transportPreference = "ltm.transportPreference"
        static let languageHint = "ltm.languageHint"
        static let resumeAutomatically = "ltm.resumeAutomatically"
        static let captureWasActive = "ltm.captureWasActive"
        static let lastConsentSatisfied = "ltm.lastConsentSatisfied"
        static let lastIngestPaused = "ltm.lastIngestPaused"
        static let welcomeSeen = "ltm.welcomeSeen"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var server: ServerConfig? {
        get { defaults.string(forKey: Key.serverOrigin).flatMap { ServerConfig.parse($0, requireScheme: true) } }
        set { defaults.set(newValue?.originString, forKey: Key.serverOrigin) }
    }

    public var deviceId: String? {
        get { defaults.string(forKey: Key.deviceId) }
        set { defaults.set(newValue, forKey: Key.deviceId) }
    }

    /// On the phone: the id of the paired watch device (for display only).
    public var watchDeviceId: String? {
        get { defaults.string(forKey: Key.watchDeviceId) }
        set { defaults.set(newValue, forKey: Key.watchDeviceId) }
    }

    public var transcriptionMode: TranscriptionMode {
        get { defaults.string(forKey: Key.transcriptionMode).flatMap(TranscriptionMode.init(rawValue:)) ?? .server }
        set { defaults.set(newValue.rawValue, forKey: Key.transcriptionMode) }
    }

    public var transportPreference: TransportPreference {
        get { defaults.string(forKey: Key.transportPreference).flatMap(TransportPreference.init(rawValue:)) ?? .automatic }
        set { defaults.set(newValue.rawValue, forKey: Key.transportPreference) }
    }

    /// Spoken-language hint ("en", "tr", ...); nil means auto-detect.
    public var languageHint: String? {
        get {
            let value = defaults.string(forKey: Key.languageHint)
            return (value?.isEmpty ?? true) ? nil : value
        }
        set { defaults.set(newValue, forKey: Key.languageHint) }
    }

    /// Restart capture after a cold relaunch if it was running when the app died.
    /// Off by default: capture must never start without a deliberate user action.
    public var resumeAutomatically: Bool {
        get { defaults.bool(forKey: Key.resumeAutomatically) }
        set { defaults.set(newValue, forKey: Key.resumeAutomatically) }
    }

    public var captureWasActive: Bool {
        get { defaults.bool(forKey: Key.captureWasActive) }
        set { defaults.set(newValue, forKey: Key.captureWasActive) }
    }

    /// Last consent state seen from the server (nil = never fetched).
    public var lastConsentSatisfied: Bool? {
        get { defaults.object(forKey: Key.lastConsentSatisfied) as? Bool }
        set { defaults.set(newValue, forKey: Key.lastConsentSatisfied) }
    }

    public var lastIngestPaused: Bool {
        get { defaults.bool(forKey: Key.lastIngestPaused) }
        set { defaults.set(newValue, forKey: Key.lastIngestPaused) }
    }

    public var welcomeSeen: Bool {
        get { defaults.bool(forKey: Key.welcomeSeen) }
        set { defaults.set(newValue, forKey: Key.welcomeSeen) }
    }

    /// Forget everything tied to the current server (un-pair).
    public func clearPairing() {
        server = nil
        deviceId = nil
        watchDeviceId = nil
        lastConsentSatisfied = nil
        lastIngestPaused = false
        captureWasActive = false
    }
}
