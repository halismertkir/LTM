#if os(iOS)
import AVFoundation
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Speech

/// Routes gated audio to the active transport/transcription combination:
///
/// | transcription | live                          | store-and-forward                   |
/// |---------------|-------------------------------|-------------------------------------|
/// | server        | PCM frames over the WebSocket | AAC chunks → `UploadQueue`          |
/// | on-device     | `transcript` stream messages  | `/ingest/transcripts` → `UploadQueue` |
///
/// Silence never leaves the device: only blocks inside an `EnergyGate` window are sent,
/// recorded or recognised.
actor CapturePipeline {
    private var config: CaptureSessionConfig
    private let uploadQueue: UploadQueue
    private let recordingDirectory: URL
    private let connector: any WebSocketConnector
    private let emit: @Sendable (CaptureEngineEvent) -> Void
    private var gate = EnergyGate()
    private let cutter = ChunkCutter()
    private var recorder: ChunkRecorder?
    private var transcriber: OnDeviceTranscriber?
    private var stream: StreamClient?
    private var streamEvents: Task<Void, Never>?
    private var lastSentEndMs: Double?

    init(
        config: CaptureSessionConfig,
        uploadQueue: UploadQueue,
        recordingDirectory: URL,
        connector: any WebSocketConnector,
        emit: @escaping @Sendable (CaptureEngineEvent) -> Void
    ) {
        self.config = config
        self.uploadQueue = uploadQueue
        self.recordingDirectory = recordingDirectory
        self.connector = connector
        self.emit = emit
    }

    static func gateConfiguration(for mode: CaptureMode) -> EnergyGate.Configuration {
        switch (mode.transcription, mode.transport) {
        case (.onDevice, _):
            // Bounded windows for recognition requests.
            return EnergyGate.Configuration(hangoverMs: 800, preRollMs: 400, maxWindowMs: 28_000)
        case (.server, .live):
            return EnergyGate.Configuration(hangoverMs: 1_000, preRollMs: 400)
        case (.server, .storeAndForward):
            // A longer hangover keeps a conversation in one chunk instead of many tiny ones.
            return EnergyGate.Configuration(hangoverMs: 2_500, preRollMs: 400)
        }
    }

    func begin() async throws {
        gate.configuration = Self.gateConfiguration(for: config.mode)
        if config.mode.transcription == .onDevice {
            transcriber = try OnDeviceTranscriber(languageHint: config.language) { [weak self] segment in
                Task { await self?.handleTranscript(segment) }
            }
        }
        await setUpTransport()
    }

    private func setUpTransport() async {
        switch config.mode.transport {
        case .live:
            let isAudio = config.mode.transcription == .server
            var streamConfig = StreamClient.Configuration(
                url: config.server.webSocketURL,
                token: config.token,
                streamId: config.streamId,
                source: config.source,
                mode: isAudio ? .audio : .transcript,
                audioFormat: isAudio ? .pcm16kMono : nil,
                language: config.language
            )
            streamConfig.pingInterval = 15
            let client = StreamClient(configuration: streamConfig, connector: connector)
            stream = client
            streamEvents = Task { [weak self] in
                for await event in client.events {
                    await self?.handleStreamEvent(event)
                }
            }
            await client.start()
        case .storeAndForward:
            if config.mode.transcription == .server {
                recorder = ChunkRecorder(directory: recordingDirectory, streamId: config.streamId)
            }
        }
    }

    func process(_ block: AudioBlock) async {
        for event in gate.process(block) {
            await handle(event)
        }
    }

    private func handle(_ event: EnergyGate.Event) async {
        let onDevice = config.mode.transcription == .onDevice
        switch event {
        case .windowStarted(let startMs):
            if onDevice { transcriber?.beginWindow(startMs: startMs) }
        case .audio(let block, let isSpeech):
            if onDevice {
                transcriber?.append(block)
                return
            }
            switch config.mode.transport {
            case .live:
                let gap = lastSentEndMs.map { abs(block.startMs - $0) > 50 } ?? false
                await stream?.sendAudio(block.pcmData, captureTimeMs: block.startMs, discontinuity: block.discontinuity || gap)
                lastSentEndMs = block.endMs
            case .storeAndForward:
                guard let recorder else { return }
                if block.discontinuity && recorder.isRecording { await finalizeChunk() }
                do {
                    try recorder.append(block)
                } catch {
                    emit(.failed(.storage(error.localizedDescription)))
                    return
                }
                if cutter.shouldCut(durationMs: recorder.durationMs, isSpeech: isSpeech) {
                    await finalizeChunk()
                }
            }
        case .windowEnded:
            if onDevice {
                transcriber?.endWindow()
            } else if config.mode.transport == .storeAndForward {
                await finalizeChunk()
            }
        }
    }

    private func finalizeChunk() async {
        guard let recorder, let chunk = recorder.finish(minimumMs: cutter.minimumMs) else { return }
        let meta = ChunkMeta(
            streamId: recorder.streamId,
            seq: chunk.seq,
            source: config.source,
            startMs: chunk.startMs,
            durationMs: chunk.durationMs,
            clientTimeMs: EpochMs.now(),
            language: config.language
        )
        do {
            try await uploadQueue.enqueueChunk(audioFile: chunk.url, meta: meta, mimeType: "audio/mp4", role: config.role)
        } catch {
            emit(.failed(.storage(error.localizedDescription)))
        }
    }

    private func handleTranscript(_ segment: TranscriptSegment) async {
        emit(.caption(segment.text))
        switch config.mode.transport {
        case .live:
            await stream?.sendTranscript([segment])
        case .storeAndForward:
            let batch = TranscriptBatch(streamId: config.streamId, source: config.source, clientTimeMs: EpochMs.now(), segments: [segment])
            do {
                try await uploadQueue.enqueueTranscripts(batch, role: config.role)
            } catch {
                emit(.failed(.storage(error.localizedDescription)))
            }
        }
    }

    private func handleStreamEvent(_ event: StreamClient.Event) {
        switch event {
        case .segment(let segment):
            emit(.caption(segment.text))
        case .state(.failed(let error)):
            emit(.serverRejected(error))
        default:
            break
        }
    }

    /// Closes the current speech window (pause): the last chunk is enqueued, the current
    /// recognition request ends. The stream itself stays open.
    func pause() async {
        for event in gate.flush() { await handle(event) }
        lastSentEndMs = nil
    }

    /// Ends the current stream and starts a new one with another transport.
    func setTransport(_ transport: CaptureTransport) async {
        guard transport != config.mode.transport else { return }
        for event in gate.flush() { await handle(event) }
        await endCurrentTransport()
        config.mode.transport = transport
        config.streamId = CaptureSessionConfig.newStreamId()
        gate.configuration = Self.gateConfiguration(for: config.mode)
        lastSentEndMs = nil
        await setUpTransport()
    }

    func finish() async {
        for event in gate.flush() { await handle(event) }
        if let transcriber {
            // Give the last recognition request a moment to deliver its final result
            // before the stream is ended.
            var waited = 0
            while transcriber.hasPendingResults && waited < 30 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                waited += 1
            }
        }
        await endCurrentTransport()
        transcriber?.cancelAll()
        transcriber = nil
    }

    private func endCurrentTransport() async {
        switch config.mode.transport {
        case .live:
            if let stream {
                let confirmed = await stream.finish()
                if !confirmed {
                    // Offline or the server did not answer: end it over REST once reachable.
                    try? await uploadQueue.enqueueStreamEnd(streamId: config.streamId, role: config.role)
                }
            }
            streamEvents?.cancel()
            streamEvents = nil
            stream = nil
        case .storeAndForward:
            await finalizeChunk()
            recorder = nil
            try? await uploadQueue.enqueueStreamEnd(streamId: config.streamId, role: config.role)
        }
    }
}

