import AppKit
import LocalAuthentication
import SecretCore

/// The native windows: a masked entry field (NSSecureTextField), yes/no confirms, and the LocalAuthentication prompt
/// (Touch ID, or the login password when Touch ID is not there). Each runs on the main thread of this CLI process.
struct NativePrompts: HumanPrompts {
    private func app() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.activate(ignoringOtherApps: true)
    }

    func askValue(label: String, replacing: Bool) -> Data? {
        app()
        let alert = NSAlert()
        alert.messageText = replacing ? "New value for \(label)" : "Store a secret: \(label)"
        alert.informativeText = "Type or paste the value. It goes into your login Keychain and is never shown again. "
            + "Agents can use it only through dasks-secret run, after you approve each run."
        alert.addButton(withTitle: "Store")
        alert.addButton(withTitle: "Cancel")
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = label
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.window.level = .floating
        let answer = alert.runModal()
        let value = field.stringValue
        field.stringValue = ""
        guard answer == .alertFirstButtonReturn else { return nil }
        return Data(value.utf8)
    }

    func confirm(title: String, message: String) -> Bool {
        app()
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Continue")
        alert.window.level = .floating
        return alert.runModal() == .alertSecondButtonReturn
    }

    func approveRun(_ request: RunRequest) -> Approval? { authenticate(reason: request.summary) }

    func authenticate(reason: String) -> Approval? {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Deny"
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return nil }
        let done = DispatchSemaphore(value: 0)
        var ok = false
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
            ok = success
            done.signal()
        }
        done.wait()
        return ok ? Approval(context: ctx) : nil
    }
}
