import Foundation
import XCTest
@testable import SecretCore

final class LabelTests: XCTestCase {
    func testEnvNames() throws {
        XCTAssertEqual(Labels.envName("google-places-api-key"), "GOOGLE_PLACES_API_KEY")
        XCTAssertEqual(Labels.envName("stripe.test_key"), "STRIPE_TEST_KEY")
        XCTAssertEqual(Labels.envName("2fa-seed"), "_2FA_SEED")
        XCTAssertEqual(try Labels.envNames(["a-b", "c"]), ["a-b": "A_B", "c": "C"])
    }

    func testReservedAndClashingNamesAreRefused() {
        for l in ["path", "home", "node-options", "dyld-insert-libraries", "dasks-token", "ld-preload"] {
            XCTAssertThrowsError(try Labels.envNames([l]), l) { XCTAssertEqual(($0 as? SecretError)?.code, "invalid_env_name") }
        }
        XCTAssertThrowsError(try Labels.envNames(["a-b", "a.b"])) { XCTAssertEqual(($0 as? SecretError)?.code, "invalid_env_name") }
    }

    func testLabelRules() {
        XCTAssertTrue(Labels.isValid("google-places-api-key"))
        XCTAssertTrue(Labels.isValid("k0"))
        for bad in ["", "Bad", "-x", "a b", "a/b", String(repeating: "a", count: 90), "é"] { XCTAssertFalse(Labels.isValid(bad), bad) }
        XCTAssertThrowsError(try Labels.parseList("a,a"))
        XCTAssertThrowsError(try Labels.parseList((0...8).map { "k\($0)" }.joined(separator: ",")))
        XCTAssertEqual(try Labels.parseList("a, b"), ["a", "b"])
    }
}

final class CommandPolicyTests: XCTestCase {
    func refused(_ s: String) -> Bool { CommandPolicy.refusal(s.split(separator: " ").map(String.init)) != nil }

    func testRefused() {
        let cases = [
            "bash", "/bin/zsh -c x", "sh script.sh", "env", "/usr/bin/env FOO=1 node app.js", "printenv",
            "node", "node -e x", "node --eval=x", "node -p 1", "node -", "python3", "python3 -c x", "python3.12 -c x", "python -Bc x",
            "python3 -i app.py", "ruby -e x", "perl -ne x", "php -r x", "deno eval x", "bun -e x", "awk {print}",
            "curl https://x", "/usr/bin/curl -d x", "wget x", "nc host 80", "ssh host", "gh api x", "scp a b",
            "sudo make", "xargs echo", "nohup make", "timeout 5 make", "osascript -e x", "open -a x", "security find-generic-password",
            "git push", "git -C repo push origin", "git -c a=b push", "npm publish", "pnpm publish", "yarn npm publish",
            "cargo publish", "docker push img", "twine upload dist", "npx something", "BASH", "/BIN/SH", "fish", "ksh", "tcsh",
        ]
        for c in cases { XCTAssertTrue(refused(c), "should refuse: \(c)") }
    }

    func testAllowed() {
        let cases = [
            "node scripts/fetch.js", "node --no-warnings scripts/x.mjs -e", "python3 tools/sync.py -c config", "python3 -m pytest",
            "npm test", "npm run build", "make deploy-check", "git status", "git commit -m x", "./scripts/check.sh", "swift build",
            "deno run app.ts", "pytest -q", "cargo test", "docker build .",
        ]
        for c in cases { XCTAssertNil(CommandPolicy.refusal(c.split(separator: " ").map(String.init), fileExists: { _ in true }), "should allow: \(c)") }
    }
}

final class AgentTests: XCTestCase {
    func testRuntimeFromProcessTree() {
        let shell = Ancestor(pid: 9, path: "/bin/zsh")
        XCTAssertEqual(Agents.runtime(ancestors: [shell, Ancestor(pid: 8, path: "/opt/x/bin/claude")], environment: [:]), "claude-code")
        XCTAssertEqual(Agents.runtime(ancestors: [shell, Ancestor(pid: 8, path: "/opt/x/bin/codex")], environment: [:]), "codex")
        XCTAssertEqual(Agents.runtime(ancestors: [shell, Ancestor(pid: 8, path: "/usr/local/bin/node", args: ["node", "/usr/local/bin/claude"])], environment: [:]), "claude-code")
        XCTAssertEqual(Agents.runtime(ancestors: [shell, Ancestor(pid: 8, path: "/usr/local/bin/node", args: ["node", "/x/node_modules/@openai/codex/bin/codex.js"])], environment: [:]), "codex")
        XCTAssertNil(Agents.runtime(ancestors: [shell, Ancestor(pid: 8, path: "/Applications/Terminal.app/Contents/MacOS/Terminal")], environment: [:]))
        XCTAssertEqual(Agents.runtime(ancestors: [shell], environment: ["CLAUDECODE": "1"]), "claude-code", "env fills in when the tree shows nothing")
        XCTAssertEqual(Agents.runtime(ancestors: [Ancestor(pid: 3, path: "/x/codex"), Ancestor(pid: 2, path: "/x/claude")], environment: [:]), "codex", "the nearest agent wins")
    }

