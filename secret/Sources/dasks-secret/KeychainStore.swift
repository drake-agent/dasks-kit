import Foundation
import LocalAuthentication
import Security
import SecretCore

/// One generic password item per label in the login Keychain: service `dev.dasks.secret`, account = label, the value as
/// data, the agent list in the item's generic attribute (`agents=a,b`), names only.
///
/// A new item first tries the data protection keychain with access control `.userPresence` (Touch ID / password on
/// every read). A binary built from source has no keychain entitlement, so macOS answers errSecMissingEntitlement and
/// the item goes to the file-based login keychain instead, where only this binary may read it without a macOS prompt;
/// the run approval (LocalAuthentication) is then the Touch ID gate. docs/secrets.md says what that does and does not stop.
struct KeychainStore: SecretStore {
    let service: String

    /// `dev.dasks.secret`, or a test-only service (`DASKS_SECRET_SERVICE`, which must start with `dev.dasks.secret.test`).
    static func service(environment: [String: String]) -> String {
        if let s = environment["DASKS_SECRET_SERVICE"], s.hasPrefix("dev.dasks.secret.test"), s.count <= 100 { return s }
        return "dev.dasks.secret"
    }

    private func base(_ label: String?, dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let label { q[kSecAttrAccount as String] = label }
        if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
        return q
    }

    private static func agents(from attrs: [String: Any]) -> [String] {
        guard let d = attrs[kSecAttrGeneric as String] as? Data, let s = String(data: d, encoding: .utf8), s.hasPrefix("agents=") else { return [] }
        return s.dropFirst("agents=".count).split(separator: ",").map(String.init).filter(Agents.isAgentName)
    }

    private static func encode(_ agents: [String]) -> Data { Data("agents=\(agents.sorted().joined(separator: ","))".utf8) }

    private func check(_ status: OSStatus, _ what: String) throws {
        guard status == errSecSuccess else {
            let msg = (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
            throw SecretError.keychain("\(what): \(msg)")
        }
    }

    /// Attribute rows from both keychains (the data protection one usually answers "missing entitlement": skipped).
    private func rows(_ label: String?) throws -> [(attrs: [String: Any], dataProtection: Bool)] {
        var out: [(attrs: [String: Any], dataProtection: Bool)] = []
        for dp in [true, false] {
            var q = base(label, dataProtection: dp)
            q[kSecMatchLimit as String] = kSecMatchLimitAll
            q[kSecReturnAttributes as String] = true
            q[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
            var result: CFTypeRef?
            let st = SecItemCopyMatching(q as CFDictionary, &result)
            if st == errSecItemNotFound || st == errSecMissingEntitlement || st == errSecInteractionNotAllowed { continue }
            try check(st, "read the label list")
            for a in (result as? [[String: Any]]) ?? [] { out.append((a, dp)) }
        }
        return out
    }

    func all() throws -> [StoredLabel] {
        var seen: [String: StoredLabel] = [:]
        for r in try rows(nil) {
            guard let l = r.attrs[kSecAttrAccount as String] as? String, Labels.isValid(l), seen[l] == nil else { continue }
            seen[l] = StoredLabel(label: l, agents: Self.agents(from: r.attrs))
        }
        return Array(seen.values)
    }

    func find(_ label: String) throws -> StoredLabel? {
        guard let r = try rows(label).first else { return nil }
        return StoredLabel(label: label, agents: Self.agents(from: r.attrs))
    }

    func save(label: String, value: Data, replace: Bool) throws {
        if replace, let r = try rows(label).first {
            let st = SecItemUpdate(base(label, dataProtection: r.dataProtection) as CFDictionary, [kSecValueData as String: value] as CFDictionary)
            return try check(st, "replace \(label)")
        }
        var attrs = base(label, dataProtection: true)
        attrs[kSecValueData as String] = value
        attrs[kSecAttrLabel as String] = "dasks secret: \(label)"
        attrs[kSecAttrGeneric as String] = Self.encode([])
        var err: Unmanaged<CFError>?
        if let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, &err) {
            attrs[kSecAttrAccessControl as String] = ac
        }
        var st = SecItemAdd(attrs as CFDictionary, nil)
        if st == errSecMissingEntitlement {
            attrs.removeValue(forKey: kSecUseDataProtectionKeychain as String)
            attrs.removeValue(forKey: kSecAttrAccessControl as String)
            st = SecItemAdd(attrs as CFDictionary, nil)
        }
        if st == errSecDuplicateItem { throw SecretError.labelExists(label) }
        try check(st, "store \(label)")
    }

    func setAgents(label: String, agents: [String], approval: Approval) throws {
        guard let r = try rows(label).first else { throw SecretError.labelMissing(label) }
        var q = base(label, dataProtection: r.dataProtection)
        if let ctx = approval.context as? LAContext { q[kSecUseAuthenticationContext as String] = ctx }
        try check(SecItemUpdate(q as CFDictionary, [kSecAttrGeneric as String: Self.encode(agents)] as CFDictionary), "update the agents of \(label)")
    }

    func delete(label: String) throws {
        for r in try rows(label) {
            try check(SecItemDelete(base(label, dataProtection: r.dataProtection) as CFDictionary), "delete \(label)")
        }
    }

    func values(_ labels: [String], approval: Approval) throws -> [String: Data] {
        var out: [String: Data] = [:]
        for l in labels {
            guard let r = try rows(l).first else { throw SecretError.labelMissing(l) }
            var q = base(l, dataProtection: r.dataProtection)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            if let ctx = approval.context as? LAContext { q[kSecUseAuthenticationContext as String] = ctx }
            var result: CFTypeRef?
            try check(SecItemCopyMatching(q as CFDictionary, &result), "read \(l)")
            guard let d = result as? Data else { throw SecretError.labelMissing(l) }
            out[l] = d
        }
        return out
    }
}
