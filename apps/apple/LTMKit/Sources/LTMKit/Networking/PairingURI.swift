import Foundation

/// `ltm://pair?server=<origin>&code=<code>` as rendered by the web app's pairing QR code.
public struct PairingURI: Sendable, Equatable {
    public let server: ServerConfig
    public let code: String

    public init(server: ServerConfig, code: String) {
        self.server = server
        self.code = code
    }

    public static func parse(_ string: String) -> PairingURI? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "ltm"
        else { return nil }
        // "ltm://pair?..." puts "pair" in the host; tolerate "ltm:pair?..." / "ltm:///pair?..." too.
        let target = (components.host ?? "").lowercased()
        let path = components.path.lowercased()
        guard target == "pair" || (target.isEmpty && (path == "pair" || path == "/pair")) else { return nil }

        let items = components.queryItems ?? []
        guard let serverValue = items.first(where: { $0.name == "server" })?.value,
              let codeValue = items.first(where: { $0.name == "code" })?.value,
              let server = ServerConfig.parse(serverValue, requireScheme: true),
              let code = normalizeCode(codeValue, uppercase: false)
        else { return nil }
        return PairingURI(server: server, code: code)
    }

    /// Validates a pairing code (4–32 characters per `zPairRequest`). Typed codes are
    /// upper-cased because the documented format ("K7QF-2MXD") is upper case and people
    /// type it on a phone keyboard; codes from a QR code are passed through unchanged.
    public static func normalizeCode(_ raw: String, uppercase: Bool) -> String? {
        var code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        code = code.replacingOccurrences(of: " ", with: "")
        if uppercase { code = code.uppercased() }
        guard (4...32).contains(code.count) else { return nil }
        return code
    }
}
