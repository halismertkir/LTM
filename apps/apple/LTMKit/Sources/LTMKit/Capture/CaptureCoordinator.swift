import Combine
import Foundation
import os

/// The single state machine both UIs observe.
///
/// It owns the pairing/consent/pause gates and enforces "no capture before consent" on
/// the client (the server enforces it as well): `start()` refuses unless the device is
/// paired, the last known consent state is satisfied and ingest is not paused, and a
/// later change of any of those stops or pauses a running capture.
@MainActor
public final class CaptureCoordinator: ObservableObject {
    @Published public private(set) var state: CaptureState = .notPaired
    @Published public private(set) var listeningSince: Date?
    @Published public private(set) var backlogCount = 0
    @Published public private(set) var uploadsPausedReason: UploadPauseReason?
    @Published public private(set) var liveCaption: String?
    @Published public private(set) var me: Me?
    @Published public private(set) var serverVersion: VersionInfo?
    @Published public private(set) var lastError: LTMError?
    @Published public private(set) var isInterrupted = false
    @Published public private(set) var isBusy = false
    @Published public private(set) var network: NetworkStatus = .unknown
    @Published public var transcriptionMode: TranscriptionMode {
        didSet { settings.transcriptionMode = transcriptionMode }
    }

    public let settings: SettingsStore
    public let tokens: any TokenStore
    public let uploadQueue: UploadQueue
    public let role: DeviceRole
    public let source: AudioSource
    private let engine: any CaptureEngine
    private let supportsLive: Bool
    private let session: URLSession
    private let networkMonitor: NetworkMonitor?

    private var activity: CaptureActivity = .idle
    private var consentSatisfied: Bool?
    private var ingestPaused: Bool
    private var isForeground = true
    private var bootstrapped = false
    private var queueObserver: Task<Void, Never>?
    private var currentMode: CaptureMode?
    private var lastPauseRefresh: Date?

    public init(
        settings: SettingsStore,
        tokens: any TokenStore,
        uploadQueue: UploadQueue,
        engine: any CaptureEngine,
        role: DeviceRole,
        source: AudioSource,
        supportsLive: Bool,
        monitorNetwork: Bool = true,
        session: URLSession = .shared
    ) {
        self.settings = settings
        self.tokens = tokens
        self.uploadQueue = uploadQueue
        self.engine = engine
        self.role = role
        self.source = source
        self.supportsLive = supportsLive
        self.session = session
        self.networkMonitor = monitorNetwork ? NetworkMonitor() : nil
        self.transcriptionMode = supportsLive ? settings.transcriptionMode : .server
        self.consentSatisfied = settings.lastConsentSatisfied
        self.ingestPaused = settings.lastIngestPaused
        engine.eventHandler = { [weak self] event in
            self?.handleEngineEvent(event)
        }
        recompute()
    }

    // MARK: Derived

    public var server: ServerConfig? { settings.server }

    public var isPaired: Bool {
        settings.server != nil && tokens.token(for: role) != nil
    }

    public func api() -> APIClient? {
        guard let server = settings.server else { return nil }
        return APIClient(server: server, token: tokens.token(for: role), session: session)
    }

    public var mayCapture: Bool {
        CaptureState.mayCapture(isPaired: isPaired, consentSatisfied: consentSatisfied, ingestPaused: ingestPaused)
    }

    // MARK: Lifecycle

    /// Starts the upload queue (resuming whatever survived a relaunch), observes it, and
    /// refreshes the server state. Never starts capture by itself.
    public func bootstrap() async {
        guard !bootstrapped else { return }
        bootstrapped = true
        let queue = uploadQueue
        queueObserver = Task { [weak self] in
            for await snapshot in queue.snapshots {
                self?.apply(snapshot)
            }
        }
        networkMonitor?.start { [weak self] status in
            Task { @MainActor in self?.setNetwork(status) }
        }
        await uploadQueue.start()
        await refresh()
    }

    /// Cold relaunch: only resume capture if the user opted in and capture was running
    /// when the app went away.
    public func resumeAfterLaunchIfAllowed() async {
        guard settings.resumeAutomatically, settings.captureWasActive, state == .idle else { return }
        await start()
    }

    // MARK: Server state

    public func refresh() async {
        guard let api = api(), isPaired else {
            recompute()
            return
        }
        do {
            if serverVersion == nil {
                serverVersion = try await api.checkCompatibility()
            }
            let current = try await api.me()
            apply(current)
            lastError = nil
        } catch let error as LTMError {
            if error.isUnauthorized {
                await handleUnauthorized()
            } else {
                lastError = error
            }
        } catch {
            lastError = LTMError.from(error)
        }
        recompute()
    }

