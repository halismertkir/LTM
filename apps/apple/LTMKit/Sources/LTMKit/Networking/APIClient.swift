import Foundation

/// Thin async/await client for the REST routes a device token may call.
public struct APIClient: Sendable {
    public let server: ServerConfig
    public let token: String?
    public let session: URLSession
    public let userAgent: String

    public init(server: ServerConfig, token: String?, session: URLSession = .shared, userAgent: String = APIClient.defaultUserAgent) {
        self.server = server
        self.token = token
        self.session = session
        self.userAgent = userAgent
    }

    /// Generic product name and version only — no device or user details.
    public static var defaultUserAgent: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        #if os(watchOS)
        return "LTM-watchOS/\(version)"
        #elseif os(iOS)
        return "LTM-iOS/\(version)"
        #else
        return "LTMKit/\(version)"
        #endif
    }

    // MARK: Routes

    /// `GET /version` (public).
    public func version() async throws -> VersionInfo {
        try await send(method: "GET", path: LTMRoute.version, body: nil, authenticated: false)
    }

    /// Fetches `/version` and fails with a precise error when the server is not LTM or
    /// speaks another protocol version (so the UI can say "update the app/server").
    @discardableResult
    public func checkCompatibility() async throws -> VersionInfo {
        let info = try await version()
        guard info.name == "ltm" else { throw LTMError.notAnLTMServer }
        guard info.protocolVersion == LTMProtocol.version else {
            throw LTMError.unsupportedProtocol(server: info.protocolVersion, client: LTMProtocol.version)
        }
        return info
    }

    /// `POST /devices/pair` (public; the code is the credential).
    public func pair(_ request: PairRequest) async throws -> PairResponse {
        try await send(method: "POST", path: LTMRoute.devicePair, body: LTMJSON.encode(request), authenticated: false)
    }

    public func me() async throws -> Me {
        try await send(method: "GET", path: LTMRoute.me, body: nil)
    }

    public func deviceSelf() async throws -> Device {
        try await send(method: "GET", path: LTMRoute.deviceSelf, body: nil)
    }

    public func consents() async throws -> ConsentState {
        try await send(method: "GET", path: LTMRoute.consents, body: nil)
    }

    public func acceptConsents(_ items: [ConsentAccept.Item]) async throws -> ConsentState {
        try await send(method: "POST", path: LTMRoute.consents, body: LTMJSON.encode(ConsentAccept(accept: items)))
    }

    /// Withdrawing also pauses ingest server-side.
    public func withdrawConsents(_ types: [ConsentType]) async throws -> ConsentState {
        try await send(method: "POST", path: LTMRoute.consentWithdraw, body: LTMJSON.encode(ConsentWithdraw(types: types)))
    }

    public func sendTranscripts(_ batch: TranscriptBatch) async throws -> TranscriptAccepted {
        try await send(method: "POST", path: LTMRoute.ingestTranscripts, body: LTMJSON.encode(batch))
    }

    /// `POST /ingest/streams/:streamId/end` → 204.
    public func endStream(_ streamId: String) async throws {
        let request = makeRequest(method: "POST", path: LTMRoute.ingestStreamEnd(streamId), contentType: nil)
        _ = try await perform(request, body: nil)
    }

    /// Foreground chunk upload (the durable path is `UploadQueue`).
    public func uploadChunk(meta: ChunkMeta, audio: Data, fileName: String, mimeType: String) async throws -> ChunkAccepted {
        let multipart = MultipartFormData()
        let body = multipart.body(metaJSON: try LTMJSON.encode(meta), audio: audio, fileName: fileName, mimeType: mimeType)
        let request = makeRequest(method: "POST", path: LTMRoute.ingestChunks, contentType: multipart.contentType)
        let data = try await perform(request, body: body)
        return try Self.decodeBody(ChunkAccepted.self, from: data)
    }

    // MARK: Plumbing

    /// Builds a request with the standard headers. Exposed for `UploadQueue`, which hands
    /// requests to a background session.
    public func makeRequest(method: String, path: String, contentType: String?, authenticated: Bool = true) -> URLRequest {
        var request = URLRequest(url: server.apiURL(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        if authenticated, let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.timeoutInterval = 30
        return request
    }

    private func send<T: Decodable>(method: String, path: String, body: Data?, authenticated: Bool = true) async throws -> T {
        if authenticated && token == nil { throw LTMError.notPaired }
        let request = makeRequest(method: method, path: path, contentType: body == nil ? nil : "application/json", authenticated: authenticated)
        let data = try await perform(request, body: body)
        return try Self.decodeBody(T.self, from: data)
    }

    private func perform(_ request: URLRequest, body: Data?) async throws -> Data {
        var request = request
        request.httpBody = body
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch {
            throw LTMError.from(error)
        }
        let (data, response) = result
        guard let http = response as? HTTPURLResponse else { throw LTMError.transport("no HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.error(status: http.statusCode, body: data)
        }
        return data
    }

    static func decodeBody<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try LTMJSON.decode(type, from: data)
        } catch {
            throw LTMError.decoding(String(describing: error))
        }
    }

    /// Maps a non-2xx response onto LTMError, preferring the server's error envelope.
    public static func error(status: Int, body: Data) -> LTMError {
        if let envelope = try? LTMJSON.decode(ErrorResponse.self, from: body) {
            return .server(code: envelope.error.code, message: envelope.error.message, status: status)
        }
        return .unexpectedStatus(status)
    }

    /// Parses the error code out of an error envelope, if the body is one.
    public static func errorCode(in body: Data) -> ErrorCode? {
        (try? LTMJSON.decode(ErrorResponse.self, from: body))?.error.code
    }
}
