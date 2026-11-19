import Foundation

/// File-backed persistence for upload jobs: `<id>.json` (the job), `<id>.<ext>` (audio),
/// `<id>.body` (the request body of the current attempt). Survives relaunch; not thread-
/// safe on its own — `UploadQueue` (an actor) is the only user.
public final class UploadJobStore {
    public let directory: URL
    public private(set) var jobs: [String: UploadJob] = [:]
    private let fileManager = FileManager.default

    public init(directory: URL) throws {
        self.directory = directory
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var mutableDirectory = directory
        var values = URLResourceValues()
        // Captured audio must not end up in iCloud/iTunes backups.
        values.isExcludedFromBackup = true
        try? mutableDirectory.setResourceValues(values)
        try load()
    }

    private func load() throws {
        let urls = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        for url in urls where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let job = try? LTMJSON.decode(UploadJob.self, from: data)
            else {
                // A torn write from a crash: drop the record so it cannot block the queue.
                try? fileManager.removeItem(at: url)
                continue
            }
            jobs[job.id] = job
        }
        // Remove orphaned audio/body files whose job record is gone.
        for url in urls where url.pathExtension != "json" {
            let id = url.deletingPathExtension().lastPathComponent
            if jobs[id] == nil { try? fileManager.removeItem(at: url) }
        }
    }

    public var count: Int { jobs.count }

    public func audioURL(for job: UploadJob) -> URL? {
        guard case .chunk(_, _, let ext) = job.kind else { return nil }
        return directory.appendingPathComponent("\(job.id).\(ext)")
    }

    public func bodyURL(for job: UploadJob) -> URL {
        directory.appendingPathComponent("\(job.id).body")
    }

    private func recordURL(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    /// Adds a job, moving its audio file (if any) into the store first so a crash between
    /// the two steps leaves at worst an orphaned audio file, never a job without audio.
    public func add(_ job: UploadJob, audioFile: URL?) throws {
        if let audioFile, let destination = audioURL(for: job) {
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: audioFile, to: destination)
        }
        try write(job)
    }

    public func update(_ job: UploadJob) throws {
        try write(job)
    }

    private func write(_ job: UploadJob) throws {
        let data = try LTMJSON.encode(job)
        try data.write(to: recordURL(job.id), options: .atomic)
        jobs[job.id] = job
    }

    public func remove(_ id: String) {
        guard let job = jobs[id] else { return }
        jobs[id] = nil
        try? fileManager.removeItem(at: recordURL(id))
        if let audio = audioURL(for: job) { try? fileManager.removeItem(at: audio) }
        removeBody(for: job)
    }

    public func removeBody(for job: UploadJob) {
        try? fileManager.removeItem(at: bodyURL(for: job))
    }

    /// Jobs that may be started now, in upload order. A stream's `streamEnd` waits until
    /// every other job of that stream is gone; chunks of a stream go in `seq` order.
    public func eligible(nowMs: Int64, excludingRoles: Set<DeviceRole> = []) -> [UploadJob] {
        let all = Array(jobs.values)
        let busyStreams = Set(all.filter { !$0.isStreamEnd }.map { "\($0.role.rawValue)|\($0.streamId)" })
        return all
            .filter { job in
                job.state == .pending
                    && job.notBeforeMs <= nowMs
                    && !excludingRoles.contains(job.role)
                    && (!job.isStreamEnd || !busyStreams.contains("\(job.role.rawValue)|\(job.streamId)"))
            }
            .sorted(by: Self.uploadOrder)
    }

    static func uploadOrder(_ a: UploadJob, _ b: UploadJob) -> Bool {
        if a.createdAtMs != b.createdAtMs { return a.createdAtMs < b.createdAtMs }
        if a.sequenceKey != b.sequenceKey { return a.sequenceKey < b.sequenceKey }
        return a.id < b.id
    }

    /// Earliest `notBeforeMs` among pending jobs that are waiting for back-off.
    public func nextRetryMs(nowMs: Int64) -> Int64? {
        jobs.values.filter { $0.state == .pending && $0.notBeforeMs > nowMs }.map(\.notBeforeMs).min()
    }

    /// After a relaunch: jobs marked in flight whose transfer no longer exists go back to pending.
    public func resetInFlight(except active: Set<String>) {
        for job in jobs.values where job.state == .inFlight && !active.contains(job.id) {
            var reset = job
            reset.state = .pending
            try? update(reset)
        }
    }

    /// Deletes every job of `role` (un-pairing makes them un-uploadable).
    public func purge(role: DeviceRole) {
        for job in jobs.values where job.role == role {
            remove(job.id)
        }
    }
}