    private func apply(_ me: Me) {
        self.me = me
        updateGates(consentSatisfied: me.consent.satisfied, ingestPaused: me.ingestPaused)
    }

    /// Watch: consent and pause state synced from the phone.
    public func applyRemoteState(consentSatisfied: Bool, ingestPaused: Bool) {
        updateGates(consentSatisfied: consentSatisfied, ingestPaused: ingestPaused)
    }

    public var consentState: ConsentState? { me?.consent }

    private func updateGates(consentSatisfied satisfied: Bool, ingestPaused paused: Bool) {
        consentSatisfied = satisfied
        ingestPaused = paused
        settings.lastConsentSatisfied = satisfied
        settings.lastIngestPaused = paused
        let queue = uploadQueue
        Task {
            if !satisfied {
                await queue.pause(.consentRequired)
            } else if paused {
                await queue.pause(.ingestPaused)
            } else {
                await queue.resume()
            }
        }
        Task { await self.enforceGates() }
        recompute()
    }

    /// Stops or pauses a running capture when a gate closed.
    private func enforceGates() async {
        switch activity {
        case .listening(let mode):
            if consentSatisfied != true {
                await stopEngine()
            } else if ingestPaused {
                await engine.pause()
                activity = .paused(mode)
            }
        case .paused:
            if consentSatisfied != true { await stopEngine() }
        default:
            break
        }
        recompute()
    }

    // MARK: Pairing

    /// Pairs this device with a code. Checks the protocol version first so an
    /// incompatible server is reported as such, not as a confusing pairing failure.
    public func pair(server: ServerConfig, request: PairRequest) async throws {
        isBusy = true
        defer { isBusy = false }
        let anonymous = APIClient(server: server, token: nil, session: session)
        serverVersion = try await anonymous.checkCompatibility()
        let response = try await anonymous.pair(request)
        try storePairing(server: server, token: response.token, deviceId: response.device.id)
        await refresh()
    }

    public func storePairing(server: ServerConfig, token: String, deviceId: String?) throws {
        try tokens.setToken(token, for: role)
        settings.server = server
        settings.deviceId = deviceId
        if case .failed(.unauthorized) = activity { activity = .idle }
        let queue = uploadQueue
        Task { await queue.resume() }
        recompute()
    }

    /// Forgets the token and server locally. A device token cannot revoke itself, so the
    /// UI tells the user to remove the device in the web app as well.
    public func unpair(purgeRoles: [DeviceRole]) async {
        await stopEngine()
        try? tokens.setToken(nil, for: role)
        settings.clearPairing()
        me = nil
        serverVersion = nil
        consentSatisfied = nil
        ingestPaused = false
        activity = .idle
        let queue = uploadQueue
        for purgeRole in Set(purgeRoles + [role]) {
            await queue.purge(role: purgeRole)
        }
        recompute()
    }

    private func handleUnauthorized() async {
        await stopEngine()
        activity = .failed(.unauthorized)
        recompute()
    }

    // MARK: Consent

    public func acceptConsents(_ items: [ConsentAccept.Item]) async throws {
        guard let api = api() else { throw LTMError.notPaired }
        isBusy = true
        defer { isBusy = false }
        _ = try await api.acceptConsents(items)
        await refresh()
    }

    /// Withdrawing stops capture at once (the server also pauses ingest).
    public func withdrawConsents(_ types: [ConsentType]) async throws {
        guard let api = api() else { throw LTMError.notPaired }
        isBusy = true
        defer { isBusy = false }
        await stopEngine()
        _ = try await api.withdrawConsents(types)
        await refresh()
    }

    // MARK: Capture control

    public func start() async {
        guard !isBusy else { return }
        switch activity {
        case .idle, .failed: break
        default: return
        }
        guard mayCapture, let server = settings.server, let token = tokens.token(for: role) else {
            recompute()
            return
        }
        let mode = CaptureMode(transport: desiredTransport(), transcription: transcriptionMode)
        let config = CaptureSessionConfig(
            streamId: CaptureSessionConfig.newStreamId(),
            source: source,
            role: role,
            mode: mode,
            language: settings.languageHint,
            server: server,
            token: token
        )
        isBusy = true
        defer { isBusy = false }
        do {
            try await engine.start(config)
            activity = .listening(mode)
            currentMode = mode
            listeningSince = Date()
            liveCaption = nil
            isInterrupted = false
            settings.captureWasActive = true
            Log.capture.info("capture started")
        } catch let issue as CaptureIssue {
            activity = .failed(issue)
        } catch {
            activity = .failed(.audioEngine(error.localizedDescription))
        }
        recompute()
    }

