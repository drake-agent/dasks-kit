import Foundation

/// Commands an agent may not run with secrets in their environment. A speed bump against the easy ways to print or send
/// a value (a shell, `env`, an inline script, a network tool, a wrapper that hides the real command, a push or publish),
/// not a sandbox: an approved script can still do any of these itself (docs/secrets.md).
public enum CommandPolicy {
    /// Shells: every short name ending in "sh" (sh, bash, zsh, ksh, csh, tcsh, fish, …) and a few others.
    static let shells: Set<String> = ["nu", "pwsh", "xonsh", "elvish", "login", "rc", "es"]
    static func isShell(_ name: String) -> Bool {
        if shells.contains(name) { return true }
        return name.hasSuffix("sh") && name.count <= 5 && name.allSatisfy { $0.isLetter && $0.isASCII }
    }
    static let envDumpers: Set<String> = ["env", "printenv", "export", "set", "declare", "typeset"]
    static let network: Set<String> = ["curl", "wget", "nc", "ncat", "netcat", "socat", "ssh", "scp", "sftp", "rsync", "telnet", "ftp", "gh", "openssl", "http", "https", "xh"]
    static let wrappers: Set<String> = [
        "sudo", "doas", "su", "xargs", "nohup", "timeout", "gtimeout", "nice", "renice", "time", "exec", "command", "builtin",
        "eval", "caffeinate", "watch", "parallel", "stdbuf", "unbuffer", "arch", "chroot", "setsid", "launchctl", "at",
        "batch", "screen", "tmux", "script", "expect", "osascript", "open", "security", "find", "sandbox-exec", "flock",
    ]
    /// `<tool> <subcommand>` pairs that publish or push.
    static let publishing: [String: Set<String>] = [
        "npm": ["publish", "unpublish", "deprecate", "dist-tag", "exec", "x"], "pnpm": ["publish", "dlx", "exec"], "yarn": ["publish", "npm", "dlx"],
        "cargo": ["publish", "login", "owner", "yank"], "gem": ["push", "owner", "yank"], "twine": ["upload", "register"],
        "poetry": ["publish"], "flit": ["publish"], "hatch": ["publish"], "uv": ["publish"], "docker": ["push", "login"],
        "podman": ["push", "login"], "pod": ["trunk"], "vsce": ["publish"], "ovsx": ["publish"], "dotnet": ["nuget"],
        "mvn": ["deploy"], "gradle": ["publish"], "firebase": ["deploy"], "vercel": ["deploy"], "netlify": ["deploy"],
        "fly": ["deploy"], "flyctl": ["deploy"], "heroku": ["config:set"], "wrangler": ["deploy", "publish", "secret"],
    ]
    static let gitRefused: Set<String> = ["push", "send-email", "request-pull", "remote", "config", "credential", "submodule"]
    static let npxLike: Set<String> = ["npx", "pnpx", "bunx", "uvx", "pipx"]

    /// nil = allowed; otherwise the reason it is refused. `realPath` is where the command resolves (symlinks followed):
    /// both the typed name and the real file's name must pass. `fileExists` says whether an interpreter's script is a file.
    public static func refusal(_ argv: [String], realPath: String? = nil,
                               fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> String? {
        guard let first = argv.first, !first.isEmpty else { return "no command" }
        var names = [normalized(first)]
        if let realPath, normalized(realPath) != names[0] { names.append(normalized(realPath)) }
        let rest = Array(argv.dropFirst())
        for name in names {
            if let why = refusal(name: name, rest: rest, fileExists: fileExists) {
                return names.count > 1 && name == names[1] ? "\(first) is \(realPath!): \(why)" : why
            }
        }
        return nil
    }

    static func refusal(name: String, rest: [String], fileExists: (String) -> Bool) -> String? {
        if isShell(name) { return "\(name) is a shell" }
        if envDumpers.contains(name) { return "\(name) prints the environment" }
        if network.contains(name) { return "\(name) talks to the network" }
        if wrappers.contains(name) { return "\(name) wraps or hides another command" }
        if npxLike.contains(name) { return "\(name) downloads and runs a package" }
        if let spec = Interpreters.spec(for: name), let why = spec.refusal(rest, fileExists: fileExists) { return "\(name) \(why)" }
        if name == "git", let sub = gitSubcommand(rest), gitRefused.contains(sub) { return "git \(sub) is refused" }
        if let subs = publishing[name], let sub = firstWord(rest), subs.contains(sub) { return "\(name) \(sub) publishes or pushes" }
        if name == "swift", let sub = firstWord(rest), sub == "package-registry" { return "swift package-registry publishes" }
        return nil
    }

    /// Lower-cased basename (macOS file names are case-insensitive), so `/bin/BASH` is `bash`.
    static func normalized(_ s: String) -> String { (s as NSString).lastPathComponent.lowercased() }

    /// The git subcommand after global options (`git -C dir -c k=v push` -> push).
    static func gitSubcommand(_ args: [String]) -> String? {
        var i = 0
        while i < args.count {
            let a = args[i]
            if ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].contains(a) { i += 2; continue }
            if a.hasPrefix("-") { i += 1; continue }
            return a.lowercased()
        }
        return nil
    }

    static func firstWord(_ args: [String]) -> String? { args.first { !$0.hasPrefix("-") }?.lowercased() }
}
