#if os(watchOS)
import AVFoundation
import Foundation

/// Apple Watch capture: `AVAudioRecorder` writing rotating AAC chunks (16 kHz mono).
///
/// `AVAudioRecorder` is the boring, long-supported recording API on watchOS. Its meter
/// (sampled every 100 ms) drives the same `EnergyGate` the phone uses, so:
/// - a chunk is cut at a pause once it is ~25 s long (hard cut at 40 s) or when speech
///   ends;
/// - while nobody speaks, the recorder rotates every ~10 s and silent chunks are deleted
///   instead of uploaded.
/// Each recording is started with `record(atTime:)` slightly in the future, which pins its
/// first sample to a known device time and therefore to an exact wall-clock start.
@MainActor
public final class WatchCaptureEngine: CaptureEngine {
    public var eventHandler: (@MainActor (CaptureEngineEvent) -> Void)?
    private let uploadQueue: UploadQueue
    private let directory: URL
    private var config: CaptureSessionConfig?
    private var recorder: AVAudioRecorder?
    private var chunkURL: URL?
    private var chunkStartMs: Double = 0
    private var chunkHadSpeech = false
    private var gate = EnergyGate(configuration: EnergyGate.Configuration(hangoverMs: 2_500, preRollMs: 0))
    private let cutter = ChunkCutter()
    private let silentRotationMs: Double = 10_000
    private let meterInterval: Double = 0.1
    private var meterTimer: Timer?
    private var seq = 0
    private var running = false
    private var observers: [NSObjectProtocol] = []
    /// Serialises enqueue calls so chunks and the final stream end reach the queue in order.
    private var enqueueChain: Task<Void, Never>?

    public init(uploadQueue: UploadQueue, directory: URL) {
        self.uploadQueue = uploadQueue
        self.directory = directory
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    public nonisolated static var microphoneGranted: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    public nonisolated static func requestMicrophone() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    // MARK: CaptureEngine

    public func start(_ config: CaptureSessionConfig) async throws {
        if !Self.microphoneGranted {
            guard await Self.requestMicrophone() else { throw CaptureIssue.microphonePermissionDenied }
        }
        self.config = config
        seq = 0
        gate = EnergyGate(configuration: EnergyGate.Configuration(hangoverMs: 2_500, preRollMs: 0))
        try activateSession()
        installObservers()
        running = true
        try beginChunk()
        startMeterTimer()
    }

    public func pause() async {
        running = false
        stopMeterTimer()
        finishChunk()
        deactivateSession()
    }

    public func resume() async throws {
        guard config != nil else { return }
        try activateSession()
        running = true
        try beginChunk()
        startMeterTimer()
    }

    public func stop() async {
        running = false
        stopMeterTimer()
        finishChunk()
        deactivateSession()
        removeObservers()
        if let config {
            let queue = uploadQueue
            let streamId = config.streamId
            let role = config.role
            chain { try? await queue.enqueueStreamEnd(streamId: streamId, role: role) }
        }
        await enqueueChain?.value
        config = nil
    }

    public func updateTransport(_ transport: CaptureTransport) async {
        // The watch only records chunks.
    }

    // MARK: Session

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            throw CaptureIssue.audioSession(error.localizedDescription)
        }
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    // MARK: Chunks

    private func beginChunk() throws {
        let url = directory.appendingPathComponent("\(UUID().uuidString.lowercased()).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: LTMProtocol.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        let recorder: AVAudioRecorder
        do {
            recorder = try AVAudioRecorder(url: url, settings: settings)
        } catch {
            throw CaptureIssue.audioEngine(error.localizedDescription)
        }
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord() else { throw CaptureIssue.audioEngine("prepareToRecord failed") }
        // Start a little in the future at a known device time, then map that device time
        // to the wall clock measured at the same moment.
        let lead = 0.05
        let deviceNow = recorder.deviceCurrentTime
        let wallNowMs = Date().timeIntervalSince1970 * 1000
        guard recorder.record(atTime: deviceNow + lead) else { throw CaptureIssue.audioEngine("record failed") }
        self.recorder = recorder
        chunkURL = url
        chunkStartMs = wallNowMs + lead * 1000
        chunkHadSpeech = gate.isOpen
    }

    /// Stops the current recorder and enqueues the chunk if it contains speech.
    private func finishChunk() {
        guard let recorder, let url = chunkURL, let config else { return }
        let durationMs = recorder.currentTime * 1000
        recorder.stop()
        self.recorder = nil
        chunkURL = nil
        guard chunkHadSpeech, cutter.isLongEnough(durationMs: durationMs) else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        let meta = ChunkMeta(
            streamId: config.streamId,
            seq: seq,
            source: config.source,
            startMs: EpochMs.rounded(chunkStartMs),
            durationMs: EpochMs.rounded(durationMs),
            clientTimeMs: EpochMs.now(),
            language: config.language
        )
        seq += 1
        let queue = uploadQueue
        let role = config.role
        chain { try? await queue.enqueueChunk(audioFile: url, meta: meta, mimeType: "audio/mp4", role: role) }
    }

    private func rotate() {
        finishChunk()
        guard running else { return }
        do {
            try beginChunk()
        } catch let issue as CaptureIssue {
            running = false
            stopMeterTimer()
            eventHandler?(.failed(issue))
        } catch {
            running = false
            stopMeterTimer()
            eventHandler?(.failed(.audioEngine(error.localizedDescription)))
        }
    }

    private func chain(_ work: @escaping @Sendable () async -> Void) {
        let previous = enqueueChain
        enqueueChain = Task {
            await previous?.value
            await work()
        }
    }

    // MARK: Metering

    private func startMeterTimer() {
        stopMeterTimer()
        let timer = Timer(timeInterval: meterInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        meterTimer = timer
    }

    private func stopMeterTimer() {
        meterTimer?.invalidate()
        meterTimer = nil
    }

    private func tick() {
        guard running, let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        let level = Double(recorder.averagePower(forChannel: 0))
        let elapsedMs = recorder.currentTime * 1000
        let step = gate.step(levelDb: level, startMs: chunkStartMs + elapsedMs - meterInterval * 1000, durationMs: meterInterval * 1000)
        if step.isSpeech || gate.isOpen { chunkHadSpeech = true }

        if chunkHadSpeech {
            if step.closed != nil || cutter.shouldCut(durationMs: elapsedMs, isSpeech: step.isSpeech) {
                rotate()
            }
        } else if elapsedMs >= silentRotationMs {
            // Nothing said yet: start over so a chunk never begins with a long silence.
            rotate()
        }
    }

    // MARK: Interruptions

    private func installObservers() {
        guard observers.isEmpty else { return }
        let session = AVAudioSession.sharedInstance()
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            Task { @MainActor in self?.handleInterruption(typeRaw: typeRaw) }
        })
    }

    private func removeObservers() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
    }

    private func handleInterruption(typeRaw: UInt) {
        guard let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            guard running else { return }
            stopMeterTimer()
            finishChunk()
            eventHandler?(.interrupted)
        case .ended:
            guard running else { return }
            do {
                try activateSession()
                try beginChunk()
                startMeterTimer()
                eventHandler?(.resumed)
            } catch {
                running = false
                eventHandler?(.failed(.audioEngine(error.localizedDescription)))
            }
        @unknown default:
            break
        }
    }
}
#endif