    public func pause() async {
        guard case .listening(let mode) = activity else { return }
        await engine.pause()
        activity = .paused(mode)
        recompute()
    }

    public func resume() async {
        guard case .paused(let mode) = activity, mayCapture else {
            recompute()
            return
        }
        do {
            try await engine.resume()
            activity = .listening(mode)
            isInterrupted = false
        } catch let issue as CaptureIssue {
            await stopEngine()
            activity = .failed(issue)
        } catch {
            await stopEngine()
            activity = .failed(.audioEngine(error.localizedDescription))
        }
        recompute()
    }

    public func stop() async {
        await stopEngine()
        recompute()
    }

    /// Dismisses an error so Start becomes available again.
    public func clearError() {
        if case .failed(let issue) = activity, issue != .unauthorized {
            activity = .idle
        }
        recompute()
    }

    private func stopEngine() async {
        switch activity {
        case .listening, .paused:
            await engine.stop()
        default:
            break
        }
        activity = .idle
        currentMode = nil
        listeningSince = nil
        isInterrupted = false
        settings.captureWasActive = false
    }

    // MARK: Transport policy

    public func setForeground(_ foreground: Bool) {
        guard foreground != isForeground else { return }
        isForeground = foreground
        Task { await self.applyTransportPolicy() }
        if foreground { Task { await self.refresh() } }
    }

    public func setNetwork(_ status: NetworkStatus) {
        guard status != network else { return }
        let cameOnline = network == .offline && status != .offline
        network = status
        Task { await self.applyTransportPolicy() }
        if cameOnline {
            let queue = uploadQueue
            Task { await queue.kick() }
        }
    }

    private func desiredTransport() -> CaptureTransport {
        CapturePolicy.transport(
            preference: settings.transportPreference,
            isForeground: isForeground,
            network: network,
            supportsLive: supportsLive
        )
    }

    /// Re-evaluates the policy (call after the user changed the capture-mode setting too).
    public func applyTransportPolicy() async {
        guard case .listening(var mode) = activity else { return }
        let desired = desiredTransport()
        guard desired != mode.transport else { return }
        await engine.updateTransport(desired)
        mode.transport = desired
        activity = .listening(mode)
        currentMode = mode
        recompute()
    }

    // MARK: Events

    private func handleEngineEvent(_ event: CaptureEngineEvent) {
        switch event {
        case .caption(let text):
            liveCaption = text
        case .interrupted:
            isInterrupted = true
        case .resumed:
            isInterrupted = false
        case .failed(let issue):
            Task {
                await self.stopEngine()
                self.activity = .failed(issue)
                self.recompute()
            }
        case .serverRejected(let error):
            Task { await self.handleServerRejection(error) }
        }
    }

    private func handleServerRejection(_ error: LTMError) async {
        if error.isConsentRequired {
            consentSatisfied = false
            settings.lastConsentSatisfied = false
            await stopEngine()
            await refresh()
        } else if error.isIngestPaused {
            ingestPaused = true
            settings.lastIngestPaused = true
            await enforceGates()
        } else if error.isUnauthorized {
            await handleUnauthorized()
        } else {
            await stopEngine()
            activity = .failed(.server(error))
        }
        recompute()
    }

    private func apply(_ snapshot: UploadQueueSnapshot) {
        backlogCount = snapshot.pending
        let previous = uploadsPausedReason
        uploadsPausedReason = snapshot.pausedReason
        if snapshot.stoppedRoles.contains(role) {
            Task { await self.handleUnauthorized() }
        }
        // The server refused an upload for consent/pause: learn the new state. Throttled,
        // so a server whose `/me` disagrees with its ingest routes cannot cause a
        // pause → refresh → resume → pause loop.
        if previous == nil, snapshot.pausedReason != nil {
            let now = Date()
            if lastPauseRefresh.map({ now.timeIntervalSince($0) > 60 }) ?? true {
                lastPauseRefresh = now
                Task { await self.refresh() }
            }
        }
    }

    private func recompute() {
        let newState = CaptureState.resolve(
            isPaired: isPaired,
            consentSatisfied: consentSatisfied,
            ingestPaused: ingestPaused,
            activity: activity
        )
        if newState != state { state = newState }
    }
}
