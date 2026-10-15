import AppKit
import Sparkle

// Isolated integration application. No Keychain, account requests or real CLI
// configuration can be accessed. Only the local fixture feed uses the network.
final class NoCredentials: AccountCredentialStore {
    func load() throws -> AccountCredential? { nil }
    func save(_ credential: AccountCredential) throws { fatalError("Unexpected credential write") }
    func delete() throws {}
}
struct NoNetwork: AccountTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { fatalError("Unexpected account request") }
}
let fixtureRoot = URL(fileURLWithPath: try String(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("fixture-root.txt"), encoding: .utf8))
guard fixtureRoot.path.contains("conpera-updater-fixture-") else { fatalError("Unsafe fixture root") }
@MainActor final class UpdateTestDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let runtime = SwitchRuntime(account: AccountClient(credentials: NoCredentials(), transport: NoNetwork(), openBrowser: { _ in false }), configuration: ConfigurationManager(home: fixtureRoot))
    private lazy var updater = ApplicationUpdater(runtime: runtime)
    func applicationDidFinishLaunching(_ notification: Notification) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as! String
        try! Data(version.utf8).write(to: fixtureRoot.appendingPathComponent("launched-version.txt"))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Conpera 更新测试"
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "隔离更新测试 · \(version)\n不读取账户、钥匙串或真实配置")
        label.frame = NSRect(x: 28, y: 90, width: 360, height: 55)
        window.contentView!.addSubview(label)
        let button = NSButton(title: "检查更新", target: self, action: #selector(check))
        button.frame = NSRect(x: 140, y: 30, width: 140, height: 32)
        window.contentView!.addSubview(button)
        window.center(); window.makeKeyAndOrderFront(nil)
        let menu = NSMenu(), item = NSMenuItem(), appMenu = NSMenu()
        menu.addItem(item); item.submenu = appMenu
        appMenu.addItem(withTitle: "退出测试", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func check() {
        Task { @MainActor in
            do { try await updater.check(configurationEditorOpen: false) }
            catch {
                let alert = NSAlert(); alert.messageText = error.localizedDescription
                alert.addButton(withTitle: "好"); alert.runModal()
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = MainActor.assumeIsolated { UpdateTestDelegate() }
app.delegate = delegate
app.run()
