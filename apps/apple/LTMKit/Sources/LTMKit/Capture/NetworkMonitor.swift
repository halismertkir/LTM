import Foundation
#if canImport(Network)
import Network
#endif

/// Publishes a coarse network status for `CapturePolicy`.
#if canImport(Network)
public final class NetworkMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "app.ltm.network-monitor")

    public init() {}

    /// `onChange` runs on a private queue.
    public func start(onChange: @escaping @Sendable (NetworkStatus) -> Void) {
        monitor.pathUpdateHandler = { path in
            onChange(NetworkMonitor.classify(path))
        }
        monitor.start(queue: queue)
    }

    public func stop() {
        monitor.cancel()
    }

    static func classify(_ path: NWPath) -> NetworkStatus {
        guard path.status == .satisfied else { return .offline }
        if path.isExpensive || path.isConstrained { return .metered }
        if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) { return .unmetered }
        if path.usesInterfaceType(.cellular) { return .metered }
        return .metered
    }
}
#else
/// Platforms without the Network framework (Linux tests): never reports a change.
public final class NetworkMonitor: @unchecked Sendable {
    public init() {}
    public func start(onChange: @escaping @Sendable (NetworkStatus) -> Void) {}
    public func stop() {}
}
#endif
