// swift-tools-version: 5.9
// dasks-secret: local secrets for coding agents (docs/secrets.md). SecretCore is the logic (no Keychain, no UI);
// the dasks-secret executable adds the login Keychain, the native windows and Touch ID.
import PackageDescription

let package = Package(
    name: "dasks-secret",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "dasks-secret", targets: ["dasks-secret"])],
    targets: [
        .target(name: "SecretCore"),
        .executableTarget(name: "dasks-secret", dependencies: ["SecretCore"]),
        .testTarget(name: "SecretCoreTests", dependencies: ["SecretCore"]),
    ]
)