/// iPhone capture engine: `AudioCapture` → `CapturePipeline`.
@MainActor
public final class PhoneCaptureEngine: CaptureEngine {
    public var eventHandler: (@MainActor (CaptureEngineEvent) -> Void)?
    private let uploadQueue: UploadQueue
    private let recordingDirectory: URL
    private let connector: any WebSocketConnector
    private var capture: AudioCapture?
    private var pipeline: CapturePipeline?
    private var consumer: Task<Void, Never>?

    public init(uploadQueue: UploadQueue, recordingDirectory: URL, connector: any WebSocketConnector = URLSessionWebSocketConnector()) {
        self.uploadQueue = uploadQueue
        self.recordingDirectory = recordingDirectory
        self.connector = connector
        // Partial chunk files from a crash have no AAC trailer and cannot be decoded.
        try? FileManager.default.removeItem(at: recordingDirectory)
        try? FileManager.default.createDirectory(at: recordingDirectory, withIntermediateDirectories: true)
    }

    // MARK: Permissions

    public nonisolated static var microphoneGranted: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    public nonisolated static var microphoneUndetermined: Bool {
        AVAudioApplication.shared.recordPermission == .undetermined
    }

    public nonisolated static func requestMicrophone() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    public nonisolated static var speechAuthorized: Bool { OnDeviceTranscriber.isAuthorized }

