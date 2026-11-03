import Foundation

/// How each interpreter takes its options, so the policy finds the real script instead of an option's value.
/// An agent may run an interpreter only on a script file that exists (or `python -m module`); an inline program
/// (`-e`, `-c`, `-p`, `--eval`, …) anywhere before the script, stdin (`-`), no script at all, or a "script" that is not a
/// file here is refused. So is an option it does not know: it may take a value, and then the next argument could be read
/// as the script while a later inline flag runs (`--some-opt file.js -e …`). Known flags without a value are listed.
struct InterpreterSpec {
    var inlineShort: Set<Character> = []
    /// Takes a value: the rest of the cluster (`-Wignore`) or the next argument (`-W ignore`).
    var valueShort: Set<Character> = []
    /// Takes a value only when attached (`ruby -i.bak`); alone it takes nothing.
    var attachedShort: Set<Character> = []
    /// Flags that take no value.
    var flagShort: Set<Character> = []
    var flagLong: Set<String> = []
    /// `-m module`: what follows is a module and its arguments.
    var moduleShort: Set<Character> = []
    /// `php -f file`: the value is the script.
    var scriptShort: Set<Character> = []
    var inlineLong: Set<String> = []
    var valueLong: Set<String> = []
    /// First words that are subcommands and fine (`swift build`), or that run code inline (`deno eval`).
    var allowedSubcommands: Set<String> = []
    var refusedSubcommands: Set<String> = []
    /// Only the allowed subcommands (deno): anything else is refused.
    var subcommandsOnly = false
    var alwaysInline = false

    func refusal(_ args: [String], fileExists: (String) -> Bool) -> String? {
        if alwaysInline { return "runs a program given inline" }
        guard let first = args.first else { return "with no script opens an interactive session" }
        if refusedSubcommands.contains(first) { return "\(first) runs code given inline" }
        if allowedSubcommands.contains(first) { return args.contains("-") ? "reads its program from stdin" : nil }
        if subcommandsOnly { return "\(first) is not a subcommand it may run" }
        var i = 0
        while i < args.count {
            let a = args[i]
            if a == "-" { return "reads its program from stdin" }
            if a == "--" { return script(i + 1 < args.count ? args[i + 1] : nil, fileExists) }
            if a.hasPrefix("--") {
                let parts = a.split(separator: "=", maxSplits: 1).map(String.init)
                if inlineLong.contains(parts[0]) { return "\(parts[0]) runs code given inline" }
                if parts.count == 1, !valueLong.contains(parts[0]), !flagLong.contains(parts[0]) { return unknown(parts[0]) }
                i += valueLong.contains(parts[0]) && parts.count == 1 ? 2 : 1
                continue
            }
            if a.hasPrefix("-"), a.count > 1 {
                switch cluster(Array(a.dropFirst())) {
                case .inline(let c): return "-\(c) runs code given inline"
                case .unknown(let c): return unknown("-\(c)")
                case .module: return nil
                case .script(let attached): return script(attached ?? (i + 1 < args.count ? args[i + 1] : nil), fileExists)
                case .takesNext: i += 2
                case .done: i += 1
                }
                continue
            }
            return script(a, fileExists)
        }
        return "with no script opens an interactive session"
    }

    private enum Cluster { case inline(Character), unknown(Character), module, script(String?), takesNext, done }

    private func unknown(_ opt: String) -> String {
        "has an option it does not know (\(opt)); it may take a value, so the script cannot be told apart: put it after the script or write --opt=value"
    }

    /// One `-abc` token, letter by letter: an inline letter refuses, a value letter ends the cluster.
    private func cluster(_ letters: [Character]) -> Cluster {
        for (k, c) in letters.enumerated() {
            let rest = String(letters[(k + 1)...])
            if inlineShort.contains(c) { return .inline(c) }
            if moduleShort.contains(c) { return .module }
            if scriptShort.contains(c) { return .script(rest.isEmpty ? nil : rest) }
            if valueShort.contains(c) { return rest.isEmpty ? .takesNext : .done }
            if attachedShort.contains(c) { return .done }
            if !flagShort.contains(c) { return .unknown(c) }
        }
        return .done
    }

    private func script(_ s: String?, _ fileExists: (String) -> Bool) -> String? {
        guard let s, !s.isEmpty else { return "with no script opens an interactive session" }
        if s == "-" { return "reads its program from stdin" }
        return fileExists(s) ? nil : "runs \(s), which is not a script file here (an inline program or an option value?)"
    }
}

