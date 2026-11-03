import Foundation

/// One process above this one: its pid, executable path and first arguments (for `node …/claude` style launchers).
public struct Ancestor: Equatable, Sendable {
    public let pid: Int32
    public let path: String
    public let args: [String]
    public init(pid: Int32, path: String, args: [String] = []) { self.pid = pid; self.path = path; self.args = args }
    public var name: String { (path as NSString).lastPathComponent }
}

/// Who is asking. The process tree is the main signal; the environment only fills in when the tree shows nothing.
/// This is a speed bump, not proof: a process that detaches from the agent's tree (launchd, a daemon) looks like the human.
public enum Agents {
    public static let human = "human"
    public static let runtimes = ["claude-code", "codex"]

    /// The runtime of the nearest agent ancestor, nil = the human. A real executable named `claude` / `codex` is the
    /// strong signal; an argv hint (`node …/claude`, `node …/@openai/codex/…`) counts only where no executable says
    /// otherwise. If an argv hint names one runtime nearer than an executable of the other (`exec -a claude bash` under
    /// codex), that is a conflict and `run` refuses it. The environment fills in only when the tree shows nothing.
    public static func detect(ancestors: [Ancestor], environment: [String: String]) -> (runtime: String?, conflict: String?) {
        let fromPath = ancestors.enumerated().lazy.compactMap { i, a in word(a.name).map { (i, $0, a) } }.first
        let fromArgs = ancestors.enumerated().lazy.compactMap { i, a in
            a.args.prefix(2).lazy.compactMap { word(($0 as NSString).lastPathComponent) ?? word($0) }.first.map { (i, $0, a) }
        }.first
        switch (fromPath, fromArgs) {
        case let (p?, h?) where h.1 != p.1 && h.0 < p.0:
            return (p.1, "pid \(h.2.pid) claims \(h.1) by its arguments but runs under \(p.2.name) (pid \(p.2.pid), \(p.1))")
        case let (p?, _): return (p.1, nil)
        case let (nil, h?): return (h.1, nil)
        default: break
        }
        if environment["CLAUDECODE"] != nil || environment["CLAUDE_CODE_ENTRYPOINT"] != nil { return ("claude-code", nil) }
        if environment["CODEX_SANDBOX"] != nil || environment["CODEX_THREAD_ID"] != nil || environment["CODEX_SESSION_ID"] != nil { return ("codex", nil) }
        return (nil, nil)
    }

    public static func runtime(ancestors: [Ancestor], environment: [String: String]) -> String? {
        detect(ancestors: ancestors, environment: environment).runtime
    }

    private static func word(_ s: String) -> String? {
        let w = s.lowercased()
        if w == "claude" || w.contains("@anthropic-ai/claude-code") { return "claude-code" }
        if w == "codex" || w.contains("@openai/codex") { return "codex" }
        return nil
    }

    /// An agent name: `claude-code` or `codex`, optionally a lane under it (`claude-code.review`, `codex.spec-2`).
    public static func isAgentName(_ name: String) -> Bool {
        for r in runtimes {
            if name == r { return true }
            if name.hasPrefix(r + "."), Labels.isValid(String(name.dropFirst(r.count + 1))), name.count <= 64 { return true }
        }
        return false
    }

    public static func runtimeOf(_ agent: String) -> String? {
        runtimes.first { agent == $0 || agent.hasPrefix($0 + ".") }
    }

    /// The name a request runs as. Under an agent runtime `--agent` may only name a lane of that runtime; it can never
    /// name the human or the other runtime. Without a runtime (the human's own terminal) `--agent` makes it run as that
    /// agent, which only ever adds rules.
    public static func resolve(declared: String?, runtime: String?) throws -> String {
        guard let declared else { return runtime ?? human }
        guard isAgentName(declared) else { throw SecretError.invalidAgent(declared) }
        if let runtime, runtimeOf(declared) != runtime {
            throw SecretError.agentMismatch("this process runs under \(runtime); it cannot act as \(declared)")
        }
        return declared
    }
}
