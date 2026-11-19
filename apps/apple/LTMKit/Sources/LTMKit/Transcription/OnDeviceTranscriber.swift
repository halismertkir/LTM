#if os(iOS) && canImport(Speech)
import AVFoundation
import Foundation
import Speech
import os

/// On-device speech recognition with `SFSpeechRecognizer`.
///
/// `requiresOnDeviceRecognition = true` is set on every request and the recognizer must
/// report `supportsOnDeviceRecognition` for the chosen locale; otherwise this type refuses
/// to start. It never falls back to Apple's server-based recognition — in on-device mode
/// no audio may leave the phone.
///
/// One recognition request per speech window from `EnergyGate` (windows are capped at
/// ~28 s), which keeps each request well inside the per-request duration limits and
/// gives every result an absolute start time: window start + segment offset.
/// Not thread-safe: owned by `CapturePipeline`.
final class OnDeviceTranscriber {
    private let recognizer: SFSpeechRecognizer
    private let languageTag: String
    private let format: AVAudioFormat
    private let onSegment: @Sendable (TranscriptSegment) -> Void
    private var currentRequest: SFSpeechAudioBufferRecognitionRequest?
    private var currentWindowStartMs: Double = 0
    private var tasks: [SFSpeechRecognitionTask] = []
    private var windowCounter = 0

    /// Fails with `.onDeviceRecognitionUnavailable` when on-device recognition is not
    /// supported for the resolved locale on this device.
    init(languageHint: String?, onSegment: @escaping @Sendable (TranscriptSegment) -> Void) throws {
        guard let locale = Self.resolveLocale(languageHint: languageHint),
              let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.supportsOnDeviceRecognition
        else {
            throw CaptureIssue.onDeviceRecognitionUnavailable(language: languageHint ?? Locale.current.identifier)
        }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: LTMProtocol.sampleRate, channels: 1) else {
            throw CaptureIssue.audioEngine("cannot create recognition format")
        }
        self.recognizer = recognizer
        self.format = format
        self.languageTag = locale.identifier.replacingOccurrences(of: "_", with: "-")
        self.onSegment = onSegment
    }

    // MARK: Availability

    static var isAuthorized: Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    static func requestAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    /// True when on-device recognition exists for the hint (or the device locale).
    static func isSupported(languageHint: String?) -> Bool {
        guard let locale = resolveLocale(languageHint: languageHint),
              let recognizer = SFSpeechRecognizer(locale: locale)
        else { return false }
        return recognizer.supportsOnDeviceRecognition
    }

    /// Picks a supported recognizer locale for a language hint such as "tr" or "en-GB":
    /// exact match first, then the device's region for that language, then any region.
    static func resolveLocale(languageHint: String?) -> Locale? {
        let supported = SFSpeechRecognizer.supportedLocales().map { $0.identifier.replacingOccurrences(of: "_", with: "-") }
        let requested = (languageHint ?? Locale.current.identifier).replacingOccurrences(of: "_", with: "-")
        let lowerRequested = requested.lowercased()
        if let exact = supported.first(where: { $0.lowercased() == lowerRequested }) {
            return Locale(identifier: exact)
        }
        let language = String(lowerRequested.split(separator: "-").first ?? Substring(lowerRequested))
        let deviceRegionMatch = language + "-" + (Locale.current.region?.identifier.lowercased() ?? "")
        if let regional = supported.first(where: { $0.lowercased() == deviceRegionMatch }) {
            return Locale(identifier: regional)
        }
        if let any = supported.sorted().first(where: { $0.lowercased().hasPrefix(language + "-") || $0.lowercased() == language }) {
            return Locale(identifier: any)
        }
        return nil
    }

    // MARK: Windows

    func beginWindow(startMs: Double) {
        endWindow()
        tasks.removeAll { $0.state == .completed }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        request.taskHint = .dictation
        windowCounter += 1
        let windowId = windowCounter
        let windowStart = startMs
        let languageTag = self.languageTag
        let onSegment = self.onSegment
        let task = recognizer.recognitionTask(with: request) { result, error in
            if let result, result.isFinal,
               let segment = Self.makeSegment(result.bestTranscription, windowStartMs: windowStart, windowId: windowId, language: languageTag) {
                onSegment(segment)
            }
            if let error {
                // "No speech detected" ends most silent windows; it is not worth surfacing.
                Log.speech.debug("recognition ended: \(error.localizedDescription, privacy: .public)")
            }
        }
        tasks.append(task)
        currentRequest = request
        currentWindowStartMs = startMs
    }

    func append(_ block: AudioBlock) {
        guard let request = currentRequest, !block.samples.isEmpty else { return }
        let count = block.samples.count
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channels = buffer.floatChannelData
        else { return }
        buffer.frameLength = AVAudioFrameCount(count)
        let destination = channels[0]
        for index in 0..<count {
            destination[index] = Float(block.samples[index]) / 32_768
        }
        request.append(buffer)
    }

    func endWindow() {
        currentRequest?.endAudio()
        currentRequest = nil
    }

    var hasPendingResults: Bool {
        tasks.contains { $0.state == .starting || $0.state == .running || $0.state == .finishing }
    }

    func cancelAll() {
        currentRequest = nil
        for task in tasks { task.cancel() }
        tasks.removeAll()
    }

    // MARK: Segments

    static func makeSegment(_ transcription: SFTranscription, windowStartMs: Double, windowId: Int, language: String) -> TranscriptSegment? {
        let text = transcription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let parts = transcription.segments
        let firstOffset = parts.first?.timestamp ?? 0
        let lastEnd = parts.last.map { $0.timestamp + $0.duration } ?? firstOffset
        let confidences = parts.map { Double($0.confidence) }.filter { $0 > 0 }
        let confidence = confidences.isEmpty ? nil : min(1, max(0, confidences.reduce(0, +) / Double(confidences.count)))
        let startMs = EpochMs.rounded(windowStartMs + firstOffset * 1000)
        let endMs = max(startMs, EpochMs.rounded(windowStartMs + lastEnd * 1000))
        return TranscriptSegment(
            id: "w\(EpochMs.rounded(windowStartMs))-\(windowId)",
            startMs: startMs,
            endMs: endMs,
            text: String(text.prefix(8_000)),
            confidence: confidence,
            language: language,
            speaker: nil
        )
    }
}
#endif
