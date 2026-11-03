import Foundation
import XCTest
@testable import SecretCore

final class InterpreterOptionTests: XCTestCase {
    var dir: URL!
    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("dsk-policy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for f in ["sync.py", "x.js", "app.rb", "tool.pl"] { try Data("x".utf8).write(to: dir.appendingPathComponent(f)) }
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }
    func p(_ f: String) -> String { dir.appendingPathComponent(f).path }
    func argv(_ s: String) -> [String] { s.split(separator: " ").map { String($0).replacingOccurrences(of: "@", with: dir.path + "/") } }

    /// An option's value is not the script; an inline flag anywhere before the script is refused.
    func testOptionValuesAreNotTakenForTheScript() {
        let refused = [
            "python3 -W ignore -c x", "python3 -Wignore -c x", "python3 -X dev -c x", "python3 -W ignore -Bc x",
            "node --require node:path -e x", "node -r node:path -e x", "node --require=x --eval x", "node -pe x", "node -ep x",
            "node --import x -p 1", "node --no-warnings -C dev -e x", "node --eval=x", "node --print=x",
            "ruby -I lib -e x", "perl -Ilib -e x", "perl -I lib -ne x", "php -d x=1 -r x", "lua -l mod -e x",
            "node --no-warnings not-a-file", "python3 -W ignore", "node -r x",
            "node --tls-cipher-list @x.js -e x", "node --some-new-opt @x.js -p x", "python3 -Z @sync.py -c x", "ruby -Q @app.rb -e x",
        ]
        for c in refused { XCTAssertNotNil(CommandPolicy.refusal(argv(c)), "should refuse: \(c)") }
        let allowed = [
            "python3 -W ignore @sync.py", "python3 -B @sync.py -c config", "python3 -m pytest -c x", "node -r dotenv/config @x.js",
            "node --require=dotenv/config --no-warnings @x.js -e", "node --conditions dev @x.js", "ruby -I lib @app.rb", "perl -Ilib @tool.pl",
        ]
        for c in allowed { XCTAssertNil(CommandPolicy.refusal(argv(c)), "should allow: \(c)") }
    }
}
