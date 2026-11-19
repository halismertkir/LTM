import XCTest
@testable import LTMKit

final class EnergyGateTests: XCTestCase {
    let t0 = 1_763_000_000_000.0

    private func block(_ index: Int, speech: Bool, discontinuity: Bool = false) -> AudioBlock {
        AudioBlock(samples: speech ? toneSamples() : silenceSamples(), startMs: t0 + Double(index) * 200, discontinuity: discontinuity)
    }

    func testLevels() {
        XCTAssertEqual(AudioLevel.rmsDb(silenceSamples()), -60.77, accuracy: 0.05)
        XCTAssertEqual(AudioLevel.rmsDb(toneSamples()), -15.26, accuracy: 0.05)
        XCTAssertEqual(AudioLevel.rmsDb([]), -120)
        XCTAssertEqual(AudioLevel.rmsDb([0, 0, 0]), -120)
    }

    /// 2 s silence, 2 s speech, 2 s silence: one window with 400 ms pre-roll and 1 s hangover.
    func testWindowWithPreRollAndHangover() {
        var gate = EnergyGate()
        var events: [(Int, EnergyGate.Event)] = []
        for index in 0..<30 {
            for event in gate.process(block(index, speech: (10..<20).contains(index))) {
                events.append((index, event))
            }
        }
        let starts = events.compactMap { item -> Double? in
            if case .windowStarted(let start) = item.1 { return start }
            return nil
        }
        XCTAssertEqual(starts, [t0 + 1_600], "window starts at the pre-roll (block 8)")

        let audio = events.compactMap { item -> (Double, Bool)? in
            if case .audio(let b, let isSpeech) = item.1 { return (b.startMs, isSpeech) }
            return nil
        }
        XCTAssertEqual(audio.count, 17, "2 pre-roll + 10 speech + 5 hangover blocks")
        XCTAssertEqual(audio.first?.0, t0 + 1_600)
        XCTAssertEqual(audio.first?.1, false)
        XCTAssertEqual(audio[2].1, true)
        XCTAssertEqual(audio.last?.0, t0 + 4_800)

        guard let last = events.last, case .windowEnded(let endMs, let reason) = last.1 else {
            return XCTFail("window did not end")
        }
        XCTAssertEqual(last.0, 24)
        XCTAssertEqual(endMs, t0 + 5_000)
        XCTAssertEqual(reason, .silence)
        XCTAssertFalse(gate.isOpen)
    }

    func testSilenceProducesNoEvents() {
        var gate = EnergyGate()
        for index in 0..<50 {
            XCTAssertTrue(gate.process(block(index, speech: false)).isEmpty)
        }
    }

    func testMaxWindowCutsAndReopens() {
        var gate = EnergyGate(configuration: .init(preRollMs: 0, maxWindowMs: 1_000))
        var boundaries: [String] = []
        for index in 0..<15 {
            for event in gate.process(block(index, speech: true)) {
                switch event {
                case .windowStarted(let start): boundaries.append("start@\(Int(start - t0))")
                case .windowEnded(let end, let reason): boundaries.append("end@\(Int(end - t0)):\(reason)")
                case .audio: break
                }
            }
        }
        XCTAssertEqual(boundaries, [
            "start@0", "end@1000:maxDuration",
            "start@1000", "end@2000:maxDuration",
            "start@2000", "end@3000:maxDuration",
        ])
    }

    func testDiscontinuityClosesWindowAndClearsPreRoll() {
        var gate = EnergyGate()
        var events: [EnergyGate.Event] = []
        events += gate.process(block(0, speech: false))
        events += gate.process(block(1, speech: true))
        events += gate.process(block(2, speech: true))
        events += gate.process(AudioBlock(samples: toneSamples(), startMs: t0 + 5_000, discontinuity: true))
        let boundaries = events.filter {
            if case .audio = $0 { return false }
            return true
        }
        XCTAssertEqual(boundaries, [
            .windowStarted(startMs: t0),
            .windowEnded(endMs: t0 + 600, reason: .discontinuity),
            .windowStarted(startMs: t0 + 5_000),
        ])
    }

    func testFlushClosesOpenWindow() {
        var gate = EnergyGate()
        _ = gate.process(block(0, speech: true))
        XCTAssertEqual(gate.flush(), [.windowEnded(endMs: t0 + 200, reason: .flush)])
        XCTAssertEqual(gate.flush(), [])
    }

