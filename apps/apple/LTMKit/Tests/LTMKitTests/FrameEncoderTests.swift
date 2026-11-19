import XCTest
@testable import LTMKit

/// Pins the binary frame layout of `packages/protocol/src/frames.ts` byte for byte.
final class FrameEncoderTests: XCTestCase {
    func testKnownFrameBytes() {
        // seq 4_000_000_000, t = 1_763_000_000_123.5 ms, DISCONTINUITY, samples [1, -2, 32767].
        let payload = FrameEncoder.pcmPayload([1, -2, 32_767])
        let frame = FrameEncoder.encode(seq: 4_000_000_000, captureTimeMs: 1_763_000_000_123.5, discontinuity: true, payload: payload)
        let expected: [UInt8] = [
            0x4C, 0x54, 0x01, 0x01, // magic 'L' 'T', version 1, flags DISCONTINUITY
            0x00, 0x28, 0x6B, 0xEE, // seq uint32 LE
            0x00, 0xB8, 0xE7, 0xD1, 0xAF, 0xA7, 0x79, 0x42, // captureTimeMs float64 LE
            0x01, 0x00, 0xFE, 0xFF, 0xFF, 0x7F, // pcm_s16le payload
        ]
        XCTAssertEqual([UInt8](frame), expected)
    }

    func testHeaderWithoutPayloadAndFlags() {
        let frame = FrameEncoder.encode(seq: 0, captureTimeMs: 1_000, discontinuity: false, payload: Data())
        XCTAssertEqual([UInt8](frame), [0x4C, 0x54, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x8F, 0x40])
        XCTAssertEqual(frame.count, FrameEncoder.headerBytes)
    }

    func testMaxSeq() {
        let frame = FrameEncoder.encode(seq: .max, captureTimeMs: 0, discontinuity: false, payload: Data())
        XCTAssertEqual([UInt8](frame)[4..<8], [0xFF, 0xFF, 0xFF, 0xFF])
    }

    func testRoundTrip() {
        let samples: [Int16] = [0, 1, -1, .max, .min, 1234]
        let frame = FrameEncoder.encode(seq: 7, captureTimeMs: 1_763_000_000_000.25, discontinuity: false, payload: FrameEncoder.pcmPayload(samples))
        let decoded = FrameEncoder.decodeHeader(frame)
        XCTAssertEqual(decoded?.seq, 7)
        XCTAssertEqual(decoded?.captureTimeMs, 1_763_000_000_000.25)
        XCTAssertEqual(decoded?.discontinuity, false)
        XCTAssertEqual(decoded?.payload.count, samples.count * 2)
        XCTAssertEqual([UInt8](decoded?.payload ?? Data()).prefix(6), [0x00, 0x00, 0x01, 0x00, 0xFF, 0xFF])
    }

    func testAudioBlockPayloadIsLittleEndian() {
        let block = AudioBlock(samples: [0x0102, -0x0102], startMs: 0, discontinuity: false)
        XCTAssertEqual([UInt8](block.pcmData), [0x02, 0x01, 0xFE, 0xFE])
        XCTAssertEqual(block.durationMs, 2.0 / 16)
    }
}
