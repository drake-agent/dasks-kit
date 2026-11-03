import Foundation
@testable import SecretCore

/// A fake value, assembled at run time so no secret-looking literal sits in the source.
func fakeValue(_ n: Int) -> String { ["fake", "value", String(n * 7919), "zq"].joined(separator: "-") }

final class FakeStore: SecretStore {
    var items: [String: (value: Data, agents: [String])] = [:]
    var reads = 0

    func all() throws -> [StoredLabel] { items.map { StoredLabel(label: $0.key, agents: $0.value.agents) } }
    func find(_ label: String) throws -> StoredLabel? { items[label].map { StoredLabel(label: label, agents: $0.agents) } }
    func save(label: String, value: Data, replace: Bool) throws {
        if items[label] != nil, !replace { throw SecretError.labelExists(label) }
        items[label] = (value, items[label]?.agents ?? [])
    }
    func setAgents(label: String, agents: [String], approval: Approval) throws { items[label]?.agents = agents }
    func delete(label: String) throws { items[label] = nil }
    func values(_ labels: [String], approval: Approval) throws -> [String: Data] {
        reads += 1
        var out: [String: Data] = [:]
        for l in labels { guard let v = items[l]?.value else { throw SecretError.labelMissing(l) }; out[l] = v }
        return out
    }
}

final class FakePrompts: HumanPrompts {
    var typed: String?
    var confirmAnswer = true
    var approve = true
    var calls: [String] = []
    var lastRequest: RunRequest?

    func askValue(label: String, replacing: Bool) -> Data? { calls.append("ask:\(label)"); return typed.map { Data($0.utf8) } }
    func confirm(title: String, message: String) -> Bool { calls.append("confirm"); return confirmAnswer }
    var onApprove: (() -> Void)?
    func approveRun(_ request: RunRequest) -> Approval? { calls.append("approve"); lastRequest = request; onApprove?(); return approve ? Approval() : nil }
    func authenticate(reason: String) -> Approval? { calls.append("auth"); return approve ? Approval() : nil }
}

final class MemoryAudit: AuditSink {
    var lines: [String] = []
    var broken = false
    func append(_ line: String) throws { if broken { throw SecretError.auditFailed }; lines.append(line) }
}

final class FakeExecutor: CommandExecutor {
    var argv: [String]?
    var path: String?
    var env: [String: String] = [:]
    func exec(path: String, argv: [String], extraEnvironment: [String: String]) -> SecretError {
        self.argv = argv; self.path = path; env = extraEnvironment
        return .execFailed("fake exec")
    }
}

/// Resolves `name` to /usr/bin/<basename> unless `table` says otherwise; every script file exists unless listed in `missing`.
final class FakeResolver: CommandResolver {
    var table: [String: ResolvedCommand] = [:]
    var missing: Set<String> = []
    func resolve(_ name: String) -> ResolvedCommand? {
        table[name] ?? ResolvedCommand(path: "/usr/bin/" + (name as NSString).lastPathComponent, fingerprint: "1")
    }
    func fileExists(_ path: String) -> Bool { !missing.contains(path) }
}

struct Harness {
    let store = FakeStore()
    let prompts = FakePrompts()
    let audit = MemoryAudit()
    let exec = FakeExecutor()
    let resolver = FakeResolver()
    var output: [String] { box.lines }
    private let box = Box()
    final class Box { var lines: [String] = [] }

    func commands(agentAncestor: String? = "claude", ancestors given: [Ancestor]? = nil) -> SecretCommands {
        var ancestors = [Ancestor(pid: 4242, path: "/bin/zsh")]
        if let a = agentAncestor { ancestors.append(Ancestor(pid: 100, path: "/usr/local/bin/\(a)")) }
        let box = self.box
        return SecretCommands(store: store, prompts: prompts, audit: audit, executor: exec, resolver: resolver,
                       caller: Caller(ancestors: given ?? ancestors, environment: [:]), out: { box.lines.append($0) })
    }

    func perform(_ args: [String], agentAncestor: String? = "claude", ancestors: [Ancestor]? = nil) -> Result<Int32, SecretError> {
        do { return .success(try commands(agentAncestor: agentAncestor, ancestors: ancestors).perform(try Invocation.parse(args))) }
        catch let e as SecretError { return .failure(e) }
        catch { return .failure(.keychain("unexpected \(error)")) }
    }
}

extension Result where Failure == SecretError {
    var code: String? { if case .failure(let e) = self { return e.code }; return nil }
}
