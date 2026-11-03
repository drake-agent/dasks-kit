import Foundation
import SecretCore

// dasks-secret: secrets for coding agents on this Mac, kept in the login Keychain. docs/secrets.md
let environment = ProcessInfo.processInfo.environment
let commands = SecretCommands(
    store: KeychainStore(service: KeychainStore.service(environment: environment)),
    prompts: NativePrompts(),
    audit: FileAuditSink(path: FileAuditSink.defaultPath(environment: environment)),
    executor: ExecveExecutor(),
    resolver: RealResolver(),
    caller: Caller(ancestors: ProcessTree.ancestors(), environment: environment),
    out: { print($0) }
)

do {
    let status = try commands.perform(try Invocation.parse(Array(CommandLine.arguments.dropFirst())))
    exit(status)
} catch let e as SecretError {
    FileHandle.standardError.write(Data((e.line + "\n").utf8))
    if case .usage = e { FileHandle.standardError.write(Data((Invocation.usage + "\n").utf8)) }
    exit(e.exitCode)
} catch {
    FileHandle.standardError.write(Data("dasks-secret: internal_error\n".utf8))
    exit(1)
}
