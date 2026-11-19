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

        watchBridge.activate()
        Task { await coordinator.bootstrap() }
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
