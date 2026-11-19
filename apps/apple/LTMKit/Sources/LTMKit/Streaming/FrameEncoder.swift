import Foundation

/// Binary audio frame of the ingest WebSocket (`packages/protocol/src/frames.ts`):
///
/// ```
/// offset  size  field
/// 0       1     magic[0] = 0x4C ('L')
/// 1       1     magic[1] = 0x54 ('T')
/// 2       1     version  = 1
/// 3       1     flags    (bit 0: DISCONTINUITY)
/// 4       4     seq      (uint32 LE)
/// 8       8     captureTimeMs (float64 LE, device-clock epoch ms of the FIRST sample)
/// 16      n     payload  (pcm_s16le, interleaved)
/// ```
public enum FrameEncoder {
    public static let magic0: UInt8 = 0x4C
    public static let magic1: UInt8 = 0x54
    public static let version: UInt8 = 1
    public static let headerBytes = 16
    public static let flagDiscontinuity: UInt8 = 0x01

    public static func encode(seq: UInt32, captureTimeMs: Double, discontinuity: Bool, payload: Data) -> Data {
        var data = Data(capacity: headerBytes + payload.count)
        data.append(magic0)
        data.append(magic1)
        data.append(version)
        data.append(discontinuity ? flagDiscontinuity : 0)
        withUnsafeBytes(of: seq.littleEndian) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: captureTimeMs.bitPattern.littleEndian) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }

    /// Little-endian bytes of signed 16-bit samples (the `pcm_s16le` payload).
    public static func pcmPayload(_ samples: [Int16]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }

    /// Inverse of `encode`, used by tests and debugging tools.
    public static func decodeHeader(_ data: Data) -> (seq: UInt32, captureTimeMs: Double, discontinuity: Bool, payload: Data)? {
        guard data.count >= headerBytes else { return nil }
        let bytes = [UInt8](data)
        guard bytes[0] == magic0, bytes[1] == magic1, bytes[2] == version else { return nil }
        var seq: UInt32 = 0
        for i in 0..<4 { seq |= UInt32(bytes[4 + i]) << (8 * UInt32(i)) }
        var bits: UInt64 = 0
        for i in 0..<8 { bits |= UInt64(bytes[8 + i]) << (8 * UInt64(i)) }
        let payload = Data(bytes[headerBytes...])
        return (seq, Double(bitPattern: bits), (bytes[3] & flagDiscontinuity) != 0, payload)
    }
}
