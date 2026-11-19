import Foundation

/// How the current capture session moves and transcribes audio.
public struct CaptureMode: Sendable, Equatable {
    public var transport: CaptureTransport
    public var transcription: TranscriptionMode

    public init(transport: CaptureTransport, transcription: TranscriptionMode) {
        self.transport = transport
        self.transcription = transcription
    }
}

public enum PauseReason: Sendable, Equatable {
    /// The user tapped pause on this device.
    case user
    /// The account-wide kill switch (`ingestPaused`) is on.
    case server
}

/// Problems the UI explains to the user. Equatable so state changes can be diffed.
public enum CaptureIssue: Error, Sendable, Equatable {
    case microphonePermissionDenied
    case speechPermissionDenied
    /// On-device recognition is not available for this language on this device; the app
    /// will not silently send audio to the server instead.
    case onDeviceRecognitionUnavailable(language: String)
    case audioSession(String)
    case audioEngine(String)
    case storage(String)
    /// The device token was revoked (or the device deleted in the web app).
    case unauthorized
    case server(LTMError)
}

/// The single state the UIs render.
public enum CaptureState: Sendable, Equatable {
    case notPaired
    case consentRequired
    case idle
    case listening(CaptureMode)
    case paused(PauseReason)
    case error(CaptureIssue)

    public var isCapturing: Bool {
        if case .listening = self { return true }
        return false
    }

    /// Whether a Start button makes sense.
    public var canStart: Bool {
        switch self {
        case .idle, .error: return true
        default: return false
        }
    }
}

/// What this device is doing, independent of server-side gates.
public enum CaptureActivity: Sendable, Equatable {
    case idle
    case listening(CaptureMode)
    case paused(CaptureMode)
    case failed(CaptureIssue)
}

extension CaptureState {
    /// Derives the visible state. Order matters: pairing, then consent, then errors,
    /// then the account-wide pause, then what the device is doing.
    public static func resolve(
        isPaired: Bool,
        consentSatisfied: Bool?,
        ingestPaused: Bool,
        activity: CaptureActivity
    ) -> CaptureState {
        guard isPaired else { return .notPaired }
        if case .failed(.unauthorized) = activity { return .error(.unauthorized) }
        // Unknown consent (never fetched) counts as not given: no capture before consent.
        guard consentSatisfied == true else { return .consentRequired }
        if case .failed(let issue) = activity { return .error(issue) }
        if ingestPaused { return .paused(.server) }
        switch activity {
        case .idle: return .idle
        case .listening(let mode): return .listening(mode)
        case .paused: return .paused(.user)
        case .failed(let issue): return .error(issue)
        }
    }

    /// The client-side gate that mirrors the server's: capture only when paired, consent
    /// is known to be satisfied and the account is not paused.
    public static func mayCapture(isPaired: Bool, consentSatisfied: Bool?, ingestPaused: Bool) -> Bool {
        isPaired && consentSatisfied == true && !ingestPaused
    }
}

/// Network as far as the capture policy cares.
public enum NetworkStatus: Sendable, Equatable {
    case unknown
    case offline
    /// Wi-Fi or wired, not in Low Data Mode.
    case unmetered
    /// Cellular, personal hotspot, or Low Data Mode.
    case metered
}

/// Chooses live WebSocket vs. store-and-forward. Kept tiny and pure so it is testable.
///
/// Default (`automatic`): live only when the app is in the foreground on an unmetered
/// network — that is when live captions are useful and a socket is cheap. In the
/// background or on cellular, compressed chunks use a fraction of the data, survive
/// connectivity gaps, and upload through the background session.
public enum CapturePolicy {
    public static func transport(
        preference: TransportPreference,
        isForeground: Bool,
        network: NetworkStatus,
        supportsLive: Bool = true
    ) -> CaptureTransport {
        guard supportsLive else { return .storeAndForward }
        switch preference {
        case .alwaysChunks:
            return .storeAndForward
        case .alwaysLive:
            return network == .offline ? .storeAndForward : .live
        case .automatic:
            return isForeground && network == .unmetered ? .live : .storeAndForward
        }
    }
}
