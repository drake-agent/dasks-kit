import Foundation
import XCTest
@testable import SecretCore
@testable import dasks_secret

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

/// The real resolver (PATH lookup, realpath, stat) on files in a fresh temp directory, so a fingerprint that stops
/// seeing changes, or a path that keeps a symlink, fails here and not only in the field.
final class RealResolverTests: XCTestCase {
    private var dir = ""

    override func setUpWithError() throws {
        dir = NSTemporaryDirectory() + "dasks-secret-real-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: false)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(atPath: dir) }

    private func executable(_ name: String, _ body: String) throws -> String {
        let p = dir + "/" + name
        try Data("#!/bin/sh\n\(body)\n".utf8).write(to: URL(fileURLWithPath: p))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: p)
        return p
    }

    /// Appends in place: same inode, a different size, so the change shows on any filesystem without waiting for the clock.
    private func editInPlace(_ path: String) throws {
        let h = try XCTUnwrap(FileHandle(forWritingAtPath: path))
        h.seekToEndOfFile()
        h.write(Data("echo swapped\n".utf8))
        try h.close()
    }

    /// realpath(3) of a path, independent of the resolver: the temp directory itself sits behind /var -> /private/var.
    private func real(_ path: String) throws -> String {
        let r = try XCTUnwrap(realpath(path, nil))
        defer { free(r) }
        return String(cString: r)
    }

    // Real case: an agent edits the binary in place while the Touch ID prompt is open.
    func testAnExecutableEditedInPlaceNoLongerMatches() throws {
        let tool = try executable("tool", "exit 0")
        let before = try XCTUnwrap(RealResolver().resolve(tool))
        XCTAssertEqual(before.path, try real(tool))
        XCTAssertEqual(RealResolver().resolve(tool), before, "an unchanged file resolves the same")
        try editInPlace(tool)
        let after = try XCTUnwrap(RealResolver().resolve(tool))
        XCTAssertEqual(after.path, before.path)
        XCTAssertNotEqual(after.fingerprint, before.fingerprint)
        XCTAssertNotEqual(after, before)
    }

    // Real case: an agent points the symlink on PATH at another binary while the Touch ID prompt is open.
    func testARetargetedSymlinkResolvesToTheNewRealFile() throws {
        let a = try executable("a", "exit 0")
        let b = try executable("b", "echo other; exit 0")
        let link = dir + "/link"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: a)
        let before = try XCTUnwrap(RealResolver().resolve(link))
        XCTAssertEqual(before.path, try real(a))
        try FileManager.default.removeItem(atPath: link)
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: b)
        let after = try XCTUnwrap(RealResolver().resolve(link))
        XCTAssertEqual(after.path, try real(b))
        XCTAssertNotEqual(after, before)
    }

    // Real case: the approval was for one file; while the prompt was open an agent edited it, then retargeted the symlink.
    func testRunRefusesAFileChangedDuringTheApproval() throws {
        let a = try executable("a", "exit 0")
        let b = try executable("b", "echo other; exit 0")
        let link = dir + "/link"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: a)
        let changes: [(String, () throws -> Void)] = [
            (a, { try self.editInPlace(a) }),
            (link, { try FileManager.default.removeItem(atPath: link); try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: b) }),
        ]
        for (name, change) in changes {
            var h = Harness()
            h.commandResolver = RealResolver()
            h.store.items["k"] = (Data(fakeValue(35).utf8), ["claude-code"])
            var changeError: Error?
            h.prompts.onApprove = { do { try change() } catch { changeError = error } }
            let r = h.perform(["run", "--labels", "k", "--", name])
            XCTAssertNil(changeError)
            XCTAssertEqual(h.prompts.calls, ["approve"], name)
            XCTAssertEqual(r.code, "target_changed", name)
            XCTAssertNil(h.exec.argv, name)
        }
    }
}
