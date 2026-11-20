import Combine
import Foundation
import LTMKit
import SwiftUI

/// Composition root of the iPhone app. Created once per process — also when the system
/// relaunches the app in the background for upload events, so the background session is
/// re-created with the same identifier and the queue resumes on its own. Capture is
/// never started from here.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    static let uploadSessionIdentifier = "app.ltm.ios.uploads"

    let settings: SettingsStore
    let tokens: KeychainStore
    let consentStore: ConsentStore?
    let transport: BackgroundUploadTransport
    let uploadQueue: UploadQueue
    let coordinator: CaptureCoordinator
    let watchBridge: PhoneWatchBridge
    /// The reader (Today, Timeline, Ask, Memories) — works when the phone was paired with
    /// `access: "memory"`; otherwise it explains how to allow reading in the web app.
    let memoryStore: MemoryStore

    private var cancellables = Set<AnyCancellable>()
    private var isForeground = false

    /// A pairing link opened from the camera app or a QR code (`ltm://pair?...`).
    @Published var pendingPairingURI: PairingURI?

    private init() {
        let settings = SettingsStore()
        let tokens = KeychainStore()
        let transport = BackgroundUploadTransport(identifier: Self.uploadSessionIdentifier)
        let support = Self.supportDirectory()
        let queue = Self.makeQueue(directory: support.appendingPathComponent("uploads", isDirectory: true), transport: transport, settings: settings, tokens: tokens)
        let engine = PhoneCaptureEngine(uploadQueue: queue, recordingDirectory: support.appendingPathComponent("recording", isDirectory: true))
        let coordinator = CaptureCoordinator(
            settings: settings,
            tokens: tokens,
            uploadQueue: queue,
            engine: engine,
            role: .phone,
            source: .mic,
            supportsLive: true
        )
        self.settings = settings
        self.tokens = tokens
        self.consentStore = ConsentStore.bundled()
        self.transport = transport
        self.uploadQueue = queue
        self.coordinator = coordinator
        self.watchBridge = PhoneWatchBridge(coordinator: coordinator, settings: settings, tokens: tokens, uploadQueue: queue)
        self.memoryStore = MemoryStore(api: { coordinator.api().map { $0 as any MemoryAPI } })

        // The kill switch, wherever it changes, reaches capture (and from there the watch).
        memoryStore.onCapturePaused = { paused in coordinator.setIngestPaused(paused) }
        coordinator.$me
            .compactMap { $0?.ingestPaused }
            .sink { [weak self] paused in self?.memoryStore.knownIngestPaused(paused) }
            .store(in: &cancellables)

        watchBridge.activate()
        Task { await coordinator.bootstrap() }
    }

    // MARK: Reader lifecycle

    /// Foreground: check what this device may do and follow live events. Background: stop
    /// the event stream (it is only useful while the reader is on screen).
    func setForeground(_ foreground: Bool) {
        isForeground = foreground
        if foreground {
            Task { await refreshReader() }
        } else {
            memoryStore.stopLive()
        }
    }

    func refreshReader() async {
        guard coordinator.isPaired else {
            memoryStore.stopLive()
            return
        }
        await memoryStore.checkAccess()
        if memoryStore.access == .memory {
            settings.deviceAccess = .memory
            startLiveIfPossible()
        } else if memoryStore.access == .captureOnly {
            settings.deviceAccess = .capture
            memoryStore.stopLive()
        }
    }

    private func startLiveIfPossible() {
        guard isForeground, memoryStore.canRead, !memoryStore.isLive,
              let server = settings.server, let token = tokens.token(for: .phone) else { return }
        memoryStore.startLive(LiveEventClient(server: server, token: token, source: URLSessionEventByteSource()))
    }

    /// After un-pairing: drop everything the reader cached.
    func resetReader() {
        memoryStore.reset()
    }

    func handle(url: URL) {
        guard let uri = PairingURI.parse(url.absoluteString) else { return }
        pendingPairingURI = uri
    }

    // MARK: Setup helpers

    private static func supportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let url = base.appendingPathComponent("LTM", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private static func makeQueue(directory: URL, transport: BackgroundUploadTransport, settings: SettingsStore, tokens: KeychainStore) -> UploadQueue {
        let credentials: UploadQueue.Credentials = { role in
            guard let server = settings.server, let token = tokens.token(for: role) else { return nil }
            return (server, token)
        }
        if let queue = try? UploadQueue(directory: directory, transport: transport, credentials: credentials) {
            return queue
        }
        // Application Support is unavailable only in pathological cases; keep working
        // with a temporary queue rather than crashing.
        let fallback = FileManager.default.temporaryDirectory.appendingPathComponent("ltm-uploads", isDirectory: true)
        do {
            return try UploadQueue(directory: fallback, transport: transport, credentials: credentials)
        } catch {
            fatalError("cannot create an upload queue: \(error)")
        }
    }
}
