import Foundation

/// Every failure the LTM clients surface, with the server's typed error codes preserved.
public enum LTMError: Error, Sendable, Equatable {
    /// The server answered with the error envelope (REST) or an `error` message (WebSocket).
    case server(code: ErrorCode, message: String, status: Int?)
    /// A non-2xx response without a decodable error envelope.
    case unexpectedStatus(Int)
    /// `/version` reports a protocol this build does not speak.
    case unsupportedProtocol(server: Int, client: Int)
    /// `/version` answered, but not with `name: "ltm"`.
    case notAnLTMServer
    case invalidServerURL
    case invalidPairingCode
    /// App Transport Security refused a plain-HTTP connection to a non-local host.
    case insecureConnectionBlocked
    /// TLS failed (self-signed or expired certificate, wrong host name, ...).
    case tlsFailure(String)
    /// Network unreachable, timeout, connection reset, ...
    case transport(String)
    case decoding(String)
    case notPaired
    case cancelled

    /// The typed protocol error code, when there is one.
    public var code: ErrorCode? {
        switch self {
        case .server(let code, _, _): return code
        case .unsupportedProtocol: return .unsupportedProtocol
        case .unexpectedStatus(401): return .unauthorized
        case .unexpectedStatus(403): return .forbidden
        default: return nil
        }
    }

    public var isUnauthorized: Bool { code == .unauthorized }
    public var isConsentRequired: Bool { code == .consentRequired }
    public var isIngestPaused: Bool { code == .ingestPaused }

    /// True for errors that retrying later can fix (network trouble, 5xx, rate limits).
    public var isTransient: Bool {
        switch self {
        case .transport: return true
        case .unexpectedStatus(let status): return status >= 500 || status == 429
        case .server(let code, _, let status):
            if code == .rateLimited || code == .internalError || code == .providerError { return true }
            if let status, status >= 500 { return true }
            return false
        default: return false
        }
    }

    /// Maps any thrown error (URLError, DecodingError, CancellationError, LTMError) onto LTMError.
    public static func from(_ error: Error) -> LTMError {
        if let error = error as? LTMError { return error }
        if error is CancellationError { return .cancelled }
        if let urlError = error as? URLError { return from(urlError) }
        if error is DecodingError { return .decoding(String(describing: error)) }
        return .transport(error.localizedDescription)
    }

    public static func from(_ error: URLError) -> LTMError {
        switch error.code {
        case .cancelled:
            return .cancelled
        case .appTransportSecurityRequiresSecureConnection:
            return .insecureConnectionBlocked
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .secureConnectionFailed, .clientCertificateRejected,
             .clientCertificateRequired:
            return .tlsFailure(error.localizedDescription)
        case .badURL, .unsupportedURL:
            return .invalidServerURL
        default:
            return .transport(error.localizedDescription)
        }
    }
}
