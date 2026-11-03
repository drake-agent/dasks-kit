import Foundation
import XCTest
@testable import SecretCore

final class AgentDetectionTests: XCTestCase {
    /// A real executable beats an argv name; an argv name of the other runtime nearer than it is refused.
    func testArgvNameCannotOverrideTheRealRuntime() {
        let disguised = Ancestor(pid: 300, path: "/bin/bash", args: ["claude", "-c"])
        let codex = Ancestor(pid: 200, path: "/opt/bin/codex")
        let d = Agents.detect(ancestors: [Ancestor(pid: 400, path: "/bin/zsh"), disguised, codex], environment: [:])
        XCTAssertEqual(d.runtime, "codex")
        XCTAssertNotNil(d.conflict)
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(35).utf8), ["claude-code"])
        let tree = [Ancestor(pid: 400, path: "/bin/zsh"), disguised, codex]
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "node", "x.js"], ancestors: tree).code, "agent_mismatch")
        XCTAssertEqual(h.perform(["allow", "--label", "k", "--agent", "codex"], ancestors: tree).code, "human_only")
        XCTAssertEqual(h.prompts.calls, [])
        // Legit nesting: Claude Code started from a node-based Codex is claude-code, no conflict.
        let nested = Agents.detect(ancestors: [Ancestor(pid: 9, path: "/bin/zsh"), Ancestor(pid: 8, path: "/x/claude"),
                                               Ancestor(pid: 7, path: "/usr/bin/node", args: ["node", "/x/@openai/codex/bin/codex.js"])], environment: [:])
        XCTAssertEqual(nested.runtime, "claude-code")
        XCTAssertNil(nested.conflict)
    }
}
