import Foundation

/// Why the queue is holding back uploads.
public enum UploadPauseReason: String, Sendable, Equatable, Codable {
    case consentRequired
    case ingestPaused
}

/// What to do with a job after one attempt. Pure, so the policy is unit-tested.
public enum UploadDecision: Sendable, Equatable {
    case done
    case retry
    /// Permanently rejected (malformed, too large, unknown stream): drop it so it cannot
    /// block the queue forever.
    case drop
    case pause(UploadPauseReason)
    /// The token was revoked: stop uploading for that device until it is paired again.
    case stop

    public static func classify(statusCode: Int?, errorCode: ErrorCode?) -> UploadDecision {
        guard let status = statusCode else { return .retry }
        if (200..<300).contains(status) { return .done }
        if errorCode == .consentRequired { return .pause(.consentRequired) }
        if errorCode == .ingestPaused { return .pause(.ingestPaused) }
        if status == 401 || errorCode == .unauthorized { return .stop }
        if status == 409 || errorCode == .conflict { return .done }
        if status == 429 || errorCode == .rateLimited { return .retry }
        if status >= 500 { return .retry }
        if status == 403 || errorCode == .forbidden { return .stop }
        if status == 408 { return .retry }
        return .drop
    }
}

/// Hands a job to another device (watch → phone) when it cannot be uploaded directly.
public protocol UploadHandoff: Sendable {
    /// Returns true when the job was queued for transfer.
    func handOff(job: UploadJob, audioFile: URL?) async -> Bool
}

public struct UploadQueueSnapshot: Sendable, Equatable {
    public var pending: Int
    public var pausedReason: UploadPauseReason?
    public var stoppedRoles: Set<DeviceRole>

    public init(pending: Int, pausedReason: UploadPauseReason?, stoppedRoles: Set<DeviceRole>) {
        self.pending = pending
        self.pausedReason = pausedReason
        self.stoppedRoles = stoppedRoles
    }
}