    /// A constant noise source (a fan switched on) must not hold the gate open forever.
    func testAdaptsToConstantNoise() {
        var gate = EnergyGate()
        _ = gate.process(block(0, speech: false))
        var closedAt: Int?
        for index in 1..<300 {
            let noise = AudioBlock(samples: silenceSamples(amplitude: 1_036), startMs: t0 + Double(index) * 200, discontinuity: false)
            for event in gate.process(noise) {
                if case .windowEnded(_, .silence) = event, closedAt == nil { closedAt = index }
            }
        }
        XCTAssertNotNil(closedAt)
        XCTAssertLessThan(closedAt ?? .max, 250)
        XCTAssertFalse(gate.isOpen)
    }

    /// Level-only path used by the watch (100 ms meter readings, 2.5 s hangover).
    func testLevelSteps() {
        var gate = EnergyGate(configuration: .init(hangoverMs: 2_500, preRollMs: 0))
        var opened: [Int] = []
        var closed: [Int] = []
        for index in 0..<70 {
            let level: Double = (20..<30).contains(index) ? -20 : -60
            let step = gate.step(levelDb: level, startMs: Double(index) * 100, durationMs: 100)
            if step.opened { opened.append(index) }
            if step.closed != nil { closed.append(index) }
        }
        XCTAssertEqual(opened, [20])
        XCTAssertEqual(closed, [54])
    }

    func testChunkCutter() {
        let cutter = ChunkCutter()
        XCTAssertFalse(cutter.shouldCut(durationMs: 10_000, isSpeech: false))
        XCTAssertFalse(cutter.shouldCut(durationMs: 26_000, isSpeech: true))
        XCTAssertTrue(cutter.shouldCut(durationMs: 26_000, isSpeech: false))
        XCTAssertTrue(cutter.shouldCut(durationMs: 40_000, isSpeech: true))
        XCTAssertFalse(cutter.isLongEnough(durationMs: 600))
        XCTAssertTrue(cutter.isLongEnough(durationMs: 1_000))
    }
}

final class BlockAssemblerTests: XCTestCase {
    func testBlocksCarryTimeOfFirstSample() {
        var assembler = BlockAssembler()
        XCTAssertTrue(assembler.append(Array(repeating: 1, count: 1_600), firstSampleMs: 0).isEmpty)
        // Small jitter in the hardware timestamp is ignored inside a continuous run.
        let first = assembler.append(Array(repeating: 2, count: 1_600), firstSampleMs: 100.4)
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(first[0].samples.count, 3_200)
        XCTAssertEqual(first[0].startMs, 0)
        XCTAssertFalse(first[0].discontinuity)

        // 500 ms of audio missing exactly at a block boundary: re-anchor and flag it.
        let gap = assembler.append(Array(repeating: 3, count: 3_200), firstSampleMs: 700)
        XCTAssertEqual(gap.map(\.startMs), [700])
        XCTAssertEqual(gap.map(\.discontinuity), [true])

        // Clock drift backwards: re-anchor without a discontinuity.
        let drift = assembler.append(Array(repeating: 4, count: 3_200), firstSampleMs: 750)
        XCTAssertEqual(drift.map(\.startMs), [750])
        XCTAssertEqual(drift.map(\.discontinuity), [false])

        // Explicit interruption marker.
        assembler.markDiscontinuity()
        let marked = assembler.append(Array(repeating: 5, count: 3_200), firstSampleMs: 950)
        XCTAssertEqual(marked.map(\.startMs), [950])
        XCTAssertEqual(marked.map(\.discontinuity), [true])

        _ = assembler.append(Array(repeating: 6, count: 1_000), firstSampleMs: 1_150)
        let tail = assembler.flush()
        XCTAssertEqual(tail?.samples.count, 1_000)
        XCTAssertEqual(tail?.startMs, 1_150)
        XCTAssertNil(assembler.flush())
    }

    func testGapInsideRunEmitsShortBlock() {
        var assembler = BlockAssembler()
        _ = assembler.append(Array(repeating: 1, count: 800), firstSampleMs: 0)
        let out = assembler.append(Array(repeating: 2, count: 3_200), firstSampleMs: 1_000)
        XCTAssertEqual(out.map(\.samples.count), [800, 3_200])
        XCTAssertEqual(out.map(\.startMs), [0, 1_000])
        XCTAssertEqual(out.map(\.discontinuity), [false, true])
    }
}
