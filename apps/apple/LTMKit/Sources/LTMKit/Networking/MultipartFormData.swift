import Foundation

/// Hand-built `multipart/form-data` body for `POST /ingest/chunks`:
/// a `meta` text field carrying ChunkMeta JSON, followed by the `audio` file part.
///
/// `meta` comes first so a streaming parser on the server sees the metadata before the
/// audio bytes. The `meta` part carries no Content-Type header, exactly like a browser
/// `FormData.append("meta", JSON.stringify(meta))`, so the server treats it as a plain
/// field in every client.
public struct MultipartFormData: Sendable, Equatable {
    public let boundary: String

    public init(boundary: String = "LTMBoundary-" + UUID().uuidString) {
        self.boundary = boundary
    }

    public var contentType: String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// Everything before the audio bytes.
    public func head(metaJSON: Data, fileName: String, mimeType: String) -> Data {
        var data = Data()
        data.appendUTF8("--\(boundary)\r\n")
        data.appendUTF8("Content-Disposition: form-data; name=\"meta\"\r\n")
        data.appendUTF8("\r\n")
        data.append(metaJSON)
        data.appendUTF8("\r\n")
        data.appendUTF8("--\(boundary)\r\n")
        data.appendUTF8("Content-Disposition: form-data; name=\"audio\"; filename=\"\(Self.sanitize(fileName))\"\r\n")
        data.appendUTF8("Content-Type: \(mimeType)\r\n")
        data.appendUTF8("\r\n")
        return data
    }

    /// Everything after the audio bytes.
    public var tail: Data {
        var data = Data()
        data.appendUTF8("\r\n--\(boundary)--\r\n")
        return data
    }

    public func body(metaJSON: Data, audio: Data, fileName: String, mimeType: String) -> Data {
        var data = head(metaJSON: metaJSON, fileName: fileName, mimeType: mimeType)
        data.append(audio)
        data.append(tail)
        return data
    }

    /// Writes the complete body to `destination`, which background `URLSession` uploads
    /// require (they only accept a file, never an in-memory body or a stream).
    public func writeBody(metaJSON: Data, audioFile: URL, fileName: String, mimeType: String, to destination: URL) throws {
        let audio = try Data(contentsOf: audioFile)
        let data = body(metaJSON: metaJSON, audio: audio, fileName: fileName, mimeType: mimeType)
        try data.write(to: destination, options: .atomic)
    }

    /// Quotes and line breaks would break the header; chunk file names are ours anyway.
    static func sanitize(_ fileName: String) -> String {
        String(fileName.filter { $0 != "\"" && $0 != "\r" && $0 != "\n" })
    }
}

extension Data {
    mutating func appendUTF8(_ string: String) {
        append(contentsOf: Array(string.utf8))
    }
}
