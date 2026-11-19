#if os(iOS)
import AVFoundation
import Foundation
import os

/// Maps `AVAudioTime` host time (mach ticks) to device-clock epoch milliseconds.
///
/// The tap callback runs some time after its first sample was captured (buffering, IO
/// cycles), so "now at callback" would be late by up to ~100 ms and jitter. The buffer's
/// host time is when the first sample entered the input; we measure how long ago that
/// was in host-time seconds and subtract it from the current wall clock.
enum HostTime {
    static func epochMs(for time: AVAudioTime) -> Double? {
        guard time.isHostTimeValid else { return nil }
        let nowHost = mach_absolute_time()
        let nowMs = Date().timeIntervalSince1970 * 1000
        let ageSeconds = AVAudioTime.seconds(forHostTime: nowHost) - AVAudioTime.seconds(forHostTime: time.hostTime)
        return nowMs - ageSeconds * 1000
    }
}

/// Converts tap buffers to 16 kHz mono Int16 and re-blocks them. One instance per engine
/// start; the tap thread and the capture queue both touch it, hence the lock.
final class TapProcessor: @unchecked Sendable {
    private let lock = NSLock()
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat
    private let continuation: AsyncStream<AudioBlock>.Continuation
    private var assembler = BlockAssembler()
    private var finished = false

    init(converter: AVAudioConverter, outputFormat: AVAudioFormat, continuation: AsyncStream<AudioBlock>.Continuation, discontinuity: Bool) {
        self.converter = converter
        self.outputFormat = outputFormat
        self.continuation = continuation
        if discontinuity { assembler.markDiscontinuity() }
    }

    func process(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        let inputRate = buffer.format.sampleRate
        let fallbackMs = Date().timeIntervalSince1970 * 1000 - Double(buffer.frameLength) / max(inputRate, 1) * 1000
        let startMs = HostTime.epochMs(for: time) ?? fallbackMs
        guard let samples = convert(buffer), !samples.isEmpty else { return }
        let blocks: [AudioBlock] = withLock {
            finished ? [] : assembler.append(samples, firstSampleMs: startMs)
        }
        for block in blocks { continuation.yield(block) }
    }

    /// Emits the trailing partial block and stops accepting buffers.
    func finish() {
        let tail: AudioBlock? = withLock {
            guard !finished else { return nil }
            finished = true
            return assembler.flush()
        }
        if let tail { continuation.yield(tail) }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> [Int16]? {
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return nil }
        var supplied = false
        var conversionError: NSError?
        // Hand the converter exactly one buffer per call and answer `.noDataNow` afterwards
        // (not `.endOfStream`), so the sample-rate converter keeps its filter state between
        // tap callbacks and the output is continuous.
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, conversionError == nil, let channels = output.int16ChannelData else { return nil }
        let count = Int(output.frameLength)
        return Array(UnsafeBufferPointer(start: channels[0], count: count))
    }
}

/// Microphone capture on iPhone: `AVAudioEngine` input tap → 16 kHz mono Int16 →
/// ~200 ms `AudioBlock`s stamped with the wall-clock time of their first sample.
///
/// Audio session: `.playAndRecord` + `.default` mode with
/// - `.mixWithOthers` — LTM never takes audio away from the user: music, podcasts and
///   navigation keep playing, and a mixable session may (re)activate in the background;
///   `.record` would silence other apps.
/// - `.defaultToSpeaker` — without it `.playAndRecord` moves *all* output, including other
///   apps' mixed audio, to the earpiece.
/// - `.allowBluetoothA2DP` (but not `.allowBluetooth`/HFP) — Bluetooth headphones stay in
///   high-quality output mode and the built-in microphone keeps capturing the room; HFP
///   would switch input to the headset mic and degrade everybody's audio.
/// - `.default` mode keeps the system's automatic gain control, which helps with distant
///   speakers across a table (`.measurement` would give raw, much quieter levels;
///   `.voiceChat` adds processing tuned for a single near talker).
/// With `UIBackgroundModes: audio`, a running engine keeps the app alive with the screen
/// locked. Interruptions (calls, Siri), route changes, engine configuration changes and
/// media-services resets restart the engine cleanly and flag a discontinuity.
public final class AudioCapture: @unchecked Sendable {
    public enum Event: Sendable, Equatable {
        case interruptionBegan
        case interruptionEnded
        case restarted
        case restartFailed(String)
    }

    private let queue = DispatchQueue(label: "app.ltm.audio-capture")
    private let eventHandler = LockedBox<(@Sendable (Event) -> Void)?>(nil)
    private var engine: AVAudioEngine?
    private var processor: TapProcessor?
    private var continuation: AsyncStream<AudioBlock>.Continuation?
    private var wantsRunning = false
    private var isPaused = false
    private var isInterrupted = false
    private var observers: [NSObjectProtocol] = []

