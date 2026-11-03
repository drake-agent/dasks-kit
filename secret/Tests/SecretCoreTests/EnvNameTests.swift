import Foundation
import XCTest
@testable import SecretCore

final class EnvNameTests: XCTestCase {
    /// A value must never land in a variable a common tool reads as its own setting (and may echo, e.g. GIT_TRACE).
    func testToolInterpretedEnvNamesAreRefused() {
        let labels = [
            "git-trace", "git-trace-packet", "git-askpass", "pythonwarnings", "python-startup", "node-debug", "npm-config-loglevel",
            "bash-env", "bash-func-x", "ps4", "shellopts", "bashopts", "perl5db", "perllib", "rubyopt", "java-tool-options",
            "jdk-java-options", "ld-debug", "dyld-print-libraries", "ssh-askpass", "lc-all", "prompt-command", "malloc-logfile",
        ]
        for l in labels {
            XCTAssertThrowsError(try Labels.envNames([l]), l) { XCTAssertEqual(($0 as? SecretError)?.code, "invalid_env_name", l) }
        }
        for ok in ["google-places-api-key", "github-token", "npm-token", "openai-api-key", "cargo-registry-token", "stripe-key"] {
            XCTAssertNoThrow(try Labels.envNames([ok]), ok)
        }
    }

    /// `store` refuses such a label too, before any window opens.
    func testStoreRefusesAToolInterpretedLabel() {
        let h = Harness()
        h.prompts.typed = fakeValue(30)
        XCTAssertEqual(h.perform(["store", "--label", "git-trace"], agentAncestor: nil).code, "invalid_env_name")
        XCTAssertEqual(h.prompts.calls, [])
        XCTAssertNil(h.store.items["git-trace"])
    }
}
