import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Outcome of one HTTP attempt as seen by the queue.
public struct UploadCompletion: Sendable, Equatable {
    public var jobId: String
    /// nil when the request never got an HTTP response (offline, timeout, TLS, ...).
    public var statusCode: Int?
    public var body: Data
    public var errorDescription: String?

    public init(jobId: String, statusCode: Int?, body: Data = Data(), errorDescription: String? = nil) {
        self.jobId = jobId
        self.statusCode = statusCode
        self.body = body
        self.errorDescription = errorDescription
    }
}

public struct UploadRequest: Sendable {
    public var jobId: String
    public var request: URLRequest
    /// Request body on disk; nil for body-less requests (stream end).
    public var bodyFile: URL?
    /// Large audio uploads go through the background session; tiny JSON posts do not.
    public var preferBackground: Bool

    public init(jobId: String, request: URLRequest, bodyFile: URL?, preferBackground: Bool) {
        self.jobId = jobId
        self.request = request
        self.bodyFile = bodyFile
        self.preferBackground = preferBackground
    }
}

/// Executes requests and reports completions asynchronously. Completions of a background
/// session can arrive in a later process (after relaunch), which is why this is
/// callback-based rather than `async` request/response.
public protocol UploadTransport: AnyObject, Sendable {
    func setCompletionHandler(_ handler: @escaping @Sendable (UploadCompletion) -> Void)
    func start(_ request: UploadRequest)
    /// Job ids that currently have a task in flight (used to reconcile after relaunch).
    func inFlightJobIds() async -> Set<String>
}

/// Shared completion plumbing: buffers completions that arrive before the queue has
/// registered its handler (common on relaunch for background-session events).
open class CompletionRelay: NSObject, @unchecked Sendable {
    private let state = LockedBox<(handler: (@Sendable (UploadCompletion) -> Void)?, pending: [UploadCompletion])>((nil, []))

    override public init() {
        super.init()
    }

    public func setCompletionHandler(_ handler: @escaping @Sendable (UploadCompletion) -> Void) {
        let backlog: [UploadCompletion] = state.withValue { value in
            value.handler = handler
            let pending = value.pending
            value.pending = []
            return pending
        }
        for completion in backlog { handler(completion) }
    }

    public func deliver(_ completion: UploadCompletion) {
        let handler: (@Sendable (UploadCompletion) -> Void)? = state.withValue { value in
            if value.handler == nil { value.pending.append(completion) }
            return value.handler
        }
        handler?(completion)
    }
}

#if canImport(Darwin)
/// Background `URLSession` transport (iPhone).
///
/// Background sessions only support upload tasks *from a file* and report results only
/// through the delegate (completion-handler APIs are not allowed), the session must be
/// re-created with the same identifier on relaunch, and the system calls
/// `application(_:handleEventsForBackgroundURLSession:completionHandler:)` whose handler
/// must be invoked after `urlSessionDidFinishEvents`. Response bodies are collected per
/// task in `didReceive data` because there is no completion handler to receive them.
public final class BackgroundUploadTransport: CompletionRelay, URLSessionDataDelegate, UploadTransport, @unchecked Sendable {
    public let identifier: String
    private var backgroundSession: URLSession!
    private let foregroundSession: URLSession
    private let responseData = LockedBox<[Int: Data]>([:])
    private let foregroundInFlight = LockedBox<Set<String>>([])
    private let eventsCompletion = LockedBox<(() -> Void)?>(nil)

