import Foundation

/// Label names (the same rule as a card's `secrets` field) and the environment variable each one becomes.
public enum Labels {
    public static let maxPerRun = 8

    /// `^[a-z0-9][a-z0-9._-]{0,88}$`
    public static func isValid(_ label: String) -> Bool {
        let bytes = Array(label.utf8)
        guard (1...89).contains(bytes.count) else { return false }
        let lowerOrDigit: (UInt8) -> Bool = { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) }
        guard lowerOrDigit(bytes[0]) else { return false }
        return bytes.allSatisfy { lowerOrDigit($0) || $0 == 0x2e || $0 == 0x5f || $0 == 0x2d }
    }

    /// `google-places-api-key` -> `GOOGLE_PLACES_API_KEY`: upper case, `.` and `-` become `_`, and a leading digit gets
    /// a `_` in front (a shell name cannot start with one).
    public static func envName(_ label: String) -> String {
        var name = String(label.uppercased().map { $0 == "-" || $0 == "." ? "_" : $0 })
        if let first = name.first, first.isNumber { name = "_" + name }
        return name
    }

    /// Variables a value must never become: names a shell, loader or common tool reads as its own setting. Such a tool
    /// may change what runs or print the setting back (git prints a bad GIT_TRACE, Python a bad PYTHONWARNINGS), so a
    /// value there could leak. A rule by prefix covers the families; exact names cover the rest.
    static let reservedPrefixes = [
        "GIT_", "PYTHON", "NODE_", "NPM_CONFIG_", "YARN_", "PNPM_", "BUN_", "DENO_", "LD_", "DYLD_", "BASH", "ZSH", "KSH",
        "PS1", "PS2", "PS3", "PS4", "PERL", "RUBY", "GEM_", "BUNDLE_", "JAVA_", "_JAVA_", "JDK_", "MAVEN_", "GRADLE_",
        "DASKS_", "SSH_", "GPG_", "GNUPG", "LC_", "MALLOC_", "XDG_", "TERM", "HIST", "PROMPT_", "LESS", "MANPAGER", "GCONV_",
        "SSL_", "CURL_", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "CLAUDE", "CODEX", "ANTHROPIC_LOG", "OPENSSL_",
    ]
    static let reserved: Set<String> = [
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "SHELLOPTS", "TMPDIR", "PWD", "OLDPWD", "IFS", "ENV", "CDPATH", "FPATH",
        "EDITOR", "VISUAL", "PAGER", "LANG", "LANGUAGE", "TZ", "DISPLAY", "COLUMNS", "LINES", "OPTIND", "OPTARG", "PPID",
        "RUSTFLAGS", "RUST_LOG", "RUST_BACKTRACE", "CARGO_HOME", "GOFLAGS", "GOPATH", "GODEBUG", "CFLAGS", "LDFLAGS",
        "CC", "CXX", "MAKEFLAGS", "DEBUG", "NODE", "NPM", "SUDO_ASKPASS", "VERBOSE", "TRACE",
    ]

    public static func isReservedEnv(_ name: String) -> Bool {
        reserved.contains(name) || reservedPrefixes.contains { name.hasPrefix($0) }
    }

    /// Refuses a label whose variable is reserved (at `store` as well as at `run`).
    public static func checkEnvName(_ label: String) throws {
        let n = envName(label)
        if isReservedEnv(n) { throw SecretError.invalidEnvName("\(label) would set \(n), which tools read as a setting; choose another label") }
    }

    /// Parses `a,b` into labels: each valid, no duplicates, 1...8 of them, distinct and allowed variable names.
    public static func parseList(_ raw: String) throws -> [String] {
        let labels = raw.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard !labels.isEmpty, labels.allSatisfy({ !$0.isEmpty }) else { throw SecretError.usage("--labels takes a,b (names only)") }
        for l in labels where !isValid(l) { throw SecretError.invalidLabel(l) }
        guard labels.count <= maxPerRun else { throw SecretError.usage("at most \(maxPerRun) labels at once") }
        guard Set(labels).count == labels.count else { throw SecretError.usage("a label is named twice") }
        return labels
    }

    /// The variable names for a run: refused when two labels map to one name or a name is reserved.
    public static func envNames(_ labels: [String]) throws -> [String: String] {
        var out: [String: String] = [:]
        var seen: [String: String] = [:]
        for l in labels {
            let n = envName(l)
            try checkEnvName(l)
            if let other = seen[n] { throw SecretError.invalidEnvName("\(other) and \(l) both become \(n)") }
            seen[n] = l
            out[l] = n
        }
        return out
    }
}
