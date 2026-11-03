import Foundation

/// The commands, over the store, the prompts, the audit log and the executor. The app wires in the Keychain, AppKit and
/// execve; tests wire in fakes.
public struct SecretCommands {
    public let store: SecretStore
    public let prompts: HumanPrompts
    public let audit: AuditSink
    public let executor: CommandExecutor
    public let resolver: CommandResolver
    public let caller: Caller
    public let out: (String) -> Void
    public let now: () -> Date

    public init(store: SecretStore, prompts: HumanPrompts, audit: AuditSink, executor: CommandExecutor, resolver: CommandResolver,
                caller: Caller, out: @escaping (String) -> Void, now: @escaping () -> Date = Date.init) {
        self.store = store; self.prompts = prompts; self.audit = audit; self.executor = executor; self.resolver = resolver; self.caller = caller
        self.out = out; self.now = now
    }

    /// Runs one invocation; returns the exit status. Errors print one line on stderr from main.
    public func perform(_ inv: Invocation) throws -> Int32 {
        switch inv {
        case .help: out(Invocation.usage); return 0
        case let .store(label, replace): try storeValue(label: label, replace: replace); return 0
        case let .run(labels, agent, command): try run(labels: labels, declared: agent, command: command); return 0
        case let .allow(label, agent): try changeAgents(label: label, agent: agent, add: true); return 0
        case let .disallow(label, agent): try changeAgents(label: label, agent: agent, add: false); return 0
        case let .list(json): try list(json: json); return 0
        case let .check(labels, agent, json): return try check(labels: labels, agent: agent, json: json)
        case let .delete(label): try delete(label: label); return 0
        }
    }

    // ---------- store / delete ----------

    func storeValue(label: String, replace: Bool) throws {
        try Labels.checkEnvName(label)
        let existing = try store.find(label)
        if existing != nil, !replace { throw SecretError.labelExists(label) }
        if existing != nil {
            guard prompts.confirm(title: "Replace \(label)?", message: "The value stored as \(label) will be replaced. Its agents stay allowed.")
            else { try note("store", label: label, outcome: "user_cancelled"); throw SecretError.userCancelled }
        }
        guard let value = prompts.askValue(label: label, replacing: existing != nil) else {
            try note("store", label: label, outcome: "user_cancelled"); throw SecretError.userCancelled
        }
        guard !value.isEmpty else { throw SecretError.emptyValue }
        try store.save(label: label, value: value, replace: existing != nil)
        try note("store", label: label, outcome: existing != nil ? "replaced" : "stored")
        out("\(existing != nil ? "replaced" : "stored") \(label)")
    }

    func delete(label: String) throws {
        guard try store.find(label) != nil else { throw SecretError.labelMissing(label) }
        guard prompts.confirm(title: "Delete \(label)?", message: "The value stored as \(label) and its agent list will be deleted from your Keychain.")
        else { try note("delete", label: label, outcome: "user_cancelled"); throw SecretError.userCancelled }
        try store.delete(label: label)
        try note("delete", label: label, outcome: "deleted")
        out("deleted \(label)")
    }

    // ---------- allowlist ----------

    func changeAgents(label: String, agent: String, add: Bool) throws {
        let action = add ? "allow" : "disallow"
        if caller.runtime != nil || caller.conflict != nil {
            try note(action, label: label, agent: caller.runtime ?? "unknown", outcome: "human_only")
            throw SecretError.humanOnly
        }
        guard Agents.isAgentName(agent) else { throw SecretError.invalidAgent(agent) }
        guard let item = try store.find(label) else {
            throw SecretError.labelMissing("\(label) is not stored; first: dasks-secret store --label \(label)")
        }
        let next = add ? Array(Set(item.agents + [agent])).sorted() : item.agents.filter { $0 != agent }
        if next != item.agents {
            let reason = add ? "let \(agent) use \(label) through dasks-secret run" : "stop \(agent) from using \(label)"
            guard let approval = prompts.authenticate(reason: reason) else {
                try note(action, label: label, outcome: "user_cancelled"); throw SecretError.userCancelled
            }
            try store.setAgents(label: label, agents: next, approval: approval)
            try note(action, label: label, outcome: "\(action)ed \(agent)")
        }
        out("\(label) agents=\(next.isEmpty ? "-" : next.joined(separator: ","))")
    }

    // ---------- read-only ----------

    func list(json: Bool) throws {
        let items = try store.all().sorted { $0.label < $1.label }
        if json {
            out(Self.json(["labels": items.map { ["label": $0.label, "agents": $0.agents] }]))
            return
        }
        if items.isEmpty { out("no labels stored (dasks-secret store --label <name>)"); return }
        for i in items { out("\(i.label) agents=\(i.agents.isEmpty ? "-" : i.agents.joined(separator: ","))") }
    }