enum Interpreters {
    static let node = InterpreterSpec(
        inlineShort: ["e", "p", "i"], valueShort: ["r", "C"], flagShort: ["c", "v", "h"],
        flagLong: ["--no-warnings", "--trace-warnings", "--enable-source-maps", "--test", "--watch", "--inspect", "--inspect-brk",
                   "--inspect-wait", "--trace-uncaught", "--trace-deprecation", "--throw-deprecation", "--no-deprecation",
                   "--pending-deprecation", "--expose-gc", "--abort-on-uncaught-exception", "--preserve-symlinks",
                   "--preserve-symlinks-main", "--experimental-strip-types", "--experimental-transform-types",
                   "--no-experimental-strip-types", "--experimental-vm-modules", "--frozen-intrinsics", "--check",
                   "--experimental-test-coverage", "--test-only", "--version", "--help", "--no-addons", "--use-strict"],
        inlineLong: ["--eval", "--print", "--interactive"],
        valueLong: ["--require", "--import", "--loader", "--experimental-loader", "--conditions", "--input-type", "--env-file",
                    "--env-file-if-exists", "--inspect-port", "--title", "--watch-path", "--icu-data-dir", "--openssl-config",
                    "--redirect-warnings", "--report-dir", "--report-filename", "--diagnostic-dir", "--disable-warning",
                    "--secure-heap", "--stack-trace-limit", "--unhandled-rejections", "--experimental-default-type", "--dns-result-order"])
    static let python = InterpreterSpec(inlineShort: ["c", "i"], valueShort: ["W", "X", "Q"],
                                       flagShort: ["b", "B", "d", "E", "h", "I", "O", "q", "s", "S", "u", "v", "V", "x", "P", "R"],
                                       flagLong: ["--version", "--help"], moduleShort: ["m"], valueLong: ["--check-hash-based-pycs"])
    static let table: [String: InterpreterSpec] = [
        "node": node, "nodejs": node,
        "bun": { var b = node; b.allowedSubcommands = ["run", "test", "build", "install", "add", "remove"]; b.refusedSubcommands = ["repl", "x"]; return b }(),
        "python": python, "pypy": python, "ipython": python,
        "ruby": InterpreterSpec(inlineShort: ["e"], valueShort: ["I", "r", "C", "E", "F"], attachedShort: ["i", "x", "0", "K", "W", "T"],
                              flagShort: ["w", "v", "d", "c", "y", "s", "S", "U", "a", "l", "n", "p"], flagLong: ["--verbose", "--version", "--help"]),
        "perl": InterpreterSpec(inlineShort: ["e", "E"], valueShort: ["I", "M", "m"], attachedShort: ["x", "0", "l", "i", "d", "C", "D"],
                              flagShort: ["w", "W", "X", "T", "t", "s", "S", "n", "p", "a", "c", "U", "v"]),
        "php": InterpreterSpec(inlineShort: ["r", "a", "R", "B", "E", "F"], valueShort: ["d", "c", "z", "t"], flagShort: ["n", "q", "H", "l"], scriptShort: ["f"]),
        "lua": InterpreterSpec(inlineShort: ["e", "i"], valueShort: ["l"], flagShort: ["v", "W", "E"]),
        "luajit": InterpreterSpec(inlineShort: ["e", "i"], valueShort: ["l", "j", "O", "b"], flagShort: ["v", "E"]),
        "rscript": InterpreterSpec(inlineShort: ["e"], flagLong: ["--vanilla", "--no-save", "--no-restore", "--quiet", "--silent", "--slave", "--no-environ", "--no-site-file", "--no-init-file", "--verbose", "--version", "--help"], valueLong: ["--default-packages"]),
        "r": InterpreterSpec(inlineShort: ["e"], flagShort: ["q", "s"], flagLong: ["--vanilla", "--no-save", "--no-restore", "--quiet", "--silent", "--slave", "--no-environ", "--no-site-file", "--no-init-file", "--verbose", "--version", "--help"], scriptShort: ["f"]),
        "swift": InterpreterSpec(inlineShort: ["e"], allowedSubcommands: ["build", "test", "run", "package"], refusedSubcommands: ["repl"]),
        "deno": InterpreterSpec(allowedSubcommands: ["run", "test", "task", "fmt", "lint", "check", "compile", "bench", "cache", "info", "doc"],
                                refusedSubcommands: ["eval", "repl"], subcommandsOnly: true),
        "irb": InterpreterSpec(alwaysInline: true), "tclsh": InterpreterSpec(alwaysInline: true), "wish": InterpreterSpec(alwaysInline: true),
        "awk": InterpreterSpec(alwaysInline: true), "gawk": InterpreterSpec(alwaysInline: true), "mawk": InterpreterSpec(alwaysInline: true),
        "nawk": InterpreterSpec(alwaysInline: true), "jshell": InterpreterSpec(alwaysInline: true),
    ]

    /// `python3.12` -> python, `pypy3` -> pypy, `node22` -> node.
    static func spec(for name: String) -> InterpreterSpec? {
        if let s = table[name] { return s }
        let trimmed = name.trimmingCharacters(in: CharacterSet(charactersIn: "0123456789.-"))
        return trimmed != name ? table[trimmed] : nil
    }
}
