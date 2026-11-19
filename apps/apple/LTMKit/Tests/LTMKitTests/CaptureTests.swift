import XCTest
@testable import LTMKit

final class CaptureStateTests: XCTestCase {
    let live = CaptureMode(transport: .live, transcription: .server)

    func testResolveOrder() {
        XCTAssertEqual(CaptureState.resolve(isPaired: false, consentSatisfied: true, ingestPaused: false, activity: .listening(live)), .notPaired)
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: nil, ingestPaused: false, activity: .idle), .consentRequired,
                       "unknown consent counts as not given")
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: false, ingestPaused: true, activity: .idle), .consentRequired)
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: false, ingestPaused: false, activity: .failed(.unauthorized)), .error(.unauthorized),
                       "a revoked token beats the consent screen (the user must re-pair first)")
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: true, ingestPaused: true, activity: .listening(live)), .paused(.server))
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: true, ingestPaused: false, activity: .paused(live)), .paused(.user))
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: true, ingestPaused: false, activity: .listening(live)), .listening(live))
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: true, ingestPaused: false, activity: .idle), .idle)
        XCTAssertEqual(CaptureState.resolve(isPaired: true, consentSatisfied: true, ingestPaused: false, activity: .failed(.microphonePermissionDenied)),
                       .error(.microphonePermissionDenied))
    }

    func testMayCapture() {
        XCTAssertTrue(CaptureState.mayCapture(isPaired: true, consentSatisfied: true, ingestPaused: false))
        XCTAssertFalse(CaptureState.mayCapture(isPaired: true, consentSatisfied: nil, ingestPaused: false))
        XCTAssertFalse(CaptureState.mayCapture(isPaired: true, consentSatisfied: true, ingestPaused: true))
        XCTAssertFalse(CaptureState.mayCapture(isPaired: false, consentSatisfied: true, ingestPaused: false))
    }
}

final class CapturePolicyTests: XCTestCase {
    func testAutomatic() {
        XCTAssertEqual(CapturePolicy.transport(preference: .automatic, isForeground: true, network: .unmetered), .live)
        XCTAssertEqual(CapturePolicy.transport(preference: .automatic, isForeground: false, network: .unmetered), .storeAndForward)
        XCTAssertEqual(CapturePolicy.transport(preference: .automatic, isForeground: true, network: .metered), .storeAndForward)
        XCTAssertEqual(CapturePolicy.transport(preference: .automatic, isForeground: true, network: .offline), .storeAndForward)
        XCTAssertEqual(CapturePolicy.transport(preference: .automatic, isForeground: true, network: .unknown), .storeAndForward)
    }

    func testExplicitPreferences() {
        XCTAssertEqual(CapturePolicy.transport(preference: .alwaysChunks, isForeground: true, network: .unmetered), .storeAndForward)
        XCTAssertEqual(CapturePolicy.transport(preference: .alwaysLive, isForeground: false, network: .metered), .live)
        XCTAssertEqual(CapturePolicy.transport(preference: .alwaysLive, isForeground: true, network: .offline), .storeAndForward)
        XCTAssertEqual(CapturePolicy.transport(preference: .alwaysLive, isForeground: true, network: .unmetered, supportsLive: false), .storeAndForward)
    }
}

@MainActor
final class FakeEngine: CaptureEngine {
    var eventHandler: (@MainActor (CaptureEngineEvent) -> Void)?
    private(set) var started: [CaptureSessionConfig] = []
    private(set) var pauses = 0
    private(set) var stops = 0
    private(set) var transports: [CaptureTransport] = []

    func start(_ config: CaptureSessionConfig) async throws { started.append(config) }
    func pause() async { pauses += 1 }
    func resume() async throws {}
    func stop() async { stops += 1 }
    func updateTransport(_ transport: CaptureTransport) async { transports.append(transport) }
}

final class CaptureCoordinatorTests: XCTestCase {
    @MainActor
    private func makeCoordinator() throws -> (CaptureCoordinator, FakeEngine) {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "LTMKitTests-\(UUID().uuidString)"))
        let queue = try UploadQueue(directory: temporaryDirectory(), transport: FakeTransport(), credentials: { _ in nil })
        let engine = FakeEngine()
        let coordinator = CaptureCoordinator(
            settings: SettingsStore(defaults: defaults),
            tokens: MemoryTokenStore(),
            uploadQueue: queue,
            engine: engine,
            role: .watch,
            source: .ambient,
            supportsLive: false,
            monitorNetwork: false
        )
        return (coordinator, engine)
    }

    @MainActor
    func testNoCaptureBeforePairingAndConsent() async throws {
        let (coordinator, engine) = try makeCoordinator()
        XCTAssertEqual(coordinator.state, .notPaired)
        await coordinator.start()
        XCTAssertTrue(engine.started.isEmpty)

        try coordinator.storePairing(server: XCTUnwrap(ServerConfig.parse("https://ltm.example.com")), token: "watch_token_0123456789", deviceId: "d1")
        XCTAssertEqual(coordinator.state, .consentRequired)
        await coordinator.start()
        XCTAssertTrue(engine.started.isEmpty, "consent state unknown → no capture")

        coordinator.applyRemoteState(consentSatisfied: true, ingestPaused: false)
        XCTAssertEqual(coordinator.state, .idle)
        await coordinator.start()
        XCTAssertEqual(engine.started.count, 1)
        XCTAssertEqual(engine.started.first?.source, .ambient)
        XCTAssertEqual(engine.started.first?.mode, CaptureMode(transport: .storeAndForward, transcription: .server))
        XCTAssertEqual(engine.started.first?.streamId, engine.started.first?.streamId.lowercased())
        XCTAssertTrue(coordinator.state.isCapturing)
    }

    @MainActor
    func testWithdrawnConsentStopsAndServerPausePauses() async throws {
        let (coordinator, engine) = try makeCoordinator()
        try coordinator.storePairing(server: XCTUnwrap(ServerConfig.parse("https://ltm.example.com")), token: "watch_token_0123456789", deviceId: nil)
        coordinator.applyRemoteState(consentSatisfied: true, ingestPaused: false)
        await coordinator.start()

        coordinator.applyRemoteState(consentSatisfied: true, ingestPaused: true)
        let paused = await eventually { engine.pauses == 1 }
        XCTAssertTrue(paused)
        XCTAssertEqual(coordinator.state, .paused(.server))

        coordinator.applyRemoteState(consentSatisfied: false, ingestPaused: true)
        let stopped = await eventually { engine.stops == 1 }
        XCTAssertTrue(stopped)
        XCTAssertEqual(coordinator.state, .consentRequired)
        await coordinator.start()
        XCTAssertEqual(engine.started.count, 1)
    }

    @MainActor
    func testUserPauseResumeAndStop() async throws {
        let (coordinator, engine) = try makeCoordinator()
        try coordinator.storePairing(server: XCTUnwrap(ServerConfig.parse("https://ltm.example.com")), token: "watch_token_0123456789", deviceId: nil)
        coordinator.applyRemoteState(consentSatisfied: true, ingestPaused: false)
        await coordinator.start()
        await coordinator.pause()
        XCTAssertEqual(coordinator.state, .paused(.user))
        await coordinator.resume()
        XCTAssertTrue(coordinator.state.isCapturing)
        await coordinator.stop()
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertEqual(engine.stops, 1)
        XCTAssertNil(coordinator.listeningSince)
    }
}
