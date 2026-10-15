import Foundation

// A test-only stdio bridge with no Keychain or network access. The root must be
// the disposable directory created by verify-configuration-browser.mjs.
final class NoCredentials: AccountCredentialStore {
    func load() throws -> AccountCredential? { nil }
    func save(_ value: AccountCredential) throws { throw AccountError("disabled", "Test login is disabled.") }
    func delete() throws {}
}
struct NoNetwork: AccountTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        fatalError("Settings browser tests must never make account requests")
    }
}
guard CommandLine.arguments.count == 2, CommandLine.arguments[1].contains("conpera-settings-browser-") else { fatalError("Expected isolated root") }
let home = URL(fileURLWithPath: CommandLine.arguments[1])
let account = AccountClient(credentials: NoCredentials(), transport: NoNetwork(), openBrowser: { _ in false })
let runtime = SwitchRuntime(account: account, configuration: ConfigurationManager(home: home))
Task {
    while let line = readLine() {
        guard let value = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let action = value["action"] as? String, let payload = value["payload"] as? [String: Any] else { fatalError("Invalid fixture request") }
        let reply = await runtime.handle(action: action, payload: payload)
        let data = try JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }
    exit(0)
}
RunLoop.main.run()
