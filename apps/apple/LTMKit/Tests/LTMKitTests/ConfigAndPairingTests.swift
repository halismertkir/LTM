import XCTest
@testable import LTMKit

final class PairingURITests: XCTestCase {
    func testParsesCanonicalURI() {
        let uri = PairingURI.parse("ltm://pair?server=https://ltm.example.com&code=K7QF-2MXD")
        XCTAssertEqual(uri?.server.originString, "https://ltm.example.com")
        XCTAssertEqual(uri?.code, "K7QF-2MXD")
    }

    func testParsesPercentEncodedServerWithPort() {
        let uri = PairingURI.parse("ltm://pair?code=ABCD-1234&server=http%3A%2F%2F192.168.1.20%3A8080")
        XCTAssertEqual(uri?.server.originString, "http://192.168.1.20:8080")
        XCTAssertEqual(uri?.server.isLocalNetworkHost, true)
        XCTAssertEqual(uri?.code, "ABCD-1234")
    }

    func testToleratesWhitespaceAndUppercaseScheme() {
        XCTAssertNotNil(PairingURI.parse("  LTM://pair?server=https://a.example&code=WXYZ-0000\n"))
        XCTAssertNotNil(PairingURI.parse("ltm:pair?server=https://a.example&code=WXYZ-0000"))
    }

    func testRejectsInvalidURIs() {
        XCTAssertNil(PairingURI.parse("https://pair?server=https://a.example&code=ABCD"), "wrong scheme")
        XCTAssertNil(PairingURI.parse("ltm://unpair?server=https://a.example&code=ABCD"), "wrong action")
        XCTAssertNil(PairingURI.parse("ltm://pair?server=https://a.example"), "missing code")
        XCTAssertNil(PairingURI.parse("ltm://pair?code=ABCD"), "missing server")
        XCTAssertNil(PairingURI.parse("ltm://pair?server=ftp://a.example&code=ABCD"), "server not http(s)")
        XCTAssertNil(PairingURI.parse("ltm://pair?server=a.example&code=ABCD"), "server without scheme")
        XCTAssertNil(PairingURI.parse("ltm://pair?server=https://a.example&code=AB"), "code too short")
    }

    func testTypedCodeNormalisation() {
        XCTAssertEqual(PairingURI.normalizeCode(" k7qf-2mxd ", uppercase: true), "K7QF-2MXD")
        XCTAssertEqual(PairingURI.normalizeCode("K7QF 2MXD", uppercase: true), "K7QF2MXD")
        XCTAssertNil(PairingURI.normalizeCode("abc", uppercase: true))
        XCTAssertNil(PairingURI.normalizeCode(String(repeating: "A", count: 33), uppercase: true))
    }
}

final class ServerConfigTests: XCTestCase {
    func testNormalisesOrigin() {
        XCTAssertEqual(ServerConfig.parse("ltm.example.com")?.originString, "https://ltm.example.com")
        XCTAssertEqual(ServerConfig.parse("https://LTM.Example.com/some/path/?q=1")?.originString, "https://ltm.example.com")
        XCTAssertEqual(ServerConfig.parse("https://ltm.example.com:443")?.originString, "https://ltm.example.com")
        XCTAssertEqual(ServerConfig.parse("http://nas.local:8080/")?.originString, "http://nas.local:8080")
        XCTAssertNil(ServerConfig.parse(""))
        XCTAssertNil(ServerConfig.parse("ltm.example.com", requireScheme: true))
        XCTAssertNil(ServerConfig.parse("ws://ltm.example.com"))
    }

    func testURLs() throws {
        let config = try XCTUnwrap(ServerConfig.parse("https://ltm.example.com"))
        XCTAssertEqual(config.apiURL(LTMRoute.me).absoluteString, "https://ltm.example.com/api/v1/me")
        XCTAssertEqual(config.apiURL(LTMRoute.ingestStreamEnd("abc")).absoluteString, "https://ltm.example.com/api/v1/ingest/streams/abc/end")
        XCTAssertEqual(config.webSocketURL.absoluteString, "wss://ltm.example.com/api/v1/ingest/ws")
        let local = try XCTUnwrap(ServerConfig.parse("http://192.168.1.20:8080"))
        XCTAssertEqual(local.webSocketURL.absoluteString, "ws://192.168.1.20:8080/api/v1/ingest/ws")
    }

    func testInsecureWarning() {
        XCTAssertEqual(ServerConfig.parse("http://ltm.example.com")?.needsInsecureWarning, true)
        XCTAssertEqual(ServerConfig.parse("http://8.8.8.8")?.needsInsecureWarning, true)
        XCTAssertEqual(ServerConfig.parse("https://ltm.example.com")?.needsInsecureWarning, false)
        for local in ["http://localhost:8080", "http://nas.local", "http://10.0.0.2", "http://172.20.1.1", "http://192.168.0.5", "http://homeserver"] {
            XCTAssertEqual(ServerConfig.parse(local)?.needsInsecureWarning, false, local)
        }
        XCTAssertEqual(ServerConfig.parse("http://172.32.0.1")?.isLocalNetworkHost, false)
    }