    /// Stored and allowed per label, no prompt. Exit 0 when every label is stored (and allowed for the agent), else 10.
    func check(labels: [String], agent: String?, json: Bool) throws -> Int32 {
        if let agent, !Agents.isAgentName(agent) { throw SecretError.invalidAgent(agent) }
        var rows: [[String: Any]] = []
        var ready = true
        for l in labels {
            let item = try store.find(l)
            let allowed = agent.map { a in item?.agents.contains(a) ?? false }
            if item == nil || allowed == false { ready = false }
            var row: [String: Any] = ["label": l, "stored": item != nil, "agents": item?.agents ?? []]
            if let allowed { row["allowed"] = allowed }
            rows.append(row)
        }
        if json {
            var doc: [String: Any] = ["ready": ready, "labels": rows]
            if let agent { doc["agent"] = agent }
            out(Self.json(doc))
        } else {
            for r in rows {
                let l = r["label"] as! String
                var s = "\(l) \((r["stored"] as! Bool) ? "stored" : "missing")"
                if let a = r["allowed"] as? Bool { s += a ? " allowed" : " not_allowed" }
                out(s)
            }
        }
        return ready ? 0 : 10
    }

    // ---------- run ----------

    func run(labels: [String], declared: String?, command: [String]) throws {
        let runtime = caller.runtime
        let process = caller.description
        let agent: String
        do { agent = try Agents.resolve(declared: declared, runtime: runtime) } catch let e as SecretError {
            try note("run", agent: declared ?? runtime ?? Agents.human, labels: labels, command: command, outcome: e.code); throw e
        }
        let fail: (SecretError) throws -> Never = { e in
            try note("run", agent: agent, labels: labels, command: command, outcome: e.code); throw e
        }
        let names: [String: String]
        do { names = try Labels.envNames(labels) } catch let e as SecretError { try fail(e) }
        if let conflict = caller.conflict { try fail(.agentMismatch("the process tree disagrees: \(conflict)")) }
        let isAgent = agent != Agents.human
        // Resolve the file before anything else, so the check, the prompt and the exec all mean the same file.
        guard let target = resolver.resolve(command[0]) else { try fail(.execFailed("\(command[0]): command not found or not an executable file")) }
        if isAgent, let why = CommandPolicy.refusal(command, realPath: target.path, fileExists: resolver.fileExists) {
            try fail(.refusedCommand("\(why) (agents may not run it with secrets)"))
        }
        var missing: [String] = []
        for l in labels {
            guard let item = try store.find(l) else { missing.append(l); continue }
            if isAgent, !item.agents.contains(agent) {
                try fail(.agentNotAllowed("\(agent) may not use \(l); the human runs: dasks-secret allow --label \(l) --agent \(agent)"))
            }
        }
        if let first = missing.first {
            // Open the masked window for the human with the label filled in, then stop: the agent asks again later.
            if let value = prompts.askValue(label: first, replacing: false), !value.isEmpty {
                try store.save(label: first, value: value, replace: false)
                try note("store", agent: agent, labels: [first], outcome: "stored")
            }
            try fail(.labelMissing("\(missing.joined(separator: ", ")) not stored; run again after the human stores it" + (isAgent ? " and allows \(agent)" : "")))
        }
        let request = RunRequest(agent: agent, process: process, labels: labels, command: command, executable: target.path)
        guard let approval = prompts.approveRun(request) else { try fail(.userCancelled) }
        let values: [String: Data]
        do { values = try store.values(labels, approval: approval) } catch let e as SecretError { try fail(e) }
        var env: [String: String] = [:]
        for l in labels {
            guard let v = values[l], let s = String(data: v, encoding: .utf8) else { try fail(.labelMissing("\(l) could not be read")) }
            env[names[l]!] = s
        }
        // The file approved is the file that runs: same name, same real path, same file identity.
        guard resolver.resolve(command[0]) == target else {
            try fail(.targetChanged("\(command[0]) no longer resolves to the approved file \(target.path); nothing ran"))
        }
        // Fail closed: no audit line, no run.
        do { try note("run", agent: agent, labels: labels, command: command, outcome: "approved") } catch { throw SecretError.auditFailed }
        let err = executor.exec(path: target.path, argv: command, extraEnvironment: env)
        try? note("run", agent: agent, labels: labels, command: command, outcome: err.code)
        throw err
    }

    // ---------- helpers ----------

    private func note(_ action: String, label: String, agent: String? = nil, outcome: String) throws {
        try note(action, agent: agent ?? caller.runtime ?? Agents.human, labels: [label], outcome: outcome)
    }

    private func note(_ action: String, agent: String, labels: [String], command: [String] = [], outcome: String) throws {
        let e = AuditEntry(time: now(), action: action, agent: agent, process: caller.description, labels: labels, command: command, outcome: outcome)
        do { try audit.append(e.line) } catch { throw SecretError.auditFailed }
    }

    static func json(_ obj: Any) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: d, as: UTF8.self)
    }
}
