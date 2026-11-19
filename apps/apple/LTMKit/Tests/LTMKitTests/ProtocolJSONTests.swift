import XCTest
@testable import LTMKit

/// Encodes the client messages and DTOs and compares them with literal JSON written
/// from the zod schemas in packages/protocol (field names, nesting, omitted optionals).
final class ProtocolJSONTests: XCTestCase {
    let streamId = "3f0e9c9e-4f2b-4d5e-9a57-0d2f5f0f6a11"

    func testHelloAudio() throws {
        let hello = ClientHello(
            token: "tok_0123456789abcdef",
            streamId: streamId,
            source: .mic,
            mode: .audio,
            audio: .pcm16kMono,
            clientTimeMs: 1_763_000_000_123,
            language: "tr"
        )
        assertJSONEqual(try LTMJSON.encode(hello), """
        {"type":"hello","protocol":1,"token":"tok_0123456789abcdef","streamId":"3f0e9c9e-4f2b-4d5e-9a57-0d2f5f0f6a11",
         "source":"mic","mode":"audio","audio":{"codec":"pcm_s16le","sampleRate":16000,"channels":1},
         "clientTimeMs":1763000000123,"language":"tr"}
        """)
    }

    func testHelloTranscriptOmitsAudioAndNils() throws {
        let hello = ClientHello(token: "tok_0123456789abcdef", streamId: streamId, source: .ambient, mode: .transcript, audio: nil, clientTimeMs: 5)
        let text = try LTMJSON.encodeString(hello)
        XCTAssertFalse(text.contains("audio"))
        XCTAssertFalse(text.contains("language"))
        XCTAssertFalse(text.contains("null"), "zod optional fields reject null")
        assertJSONEqual(Data(text.utf8), """
        {"type":"hello","protocol":1,"token":"tok_0123456789abcdef","streamId":"\(streamId)","source":"ambient","mode":"transcript","clientTimeMs":5}
        """)
    }

    func testTranscriptMessage() throws {
        let message = ClientTranscript(segments: [
            TranscriptSegment(id: "s1", startMs: 1_000, endMs: 2_500, text: "merhaba dünya", confidence: 0.9, language: "tr"),
        ])
        assertJSONEqual(try LTMJSON.encode(message), """
        {"type":"transcript","segments":[{"id":"s1","startMs":1000,"endMs":2500,"text":"merhaba dünya","confidence":0.9,"language":"tr"}]}
        """)
    }

