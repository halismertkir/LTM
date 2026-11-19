import XCTest
@testable import LTMKit

final class UploadDecisionTests: XCTestCase {
    func testClassification() {
        XCTAssertEqual(UploadDecision.classify(statusCode: nil, errorCode: nil), .retry)
        XCTAssertEqual(UploadDecision.classify(statusCode: 200, errorCode: nil), .done)
        XCTAssertEqual(UploadDecision.classify(statusCode: 201, errorCode: nil), .done)
        XCTAssertEqual(UploadDecision.classify(statusCode: 204, errorCode: nil), .done)
        XCTAssertEqual(UploadDecision.classify(statusCode: 409, errorCode: .conflict), .done)
        XCTAssertEqual(UploadDecision.classify(statusCode: 403, errorCode: .consentRequired), .pause(.consentRequired))
        XCTAssertEqual(UploadDecision.classify(statusCode: 423, errorCode: .ingestPaused), .pause(.ingestPaused))
        XCTAssertEqual(UploadDecision.classify(statusCode: 401, errorCode: nil), .stop)
        XCTAssertEqual(UploadDecision.classify(statusCode: 401, errorCode: .unauthorized), .stop)
        XCTAssertEqual(UploadDecision.classify(statusCode: 403, errorCode: .forbidden), .stop)
        XCTAssertEqual(UploadDecision.classify(statusCode: 429, errorCode: .rateLimited), .retry)
        XCTAssertEqual(UploadDecision.classify(statusCode: 500, errorCode: .internalError), .retry)
        XCTAssertEqual(UploadDecision.classify(statusCode: 503, errorCode: nil), .retry)
        XCTAssertEqual(UploadDecision.classify(statusCode: 400, errorCode: .badRequest), .drop)
        XCTAssertEqual(UploadDecision.classify(statusCode: 413, errorCode: .payloadTooLarge), .drop)
        XCTAssertEqual(UploadDecision.classify(statusCode: 415, errorCode: .unsupportedCodec), .drop)
    }
}

final class UploadJobStoreTests: XCTestCase {
    private func chunkJob(stream: String = "s1", seq: Int, created: Int64, role: DeviceRole = .phone) -> UploadJob {
        let meta = ChunkMeta(streamId: stream, seq: seq, source: .mic, startMs: 1_000 + Int64(seq) * 30_000, durationMs: 30_000, clientTimeMs: 0)
        return UploadJob(role: role, kind: .chunk(meta: meta, mimeType: "audio/mp4", fileExtension: "m4a"), createdAtMs: created)
    }

    private func audioFile(in dir: URL, bytes: [UInt8] = [1, 2, 3]) throws -> URL {
        let url = dir.appendingPathComponent("rec-\(UUID().uuidString).m4a")
        try Data(bytes).write(to: url)
        return url
    }

