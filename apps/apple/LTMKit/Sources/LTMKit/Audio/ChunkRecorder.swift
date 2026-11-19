#if os(iOS)
import AVFoundation
import Foundation

/// Writes gated 16 kHz mono PCM into rotating AAC (.m4a) chunks for store-and-forward.
///
/// Each chunk is a contiguous span of audio, so its `startMs` (time of its first sample)
/// and `durationMs` (sample count) are exact. `seq` increases by one per uploaded chunk
/// of the stream; chunks too short to be useful are discarded without using a seq.
/// Not thread-safe: owned by `CapturePipeline` (an actor).
final class ChunkRecorder {
    struct Chunk: Sendable {
        var url: URL
        var seq: Int
        var startMs: Int64
        var durationMs: Int64
    }

    let directory: URL
    let streamId: String
    private(set) var nextSeq = 0
    private var file: AVAudioFile?
    private var url: URL?
    private var startMs: Double = 0
    private var samplesWritten = 0

    init(directory: URL, streamId: String) {
        self.directory = directory
        self.streamId = streamId
    }

    var isRecording: Bool { file != nil }

    var durationMs: Double { Double(samplesWritten) * 1000 / LTMProtocol.sampleRate }

    func append(_ block: AudioBlock) throws {
        if file == nil { try open(startMs: block.startMs) }
        guard let file else { return }
        let count = block.samples.count
        guard count > 0 else { return }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(count)),
              let channels = buffer.int16ChannelData
        else { throw CaptureIssue.storage("cannot allocate audio buffer") }
        buffer.frameLength = AVAudioFrameCount(count)
        let destination = channels[0]
        for index in 0..<count {
            destination[index] = block.samples[index]
        }
        try file.write(from: buffer)
        samplesWritten += count
    }

    /// Closes the current file. Returns the chunk, or nil (file deleted) if it is shorter
    /// than `minimumMs`.
    func finish(minimumMs: Double) -> Chunk? {
        guard file != nil, let url else { return nil }
        // AVAudioFile writes the AAC trailer (moov atom) when it is released; we hold the
        // only reference, so dropping it finalises the file synchronously.
        file = nil
        self.url = nil
        let duration = durationMs
        samplesWritten = 0
        guard duration >= minimumMs else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        let seq = nextSeq
        nextSeq += 1
        return Chunk(url: url, seq: seq, startMs: EpochMs.rounded(startMs), durationMs: EpochMs.rounded(duration))
    }

    /// Drops an unfinished file (stop without upload).
    func discard() {
        guard let url else { return }
        file = nil
        self.url = nil
        samplesWritten = 0
        try? FileManager.default.removeItem(at: url)
    }

    private func open(startMs: Double) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("\(streamId)-\(nextSeq)-\(UUID().uuidString.prefix(8)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: LTMProtocol.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true)
        } catch {
            throw CaptureIssue.storage(error.localizedDescription)
        }
        self.url = url
        self.startMs = startMs
        samplesWritten = 0
    }
}
#endif
