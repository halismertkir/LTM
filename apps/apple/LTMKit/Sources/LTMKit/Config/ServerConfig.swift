import Foundation

/// Where the LTM server lives. Only the origin (scheme, host, port) is kept; the API
/// prefix and routes are appended here so that every caller builds URLs the same way.
public struct ServerConfig: Sendable, Equatable, Hashable, Codable {
    /// e.g. "https://ltm.example.com" or "http://192.168.1.20:8080" — no trailing slash.
    public let originString: String
    public let scheme: String
    public let host: String
    public let port: Int?

    /// Parses an origin. When `requireScheme` is false a missing scheme defaults to https
    /// (what a person typing "ltm.example.com" means).
    public static func parse(_ input: String, requireScheme: Bool = false) -> ServerConfig? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http://") && !text.lowercased().hasPrefix("https://") {
            if requireScheme || text.contains("://") { return nil }
            text = "https://" + text
        }
        guard let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let rawHost = components.host, !rawHost.isEmpty
        else { return nil }
        // IPv6 literals may come back with or without brackets depending on the OS version.
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let port = components.port
        if let port, !(1...65_535).contains(port) { return nil }
        return ServerConfig(scheme: scheme, host: host, port: port)
    }

    public init?(origin: URL) {
        guard let parsed = ServerConfig.parse(origin.absoluteString, requireScheme: true) else { return nil }
        self = parsed
    }

    private init(scheme: String, host: String, port: Int?) {
        // Drop default ports so that the same server always has the same origin string.
        var normalizedPort = port
        if let port, (scheme == "https" && port == 443) || (scheme == "http" && port == 80) {
            normalizedPort = nil
        }
        let hostPart = host.contains(":") ? "[\(host)]" : host
        let portPart = normalizedPort.map { ":\($0)" } ?? ""
        self.scheme = scheme
        self.host = host
        self.port = normalizedPort
        self.originString = "\(scheme)://\(hostPart)\(portPart)"
    }

    public var origin: URL {
        // `originString` was assembled from validated parts, so this cannot fail in practice.
        URL(string: originString) ?? URL(fileURLWithPath: "/")
    }

    /// `<origin>/api/v1<path>`.
    public func apiURL(_ path: String) -> URL {
        URL(string: originString + LTMProtocol.apiPrefix + path) ?? origin
    }

    /// `<origin>/api/v1<path>?<query>`. Values are percent-encoded strictly: `+`, `&`, `=`
    /// and friends are escaped, because form-style servers decode a literal `+` as a space.
    public func apiURL(_ path: String, query: [(String, String)]) -> URL {
        let items = query.map { "\(Self.encodeQueryComponent($0.0))=\(Self.encodeQueryComponent($0.1))" }
        guard !items.isEmpty else { return apiURL(path) }
        return URL(string: originString + LTMProtocol.apiPrefix + path + "?" + items.joined(separator: "&")) ?? apiURL(path)
    }

    static let queryValueAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: Unicode.Scalar(0)..<Unicode.Scalar(128)))
        set.insert(charactersIn: "-._~")
        return set
    }()

    static func encodeQueryComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: queryValueAllowed) ?? value
    }

    /// `ws(s)://<host>/api/v1/ingest/ws`.
    public var webSocketURL: URL {
        let wsScheme = scheme == "https" ? "wss" : "ws"
        let rest = originString.dropFirst(scheme.count)
        return URL(string: wsScheme + rest + LTMProtocol.apiPrefix + LTMRoute.ingestWebSocket) ?? origin
    }

    public var isSecure: Bool { scheme == "https" }

    /// Hosts that iOS treats as "local networking" for App Transport Security and that are
    /// reasonable to reach over plain HTTP at home: localhost, `.local` mDNS names,
    /// unqualified names, and private/link-local/loopback IP addresses.
    public var isLocalNetworkHost: Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        if let octets = Self.ipv4Octets(host) {
            switch (octets[0], octets[1]) {
            case (10, _), (127, _), (192, 168), (169, 254): return true
            case (172, let second) where (16...31).contains(second): return true
            case (100, let second) where (64...127).contains(second): return true // CGNAT / Tailscale
            default: return false
            }
        }
        if host.contains(":") {
            let lower = host.lowercased()
            return lower == "::1" || lower.hasPrefix("fe80:") || lower.hasPrefix("fc") || lower.hasPrefix("fd")
        }
        return !host.contains(".")
    }

    /// True when the user should be warned before connecting: plain HTTP to a host that
    /// is not on the local network sends audio and the device token unencrypted, and
    /// App Transport Security will refuse it for host names anyway.
    public var needsInsecureWarning: Bool { !isSecure && !isLocalNetworkHost }

    static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, let value = Int(part), (0...255).contains(value) else { return nil }
            octets.append(value)
        }
        return octets
    }
}
