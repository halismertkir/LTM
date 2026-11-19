import Foundation

/// Everything an engine needs to run one capture session (one `streamId` at a time;
/// engines may rotate the stream id themselves when the transport changes).
public struct CaptureSessionConfig: Sendable, Equatable {
    public var streamId: String
    public var source: AudioSource
    public var role: DeviceRole
    public var mode: CaptureMode
    /// Spoken-language hint; nil = auto-detect on the server, device locale on-device.
    public var language: String?
    public var server: ServerConfig
    public var token: String

    public init(
        streamId: String,
        source: AudioSource,
        role: DeviceRole,
        mode: CaptureMode,
        language: String?,
        server: ServerConfig,
        token: String
    ) {
        self.streamId = streamId
        self.source = source
        self.role = role
        self.mode = mode
        self.language = language
        self.server = server
        self.token = token
    }

    public static func newStreamId() -> String {
        UUID().uuidString.lowercased()
    }
}

public enum CaptureEngineEvent: Sendable, Equatable {
    /// Latest recognised text (server `segment` echo or on-device result).
    case caption(String)
    /// Audio was interrupted (phone call, Siri, another app took the microphone).
    case interrupted
    /// Capture resumed after an interruption.
    case resumed
    /// The engine could not continue.
    case failed(CaptureIssue)
    /// The server refused the stream for a reason a retry cannot fix.
    case serverRejected(LTMError)
}

/// Platform capture implementation driven by `CaptureCoordinator`.
@MainActor
public protocol CaptureEngine: AnyObject {
    var eventHandler: (@MainActor (CaptureEngineEvent) -> Void)? { get set }
    /// Throws `CaptureIssue` when capture cannot start.
    func start(_ config: CaptureSessionConfig) async throws
    func pause() async
    func resume() async throws
    /// Flushes and ends the stream (last chunk enqueued, `end` sent / stream-end queued).
    func stop() async
    /// Switches live ↔ store-and-forward mid-session (ignored by engines that only do one).
    func updateTransport(_ transport: CaptureTransport) async
}
