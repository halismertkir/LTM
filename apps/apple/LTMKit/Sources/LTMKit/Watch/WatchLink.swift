#if canImport(WatchConnectivity) && (os(iOS) || os(watchOS))
import Foundation
import WatchConnectivity
import os

/// WatchConnectivity bridge shared by both apps.
///
/// Phone → watch: `WatchContext` (server, the watch's token, consent and pause state) via
/// `updateApplicationContext`; `WatchPairCommand` via `sendMessage` when the watch app is
/// reachable.
/// Watch → phone: `WatchPairResult` via reply + `transferUserInfo`; chunks the watch
/// cannot upload itself via `transferFile` (the `UploadJob` JSON travels in the file's
/// metadata, so the phone can upload it with the WATCH's token and stream id).
///
/// Delegate callbacks arrive on a WatchConnectivity background queue; handlers are
/// `@Sendable` and receive already-decoded values.
public final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    public struct Handlers: Sendable {
        public var onActivated: (@Sendable () -> Void)?
        public var onReachabilityChanged: (@Sendable (Bool) -> Void)?
        public var onContext: (@Sendable (WatchContext) -> Void)?
        /// Watch side: pair with the command, then call the reply closure exactly once.
        public var onPairCommand: (@Sendable (WatchPairCommand, @escaping @Sendable (WatchPairResult) -> Void) -> Void)?
        public var onPairResult: (@Sendable (WatchPairResult) -> Void)?
        public var onContextRequested: (@Sendable () -> Void)?
        /// Phone side: a job from the watch; `audioFile` was already moved to a staging
        /// location that the handler owns.
        public var onJobReceived: (@Sendable (UploadJob, URL?) -> Void)?
        /// Watch side: a handed-off job reached the phone (or failed to).
        public var onTransferFinished: (@Sendable (String, Bool) -> Void)?

        public init() {}
    }

    public static let shared = WatchLink()

    private let handlers = LockedBox(Handlers())
    private let stagingDirectory: URL

    override private init() {
        stagingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("ltm-watch-inbox", isDirectory: true)
        super.init()
    }

    public static var isSupported: Bool { WCSession.isSupported() }

    public func configure(_ newHandlers: Handlers) {
        handlers.set(newHandlers)
    }

    public func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private var activeSession: WCSession? {
        guard WCSession.isSupported() else { return nil }
        let session = WCSession.default
        return session.activationState == .activated ? session : nil
    }

    public var isReachable: Bool { activeSession?.isReachable ?? false }

    #if os(iOS)
    /// A watch is paired with this phone and the LTM watch app is installed on it.
    public var isWatchAppInstalled: Bool {
        guard let session = activeSession else { return false }
        return session.isPaired && session.isWatchAppInstalled
    }

    public var isWatchPaired: Bool { activeSession?.isPaired ?? false }
    #endif

    #if os(watchOS)
    public var isCompanionAppInstalled: Bool { activeSession?.isCompanionAppInstalled ?? false }
    #endif

    // MARK: Phone → watch

    public func updateContext(_ context: WatchContext) throws {
        guard let session = activeSession, let data = WatchCoding.encode(context) else { return }
        try session.updateApplicationContext([WatchMessageKey.context: data])
    }

    /// Asks the (reachable) watch app to pair itself. Throws when the watch is not
    /// reachable or does not answer.
    public func sendPairCommand(_ command: WatchPairCommand) async throws -> WatchPairResult {
        guard let session = activeSession, session.isReachable, let data = WatchCoding.encode(command) else {
            throw LTMError.transport("watch not reachable")
        }
        let message: [String: Any] = [WatchMessageKey.kind: WatchMessageKind.pair, WatchMessageKey.payload: data]
        return try await withCheckedThrowingContinuation { continuation in
            session.sendMessage(message, replyHandler: { reply in
                if let result = WatchCoding.decode(WatchPairResult.self, from: reply[WatchMessageKey.payload]) {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(throwing: LTMError.decoding("bad pair reply"))
                }
            }, errorHandler: { error in
                continuation.resume(throwing: LTMError.transport(error.localizedDescription))
            })
        }
    }

    // MARK: Watch → phone

    public func sendPairResult(_ result: WatchPairResult) {
        guard let session = activeSession, let data = WatchCoding.encode(result) else { return }
        _ = session.transferUserInfo([WatchMessageKey.kind: WatchMessageKind.pairResult, WatchMessageKey.payload: data])
    }

    public func requestContext() {
        guard let session = activeSession, session.isReachable else { return }
        session.sendMessage([WatchMessageKey.kind: WatchMessageKind.requestContext], replyHandler: nil, errorHandler: nil)
    }

    /// Queues a job for the phone. Chunks travel as files with the job in the metadata.
    @discardableResult
    public func transfer(job: UploadJob, audioFile: URL?) -> Bool {
        guard let session = activeSession, let data = WatchCoding.encode(job) else { return false }
        #if os(watchOS)
        guard session.isCompanionAppInstalled else { return false }
        #endif
        let metadata: [String: Any] = [WatchMessageKey.job: data, WatchMessageKey.jobId: job.id]
        if let audioFile {
            _ = session.transferFile(audioFile, metadata: metadata)
        } else {
            _ = session.transferUserInfo(metadata)
        }
        return true
    }

    // MARK: WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error {
            Log.watch.error("WCSession activation failed: \(error.localizedDescription, privacy: .public)")
        }
        guard activationState == .activated else { return }
        handlers.get().onActivated?()
        // Deliver the context that may have arrived while the app was not running.
        let context = session.receivedApplicationContext
        if let decoded = WatchCoding.decode(WatchContext.self, from: context[WatchMessageKey.context]) {
            handlers.get().onContext?(decoded)
        }
    }

    #if os(iOS)
    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        // The user switched to another watch: activate again for the new one.
        WCSession.default.activate()
    }
    #endif

    public func sessionReachabilityDidChange(_ session: WCSession) {
        handlers.get().onReachabilityChanged?(session.isReachable)
    }

    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let context = WatchCoding.decode(WatchContext.self, from: applicationContext[WatchMessageKey.context]) {
            handlers.get().onContext?(context)
        }
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handleMessage(message, reply: nil)
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        handleMessage(message, reply: ReplyBox(replyHandler))
    }

    private func handleMessage(_ message: [String: Any], reply: ReplyBox?) {
        let kind = message[WatchMessageKey.kind] as? String ?? ""
        switch kind {
        case WatchMessageKind.pair:
            guard let command = WatchCoding.decode(WatchPairCommand.self, from: message[WatchMessageKey.payload]),
                  let handler = handlers.get().onPairCommand
            else {
                reply?.send(WatchPairResult(ok: false, errorMessage: "not handled"))
                return
            }
            handler(command) { result in
                reply?.send(result)
            }
        case WatchMessageKind.requestContext:
            handlers.get().onContextRequested?()
            reply?.call([:])
        default:
            reply?.call([:])
        }
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        if userInfo[WatchMessageKey.kind] as? String == WatchMessageKind.pairResult {
            if let result = WatchCoding.decode(WatchPairResult.self, from: userInfo[WatchMessageKey.payload]) {
                handlers.get().onPairResult?(result)
            }
            return
        }
        if let job = WatchCoding.decode(UploadJob.self, from: userInfo[WatchMessageKey.job]) {
            handlers.get().onJobReceived?(job, nil)
        }
    }

    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let job = WatchCoding.decode(UploadJob.self, from: file.metadata?[WatchMessageKey.job]) else {
            Log.watch.error("received a file without job metadata")
            return
        }
        // The system deletes the file when this method returns: move it synchronously.
        do {
            try FileManager.default.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
            let ext = file.fileURL.pathExtension.isEmpty ? "m4a" : file.fileURL.pathExtension
            let staged = stagingDirectory.appendingPathComponent("\(UUID().uuidString.lowercased()).\(ext)")
            try FileManager.default.moveItem(at: file.fileURL, to: staged)
            handlers.get().onJobReceived?(job, staged)
        } catch {
            Log.watch.error("could not stage watch chunk: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard let jobId = fileTransfer.file.metadata?[WatchMessageKey.jobId] as? String else { return }
        handlers.get().onTransferFinished?(jobId, error == nil)
    }

    public func session(_ session: WCSession, didFinish userInfoTransfer: WCSessionUserInfoTransfer, error: Error?) {
        guard let jobId = userInfoTransfer.userInfo[WatchMessageKey.jobId] as? String else { return }
        handlers.get().onTransferFinished?(jobId, error == nil)
    }
}

/// Makes WatchConnectivity's non-Sendable reply handler callable from the async pairing
/// flow; WatchConnectivity allows calling it from any thread, exactly once.
final class ReplyBox: @unchecked Sendable {
    private let handler: ([String: Any]) -> Void
    private let used = LockedBox(false)

    init(_ handler: @escaping ([String: Any]) -> Void) {
        self.handler = handler
    }

    func call(_ payload: [String: Any]) {
        let first: Bool = used.withValue { value in
            if value { return false }
            value = true
            return true
        }
        if first { handler(payload) }
    }

    func send(_ result: WatchPairResult) {
        guard let data = WatchCoding.encode(result) else {
            call([:])
            return
        }
        call([WatchMessageKey.payload: data])
    }
}

/// Watch side of the upload queue's hand-off: `transferFile` to the phone.
public struct PhoneHandoff: UploadHandoff {
    public init() {}

    public func handOff(job: UploadJob, audioFile: URL?) async -> Bool {
        WatchLink.shared.transfer(job: job, audioFile: audioFile)
    }
}
#endif
