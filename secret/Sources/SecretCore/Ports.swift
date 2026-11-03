import Foundation

/// A stored label: its name and the agents allowed to use it through `run`. Never the value.
public struct StoredLabel: Equatable, Sendable {
    public let label: String
    public var agents: [String]
    public init(label: String, agents: [String]) { self.label = label; self.agents = agents.sorted() }
}

/// Proof that the human just approved (Touch ID or password). The Keychain store passes it on so the read does not ask
/// again; fakes leave it empty.
public struct Approval: @unchecked Sendable {
    public let context: AnyObject?
    public init(context: AnyObject? = nil) { self.context = context }
}

/// Where values live (the login Keychain in the app; a dictionary in tests).
public protocol SecretStore {
    /// Every stored label with its agents; no values, no prompt.
    func all() throws -> [StoredLabel]
    func find(_ label: String) throws -> StoredLabel?
    /// Adds a new label; `replace` overwrites the value of an existing one and keeps its agents.
    func save(label: String, value: Data, replace: Bool) throws
    func setAgents(label: String, agents: [String], approval: Approval) throws
    func delete(label: String) throws
    /// The values, after an approval. A label that is gone by now throws `labelMissing`.
    func values(_ labels: [String], approval: Approval) throws -> [String: Data]
}

/// What the human sees (native windows in the app; scripted answers in tests).
public struct RunRequest: Equatable, Sendable {
    public let agent: String
    public let process: String
    public let labels: [String]
    public let command: [String]
    /// The file that will run: the command resolved through PATH with every symlink followed.
    public let executable: String

    /// The text of the approval prompt: everything the human needs to decide, never a value.
    public var summary: String {
        "give \(agent) the secrets \(labels.joined(separator: ", ")) to run:\n\(Commands.display(command))\n"
            + "File: \(executable)\n\nRequested by \(process)."
    }
}

/// A command resolved before the approval: its absolute real path and an identity of that file (device, inode, size,
/// times, mode). The run goes ahead only if the same name still resolves to the same, unchanged file afterwards.
public struct ResolvedCommand: Equatable, Sendable {
    public let path: String
    public let fingerprint: String
    public init(path: String, fingerprint: String) { self.path = path; self.fingerprint = fingerprint }
}

public protocol CommandResolver {
    /// The command's absolute real path (PATH lookup, symlinks followed) and fingerprint; nil = not an executable file.
    func resolve(_ name: String) -> ResolvedCommand?
    /// Whether an interpreter's script argument is an existing file.
    func fileExists(_ path: String) -> Bool
}

public protocol HumanPrompts {
    /// The masked entry window with the label filled in. nil = cancelled.
    func askValue(label: String, replacing: Bool) -> Data?
    /// A native yes/no window.
    func confirm(title: String, message: String) -> Bool
    /// The run approval: one Touch ID / password prompt showing the request. nil = declined.
    func approveRun(_ request: RunRequest) -> Approval?
    /// Touch ID / password for an allowlist change. nil = declined.
    func authenticate(reason: String) -> Approval?
}

/// Runs the approved command in place of this process (execve). Returns only when it could not start it.
public protocol CommandExecutor {
    /// Runs the file at `path` with `argv` (argv[0] as typed). Returns only when it could not start it.
    func exec(path: String, argv: [String], extraEnvironment: [String: String]) -> SecretError
}

/// The audit log: one line per decision.
public protocol AuditSink {
    func append(_ line: String) throws
}

/// The caller as the process tree shows it.
public struct Caller: Equatable, Sendable {
    public let ancestors: [Ancestor]
    public let environment: [String: String]
    public init(ancestors: [Ancestor], environment: [String: String]) { self.ancestors = ancestors; self.environment = environment }

    public var runtime: String? { Agents.detect(ancestors: ancestors, environment: environment).runtime }
    /// Set when the process tree disagrees with itself (an argv name says one runtime, a nearer real executable another).
    public var conflict: String? { Agents.detect(ancestors: ancestors, environment: environment).conflict }

    /// `zsh (pid 42) under claude (pid 7)`: the parent, and the agent ancestor when there is one.
    public var description: String {
        guard let parent = ancestors.first else { return "unknown process" }
        var s = "\(parent.name) (pid \(parent.pid))"
        if let agent = ancestors.dropFirst().first(where: { Agents.detect(ancestors: [$0], environment: [:]).runtime != nil }) {
            s += " under \(agent.name) (pid \(agent.pid))"
        }
        return s
    }
}

public enum Commands {
    /// A command as one line a person can read: arguments with spaces or quotes are single-quoted.
    public static func display(_ argv: [String]) -> String {
        argv.map { a in
            if !a.isEmpty, a.allSatisfy({ $0.isLetter || $0.isNumber || "-_./=:,@%+".contains($0) }) { return a }
            return "'" + a.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }.joined(separator: " ")
    }
}