    func testDeclaredAgent() throws {
        XCTAssertEqual(try Agents.resolve(declared: nil, runtime: "claude-code"), "claude-code")
        XCTAssertEqual(try Agents.resolve(declared: nil, runtime: nil), "human")
        XCTAssertEqual(try Agents.resolve(declared: "claude-code.review", runtime: "claude-code"), "claude-code.review")
        XCTAssertThrowsError(try Agents.resolve(declared: "codex", runtime: "claude-code")) { XCTAssertEqual(($0 as? SecretError)?.code, "agent_mismatch") }
        XCTAssertThrowsError(try Agents.resolve(declared: "human", runtime: "claude-code")) { XCTAssertEqual(($0 as? SecretError)?.code, "invalid_agent") }
        XCTAssertThrowsError(try Agents.resolve(declared: "someone", runtime: nil)) { XCTAssertEqual(($0 as? SecretError)?.code, "invalid_agent") }
        XCTAssertEqual(try Agents.resolve(declared: "codex", runtime: nil), "codex", "the human may act as an agent (only adds rules)")
    }
}

final class InvocationTests: XCTestCase {
    func code(_ args: [String]) -> String? {
        do { _ = try Invocation.parse(args); return nil } catch { return (error as? SecretError)?.code }
    }

    func testValuesAreNeverTakenFromArgvOrStdin() {
        let v = fakeValue(1)
        XCTAssertEqual(code(["store", "--label", "k", "--value", v]), "value_not_accepted")
        XCTAssertEqual(code(["store", "--label", "k", v]), "value_not_accepted")
        XCTAssertEqual(code(["store", "--label", "k", "-"]), "value_not_accepted", "- (stdin) is refused")
        XCTAssertEqual(code(["store", "--label", "k", "--stdin"]), "value_not_accepted")
        XCTAssertEqual(code(["store", "--label=k", "--from-clipboard"]), "value_not_accepted")
        XCTAssertEqual(try Invocation.parse(["store", "--label", "k"]), .store(label: "k", replace: false))
        XCTAssertEqual(try Invocation.parse(["store", "--label=k", "--replace"]), .store(label: "k", replace: true))
        for sub in ["show", "reveal", "get", "install", "rotate", "backup", "recover"] { XCTAssertEqual(code([sub, "--label", "k"]), "usage", sub) }
    }

    func testStoreNeverReadsStdin() {
        // The value comes only from the masked window; stdin holding a value changes nothing.
        let h = Harness()
        h.prompts.typed = fakeValue(2)
        let pipe = Pipe()
        pipe.fileHandleForWriting.write(Data(fakeValue(3).utf8))
        XCTAssertEqual(try h.perform(["store", "--label", "k"]).get(), 0)
        XCTAssertEqual(h.store.items["k"]?.value, Data(fakeValue(2).utf8))
        XCTAssertEqual(h.prompts.calls, ["ask:k"])
    }

    func testRunParsing() throws {
        XCTAssertEqual(try Invocation.parse(["run", "--labels", "a,b", "--", "node", "x.js"]), .run(labels: ["a", "b"], agent: nil, command: ["node", "x.js"]))
        XCTAssertEqual(code(["run", "--labels", "a", "node", "x.js"]), "usage", "-- is required")
        XCTAssertEqual(code(["run", "--labels", "a", "--"]), "usage")
        XCTAssertEqual(code(["run", "--labels", "Bad", "--", "x"]), "invalid_label")
    }
}

final class RunTests: XCTestCase {
    func testAllowedAgentRunsWithValuesInEnvAfterOneApproval() throws {
        let h = Harness()
        let v = fakeValue(4)
        h.store.items["google-places-api-key"] = (Data(v.utf8), ["claude-code"])
        let r = h.perform(["run", "--labels", "google-places-api-key", "--", "node", "scripts/places.js", "--city", "Seoul"])
        XCTAssertEqual(r.code, "exec_failed", "the fake executor returns, the real one never does")
        XCTAssertEqual(h.exec.argv, ["node", "scripts/places.js", "--city", "Seoul"])
        XCTAssertEqual(h.exec.env, ["GOOGLE_PLACES_API_KEY": v])
        XCTAssertEqual(h.prompts.calls, ["approve"])
        let req = try XCTUnwrap(h.prompts.lastRequest)
        XCTAssertEqual(req.agent, "claude-code")
        XCTAssertTrue(req.process.contains("zsh (pid 4242)") && req.process.contains("claude (pid 100)"), req.process)
        XCTAssertTrue(req.summary.contains("node scripts/places.js --city Seoul"))
        XCTAssertFalse(req.summary.contains(v))
        XCTAssertTrue(h.output.isEmpty, "run prints nothing else")
    }

