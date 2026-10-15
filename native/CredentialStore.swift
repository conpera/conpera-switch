import Foundation
import Security

/// Only Conpera Switch's own desktop session is stored here. CLI credentials
/// belong to ConfigurationManager and are never read by this store.
struct AccountCredential: Codable, Equatable {
    let accessToken: String
    let expiresAt: String
}

protocol AccountCredentialStore {
    func load() throws -> AccountCredential?
    func save(_ credential: AccountCredential) throws
    func delete() throws
}

final class KeychainCredentialStore: AccountCredentialStore {
    private let service = "ai.conpera.switch.beta"
    private let account = "desktop-session"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func load() throws -> AccountCredential? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data,
              let credential = try? JSONDecoder().decode(AccountCredential.self, from: data) else {
            throw AccountError("keychain_error", "无法读取 Conpera 登录凭据，请检查系统钥匙串权限。")
        }
        return credential
    }

    func save(_ credential: AccountCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            for (key, value) in attributes { item[key] = value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                throw AccountError("keychain_error", "无法安全保存登录凭据，请检查系统钥匙串权限。")
            }
        } else if status != errSecSuccess {
            throw AccountError("keychain_error", "无法安全保存登录凭据，请检查系统钥匙串权限。")
        }
    }

    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AccountError("keychain_error", "无法移除 Conpera 登录凭据，请检查系统钥匙串权限。")
        }
    }
}
