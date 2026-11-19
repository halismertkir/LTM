import Foundation

/// Small energy-based voice activity gate.
///
/// - **Adaptive noise floor**: falls quickly towards quieter input, rises slowly (faster
///   while the input is not speech, very slowly during speech so a fan switched on is
///   eventually absorbed instead of keeping the gate open forever).
/// - **Threshold**: a block is speech when its level is `thresholdDb` above the floor and
///   above `absoluteMinDb`.
/// - **Hangover**: the window stays open for `hangoverMs` after the last speech block so
///   short pauses between words do not split it.
/// - **Pre-roll**: up to `preRollMs` of audio before the first speech block is emitted
///   with the window, so the onset of the first word is not clipped.
/// - **Max window**: windows are force-cut at `maxWindowMs` (on-device recognition needs
///   bounded requests).
///
/// It is used three ways: to drop silence before live upload, to cut chunk recordings at
/// pauses, and to delimit speech windows for on-device recognition. The level-only entry
/// point (`step`) serves the watch, which only has `AVAudioRecorder` meter readings.
public struct EnergyGate: Sendable {
    public struct Configuration: Sendable, Equatable {
        public var thresholdDb: Double = 10
        public var absoluteMinDb: Double = -55
        public var hangoverMs: Double = 1_000
        public var preRollMs: Double = 400
        public var maxWindowMs: Double = .infinity
        /// The floor never sits above this (so a loud first block does not blind the gate).
        public var maxNoiseFloorDb: Double = -35
        public var minNoiseFloorDb: Double = -90
        /// Fraction of the distance to a quieter level covered per block.
        public var floorFallFactor: Double = 0.5
        public var floorRiseDbPerSecond: Double = 3
        public var floorRiseDuringSpeechDbPerSecond: Double = 0.5

        public init(
            thresholdDb: Double = 10,
            absoluteMinDb: Double = -55,
            hangoverMs: Double = 1_000,
            preRollMs: Double = 400,
            maxWindowMs: Double = .infinity
        ) {
            self.thresholdDb = thresholdDb
            self.absoluteMinDb = absoluteMinDb
            self.hangoverMs = hangoverMs
            self.preRollMs = preRollMs
            self.maxWindowMs = maxWindowMs
        }
    }

    public enum EndReason: Sendable, Equatable {
        case silence
        case maxDuration
        case discontinuity
        case flush
    }

    public enum Event: Sendable, Equatable {
        case windowStarted(startMs: Double)
        /// Audio that belongs to the open window (pre-roll first). `isSpeech` is the
        /// instantaneous decision for this block (false for pre-roll and hangover).
        case audio(AudioBlock, isSpeech: Bool)
        case windowEnded(endMs: Double, reason: EndReason)
    }

    /// Result of feeding one level reading.
    public struct Step: Sendable, Equatable {
        public var isSpeech: Bool
        public var opened: Bool
        public var closed: EndReason?
    }

    public var configuration: Configuration
    public private(set) var noiseFloorDb: Double?
    public private(set) var isOpen = false
    public private(set) var windowStartMs: Double = 0
    private var lastSpeechEndMs: Double = 0
    private var lastEndMs: Double?
    private var preRoll: [AudioBlock] = []

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    // MARK: Level-only core

    /// Feeds one level reading covering [startMs, startMs + durationMs).
    /// `openedAtMs` lets the block-based wrapper start the window at its pre-roll.
    public mutating func step(levelDb: Double, startMs: Double, durationMs: Double, openedAtMs: Double? = nil) -> Step {
        let endMs = startMs + durationMs
        // Decide against the floor *before* adapting it, so one loud block cannot raise
        // its own bar. The very first reading seeds the floor (clamped to a quiet ceiling,
        // so starting in the middle of a conversation still detects speech).
        let floorBefore = noiseFloorDb ?? clampFloor(levelDb)
        let isSpeech = levelDb >= max(configuration.absoluteMinDb, floorBefore + configuration.thresholdDb)
        adaptFloor(from: floorBefore, levelDb: levelDb, isSpeech: isSpeech, durationMs: durationMs)

        var result = Step(isSpeech: isSpeech, opened: false, closed: nil)
        if isSpeech { lastSpeechEndMs = endMs }

        if !isOpen {
            if isSpeech {
                isOpen = true
                windowStartMs = openedAtMs ?? startMs
                result.opened = true
            }
        } else if endMs - windowStartMs >= configuration.maxWindowMs {
            isOpen = false
            result.closed = .maxDuration
        } else if !isSpeech && endMs - lastSpeechEndMs >= configuration.hangoverMs {
            isOpen = false
            result.closed = .silence
        }
        lastEndMs = endMs
        return result
    }