    func testNotOnTheAllowlistIsRefusedBeforeAnyPrompt() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(5).utf8), ["codex"])
        let r = h.perform(["run", "--labels", "k", "--", "node", "x.js"])
        XCTAssertEqual(r.code, "agent_not_allowed")
        if case .failure(let e) = r { XCTAssertTrue(e.detail.contains("dasks-secret allow --label k --agent claude-code")) }
        XCTAssertEqual(h.prompts.calls, [])
        XCTAssertEqual(h.store.reads, 0)
        XCTAssertNil(h.exec.argv)
    }

    func testLaneMustBeOnTheListItself() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(6).utf8), ["claude-code"])
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--agent", "claude-code.review", "--", "node", "x.js"]).code, "agent_not_allowed")
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--agent", "codex", "--", "node", "x.js"]).code, "agent_mismatch")
        XCTAssertEqual(h.prompts.calls, [])
    }

    func testRefusedCommandsForAgentsOnly() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(7).utf8), ["claude-code"])
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "printenv"]).code, "refused_command")
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "git", "push"]).code, "refused_command")
        XCTAssertEqual(h.prompts.calls, [], "refused before any prompt")
        // The human's own terminal: no refusal list, no allowlist, still one approval.
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "printenv"], agentAncestor: nil).code, "exec_failed")
        XCTAssertEqual(h.prompts.calls, ["approve"])
        XCTAssertEqual(h.prompts.lastRequest?.agent, "human")
    }

    func testMissingLabelOpensTheStoreWindowThenStops() {
        let h = Harness()
        h.prompts.typed = fakeValue(8)
        let r = h.perform(["run", "--labels", "new-key", "--", "node", "x.js"])
        XCTAssertEqual(r.code, "label_missing")
        XCTAssertEqual(h.prompts.calls, ["ask:new-key"])
        XCTAssertEqual(h.store.items["new-key"]?.value, Data(fakeValue(8).utf8), "the human stored it in the window")
        XCTAssertEqual(h.store.items["new-key"]?.agents, [], "storing never allows an agent")
        XCTAssertNil(h.exec.argv)
    }

    func testDeclinedApprovalRunsNothing() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(9).utf8), ["claude-code"])
        h.prompts.approve = false
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "node", "x.js"]).code, "user_cancelled")
        XCTAssertNil(h.exec.argv)
        XCTAssertEqual(h.store.reads, 0)
    }

    func testNoAuditNoRun() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(10).utf8), ["claude-code"])
        h.audit.broken = true
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "node", "x.js"]).code, "audit_failed")
        XCTAssertNil(h.exec.argv)
    }

    func testAuditLinesNeverHoldAValue() throws {
        let h = Harness()
        let v = fakeValue(11)
        h.store.items["k"] = (Data(v.utf8), ["claude-code"])
        _ = h.perform(["run", "--labels", "k", "--", "node", "x.js"])
        _ = h.perform(["run", "--labels", "k", "--", "curl", "x"])
        h.prompts.typed = fakeValue(12)
        _ = h.perform(["store", "--label", "k2"], agentAncestor: nil)
        XCTAssertGreaterThanOrEqual(h.audit.lines.count, 3)
        for line in h.audit.lines {
            XCTAssertFalse(line.contains(v) || line.contains(fakeValue(12)), line)
            let j = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            for key in ["time", "agent", "process", "labels", "command", "outcome"] { XCTAssertNotNil(j[key], key) }
        }
        let first = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(h.audit.lines[0].utf8)) as? [String: Any])
        XCTAssertEqual(first["outcome"] as? String, "approved")
        XCTAssertEqual(first["command"] as? String, "node x.js")
        XCTAssertEqual(first["agent"] as? String, "claude-code")
    }

    func testAuditFileIsPrivate() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dasks-secret-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let sink = FileAuditSink(path: dir.appendingPathComponent("secret-audit.log").path)
        try sink.append("{\"a\":1}")
        try sink.append("{\"a\":2}")
        let attrs = try FileManager.default.attributesOfItem(atPath: sink.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(try String(contentsOfFile: sink.path, encoding: .utf8), "{\"a\":1}\n{\"a\":2}\n")
    }
}