    func testPingAndEndExactStrings() throws {
        XCTAssertEqual(try LTMJSON.encodeString(ClientPing(clientTimeMs: 1_763_000_000_123)), #"{"clientTimeMs":1763000000123,"type":"ping"}"#)
        XCTAssertEqual(try LTMJSON.encodeString(ClientEnd()), #"{"type":"end"}"#)
    }

    func testSpeakerSelfWireValue() throws {
        let segment = TranscriptSegment(startMs: 1, endMs: 2, text: "x", speaker: .wearer)
        XCTAssertEqual(jsonObject(try LTMJSON.encode(segment))["speaker"] as? String, "self")
    }

    func testChunkMeta() throws {
        let meta = ChunkMeta(
            streamId: streamId,
            seq: 3,
            source: .ambient,
            startMs: 1_763_000_000_000,
            durationMs: 29_840,
            clientTimeMs: 1_763_000_031_000,
            language: "en",
            isFinal: true
        )
        assertJSONEqual(try LTMJSON.encode(meta), """
        {"streamId":"\(streamId)","seq":3,"source":"ambient","startMs":1763000000000,"durationMs":29840,
         "clientTimeMs":1763000031000,"language":"en","final":true}
        """)
        let minimal = ChunkMeta(streamId: streamId, seq: 0, source: .mic, startMs: 1, durationMs: 2, clientTimeMs: 3)
        assertJSONEqual(try LTMJSON.encode(minimal), """
        {"streamId":"\(streamId)","seq":0,"source":"mic","startMs":1,"durationMs":2,"clientTimeMs":3}
        """)
    }

    func testTranscriptBatch() throws {
        let batch = TranscriptBatch(
            streamId: streamId,
            source: .mic,
            clientTimeMs: 10,
            segments: [TranscriptSegment(startMs: 1, endMs: 2, text: "hi")],
            isFinal: false
        )
        assertJSONEqual(try LTMJSON.encode(batch), """
        {"streamId":"\(streamId)","source":"mic","clientTimeMs":10,"segments":[{"startMs":1,"endMs":2,"text":"hi"}],"final":false}
        """)
    }

    func testPairRequestAndConsentBodies() throws {
        let pair = PairRequest(code: "K7QF-2MXD", name: "Apple Watch", kind: .appleWatch, platform: "watchOS 10.4", appVersion: "0.1.0")
        assertJSONEqual(try LTMJSON.encode(pair), """
        {"code":"K7QF-2MXD","name":"Apple Watch","kind":"apple_watch","platform":"watchOS 10.4","appVersion":"0.1.0"}
        """)
        let accept = ConsentAccept(accept: [.init(type: .recordingResponsibility, version: "2026-11-19"), .init(type: .dataProcessing, version: "2026-11-19")])
        assertJSONEqual(try LTMJSON.encode(accept), """
        {"accept":[{"type":"recording_responsibility","version":"2026-11-19"},{"type":"data_processing","version":"2026-11-19"}]}
        """)
        assertJSONEqual(try LTMJSON.encode(ConsentWithdraw(types: [.thirdPartyAI])), #"{"types":["third_party_ai"]}"#)
    }

    func testDecodeServerMessages() throws {
        XCTAssertEqual(
            try ServerMessage.decode(#"{"type":"ready","streamId":"\#(streamId)","serverTimeMs":1763000000000.5,"resumed":true}"#),
            .ready(streamId: streamId, serverTimeMs: 1_763_000_000_000.5, resumed: true)
        )
        XCTAssertEqual(
            try ServerMessage.decode(#"{"type":"error","code":"consent_required","message":"accept first","fatal":true}"#),
            .error(code: .consentRequired, message: "accept first", fatal: true)
        )
        XCTAssertEqual(try ServerMessage.decode(#"{"type":"pong","clientTimeMs":1,"serverTimeMs":2}"#), .pong(clientTimeMs: 1, serverTimeMs: 2))
        XCTAssertEqual(try ServerMessage.decode(#"{"type":"closed","streamId":"\#(streamId)"}"#), .closed(streamId: streamId))
        XCTAssertEqual(try ServerMessage.decode(#"{"type":"something_new"}"#), .unknown(type: "something_new"))

        let segment = try ServerMessage.decode(#"""
        {"type":"segment","segment":{"id":"a","startMs":10,"endMs":20.5,"text":"hello","confidence":0.8,"speaker":"unknown","origin":"server_stt"}}
        """#)
        guard case .segment(let live) = segment else { return XCTFail("not a segment") }
        XCTAssertEqual(live.text, "hello")
        XCTAssertEqual(live.endMs, 20.5)
        XCTAssertEqual(live.origin, "server_stt")
    }

    func testDecodeMeAndPairResponse() throws {
        let me = try LTMJSON.decode(Me.self, from: Data(#"""
        {"user":{"id":"u1","email":"owner@example.invalid","displayName":"Owner","role":"owner","locale":"tr","createdAt":"2026-11-19T10:00:00.000Z"},
         "principal":{"type":"device","deviceId":"d1"},
         "consent":{"satisfied":false,
                    "required":[{"type":"recording_responsibility","version":"2026-11-19","accepted":true},
                                {"type":"data_processing","version":"2026-11-19","accepted":false}],
                    "records":[{"type":"recording_responsibility","version":"2026-11-19","acceptedAt":"2026-11-19T10:00:00.000Z","via":null}]},
         "ingestPaused":false}
        """#.utf8))
        XCTAssertEqual(me.principal.deviceId, "d1")
        XCTAssertFalse(me.consent.satisfied)
        XCTAssertEqual(me.consent.required.map(\.type), [.recordingResponsibility, .dataProcessing])
        XCTAssertNil(me.consent.records.first?.via)

        let pair = try LTMJSON.decode(PairResponse.self, from: Data(#"""
        {"device":{"id":"d2","name":"iPhone","kind":"iphone","platform":"iOS 17.5","appVersion":null,"priority":null,
                   "createdAt":"2026-11-19T10:00:00.000Z","lastSeenAt":null,"online":false},
         "token":"devtok_abcdefghijklmnop","user":{"id":"u1","displayName":"Owner","locale":"en"}}
        """#.utf8))
        XCTAssertEqual(pair.token, "devtok_abcdefghijklmnop")
        XCTAssertEqual(pair.device.kind, "iphone")
        XCTAssertNil(pair.device.priority)
    }

    func testVersionAndErrorEnvelope() throws {
        let version = try LTMJSON.decode(VersionInfo.self, from: Data(#"{"name":"ltm","version":"0.1.0","protocol":1}"#.utf8))
        XCTAssertEqual(version.protocolVersion, 1)

        let error = APIClient.error(status: 403, body: Data(#"{"error":{"code":"ingest_paused","message":"paused","details":{"x":1}}}"#.utf8))
        XCTAssertEqual(error, .server(code: .ingestPaused, message: "paused", status: 403))
        XCTAssertTrue(error.isIngestPaused)
        XCTAssertEqual(APIClient.error(status: 502, body: Data("<html>".utf8)), .unexpectedStatus(502))
        XCTAssertEqual(APIClient.errorCode(in: Data(#"{"error":{"code":"brand_new_code","message":""}}"#.utf8)), ErrorCode("brand_new_code"))
    }
}