    private func clampFloor(_ value: Double) -> Double {
        min(max(value, configuration.minNoiseFloorDb), configuration.maxNoiseFloorDb)
    }

    private mutating func adaptFloor(from floor: Double, levelDb: Double, isSpeech: Bool, durationMs: Double) {
        guard noiseFloorDb != nil else {
            noiseFloorDb = floor
            return
        }
        var updated = floor
        if levelDb < floor {
            updated += (levelDb - floor) * configuration.floorFallFactor
        } else {
            let rate = isSpeech ? configuration.floorRiseDuringSpeechDbPerSecond : configuration.floorRiseDbPerSecond
            updated += min(levelDb - floor, rate * durationMs / 1000)
        }
        noiseFloorDb = clampFloor(updated)
    }

    // MARK: Block-based wrapper

    public mutating func process(_ block: AudioBlock) -> [Event] {
        var events: [Event] = []
        if block.discontinuity {
            if isOpen {
                isOpen = false
                events.append(.windowEnded(endMs: lastEndMs ?? block.startMs, reason: .discontinuity))
            }
            preRoll.removeAll()
        }

        let preRollStart = preRoll.first?.startMs
        let result = step(levelDb: block.levelDb, startMs: block.startMs, durationMs: block.durationMs, openedAtMs: preRollStart)

        if result.opened {
            events.append(.windowStarted(startMs: windowStartMs))
            for earlier in preRoll {
                events.append(.audio(earlier, isSpeech: false))
            }
            preRoll.removeAll()
            events.append(.audio(block, isSpeech: true))
        } else if isOpen || result.closed != nil {
            events.append(.audio(block, isSpeech: result.isSpeech))
            if let reason = result.closed {
                events.append(.windowEnded(endMs: block.endMs, reason: reason))
            }
        } else {
            preRoll.append(block)
            trimPreRoll()
        }
        return events
    }

    /// Closes an open window (stop / pause).
    public mutating func flush() -> [Event] {
        preRoll.removeAll()
        guard isOpen else { return [] }
        isOpen = false
        return [.windowEnded(endMs: lastEndMs ?? windowStartMs, reason: .flush)]
    }

    private mutating func trimPreRoll() {
        var total = preRoll.reduce(0) { $0 + $1.durationMs }
        while let first = preRoll.first, total - first.durationMs >= configuration.preRollMs {
            total -= first.durationMs
            preRoll.removeFirst()
        }
        // Keep at most `preRollMs` worth (allowing one partially-overlapping block).
        if configuration.preRollMs <= 0 { preRoll.removeAll() }
    }
}

/// Decides where to cut store-and-forward chunks inside a speech window: after
/// `softLimitMs` at the first non-speech block (a pause), at `hardLimitMs` regardless.
public struct ChunkCutter: Sendable, Equatable {
    public var softLimitMs: Double
    public var hardLimitMs: Double
    /// Chunks shorter than this are discarded as noise.
    public var minimumMs: Double

    public init(softLimitMs: Double = 25_000, hardLimitMs: Double = 40_000, minimumMs: Double = 1_000) {
        self.softLimitMs = softLimitMs
        self.hardLimitMs = hardLimitMs
        self.minimumMs = minimumMs
    }

    public func shouldCut(durationMs: Double, isSpeech: Bool) -> Bool {
        durationMs >= hardLimitMs || (durationMs >= softLimitMs && !isSpeech)
    }

    public func isLongEnough(durationMs: Double) -> Bool {
        durationMs >= minimumMs
    }
}
