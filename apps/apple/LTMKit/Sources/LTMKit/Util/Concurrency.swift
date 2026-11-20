import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A value guarded by a lock, for the few places where state is touched from callback
/// threads we do not control (URLSession delegates, WatchConnectivity, audio taps).
///
/// The lock is only taken inside a synchronous closure, which keeps it legal to call
/// from async code (NSLock's `lock()` is marked unavailable from async contexts).
public final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    public init(_ value: Value) {
        self.value = value
    }

    @discardableResult
    public func withValue<R>(_ body: (inout Value) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }

    public func get() -> Value {
        withValue { $0 }
    }

    public func set(_ newValue: Value) {
        withValue { $0 = newValue }
    }
}

/// Abstracts waiting so that tests can control time.
public protocol Sleeper: Sendable {
    /// Suspends for `seconds`; throws `CancellationError` when the task is cancelled.
    func sleep(seconds: Double) async throws
}

public struct TaskSleeper: Sleeper {
    public init() {}

    public func sleep(seconds: Double) async throws {
        guard seconds > 0 else {
            try Task.checkCancellation()
            return
        }
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}

/// Exponential back-off with multiplicative jitter.
///
/// delay(n) = min(maxDelay, base * multiplier^(n-1)) * (1 - jitter + 2 * jitter * random)
/// for attempt n >= 1, where `random` is uniform in [0, 1).
public struct BackoffPolicy: Sendable, Equatable {
    public var baseDelay: Double
    public var multiplier: Double
    public var maxDelay: Double
    /// Fraction of the delay that is randomised (0.2 → ±20 %).
    public var jitter: Double

    public init(baseDelay: Double = 1, multiplier: Double = 2, maxDelay: Double = 30, jitter: Double = 0.2) {
        self.baseDelay = baseDelay
        self.multiplier = multiplier
        self.maxDelay = maxDelay
        self.jitter = jitter
    }

    public func delay(forAttempt attempt: Int, random: Double) -> Double {
        let n = max(1, attempt)
        let exponential = baseDelay * pow(multiplier, Double(n - 1))
        let capped = min(maxDelay, exponential)
        let clampedRandom = min(max(random, 0), 1)
        let factor = 1 - jitter + 2 * jitter * clampedRandom
        return max(0, capped * factor)
    }
}
