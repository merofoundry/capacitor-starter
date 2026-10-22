import Foundation
import Security

/// The consumer session's bearer token pair (ADR 2026-10-16 v2, Ruling 5) in the Keychain: one
/// generic-password item whose service is the app id, readable after the first unlock and never
/// restored to another device. Beside it, a second item of the same service keeps whether push
/// is enabled and the last APNs token (`ShellPush`). Nothing here logs or reports the tokens.
final class ShellSessionStore {
    struct Tokens: Codable {
        let accessToken: String
        let refreshToken: String
    }

    struct PushState: Codable {
        let enabled: Bool
        let token: String?
    }

    enum StoreError: Error {
        case keychain(OSStatus)
        case unreadable
    }

    private static let account = "session"
    private static let pushAccount = "push"
    private let service: String

    init(service: String) {
        self.service = service
    }

    private func item(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    /// The stored pair, or nil when none is stored.
    func load() throws -> Tokens? {
        try read(Self.account, as: Tokens.self)
    }

    /// Replaces the stored pair.
    func save(_ tokens: Tokens) throws {
        try write(Self.account, try JSONEncoder().encode(tokens))
    }

    /// Removes the stored pair. The push item is left alone.
    func clear() throws {
        let status = SecItemDelete(item(Self.account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError.keychain(status)
        }
    }

    /// The stored push state, or nil when push was never turned on.
    func loadPush() throws -> PushState? {
        try read(Self.pushAccount, as: PushState.self)
    }

    /// Replaces the stored push state.
    func savePush(_ state: PushState) throws {
        try write(Self.pushAccount, try JSONEncoder().encode(state))
    }

    private func read<Value: Decodable>(_ account: String, as type: Value.Type) throws -> Value? {
        var query = item(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw StoreError.keychain(status)
        }
        guard let value = try? JSONDecoder().decode(type, from: data) else {
            throw StoreError.unreadable
        }
        return value
    }

    private func write(_ account: String, _ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(item(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(item(account).merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw StoreError.keychain(status)
        }
    }
}
