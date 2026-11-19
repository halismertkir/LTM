import Combine
import Foundation
import LTMKit
import os

/// Phone side of the watch integration.
///
/// Pairing the watch: `/devices/pairing-codes` needs a *user session*, which the phone
/// (holding only a device token) does not have. So the user creates a second pairing
/// code in the web app and enters/scans it here. The phone forwards it to the watch app,
/// which calls `/devices/pair` itself with `kind: "apple_watch"` and reports its token
/// back. If the watch app is not reachable or cannot reach the server, the phone pairs
/// on the watch's behalf with the same code (still `kind: "apple_watch"`, so the server
/// records a separate watch device) and hands the token over in the application context.
/// Either way the phone keeps the watch's token so it can upload chunks the watch hands
/// over, attributed to the watch.
@MainActor
final class PhoneWatchBridge: ObservableObject {
    @Published private(set) var isWatchAppInstalled = false
    @Published private(set) var isReachable = false
    @Published private(set) var isWatchPaired: Bool
    @Published private(set) var isPairing = false

    private let coordinator: CaptureCoordinator
    private let settings: SettingsStore
    private let tokens: KeychainStore
    private let uploadQueue: UploadQueue
    private let link = WatchLink.shared
    private var cancellables = Set<AnyCancellable>()

    init(coordinator: CaptureCoordinator, settings: SettingsStore, tokens: KeychainStore, uploadQueue: UploadQueue) {
        self.coordinator = coordinator
        self.settings = settings
        self.tokens = tokens
        self.uploadQueue = uploadQueue
        self.isWatchPaired = tokens.token(for: .watch) != nil

        var handlers = WatchLink.Handlers()
        handlers.onActivated = { [weak self] in
            Task { @MainActor in
                self?.refreshStatus()
                self?.pushContext()
            }
        }
        handlers.onReachabilityChanged = { [weak self] reachable in
            Task { @MainActor in
                self?.isReachable = reachable
                self?.refreshStatus()
            }
        }
        handlers.onPairResult = { [weak self] result in
            Task { @MainActor in self?.accept(result) }
        }
        handlers.onContextRequested = { [weak self] in
            Task { @MainActor in self?.pushContext() }
        }
        let queue = uploadQueue
        handlers.onJobReceived = { job, audioFile in
            // Uploaded with the WATCH's token: the data belongs to the watch device.
            Task {
                do {
                    try await queue.importJob(job, audioFile: audioFile, role: .watch)
                } catch {
                    Log.watch.error("could not import a job from the watch: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        link.configure(handlers)

        // `@Published` emits before the property changes, so use the emitted value.
        coordinator.$me
            .sink { [weak self] me in self?.pushContext(me: me) }
            .store(in: &cancellables)
    }

    func activate() {
        link.activate()
    }

    func refreshStatus() {
        isWatchAppInstalled = link.isWatchAppInstalled
        isReachable = link.isReachable
        isWatchPaired = tokens.token(for: .watch) != nil
    }

    // MARK: Pairing

    func pairWatch(code rawCode: String) async throws {
        guard let code = PairingURI.normalizeCode(rawCode, uppercase: true) else { throw LTMError.invalidPairingCode }
        guard let server = settings.server else { throw LTMError.notPaired }
        isPairing = true
        defer { isPairing = false }

        if link.isReachable {
            let command = WatchPairCommand(serverOrigin: server.originString, code: code)
            let result: WatchPairResult?
            do {
                result = try await link.sendPairCommand(command)
            } catch {
                result = nil
            }
            if let result {
                if result.ok, let token = result.token {
                    try storeWatch(token: token, deviceId: result.deviceId)
                    return
                }
                if !result.transportFailure {
                    // The server rejected the code; trying again from the phone would fail the same way.
                    throw LTMError.server(code: ErrorCode(result.errorCode ?? "bad_request"), message: result.errorMessage ?? "", status: nil)
                }
            }
        }

        // Pair on the watch's behalf.
        let api = APIClient(server: server, token: nil)
        try await api.checkCompatibility()
        let response = try await api.pair(PairRequest(
            code: code,
            name: L("watch.defaultDeviceName"),
            kind: .appleWatch,
            platform: "watchOS",
            appVersion: DeviceInfo.appVersion
        ))
        try storeWatch(token: response.token, deviceId: response.device.id)
    }

    /// A pairing result the watch sent via `transferUserInfo` (also covers a lost reply).
    private func accept(_ result: WatchPairResult) {
        guard result.ok, let token = result.token, tokens.token(for: .watch) != token else { return }
        try? storeWatch(token: token, deviceId: result.deviceId)
    }

    private func storeWatch(token: String, deviceId: String?) throws {
        try tokens.setToken(token, for: .watch)
        settings.watchDeviceId = deviceId
        isWatchPaired = true
        pushContext()
        let queue = uploadQueue
        Task { await queue.resume() }
    }

    /// Forgets the watch token here and tells the watch to forget its own. The device
    /// itself must be removed in the web app (a device token cannot revoke itself).
    func unpairWatch() {
        try? tokens.setToken(nil, for: .watch)
        settings.watchDeviceId = nil
        isWatchPaired = false
        pushContext(unpaired: true)
        let queue = uploadQueue
        Task { await queue.purge(role: .watch) }
    }

    // MARK: Context

    func pushContext(me: Me? = nil, unpaired: Bool = false) {
        let current = me ?? coordinator.me
        let context = WatchContext(
            serverOrigin: settings.server?.originString,
            watchToken: tokens.token(for: .watch),
            watchDeviceId: settings.watchDeviceId,
            watchUnpaired: unpaired,
            consentSatisfied: current?.consent.satisfied ?? (settings.lastConsentSatisfied ?? false),
            ingestPaused: current?.ingestPaused ?? settings.lastIngestPaused,
            languageHint: settings.languageHint,
            updatedAtMs: EpochMs.now()
        )
        do {
            try link.updateContext(context)
        } catch {
            Log.watch.debug("application context not sent: \(error.localizedDescription, privacy: .public)")
        }
    }
}
