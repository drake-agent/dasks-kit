import Foundation

/// The parsed command line. Values never come through here: `store` refuses every argument it does not know, so a value
/// pasted as an argument (`--value x`, a bare word, `-` for stdin) is an error, and nothing ever reads stdin.
public enum Invocation: Equatable, Sendable {
    case store(label: String, replace: Bool)
    case run(labels: [String], agent: String?, command: [String])
    case allow(label: String, agent: String)
    case disallow(label: String, agent: String)
    case list(json: Bool)
    case check(labels: [String], agent: String?, json: Bool)
    case delete(label: String)
    case help

    public static let usage = """
    dasks-secret: secrets for coding agents, kept in your login Keychain (docs/secrets.md)
      dasks-secret store --label L [--replace]      type the value into a native masked window
      dasks-secret run --labels a,b [--agent NAME] -- <command> [args…]
                                                    one Touch ID / password approval, then the command runs with
                                                    each value in an env var (google-api-key -> GOOGLE_API_KEY)
      dasks-secret allow --label L --agent A        let an agent use L through run (human only, Touch ID)
      dasks-secret disallow --label L --agent A     take that back (human only, Touch ID)
      dasks-secret list [--json]                    labels and their agents; never values
      dasks-secret check --labels a,b [--agent A] [--json]   stored / allowed, no prompt; exit 10 when not ready
      dasks-secret delete --label L                 remove L after a native confirm
    Values are never accepted as arguments, from stdin, the environment or the clipboard.
    """

    public static func parse(_ args: [String]) throws -> Invocation {
        guard let sub = args.first else { return .help }
        let rest = Array(args.dropFirst())
        switch sub {
        case "-h", "--help", "help": return .help
        case "store":
            let o = try Options(rest, known: ["--label"], flags: ["--replace"], unknownIsValue: true)
            return .store(label: try o.label(), replace: o.flag("--replace"))
        case "run":
            guard let sep = rest.firstIndex(of: "--") else { throw SecretError.usage("run needs -- before the command") }
            let o = try Options(Array(rest[..<sep]), known: ["--labels", "--agent"], flags: [])
            let command = Array(rest[(sep + 1)...])
            guard !command.isEmpty, !command[0].isEmpty else { throw SecretError.usage("run needs a command after --") }
            return .run(labels: try Labels.parseList(try o.required("--labels")), agent: o.value("--agent"), command: command)
        case "allow", "disallow":
            let o = try Options(rest, known: ["--label", "--agent"], flags: [])
            let label = try o.label(), agent = try o.required("--agent")
            return sub == "allow" ? .allow(label: label, agent: agent) : .disallow(label: label, agent: agent)
        case "list":
            let o = try Options(rest, known: [], flags: ["--json"])
            return .list(json: o.flag("--json"))
        case "check":
            let o = try Options(rest, known: ["--labels", "--agent"], flags: ["--json"])
            return .check(labels: try Labels.parseList(try o.required("--labels")), agent: o.value("--agent"), json: o.flag("--json"))
        case "delete":
            let o = try Options(rest, known: ["--label"], flags: [])
            return .delete(label: try o.label())
        case "show", "reveal", "get", "print", "export", "install", "rotate", "recover", "backup":
            throw SecretError.usage("\(sub) does not exist: values never leave the Keychain except into a run")
        default:
            throw SecretError.usage("unknown command \(sub) (dasks-secret --help)")
        }
    }
}

/// `--name value`, `--name=value` and bare flags; anything else is refused.
struct Options {
    private var values: [String: String] = [:]
    private var flags: Set<String> = []

    init(_ args: [String], known: Set<String>, flags allowed: Set<String>, unknownIsValue: Bool = false) throws {
        let bad: (String) -> SecretError = { unknownIsValue ? .valueNotAccepted : .usage("unexpected argument \($0)") }
        var i = 0
        while i < args.count {
            let a = args[i]
            if allowed.contains(a) { flags.insert(a); i += 1; continue }
            let parts = a.split(separator: "=", maxSplits: 1).map(String.init)
            if parts.count == 2, known.contains(parts[0]) {
                guard values[parts[0]] == nil else { throw SecretError.usage("\(parts[0]) given twice") }
                values[parts[0]] = parts[1]; i += 1; continue
            }
            if known.contains(a) {
                guard i + 1 < args.count, !args[i + 1].hasPrefix("--") else { throw SecretError.usage("\(a) needs a value") }
                guard values[a] == nil else { throw SecretError.usage("\(a) given twice") }
                values[a] = args[i + 1]; i += 2; continue
            }
            throw bad(a)
        }
    }

    func flag(_ name: String) -> Bool { flags.contains(name) }
    func value(_ name: String) -> String? { values[name] }
    func required(_ name: String) throws -> String {
        guard let v = values[name], !v.isEmpty else { throw SecretError.usage("\(name) is required") }
        return v
    }
    func label() throws -> String {
        let l = try required("--label")
        guard Labels.isValid(l) else { throw SecretError.invalidLabel(l) }
        return l
    }
}