    public init(identifier: String) {
        self.identifier = identifier
        let foreground = URLSessionConfiguration.default
        foreground.timeoutIntervalForRequest = 30
        foreground.waitsForConnectivity = false
        self.foregroundSession = URLSession(configuration: foreground)
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.isDiscretionary = false
        #if os(iOS) || os(watchOS)
        configuration.sessionSendsLaunchEvents = true
        #endif
        // A chunk that cannot be delivered within a day is retried by the queue anyway.
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        backgroundSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    /// Stores the system's completion handler from the app delegate.
    public func setBackgroundEventsCompletionHandler(_ handler: @escaping () -> Void) {
        eventsCompletion.set(handler)
    }

    public func start(_ request: UploadRequest) {
        if request.preferBackground, let bodyFile = request.bodyFile {
            let task = backgroundSession.uploadTask(with: request.request, fromFile: bodyFile)
            task.taskDescription = request.jobId
            task.resume()
            return
        }
        // Small JSON / body-less posts: a plain session with a completion handler.
        let jobId = request.jobId
        foregroundInFlight.withValue { _ = $0.insert(jobId) }
        let completion: @Sendable (Data?, URLResponse?, Error?) -> Void = { [weak self] data, response, error in
            guard let self else { return }
            self.foregroundInFlight.withValue { _ = $0.remove(jobId) }
            self.deliver(UploadCompletion(
                jobId: jobId,
                statusCode: (response as? HTTPURLResponse)?.statusCode,
                body: data ?? Data(),
                errorDescription: error?.localizedDescription
            ))
        }
        let task: URLSessionTask
        if let bodyFile = request.bodyFile {
            task = foregroundSession.uploadTask(with: request.request, fromFile: bodyFile, completionHandler: completion)
        } else {
            task = foregroundSession.dataTask(with: request.request, completionHandler: completion)
        }
        task.taskDescription = jobId
        task.resume()
    }

    public func inFlightJobIds() async -> Set<String> {
        let session = backgroundSession!
        let background: Set<String> = await withCheckedContinuation { continuation in
            session.getAllTasks { tasks in
                continuation.resume(returning: Set(tasks.compactMap(\.taskDescription)))
            }
        }
        return background.union(foregroundInFlight.get())
    }

    // MARK: URLSessionDataDelegate

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responseData.withValue { buffers in
            buffers[dataTask.taskIdentifier, default: Data()].append(data)
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = responseData.withValue { buffers in buffers.removeValue(forKey: task.taskIdentifier) } ?? Data()
        guard let jobId = task.taskDescription else { return }
        let status = error == nil ? (task.response as? HTTPURLResponse)?.statusCode : nil
        deliver(UploadCompletion(jobId: jobId, statusCode: status, body: body, errorDescription: error?.localizedDescription))
    }

    #if os(iOS) || os(watchOS)
    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let stored: (() -> Void)? = eventsCompletion.withValue { value in
            let current = value
            value = nil
            return current
        }
        guard let stored else { return }
        DispatchQueue.main.async { stored() }
    }
    #endif
}

#endif

/// Foreground transport (watch, tests): `URLSession.upload(for:fromFile:)` with a short
/// timeout so that a watch without its own route to the server notices quickly and
/// hands the chunk to the phone instead.
public final class ForegroundUploadTransport: CompletionRelay, UploadTransport, @unchecked Sendable {
    private let session: URLSession
    private let inFlight = LockedBox<Set<String>>([])

    public init(timeout: TimeInterval = 30) {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout * 4
        #if canImport(Darwin)
        configuration.waitsForConnectivity = false
        #endif
        self.session = URLSession(configuration: configuration)
        super.init()
    }

    public func start(_ request: UploadRequest) {
        let jobId = request.jobId
        inFlight.withValue { _ = $0.insert(jobId) }
        let session = self.session
        Task { [weak self] in
            var completion = UploadCompletion(jobId: jobId, statusCode: nil)
            do {
                let result: (Data, URLResponse)
                if let bodyFile = request.bodyFile {
                    result = try await session.upload(for: request.request, fromFile: bodyFile)
                } else {
                    result = try await session.data(for: request.request)
                }
                completion.statusCode = (result.1 as? HTTPURLResponse)?.statusCode
                completion.body = result.0
            } catch {
                completion.errorDescription = error.localizedDescription
            }
            guard let self else { return }
            self.inFlight.withValue { _ = $0.remove(jobId) }
            self.deliver(completion)
        }
    }

    public func inFlightJobIds() async -> Set<String> {
        inFlight.get()
    }
}