    public init() {}

    public func setEventHandler(_ handler: @escaping @Sendable (Event) -> Void) {
        eventHandler.set(handler)
    }

    /// Activates the session and starts capturing. The returned stream ends on `stop()`.
    public func start() throws -> AsyncStream<AudioBlock> {
        try queue.sync {
            var created: AsyncStream<AudioBlock>.Continuation?
            // ~60 s of blocks if the consumer stalls; older blocks are dropped first.
            let stream = AsyncStream<AudioBlock>(bufferingPolicy: .bufferingNewest(300)) { created = $0 }
            continuation = created
            wantsRunning = true
            isPaused = false
            isInterrupted = false
            installObservers()
            do {
                try Self.activateSession()
                try startEngine(discontinuity: false)
            } catch {
                shutDown()
                throw error
            }
            return stream
        }
    }

    /// Stops the engine and releases the microphone (the recording indicator goes away)
    /// while keeping the block stream open.
    public func pause() {
        queue.sync {
            isPaused = true
            stopEngine()
            Self.deactivateSession()
        }
    }

    public func resume() throws {
        try queue.sync {
            isPaused = false
            try Self.activateSession()
            try startEngine(discontinuity: true)
        }
    }

    public func stop() {
        queue.sync { shutDown() }
    }

    // MARK: Session

    static func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            throw CaptureIssue.audioSession(error.localizedDescription)
        }
    }

    static func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: Engine (queue only)

    private func startEngine(discontinuity: Bool) throws {
        guard let continuation else { return }
        stopEngine()
        let engine = self.engine ?? AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw CaptureIssue.audioEngine("no microphone input is available")
        }
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: LTMProtocol.sampleRate, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        else {
            throw CaptureIssue.audioEngine("cannot convert \(inputFormat) to 16 kHz mono")
        }
        converter.downmix = true
        let processor = TapProcessor(converter: converter, outputFormat: outputFormat, continuation: continuation, discontinuity: discontinuity)
        // ~100 ms at 48 kHz; the engine may choose a different size, which is fine.
        input.installTap(onBus: 0, bufferSize: 4_800, format: inputFormat) { buffer, time in
            processor.process(buffer, at: time)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw CaptureIssue.audioEngine(error.localizedDescription)
        }
        self.processor = processor
    }

    private func stopEngine() {
        processor?.finish()
        processor = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning { engine.stop() }
        }
    }

    private func shutDown() {
        wantsRunning = false
        stopEngine()
        engine = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        continuation?.finish()
        continuation = nil
        Self.deactivateSession()
    }

    private func restart(reason: String) {
        guard wantsRunning, !isPaused, !isInterrupted else { return }
        do {
            try Self.activateSession()
            try startEngine(discontinuity: true)
            Log.audio.info("capture restarted after \(reason, privacy: .public)")
            emit(.restarted)
        } catch {
            Log.audio.error("capture restart failed: \(error.localizedDescription, privacy: .public)")
            emit(.restartFailed(error.localizedDescription))
        }
    }

    private func emit(_ event: Event) {
        eventHandler.get()?(event)
    }

    // MARK: Notifications

    private func installObservers() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
            let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            self?.queue.async { self?.handleInterruption(typeRaw: typeRaw) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] note in
            let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            self?.queue.async { self?.handleRouteChange(reasonRaw: reasonRaw) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
            self?.queue.async { self?.handleMediaServicesReset() }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] _ in
            self?.queue.async { self?.handleConfigurationChange() }
        })
    }

    private func handleInterruption(typeRaw: UInt) {
        guard let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            // The system already stopped the engine; flush what we have.
            isInterrupted = true
            stopEngine()
            emit(.interruptionBegan)
        case .ended:
            isInterrupted = false
            // Resume even without `.shouldResume`: the user asked to listen and has not
            // stopped. If activation is refused, the UI offers a manual retry.
            restart(reason: "interruption")
            if engine?.isRunning == true { emit(.interruptionEnded) }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(reasonRaw: UInt) {
        guard let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) else { return }
        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable, .routeConfigurationChange, .override:
            // The input format may have changed (e.g. a wired headset mic): rebuild the tap.
            restart(reason: "route change")
        default:
            break
        }
    }

    private func handleConfigurationChange() {
        guard let engine, !engine.isRunning else { return }
        restart(reason: "engine configuration change")
    }

    private func handleMediaServicesReset() {
        // Every audio object is invalid after a reset: start over with a fresh engine.
        processor?.finish()
        processor = nil
        engine = nil
        restart(reason: "media services reset")
    }
}
#endif