    public nonisolated static var speechUndetermined: Bool {
        SFSpeechRecognizer.authorizationStatus() == .notDetermined
    }

    public nonisolated static func requestSpeech() async -> Bool {
        await OnDeviceTranscriber.requestAuthorization()
    }

    public nonisolated static func onDeviceRecognitionSupported(languageHint: String?) -> Bool {
        OnDeviceTranscriber.isSupported(languageHint: languageHint)
    }

    // MARK: CaptureEngine

    public func start(_ config: CaptureSessionConfig) async throws {
        guard Self.microphoneGranted else { throw CaptureIssue.microphonePermissionDenied }
        if config.mode.transcription == .onDevice {
            guard Self.speechAuthorized else { throw CaptureIssue.speechPermissionDenied }
            guard Self.onDeviceRecognitionSupported(languageHint: config.language) else {
                throw CaptureIssue.onDeviceRecognitionUnavailable(language: config.language ?? Locale.current.identifier)
            }
        }
        let emit: @Sendable (CaptureEngineEvent) -> Void = { [weak self] event in
            Task { @MainActor in self?.eventHandler?(event) }
        }
        let pipeline = CapturePipeline(
            config: config,
            uploadQueue: uploadQueue,
            recordingDirectory: recordingDirectory,
            connector: connector,
            emit: emit
        )
        try await pipeline.begin()

        let capture = AudioCapture()
        capture.setEventHandler { event in
            switch event {
            case .interruptionBegan:
                emit(.interrupted)
            case .interruptionEnded, .restarted:
                emit(.resumed)
            case .restartFailed(let message):
                emit(.failed(.audioEngine(message)))
            }
        }
        let blocks: AsyncStream<AudioBlock>
        do {
            blocks = try capture.start()
        } catch {
            await pipeline.finish()
            throw (error as? CaptureIssue) ?? CaptureIssue.audioEngine(error.localizedDescription)
        }
        self.capture = capture
        self.pipeline = pipeline
        consumer = Task.detached(priority: .userInitiated) {
            for await block in blocks {
                await pipeline.process(block)
            }
        }
    }

    public func pause() async {
        capture?.pause()
        await pipeline?.pause()
    }

    public func resume() async throws {
        guard let capture else { return }
        do {
            try capture.resume()
        } catch {
            throw (error as? CaptureIssue) ?? CaptureIssue.audioEngine(error.localizedDescription)
        }
    }

    public func stop() async {
        capture?.stop()
        capture = nil
        // Drain blocks still buffered in the stream before ending the stream.
        await consumer?.value
        consumer = nil
        await pipeline?.finish()
        pipeline = nil
    }

    public func updateTransport(_ transport: CaptureTransport) async {
        await pipeline?.setTransport(transport)
    }
}
#endif
