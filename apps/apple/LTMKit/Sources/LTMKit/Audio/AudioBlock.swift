import Foundation

/// ~200 ms of 16 kHz mono signed 16-bit PCM, stamped with the device-clock wall time of
/// its first sample.
public struct AudioBlock: Sendable, Equatable {
    public var samples: [Int16]
    /// Device-clock epoch ms of `samples[0]` (fractional; rounded only on the wire).
    public var startMs: Double
    /// True when capture was interrupted (or audio was dropped) right before this block.
    public var discontinuity: Bool
    public var sampleRate: Double

    public init(samples: [Int16], startMs: Double, discontinuity: Bool, sampleRate: Double = LTMProtocol.sampleRate) {
        self.samples = samples
        self.startMs = startMs
        self.discontinuity = discontinuity
        self.sampleRate = sampleRate
    }

    public var durationMs: Double {
        Double(samples.count) * 1000 / sampleRate
    }

    public var endMs: Double { startMs + durationMs }

    /// `pcm_s16le` bytes for a WebSocket frame payload.
    public var pcmData: Data { FrameEncoder.pcmPayload(samples) }

    /// RMS level in dBFS (−∞ clamped to −120).
    public var levelDb: Double { AudioLevel.rmsDb(samples) }
}

public enum AudioLevel {
    public static func rmsDb(_ samples: [Int16]) -> Double {
        guard !samples.isEmpty else { return -120 }
        var sum: Double = 0
        for sample in samples {
            let value = Double(sample)
            sum += value * value
        }
        let rms = (sum / Double(samples.count)).squareRoot() / 32_768
        guard rms > 0 else { return -120 }
        return max(-120, 20 * log10(rms))
    }
}

/// Re-blocks a stream of converted PCM buffers into fixed-size blocks with exact start
/// times. Within a continuous run the time of each block is derived from the sample
/// count (monotonic, no jitter); the run is re-anchored to the hardware timestamp when
/// the two disagree by more than `gapToleranceMs`. A forward jump (lost audio) flags the
/// next block as a discontinuity; a backward jump (clock drift) just re-anchors.
public struct BlockAssembler: Sendable {
    public let sampleRate: Double
    public let blockSamples: Int
    public var gapToleranceMs: Double

    private var pending: [Int16] = []
    private var pendingStartMs: Double = 0
    private var pendingDiscontinuity = false
    private var forceDiscontinuity = false
    /// Expected device time of the next incoming sample (nil before the first buffer).
    private var nextSampleMs: Double?

    public init(sampleRate: Double = LTMProtocol.sampleRate, blockMs: Double = LTMProtocol.recommendedFrameMs, gapToleranceMs: Double = 100) {
        self.sampleRate = sampleRate
        self.blockSamples = max(1, Int((sampleRate * blockMs / 1000).rounded()))
        self.gapToleranceMs = gapToleranceMs
    }

    /// The next appended audio follows an interruption.
    public mutating func markDiscontinuity() {
        forceDiscontinuity = true
    }

    public mutating func append(_ samples: [Int16], firstSampleMs: Double) -> [AudioBlock] {
        guard !samples.isEmpty else { return [] }
        var output: [AudioBlock] = []
        var reanchor = true
        var discontinuity = forceDiscontinuity
        if let expected = nextSampleMs {
            let deviation = firstSampleMs - expected
            reanchor = forceDiscontinuity || abs(deviation) > gapToleranceMs
            if deviation > gapToleranceMs { discontinuity = true }
        }
        forceDiscontinuity = false

        let runStartMs: Double
        if reanchor {
            // Close the current run as a short block and start a new one at the hardware time.
            if !pending.isEmpty {
                output.append(AudioBlock(samples: pending, startMs: pendingStartMs, discontinuity: pendingDiscontinuity, sampleRate: sampleRate))
                pending.removeAll(keepingCapacity: true)
            }
            pendingStartMs = firstSampleMs
            pendingDiscontinuity = discontinuity
            runStartMs = firstSampleMs
        } else {
            // Continuous: trust the sample clock (pendingStartMs already points at the
            // expected time when `pending` is empty).
            runStartMs = nextSampleMs ?? firstSampleMs
        }
        pending.append(contentsOf: samples)
        nextSampleMs = runStartMs + Double(samples.count) * 1000 / sampleRate

        while pending.count >= blockSamples {
            let block = Array(pending[0..<blockSamples])
            output.append(AudioBlock(samples: block, startMs: pendingStartMs, discontinuity: pendingDiscontinuity, sampleRate: sampleRate))
            pending.removeFirst(blockSamples)
            pendingStartMs += Double(blockSamples) * 1000 / sampleRate
            pendingDiscontinuity = false
        }
        return output
    }

    /// Emits what is left (a short block) and resets.
    public mutating func flush() -> AudioBlock? {
        guard !pending.isEmpty else { return nil }
        let block = AudioBlock(samples: pending, startMs: pendingStartMs, discontinuity: pendingDiscontinuity, sampleRate: sampleRate)
        pending.removeAll(keepingCapacity: true)
        pendingDiscontinuity = false
        return block
    }
}