    func testPersistsAcrossReloadAndMovesAudio() throws {
        let dir = temporaryDirectory()
        let inbox = temporaryDirectory()
        let store = try UploadJobStore(directory: dir)
        let job = chunkJob(seq: 0, created: 10)
        let source = try audioFile(in: inbox)
        try store.add(job, audioFile: source)
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path), "audio is moved into the queue")
        let stored = try XCTUnwrap(store.audioURL(for: job))
        XCTAssertEqual(try Data(contentsOf: stored), Data([1, 2, 3]))

        let reloaded = try UploadJobStore(directory: dir)
        XCTAssertEqual(reloaded.jobs[job.id], job)
        XCTAssertEqual(reloaded.count, 1)
    }

    func testRemoveDeletesEverything() throws {
        let dir = temporaryDirectory()
        let store = try UploadJobStore(directory: dir)
        let job = chunkJob(seq: 0, created: 10)
        try store.add(job, audioFile: try audioFile(in: temporaryDirectory()))
        try Data("body".utf8).write(to: store.bodyURL(for: job))
        store.remove(job.id)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    func testDropsTornRecordsAndOrphans() throws {
        let dir = temporaryDirectory()
        try Data("{not json".utf8).write(to: dir.appendingPathComponent("broken.json"))
        try Data([0]).write(to: dir.appendingPathComponent("orphan.m4a"))
        let store = try UploadJobStore(directory: dir)
        XCTAssertEqual(store.count, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    func testEligibleOrderBackoffAndStreamEndDependency() throws {
        let store = try UploadJobStore(directory: temporaryDirectory())
        let second = chunkJob(seq: 1, created: 20)
        let first = chunkJob(seq: 0, created: 10)
        var later = chunkJob(stream: "s2", seq: 0, created: 5)
        later.notBeforeMs = 1_000
        let end = UploadJob(role: .phone, kind: .streamEnd(streamId: "s1"), createdAtMs: 30)
        let watchEnd = UploadJob(role: .watch, kind: .streamEnd(streamId: "s1"), createdAtMs: 31)
        for job in [second, first, later, end, watchEnd] { try store.add(job, audioFile: nil) }

        XCTAssertEqual(store.eligible(nowMs: 100).map(\.id), [first.id, second.id, watchEnd.id],
                       "stream end waits for its stream's chunks; back-off is honoured; roles are separate streams")
        XCTAssertEqual(store.nextRetryMs(nowMs: 100), 1_000)
        XCTAssertEqual(store.eligible(nowMs: 100, excludingRoles: [.watch]).map(\.id), [first.id, second.id])

        store.remove(first.id)
        store.remove(second.id)
        XCTAssertEqual(store.eligible(nowMs: 2_000).map(\.id), [later.id, end.id, watchEnd.id])
    }

    func testResetInFlightAndPurge() throws {
        let store = try UploadJobStore(directory: temporaryDirectory())
        var running = chunkJob(seq: 0, created: 1)
        running.state = .inFlight
        var stillRunning = chunkJob(seq: 1, created: 2)
        stillRunning.state = .inFlight
        let watchJob = chunkJob(stream: "w", seq: 0, created: 3, role: .watch)
        for job in [running, stillRunning, watchJob] { try store.add(job, audioFile: nil) }

        store.resetInFlight(except: [stillRunning.id])
        XCTAssertEqual(store.jobs[running.id]?.state, .pending)
        XCTAssertEqual(store.jobs[stillRunning.id]?.state, .inFlight)

        store.purge(role: .watch)
        XCTAssertNil(store.jobs[watchJob.id])
        XCTAssertEqual(store.count, 2)
    }
}

final class UploadQueueTests: XCTestCase {
    let server = ServerConfig.parse("https://ltm.example.com")!

    private func makeQueue(_ dir: URL, transport: FakeTransport, handoff: (any UploadHandoff)? = nil) throws -> UploadQueue {
        let server = self.server
        return try UploadQueue(
            directory: dir,
            transport: transport,
            credentials: { role in (server, role == .phone ? "phone_token_0123456789" : "watch_token_0123456789") },
            handoff: handoff,
            maxConcurrent: 2,
            backoff: BackoffPolicy(baseDelay: 60, multiplier: 2, maxDelay: 600, jitter: 0)
        )
    }

    private func audio() throws -> URL {
        let url = temporaryDirectory().appendingPathComponent("chunk.m4a")
        try Data([0xAA, 0xBB]).write(to: url)
        return url
    }

    private func meta(seq: Int = 0, stream: String = "3f0e9c9e-4f2b-4d5e-9a57-0d2f5f0f6a11") -> ChunkMeta {
        ChunkMeta(streamId: stream, seq: seq, source: .mic, startMs: 1_763_000_000_000, durationMs: 30_000, clientTimeMs: 0)
    }

    func testUploadsChunkAsMultipartAndDeletesOn2xx() async throws {
        let dir = temporaryDirectory()
        let transport = FakeTransport()
        let queue = try makeQueue(dir, transport: transport)
        await queue.start()
        try await queue.enqueueChunk(audioFile: try audio(), meta: meta(), role: .phone)

        let started = await eventually { transport.started.count == 1 }
        XCTAssertTrue(started)
        let request = try XCTUnwrap(transport.started.first)
        XCTAssertEqual(request.request.url?.absoluteString, "https://ltm.example.com/api/v1/ingest/chunks")
        XCTAssertEqual(request.request.httpMethod, "POST")
        XCTAssertEqual(request.request.value(forHTTPHeaderField: "Authorization"), "Bearer phone_token_0123456789")
        XCTAssertTrue(request.request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") ?? false)
        XCTAssertTrue(request.preferBackground)

        let body = String(decoding: try XCTUnwrap(transport.body(for: request.jobId)), as: UTF8.self)
        XCTAssertTrue(body.contains("name=\"meta\""))
        XCTAssertTrue(body.contains("name=\"audio\"; filename=\"chunk-0.m4a\""))
        XCTAssertTrue(body.contains("\"seq\":0"))
        XCTAssertFalse(body.contains("\"clientTimeMs\":0"), "clientTimeMs is refreshed per attempt")

        transport.complete(request.jobId, status: 201, body: #"{"streamId":"s","seq":0,"created":true}"#)
        let drained = await eventually { await queue.pendingCount == 0 }
        XCTAssertTrue(drained)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [], "audio, body and record are deleted")
    }

    func testSurvivesRelaunch() async throws {
        let dir = temporaryDirectory()
        do {
            let queue = try makeQueue(dir, transport: FakeTransport())
            try await queue.enqueueChunk(audioFile: try audio(), meta: meta(seq: 0), role: .phone)
            try await queue.enqueueStreamEnd(streamId: meta().streamId, role: .phone)
        }
        let transport = FakeTransport()
        let relaunched = try makeQueue(dir, transport: transport)
        let pending = await relaunched.pendingCount
        XCTAssertEqual(pending, 2)
        await relaunched.start()
        let started = await eventually { transport.started.count == 1 }
        XCTAssertTrue(started, "only the chunk starts; the stream end waits for it")
        XCTAssertEqual(transport.started.first?.request.url?.path, "/api/v1/ingest/chunks")

        transport.complete(transport.started[0].jobId, status: 201)
        let endStarted = await eventually { transport.started.count == 2 }
        XCTAssertTrue(endStarted)
        XCTAssertEqual(transport.started[1].request.url?.path, "/api/v1/ingest/streams/\(meta().streamId)/end")
        XCTAssertNil(transport.started[1].bodyFile)
    }

    func testConsentRequiredPausesUntilResume() async throws {
        let transport = FakeTransport()
        let queue = try makeQueue(temporaryDirectory(), transport: transport)
        await queue.start()
        try await queue.enqueueChunk(audioFile: try audio(), meta: meta(seq: 0), role: .phone)
        _ = await eventually { transport.started.count == 1 }
        transport.complete(transport.started[0].jobId, status: 403, body: #"{"error":{"code":"consent_required","message":"no"}}"#)

        let paused = await eventually { await queue.snapshot.pausedReason == .consentRequired }
        XCTAssertTrue(paused)
        let pendingNow = await queue.pendingCount
        XCTAssertEqual(pendingNow, 1, "the chunk is kept")

        try await queue.enqueueChunk(audioFile: try audio(), meta: meta(seq: 1), role: .phone)
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(transport.started.count, 1, "nothing starts while paused")

        await queue.resume()
        let restarted = await eventually { transport.started.count == 3 }
        XCTAssertTrue(restarted)
    }

    func testUnauthorizedStopsOnlyThatRole() async throws {
        let transport = FakeTransport()
        let queue = try makeQueue(temporaryDirectory(), transport: transport)
        await queue.start()
        try await queue.enqueueChunk(audioFile: try audio(), meta: meta(seq: 0, stream: "p"), role: .phone)
        _ = await eventually { transport.started.count == 1 }
        transport.complete(transport.started[0].jobId, status: 401)
        let stopped = await eventually { await queue.snapshot.stoppedRoles == [.phone] }
        XCTAssertTrue(stopped)

        try await queue.enqueueChunk(audioFile: try audio(), meta: meta(seq: 0, stream: "w"), role: .watch)
        let watchStarted = await eventually { transport.started.count == 2 }
        XCTAssertTrue(watchStarted)
        XCTAssertEqual(transport.started[1].request.value(forHTTPHeaderField: "Authorization"), "Bearer watch_token_0123456789")
    }

    func testTransientFailureBacksOff() async throws {
        let transport = FakeTransport()
        let queue = try makeQueue(temporaryDirectory(), transport: transport)
        await queue.start()
        try await queue.enqueueTranscripts(
            TranscriptBatch(streamId: "s", source: .mic, clientTimeMs: 0, segments: [TranscriptSegment(startMs: 1, endMs: 2, text: "hi")]),
            role: .phone
        )
        _ = await eventually { transport.started.count == 1 }
        XCTAssertEqual(transport.started[0].request.url?.path, "/api/v1/ingest/transcripts")
        XCTAssertFalse(transport.started[0].preferBackground)
        transport.complete(transport.started[0].jobId, status: 503)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(transport.started.count, 1, "60 s back-off before the next attempt")
        let pendingNow = await queue.pendingCount
        XCTAssertEqual(pendingNow, 1)
    }

    func testTransportFailureHandsOffWhenAvailable() async throws {
        final class RecordingHandoff: UploadHandoff, @unchecked Sendable {
            let jobs = LockedBox<[UploadJob]>([])
            func handOff(job: UploadJob, audioFile: URL?) async -> Bool {
                jobs.withValue { $0.append(job) }
                return audioFile != nil
            }
        }
        let handoff = RecordingHandoff()
        let transport = FakeTransport()
        let queue = try makeQueue(temporaryDirectory(), transport: transport, handoff: handoff)
        await queue.start()
        try await queue.enqueueChunk(audioFile: try audio(), meta: meta(), role: .watch)
        _ = await eventually { transport.started.count == 1 }
        let jobId = transport.started[0].jobId
        transport.complete(jobId, status: nil)
        let handed = await eventually { handoff.jobs.get().count == 1 }
        XCTAssertTrue(handed)
        let pendingNow = await queue.pendingCount
        XCTAssertEqual(pendingNow, 1, "kept until the phone confirms")
        await queue.handoffFinished(jobId: jobId, success: true)
        let pendingAfter = await queue.pendingCount
        XCTAssertEqual(pendingAfter, 0)
    }
}
