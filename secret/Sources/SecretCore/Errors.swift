/// Every failure is a short, stable code (printed as `dasks-secret: <code>[: detail]`) and an exit status.
/// Scripts and agents match the code; the detail is for people and never holds a value.
public enum SecretError: Error, Equatable, Sendable {
    case usage(String)
    case valueNotAccepted
    case invalidLabel(String)
    case invalidAgent(String)
    case invalidEnvName(String)
    case agentMismatch(String)
    case humanOnly
    case refusedCommand(String)
    case agentNotAllowed(String)
    case labelMissing(String)
    case labelExists(String)
    case emptyValue
    case userCancelled
    case keychain(String)
    case auditFailed
    case execFailed(String)
    case targetChanged(String)

    public var code: String {
        switch self {
        case .usage: return "usage"
        case .valueNotAccepted: return "value_not_accepted"
        case .invalidLabel: return "invalid_label"
        case .invalidAgent: return "invalid_agent"
        case .invalidEnvName: return "invalid_env_name"
        case .agentMismatch: return "agent_mismatch"
        case .humanOnly: return "human_only"
        case .refusedCommand: return "refused_command"
        case .agentNotAllowed: return "agent_not_allowed"
        case .labelMissing: return "label_missing"
        case .labelExists: return "label_exists"
        case .emptyValue: return "empty_value"
        case .userCancelled: return "user_cancelled"
        case .keychain: return "keychain_error"
        case .auditFailed: return "audit_failed"
        case .execFailed: return "exec_failed"
        case .targetChanged: return "target_changed"
        }
    }

    public var detail: String {
        switch self {
        case .usage(let s): return s
        case .valueNotAccepted: return "values are typed only into the native window (never argv, stdin, env or the clipboard)"
        case .invalidLabel(let s): return "\(s): labels are a-z 0-9 . _ - (first a-z or 0-9), at most 89 characters"
        case .invalidAgent(let s): return "\(s): an agent is claude-code or codex, optionally with a lane (claude-code.review)"
        case .invalidEnvName(let s): return s
        case .agentMismatch(let s): return s
        case .humanOnly: return "allow and disallow are for the human, in their own terminal; agents print the command for them"
        case .refusedCommand(let s): return s
        case .agentNotAllowed(let s): return s
        case .labelMissing(let s): return s
        case .labelExists(let s): return "\(s) is already stored; use --replace to replace it"
        case .emptyValue: return "nothing was typed"
        case .userCancelled: return "the human declined or closed the window"
        case .keychain(let s): return s
        case .auditFailed: return "the audit log could not be written, so nothing ran"
        case .execFailed(let s): return s
        case .targetChanged(let s): return s
        }
    }

    public var exitCode: Int32 {
        switch self {
        case .usage, .valueNotAccepted, .invalidLabel, .invalidAgent, .invalidEnvName: return 2
        case .agentMismatch, .humanOnly, .refusedCommand, .agentNotAllowed: return 3
        case .labelMissing: return 4
        case .userCancelled: return 5
        case .labelExists, .emptyValue: return 6
        case .keychain, .auditFailed, .execFailed, .targetChanged: return 1
        }
    }

    public var line: String { detail.isEmpty ? "dasks-secret: \(code)" : "dasks-secret: \(code): \(detail)" }
}
