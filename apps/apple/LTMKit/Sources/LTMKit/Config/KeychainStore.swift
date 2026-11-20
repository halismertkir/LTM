import Foundation
#if canImport(Security)
import Security
#endif

/// Which paired device a credential or upload belongs to. The phone holds its own token
/// and, after pairing the watch, the watch's token too (so it can upload chunks the watch
/// hands over on the watch's behalf, attributed to the watch device).
public enum DeviceRole: String, Codable, Sendable, CaseIterable {
    case phone
    case watch
}

/// Abstraction over token storage so tests and previews can use memory.
public protocol TokenStore: Sendable {
    func token(for role: DeviceRole) -> String?
    func setToken(_ token: String?, for role: DeviceRole) throws
}

#if canImport(Security)
public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
}

/// Device tokens live in the Keychain, never in UserDefaults.
///
/// Accessibility is `AfterFirstUnlockThisDeviceOnly`: readable while the device is locked
/// once it has been unlocked after boot, which background capture and background upload
/// completions need (a recording running with the screen locked must still be able to
/// authenticate). `ThisDeviceOnly` keeps the token out of backups and device migration:
/// a restored backup on another phone must not silently impersonate this device.
public final class KeychainStore: TokenStore, @unchecked Sendable {
    private let service: String

    public init(service: String = "app.ltm.device-token") {
        self.service = service
    }

    private func baseQuery(_ role: DeviceRole) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: role.rawValue,
        ]
    }

    public func token(for role: DeviceRole) -> String? {
        var query = baseQuery(role)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setToken(_ token: String?, for role: DeviceRole) throws {
        guard let token else {
            let status = SecItemDelete(baseQuery(role) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
            return
        }
        let data = Data(token.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery(role) as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw KeychainError(status: updateStatus) }
        var addQuery = baseQuery(role)
        for (key, value) in attributes { addQuery[key] = value }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
    }
}

#endif

/// In-memory token store for tests and SwiftUI previews.
public final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let tokens = LockedBox<[DeviceRole: String]>([:])

    public init(_ initial: [DeviceRole: String] = [:]) {
        tokens.set(initial)
    }

    public func token(for role: DeviceRole) -> String? {
        tokens.withValue { $0[role] }
    }

    public func setToken(_ token: String?, for role: DeviceRole) throws {
        tokens.withValue { $0[role] = token }
    }
}
