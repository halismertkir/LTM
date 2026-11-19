import Combine
import Foundation
import LTMKit
import WatchKit

func L(_ key: String) -> String {
    NSLocalizedString(key, comment: "")
}

func LF(_ key: String, _ arguments: CVarArg...) -> String {
    String(format: L(key), locale: Locale.current, arguments: arguments)
}

/// Composition root of the watch app.
///
/// The watch never pairs by scanning anything itself: the phone forwards a pairing code
/// (`WatchPairCommand`) and the watch calls `/devices/pair` with `kind: "apple_watch"`, or
/// the phone pairs on the watch's behalf and syncs the token. Consent and pause state come
/// from the phone's application context and, when the watch can reach the server, from
/// its own `/me`. No capture until a watch token and a satisfied consent state exist.
@MainActor
final class WatchModel: ObservableObject {
    static let shared = WatchModel()

    let settings: SettingsStore
    let tokens: KeychainStore
    let consentStore: ConsentStore?
    let uploadQueue: UploadQueue
    let coordinator: CaptureCoordinator

    @Published private(set) var phoneReachable = false
    @Published private(set) var lastSync: Date?

    private init() {
        let settings = SettingsStore()
        let tokens = KeychainStore()
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let support = base.appendingPathComponent("LTM", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)

        let credentials: UploadQueue.Credentials = { role in
            guard let server = settings.server, let token = tokens.token(for: role) else { return nil }
            return (server, token)
        }
        // A short timeout: a watch without its own route to the server (no known Wi-Fi,
        // phone out of range for proxying) should hand chunks to the phone quickly.
        let transport = ForegroundUploadTransport(timeout: 20)
        let queue: UploadQueue
        do {
            queue = try UploadQueue(
                directory: support.appendingPathComponent("uploads", isDirectory: true),
                transport: transport,
                credentials: credentials,
                handoff: PhoneHandoff(),
                maxConcurrent: 1
            )
        } catch {
            fatalError("cannot create the upload queue: \(error)")
        }
        let engine = WatchCaptureEngine(uploadQueue: queue, directory: support.appendingPathComponent("recording", isDirectory: true))
        let coordinator = CaptureCoordinator(
            settings: settings,
            tokens: tokens,
            uploadQueue: queue,
            engine: engine,
            role: .watch,
            source: .ambient,
            supportsLive: false,
            // The watch only records chunks; the transport policy has nothing to decide.
            monitorNetwork: false
        )
        self.settings = settings
        self.tokens = tokens
        self.consentStore = ConsentStore.bundled()
        self.uploadQueue = queue
        self.coordinator = coordinator

        configureLink()
        Task { await coordinator.bootstrap() }
    }

    private func configureLink() {
        var handlers = WatchLink.Handlers()
        handlers.onActivated = {
            WatchLink.shared.requestContext()
        }
        handlers.onReachabilityChanged = { [weak self] reachable in
            Task { @MainActor in
                self?.phoneReachable = reachable
                if reachable { WatchLink.shared.requestContext() }
            }
        }
        handlers.onContext = { [weak self] context in
            Task { @MainActor in self?.apply(context) }
        }
        handlers.onPairCommand = { [weak self] command, reply in
            Task { @MainActor in
                guard let self else {
                    reply(WatchPairResult(ok: false, errorMessage: "not ready"))
                    return
                }
                let result = await self.pair(command)
                reply(result)
                // Also via transferUserInfo, which is delivered even if the reply is lost.
                WatchLink.shared.sendPairResult(result)
            }
        }
        let queue = uploadQueue
        handlers.onTransferFinished = { jobId, success in
            Task { await queue.handoffFinished(jobId: jobId, success: success) }
        }
        WatchLink.shared.configure(handlers)
        WatchLink.shared.activate()
    }

    private func apply(_ context: WatchContext) {
        lastSync = Date()
        if context.watchUnpaired {
            Task { await coordinator.unpair(purgeRoles: [.watch]) }
            return
        }
        if let origin = context.serverOrigin,
           let server = ServerConfig.parse(origin, requireScheme: true),
           let token = context.watchToken,
           tokens.token(for: .watch) != token || settings.server != server {
            try? coordinator.storePairing(server: server, token: token, deviceId: context.watchDeviceId)
        }
        settings.languageHint = context.languageHint
        coordinator.applyRemoteState(consentSatisfied: context.consentSatisfied, ingestPaused: context.ingestPaused)
        // The watch's own view of the server wins when it can reach it.
        Task { await coordinator.refresh() }
    }

    private func pair(_ command: WatchPairCommand) async -> WatchPairResult {
        guard let server = ServerConfig.parse(command.serverOrigin, requireScheme: true) else {
            return WatchPairResult(ok: false, errorCode: ErrorCode.badRequest.rawValue, errorMessage: "invalid server")
        }
        let device = WKInterfaceDevice.current()
        let request = PairRequest(
            code: command.code,
            name: device.name,
            kind: .appleWatch,
            platform: "watchOS \(device.systemVersion)",
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        )
        do {
            try await coordinator.pair(server: server, request: request)
            return WatchPairResult(ok: true, token: tokens.token(for: .watch), deviceId: settings.deviceId)
        } catch {
            let ltmError = LTMError.from(error)
            switch ltmError {
            case .transport, .tlsFailure, .insecureConnectionBlocked, .cancelled:
                return WatchPairResult(ok: false, errorMessage: String(describing: ltmError), transportFailure: true)
            default:
                return WatchPairResult(ok: false, errorCode: ltmError.code?.rawValue, errorMessage: String(describing: ltmError))
            }
        }
    }

    // MARK: Actions with haptics

    func start() async {
        await coordinator.start()
        if coordinator.state.isCapturing {
            WKInterfaceDevice.current().play(.start)
        } else {
            WKInterfaceDevice.current().play(.failure)
        }
    }

    func stop() async {
        await coordinator.stop()
        WKInterfaceDevice.current().play(.stop)
    }

    func togglePause() async {
        if case .paused = coordinator.state {
            await coordinator.resume()
            WKInterfaceDevice.current().play(.start)
        } else {
            await coordinator.pause()
            WKInterfaceDevice.current().play(.stop)
        }
    }

    func describe(_ issue: CaptureIssue) -> String {
        switch issue {
        case .microphonePermissionDenied: return L("watch.issue.microphone")
        case .unauthorized: return L("watch.issue.unauthorized")
        case .server(let error) where error.isConsentRequired: return L("watch.state.consent")
        default: return L("watch.issue.generic")
        }
    }
}