    func testCodableRoundTrip() throws {
        let config = try XCTUnwrap(ServerConfig.parse("https://ltm.example.com:8443"))
        let decoded = try LTMJSON.decode(ServerConfig.self, from: LTMJSON.encode(config))
        XCTAssertEqual(decoded, config)
    }
}

final class BackoffTests: XCTestCase {
    func testExponentialWithCapAndJitter() {
        let policy = BackoffPolicy(baseDelay: 1, multiplier: 2, maxDelay: 30, jitter: 0.2)
        XCTAssertEqual(policy.delay(forAttempt: 1, random: 0.5), 1, accuracy: 1e-9)
        XCTAssertEqual(policy.delay(forAttempt: 2, random: 0.5), 2, accuracy: 1e-9)
        XCTAssertEqual(policy.delay(forAttempt: 5, random: 0.5), 16, accuracy: 1e-9)
        XCTAssertEqual(policy.delay(forAttempt: 10, random: 0.5), 30, accuracy: 1e-9)
        XCTAssertEqual(policy.delay(forAttempt: 3, random: 0), 4 * 0.8, accuracy: 1e-9)
        XCTAssertEqual(policy.delay(forAttempt: 3, random: 1), 4 * 1.2, accuracy: 1e-9)
        XCTAssertEqual(policy.delay(forAttempt: 0, random: 0.5), 1, accuracy: 1e-9, "attempt 0 is treated as 1")
    }
}

final class MultipartTests: XCTestCase {
    func testExactBody() {
        let multipart = MultipartFormData(boundary: "B0UNDARY")
        let body = multipart.body(metaJSON: Data(#"{"seq":0}"#.utf8), audio: Data([0x01, 0x02]), fileName: "chunk-0.m4a", mimeType: "audio/mp4")
        var expected = Data()
        expected.append(contentsOf: Array("--B0UNDARY\r\n".utf8))
        expected.append(contentsOf: Array("Content-Disposition: form-data; name=\"meta\"\r\n\r\n".utf8))
        expected.append(contentsOf: Array("{\"seq\":0}\r\n".utf8))
        expected.append(contentsOf: Array("--B0UNDARY\r\n".utf8))
        expected.append(contentsOf: Array("Content-Disposition: form-data; name=\"audio\"; filename=\"chunk-0.m4a\"\r\n".utf8))
        expected.append(contentsOf: Array("Content-Type: audio/mp4\r\n\r\n".utf8))
        expected.append(contentsOf: [0x01, 0x02])
        expected.append(contentsOf: Array("\r\n--B0UNDARY--\r\n".utf8))
        XCTAssertEqual(body, expected)
        XCTAssertEqual(multipart.contentType, "multipart/form-data; boundary=B0UNDARY")
    }

    func testWritesBodyFileAndSanitisesFileName() throws {
        let dir = temporaryDirectory()
        let audio = dir.appendingPathComponent("a.m4a")
        try Data([9, 9, 9]).write(to: audio)
        let out = dir.appendingPathComponent("a.body")
        let multipart = MultipartFormData(boundary: "X")
        try multipart.writeBody(metaJSON: Data("{}".utf8), audioFile: audio, fileName: "bad\"name\r\n.m4a", mimeType: "audio/mp4", to: out)
        let written = try Data(contentsOf: out)
        XCTAssertEqual(written, multipart.body(metaJSON: Data("{}".utf8), audio: Data([9, 9, 9]), fileName: "badname.m4a", mimeType: "audio/mp4"))
    }
}

final class WatchMessagesTests: XCTestCase {
    func testContextRoundTripThroughPlistSafeData() throws {
        let context = WatchContext(
            serverOrigin: "https://ltm.example.com",
            watchToken: "watch_token_0123456789",
            watchDeviceId: "d9",
            watchUnpaired: false,
            consentSatisfied: true,
            ingestPaused: false,
            languageHint: "tr",
            updatedAtMs: 42
        )
        let data = try XCTUnwrap(WatchCoding.encode(context))
        // What WatchConnectivity would hand back: an Any? from a [String: Any].
        let dictionary: [String: Any] = [WatchMessageKey.context: data]
        XCTAssertEqual(WatchCoding.decode(WatchContext.self, from: dictionary[WatchMessageKey.context]), context)
        XCTAssertNil(WatchCoding.decode(WatchContext.self, from: "not data"))
    }

    func testUploadJobSurvivesTransfer() throws {
        let meta = ChunkMeta(streamId: "s", seq: 2, source: .ambient, startMs: 1, durationMs: 30_000, clientTimeMs: 2)
        let job = UploadJob(role: .watch, kind: .chunk(meta: meta, mimeType: "audio/mp4", fileExtension: "m4a"), createdAtMs: 5)
        let data = try XCTUnwrap(WatchCoding.encode(job))
        XCTAssertEqual(WatchCoding.decode(UploadJob.self, from: data), job)
    }
}