/// Durable store-and-forward queue.
///
/// Jobs survive relaunch (`UploadJobStore`). Each attempt rebuilds the request body as a
/// file (fresh `clientTimeMs`, as the protocol asks) and hands it to the transport. A 2xx
/// deletes the job and its audio; transient failures retry with back-off; `unauthorized`
/// stops the device role; `consent_required` / `ingest_paused` pause everything until
/// `resume()`.
public actor UploadQueue {
    public typealias Credentials = @Sendable (DeviceRole) -> (server: ServerConfig, token: String)?

    private let store: UploadJobStore
    private let transport: any UploadTransport
    private let credentials: Credentials
    private let handoff: (any UploadHandoff)?
    private let maxConcurrent: Int
    private let backoff: BackoffPolicy
    private let now: @Sendable () -> Date
    private let userAgent: String

    private var pausedReason: UploadPauseReason?
    private var stoppedRoles: Set<DeviceRole> = []
    private var started = false
    private var wakeTask: Task<Void, Never>?
    private var wakeAtMs: Int64?

    public nonisolated let snapshots: AsyncStream<UploadQueueSnapshot>
    private let snapshotContinuation: AsyncStream<UploadQueueSnapshot>.Continuation

    public init(
        directory: URL,
        transport: any UploadTransport,
        credentials: @escaping Credentials,
        handoff: (any UploadHandoff)? = nil,
        maxConcurrent: Int = 2,
        backoff: BackoffPolicy = BackoffPolicy(baseDelay: 5, multiplier: 2, maxDelay: 15 * 60, jitter: 0.2),
        now: @escaping @Sendable () -> Date = { Date() },
        userAgent: String = APIClient.defaultUserAgent
    ) throws {
        self.store = try UploadJobStore(directory: directory)
        self.transport = transport
        self.credentials = credentials
        self.handoff = handoff
        self.maxConcurrent = maxConcurrent
        self.backoff = backoff
        self.now = now
        self.userAgent = userAgent
        var continuation: AsyncStream<UploadQueueSnapshot>.Continuation?
        self.snapshots = AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation = $0 }
        self.snapshotContinuation = continuation!
    }

    /// Reconciles with the transport (tasks that survived a relaunch keep running),
    /// registers for completions and starts uploading.
    public func start() async {
        guard !started else { return }
        started = true
        transport.setCompletionHandler { [weak self] completion in
            guard let self else { return }
            Task { await self.handle(completion) }
        }
        let active = await transport.inFlightJobIds()
        store.resetInFlight(except: active)
        publish()
        kick()
    }

    // MARK: Enqueue

    /// Moves `audioFile` into the queue and schedules the upload.
    public func enqueueChunk(audioFile: URL, meta: ChunkMeta, mimeType: String = "audio/mp4", role: DeviceRole) throws {
        let ext = audioFile.pathExtension.isEmpty ? "m4a" : audioFile.pathExtension
        let job = UploadJob(role: role, kind: .chunk(meta: meta, mimeType: mimeType, fileExtension: ext), createdAtMs: EpochMs.from(now()))
        try store.add(job, audioFile: audioFile)
        publish()
        kick()
    }

    public func enqueueTranscripts(_ batch: TranscriptBatch, role: DeviceRole) throws {
        let job = UploadJob(role: role, kind: .transcripts(batch: batch), createdAtMs: EpochMs.from(now()))
        try store.add(job, audioFile: nil)
        publish()
        kick()
    }

    public func enqueueStreamEnd(streamId: String, role: DeviceRole) throws {
        let job = UploadJob(role: role, kind: .streamEnd(streamId: streamId), createdAtMs: EpochMs.from(now()))
        try store.add(job, audioFile: nil)
        publish()
        kick()
    }

    /// Re-creates a job received from another device (watch → phone) under a new id.
    public func importJob(_ job: UploadJob, audioFile: URL?, role: DeviceRole) throws {
        var imported = job
        imported.id = UUID().uuidString.lowercased()
        imported.role = role
        imported.state = .pending
        imported.attempts = 0
        imported.notBeforeMs = 0
        imported.lastError = nil
        try store.add(imported, audioFile: audioFile)
        publish()
        kick()
    }

    // MARK: Control

    /// Clears a pause or a stopped role (after consent was given or the device re-paired).
    public func resume() {
        pausedReason = nil
        stoppedRoles.removeAll()
        publish()
        kick()
    }

    public func pause(_ reason: UploadPauseReason) {
        pausedReason = reason
        publish()
    }

    public func purge(role: DeviceRole) {
        store.purge(role: role)
        publish()
    }

    public var pendingCount: Int { store.count }

    public var snapshot: UploadQueueSnapshot {
        UploadQueueSnapshot(pending: store.count, pausedReason: pausedReason, stoppedRoles: stoppedRoles)
    }

    /// Starts as many eligible jobs as the concurrency limit allows.
    public func kick() {
        guard started, pausedReason == nil else { return }
        let nowMs = EpochMs.from(now())
        var inFlight = store.jobs.values.filter { $0.state == .inFlight }.count
        for job in store.eligible(nowMs: nowMs, excludingRoles: stoppedRoles) {
            guard inFlight < maxConcurrent else { break }
            guard let credentials = credentials(job.role) else { continue }
            do {
                let request = try makeRequest(for: job, server: credentials.server, token: credentials.token, nowMs: nowMs)
                var running = job
                running.state = .inFlight
                try store.update(running)
                transport.start(request)
                inFlight += 1
            } catch {
                Log.upload.error("cannot build request for job: \(error.localizedDescription, privacy: .public)")
                store.remove(job.id)
            }
        }
        scheduleWake(nowMs: nowMs)
    }

    // MARK: Completion

    public func handle(_ completion: UploadCompletion) async {
        guard var job = store.jobs[completion.jobId] else { return }
        store.removeBody(for: job)
        let errorCode = APIClient.errorCode(in: completion.body)
        var decision = UploadDecision.classify(statusCode: completion.statusCode, errorCode: errorCode)

        // No HTTP response at all: a watch without its own route to the server hands the
        // job to the phone instead of waiting.
        if decision == .retry, completion.statusCode == nil, let handoff {
            job.state = .handedOff
            try? store.update(job)
            if await handoff.handOff(job: job, audioFile: store.audioURL(for: job)) {
                publish()
                kick()
                return
            }
            decision = .retry
        }

        switch decision {
        case .done:
            store.remove(job.id)
        case .drop:
            Log.upload.error("dropping job after status \(completion.statusCode ?? -1)")
            store.remove(job.id)
        case .retry:
            job.attempts += 1
            job.state = .pending
            job.lastError = completion.errorDescription ?? completion.statusCode.map { "HTTP \($0)" }
            let delay = backoff.delay(forAttempt: job.attempts, random: Double.random(in: 0..<1))
            job.notBeforeMs = EpochMs.from(now()) + Int64(delay * 1000)
            try? store.update(job)
        case .pause(let reason):
            job.state = .pending
            try? store.update(job)
            pausedReason = reason
        case .stop:
            job.state = .pending
            try? store.update(job)
            stoppedRoles.insert(job.role)
        }
        publish()
        kick()
    }

    /// The other device confirmed (or failed) a handed-off transfer.
    public func handoffFinished(jobId: String, success: Bool) {
        guard var job = store.jobs[jobId] else { return }
        if success {
            store.remove(jobId)
        } else {
            job.state = .pending
            job.attempts += 1
            job.notBeforeMs = EpochMs.from(now()) + 30_000
            try? store.update(job)
        }
        publish()
        kick()
    }

    // MARK: Requests

    private func makeRequest(for job: UploadJob, server: ServerConfig, token: String, nowMs: Int64) throws -> UploadRequest {
        let api = APIClient(server: server, token: token, userAgent: userAgent)
        let bodyURL = store.bodyURL(for: job)
        switch job.kind {
        case .chunk(var meta, let mimeType, _):
            guard let audioURL = store.audioURL(for: job) else { throw LTMError.decoding("chunk without audio") }
            meta.clientTimeMs = nowMs
            let multipart = MultipartFormData()
            try multipart.writeBody(
                metaJSON: try LTMJSON.encode(meta),
                audioFile: audioURL,
                fileName: "chunk-\(meta.seq).\(audioURL.pathExtension)",
                mimeType: mimeType,
                to: bodyURL
            )
            var request = api.makeRequest(method: "POST", path: LTMRoute.ingestChunks, contentType: multipart.contentType)
            request.timeoutInterval = 120
            return UploadRequest(jobId: job.id, request: request, bodyFile: bodyURL, preferBackground: true)
        case .transcripts(var batch):
            batch.clientTimeMs = nowMs
            try LTMJSON.encode(batch).write(to: bodyURL, options: .atomic)
            let request = api.makeRequest(method: "POST", path: LTMRoute.ingestTranscripts, contentType: "application/json")
            return UploadRequest(jobId: job.id, request: request, bodyFile: bodyURL, preferBackground: false)
        case .streamEnd(let streamId):
            let request = api.makeRequest(method: "POST", path: LTMRoute.ingestStreamEnd(streamId), contentType: nil)
            return UploadRequest(jobId: job.id, request: request, bodyFile: nil, preferBackground: false)
        }
    }

    // MARK: Helpers

    private func scheduleWake(nowMs: Int64) {
        guard let next = store.nextRetryMs(nowMs: nowMs) else { return }
        if let wakeAtMs, wakeAtMs <= next, wakeTask != nil { return }
        wakeTask?.cancel()
        wakeAtMs = next
        let delaySeconds = Double(max(0, next - nowMs)) / 1000 + 0.05
        wakeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.wake()
        }
    }

    private func wake() {
        wakeTask = nil
        wakeAtMs = nil
        kick()
    }

    private func publish() {
        snapshotContinuation.yield(snapshot)
    }
}
