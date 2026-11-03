import Foundation

/// One audit line (JSON): time, agent, process, labels, command, outcome. Built only from names and the command the
/// caller typed, never from a value.
public struct AuditEntry: Equatable, Sendable {
    public let time: Date
    public let action: String
    public let agent: String
    public let process: String
    public let labels: [String]
    public let command: [String]
    public let outcome: String

    public init(time: Date = Date(), action: String, agent: String, process: String, labels: [String], command: [String] = [], outcome: String) {
        self.time = time; self.action = action; self.agent = agent; self.process = process; self.labels = labels
        self.command = command; self.outcome = outcome
    }

    public var line: String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime]
        let cmd = Commands.display(command)
        let obj: [String: Any] = [
            "time": fmt.string(from: time), "action": action, "agent": agent, "process": process,
            "labels": labels, "command": cmd.count > 2000 ? String(cmd.prefix(2000)) + "…" : cmd, "outcome": outcome,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}

/// ~/.dasks/secret-audit.log (or $DASKS_HOME/secret-audit.log): appended, mode 0600, its folder 0700 when made here.
public struct FileAuditSink: AuditSink {
    public let path: String
    public init(path: String) { self.path = path }

    public static func defaultPath(environment: [String: String]) -> String {
        let home = environment["DASKS_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() + "/.dasks")
        return (home as NSString).appendingPathComponent("secret-audit.log")
    }

    public func append(_ line: String) throws {
        let dir = (path as NSString).deletingLastPathComponent
        if !FileManager.default.fileExists(atPath: dir) {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw SecretError.auditFailed }
        defer { close(fd) }
        guard fchmod(fd, 0o600) == 0 else { throw SecretError.auditFailed }
        let bytes = Array((line + "\n").utf8)
        guard bytes.withUnsafeBytes({ write(fd, $0.baseAddress, $0.count) }) == bytes.count else { throw SecretError.auditFailed }
    }
}