final class AllowlistTests: XCTestCase {
    func testAgentsCannotChangeTheList() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(13).utf8), [])
        XCTAssertEqual(h.perform(["allow", "--label", "k", "--agent", "claude-code"]).code, "human_only")
        XCTAssertEqual(h.perform(["disallow", "--label", "k", "--agent", "claude-code"], agentAncestor: "codex").code, "human_only")
        XCTAssertEqual(h.prompts.calls, [])
        XCTAssertEqual(h.store.items["k"]?.agents, [])
    }

    func testHumanAllowAndDisallowNeedTouchID() throws {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(14).utf8), [])
        XCTAssertEqual(try h.perform(["allow", "--label", "k", "--agent", "codex"], agentAncestor: nil).get(), 0)
        XCTAssertEqual(try h.perform(["allow", "--label", "k", "--agent", "claude-code"], agentAncestor: nil).get(), 0)
        XCTAssertEqual(h.store.items["k"]?.agents, ["claude-code", "codex"])
        XCTAssertEqual(h.prompts.calls, ["auth", "auth"])
        XCTAssertEqual(try h.perform(["disallow", "--label", "k", "--agent", "codex"], agentAncestor: nil).get(), 0)
        XCTAssertEqual(h.store.items["k"]?.agents, ["claude-code"])
        h.prompts.approve = false
        XCTAssertEqual(h.perform(["allow", "--label", "k", "--agent", "codex"], agentAncestor: nil).code, "user_cancelled")
        XCTAssertEqual(h.store.items["k"]?.agents, ["claude-code"])
        XCTAssertEqual(h.perform(["allow", "--label", "k", "--agent", "human"], agentAncestor: nil).code, "invalid_agent")
        XCTAssertEqual(h.perform(["allow", "--label", "nope", "--agent", "codex"], agentAncestor: nil).code, "label_missing")
    }

    func testCheckAndListShowNamesOnlyWithoutAPrompt() throws {
        let h = Harness()
        let v = fakeValue(15)
        h.store.items["a"] = (Data(v.utf8), ["claude-code"])
        h.store.items["b"] = (Data(v.utf8), [])
        XCTAssertEqual(try h.perform(["check", "--labels", "a,b,c", "--agent", "claude-code"]).get(), 10)
        XCTAssertEqual(h.output, ["a stored allowed", "b stored not_allowed", "c missing not_allowed"])
        XCTAssertEqual(try h.perform(["check", "--labels", "a", "--agent", "claude-code", "--json"]).get(), 0)
        let j = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(h.output.last!.utf8)) as? [String: Any])
        XCTAssertEqual(j["ready"] as? Bool, true)
        XCTAssertEqual(try h.perform(["list"]).get(), 0)
        XCTAssertEqual(Array(h.output.suffix(2)), ["a agents=claude-code", "b agents=-"])
        XCTAssertEqual(h.prompts.calls, [])
        XCTAssertEqual(h.store.reads, 0)
        XCTAssertFalse(h.output.joined().contains(v))
    }

    func testStoreReplaceAndDeleteNeedANativeConfirm() throws {
        let h = Harness()
        h.prompts.typed = fakeValue(16)
        XCTAssertEqual(try h.perform(["store", "--label", "k"], agentAncestor: nil).get(), 0)
        XCTAssertEqual(h.perform(["store", "--label", "k"], agentAncestor: nil).code, "label_exists")
        h.store.items["k"]?.agents = ["codex"]
        h.prompts.typed = fakeValue(17)
        h.prompts.confirmAnswer = false
        XCTAssertEqual(h.perform(["store", "--label", "k", "--replace"], agentAncestor: nil).code, "user_cancelled")
        XCTAssertEqual(h.store.items["k"]?.value, Data(fakeValue(16).utf8))
        h.prompts.confirmAnswer = true
        XCTAssertEqual(try h.perform(["store", "--label", "k", "--replace"], agentAncestor: nil).get(), 0)
        XCTAssertEqual(h.store.items["k"]?.value, Data(fakeValue(17).utf8))
        XCTAssertEqual(h.store.items["k"]?.agents, ["codex"], "a replace keeps the agents")
        h.prompts.typed = ""
        XCTAssertEqual(h.perform(["store", "--label", "e"], agentAncestor: nil).code, "empty_value")
        XCTAssertEqual(try h.perform(["delete", "--label", "k"], agentAncestor: nil).get(), 0)
        XCTAssertNil(h.store.items["k"])
        XCTAssertEqual(h.perform(["delete", "--label", "k"], agentAncestor: nil).code, "label_missing")
    }
}
