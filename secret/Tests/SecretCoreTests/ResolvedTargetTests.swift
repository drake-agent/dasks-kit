import Foundation
import XCTest
@testable import SecretCore

final class ResolvedTargetTests: XCTestCase {
    /// The refusal check looks at the file the command really is, not only the name typed.
    func testASymlinkToARefusedToolIsRefused() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(31).utf8), ["claude-code"])
        h.resolver.table["./safe"] = ResolvedCommand(path: "/usr/bin/printenv", fingerprint: "1")
        let r = h.perform(["run", "--labels", "k", "--", "./safe"])
        XCTAssertEqual(r.code, "refused_command")
        if case .failure(let e) = r { XCTAssertTrue(e.detail.contains("./safe is /usr/bin/printenv"), e.detail) }
        XCTAssertEqual(h.prompts.calls, [])
    }

    /// The prompt names the resolved file and the exec uses that exact path.
    func testPromptShowsAndExecUsesTheResolvedFile() throws {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(32).utf8), ["claude-code"])
        h.resolver.table["tool"] = ResolvedCommand(path: "/opt/tools/libexec/tool-1.2", fingerprint: "a")
        _ = h.perform(["run", "--labels", "k", "--", "tool", "--go"])
        XCTAssertEqual(h.prompts.lastRequest?.executable, "/opt/tools/libexec/tool-1.2")
        XCTAssertTrue(try XCTUnwrap(h.prompts.lastRequest?.summary).contains("File: /opt/tools/libexec/tool-1.2"))
        XCTAssertEqual(h.exec.path, "/opt/tools/libexec/tool-1.2")
        XCTAssertEqual(h.exec.argv, ["tool", "--go"])
    }

    /// A file swapped or edited while the prompt was open is not run.
    func testATargetChangedDuringTheApprovalIsNotRun() {
        for change in [ResolvedCommand(path: "/usr/bin/tool", fingerprint: "edited"), ResolvedCommand(path: "/tmp/other", fingerprint: "1")] {
            let h = Harness()
            h.store.items["k"] = (Data(fakeValue(33).utf8), ["claude-code"])
            h.resolver.table["tool"] = ResolvedCommand(path: "/usr/bin/tool", fingerprint: "1")
            h.prompts.onApprove = { h.resolver.table["tool"] = change }
            XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "tool"]).code, "target_changed")
            XCTAssertNil(h.exec.argv)
        }
    }

    /// An interpreter script that is not a file is refused (the run's resolver decides what exists).
    func testInterpreterScriptMustExist() {
        let h = Harness()
        h.store.items["k"] = (Data(fakeValue(34).utf8), ["claude-code"])
        h.resolver.missing = ["ignore"]
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "python3", "-W", "ignore"]).code, "refused_command")
        XCTAssertEqual(h.perform(["run", "--labels", "k", "--", "node", "-r", "x", "-pe", "1"]).code, "refused_command")
        XCTAssertEqual(h.prompts.calls, [])
    }
}
