import AppKit
import WebKit

// The packaged UI is the only trusted bridge caller. Account credentials and
// configuration secrets remain in native code, outside the web view.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private enum MainWindowLayout: String { case welcome, dashboard, settings }
    private var server: LocalDemoServer?
    private var mainWindow: NSWindow?
    private var mainWebView: WKWebView?
    private var authorizationWindows: [NSWindow] = []
    private var origin: URL?
    private var mainWindowLayout: MainWindowLayout?
    #if SWITCH_NATIVE
    private let runtime = SwitchRuntime()
    #if SWITCH_UPDATER
    private lazy var softwareUpdater = ApplicationUpdater(runtime: runtime)
    #endif
    #endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .aqua)
        installMenus()
        guard let resources = Bundle.main.resourceURL else {
            fail("无法找到应用资源，请重新构建 Conpera Switch。"); return
        }
        #if SWITCH_NATIVE
        let service = LocalDemoServer(resourceRoot: resources.appendingPathComponent("web"), demoEnabled: false)
        #else
        let service = LocalDemoServer(resourceRoot: resources.appendingPathComponent("web"))
        #endif
        server = service
        service.start { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch result {
                case .success(let url):
                    self.origin = url
                    self.showMainWindow(url: url)
                case .failure(let error):
                    self.fail("本地界面服务未能启动。\n\(error.localizedDescription)")
                }
            }
        }
    }

    private func installMenus() {
        let bar = NSMenu()
        let appItem = NSMenuItem()
        bar.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 Conpera Switch", action: #selector(showAbout), keyEquivalent: "").target = self
        #if SWITCH_NATIVE
        #if SWITCH_UPDATER
        appMenu.addItem(withTitle: "检查更新…", action: #selector(checkSoftwareUpdates), keyEquivalent: "").target = self
        #endif
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "恢复 Codex 原机配置", action: #selector(restoreCodex), keyEquivalent: "").target = self
        appMenu.addItem(withTitle: "恢复 Claude Code 原机配置", action: #selector(restoreClaude), keyEquivalent: "").target = self
        #endif
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Conpera Switch", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Conpera Switch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        bar.addItem(editItem)

        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "刷新窗口", action: #selector(reloadDemo), keyEquivalent: "r").target = self
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        bar.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = bar
    }

    private func configure(_ webView: WKWebView) {
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.underPageBackgroundColor = NSColor(calibratedWhite: 0.973, alpha: 1)
    }

    private func makeWindow(title: String, size: NSSize, minimum: NSSize) -> NSWindow {
        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 900)
        let actual = NSSize(width: min(size.width, frame.width - 40), height: min(size.height, frame.height - 60))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: actual), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedWhite: 0.973, alpha: 1)
        window.minSize = minimum
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        return window
    }

    private func showMainWindow(url: URL) {
        let configuration = WKWebViewConfiguration()
        // The embedded UI has no shared browser cookies or persistent web storage.
        configuration.websiteDataStore = .nonPersistent()
        #if SWITCH_NATIVE
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        #if SWITCH_BETA
        configuration.applicationNameForUserAgent = "ConperaSwitchMac/\(version) ConperaSwitchBeta/\(version)"
        let title = "Conpera Switch — Beta"
        #else
        configuration.applicationNameForUserAgent = "ConperaSwitchMac/\(version) ConperaSwitchNative/\(version)"
        let title = "Conpera Switch"
        #endif
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "switch")
        #else
        configuration.applicationNameForUserAgent = "ConperaSwitchMac/0.1"
        let title = "Conpera Switch — 本地演示"
        #endif
        configuration.userContentController.add(self, name: "windowLayout")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        configure(webView)
        let window = makeWindow(title: title, size: NSSize(width: 540, height: 540), minimum: NSSize(width: 400, height: 400))
        window.contentView = webView
        mainWindow = window
        mainWebView = webView
        setMainWindowLayout(.welcome, animated: false)
        webView.load(URLRequest(url: url))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "windowLayout", message.webView === mainWebView,
              message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, isLocal(url), url.path == "/", url.query == nil,
              let origin,
              message.frameInfo.securityOrigin.protocol == origin.scheme,
              message.frameInfo.securityOrigin.host == origin.host,
              message.frameInfo.securityOrigin.port == origin.port,
              let value = message.body as? String, let layout = MainWindowLayout(rawValue: value) else { return }
        setMainWindowLayout(layout, animated: true)
    }

    private func setMainWindowLayout(_ layout: MainWindowLayout, animated: Bool) {
        guard let window = mainWindow, layout != mainWindowLayout else { return }
        mainWindowLayout = layout
        let visible = (window.screen ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1280, height: 900)
        let available = visible.insetBy(dx: 20, dy: 20)
        let titlebarHeight = window.frame.height - window.contentRect(forFrameRect: window.frame).height
        let maximum = NSSize(width: available.width, height: available.height - titlebarHeight)
        let contentSize: NSSize
        let minimum: NSSize
        switch layout {
        case .welcome:
            let side = min(540, maximum.width, maximum.height)
            contentSize = NSSize(width: side, height: side)
            let minimumSide = min(400, side)
            minimum = NSSize(width: minimumSide, height: minimumSide)
        case .settings:
            contentSize = NSSize(width: min(880, maximum.width), height: min(740, maximum.height))
            minimum = NSSize(width: min(480, contentSize.width), height: min(500, contentSize.height))
        case .dashboard:
            contentSize = NSSize(width: min(1000, maximum.width), height: min(460, maximum.height))
            minimum = NSSize(width: min(880, contentSize.width), height: min(430, contentSize.height))
        }

        // Clear the previous layout's constraints before applying the new frame.
        window.contentAspectRatio = .zero
        window.contentMinSize = .zero
        var target = window.frameRect(forContentRect: NSRect(origin: .zero, size: contentSize))
        target.origin = NSPoint(
            x: min(max(window.frame.midX - target.width / 2, available.minX), available.maxX - target.width),
            y: min(max(window.frame.midY - target.height / 2, available.minY), available.maxY - target.height)
        )
        if animated && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.24
                window.animator().setFrame(target, display: true)
            }
        } else {
            window.setFrame(target, display: true)
        }
        window.contentMinSize = minimum
        if layout == .welcome { window.contentAspectRatio = NSSize(width: 1, height: 1) }
    }

    private func isLocal(_ url: URL) -> Bool {
        guard let origin = origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        decisionHandler(isLocal(url) || url.absoluteString == "about:blank" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        #if SWITCH_NATIVE
        return nil
        #else
        guard webView === mainWebView, authorizationWindows.isEmpty,
              let url = navigationAction.request.url,
              isLocal(url) || url.absoluteString == "about:blank" else { return nil }
        // Use WebKit's supplied configuration to preserve window.opener and the
        // shared, isolated cookie store for the PKCE demonstration.
        configuration.applicationNameForUserAgent = "ConperaSwitchMac/0.1"
        let popup = WKWebView(frame: .zero, configuration: configuration)
        configure(popup)
        let window = makeWindow(title: "连接 Conpera — 演示授权", size: NSSize(width: 480, height: 460), minimum: NSSize(width: 400, height: 460))
        window.contentView = popup
        authorizationWindows.append(window)
        window.makeKeyAndOrderFront(nil)
        return popup
        #endif
    }

    func webViewDidClose(_ webView: WKWebView) {
        authorizationWindows.first(where: { $0.contentView === webView })?.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if window === mainWindow { NSApp.terminate(nil) }
        authorizationWindows.removeAll(where: { $0 === window })
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        mainWebView?.configuration.userContentController.removeScriptMessageHandler(forName: "windowLayout")
        #if SWITCH_NATIVE
        mainWebView?.configuration.userContentController.removeScriptMessageHandler(forName: "switch", contentWorld: .page)
        #endif
        server?.stop()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow?.makeKeyAndOrderFront(nil)
        return true
    }

    @objc private func reloadDemo() { mainWebView?.reload() }
    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = "Conpera Switch"
        #if SWITCH_NATIVE
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        alert.informativeText = "macOS · \(version)\n\n连接您的 Conpera 账户。账户凭据保存在钥匙串；配置切换前备份原文件。修改后请重启 Codex / Claude Code。可随时从应用菜单恢复原机配置。\n\nCopyright © 2026 Conpera · MIT License"
        #else
        alert.informativeText = "macOS 原生应用 · 0.1.0 Demo\n\n白色界面、配置切换和账户授权流程演示。\n\n此版本使用模拟数据，不读取或修改 Claude / Codex 配置，不连接真实账户。关闭应用会清除演示会话与偏好。"
        #endif
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "无法打开 Conpera Switch"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }
}


#if SWITCH_NATIVE
extension AppDelegate: WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "switch", message.webView === mainWebView, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, isLocal(url), url.path == "/", url.query == nil,
              let origin, message.frameInfo.securityOrigin.protocol == origin.scheme,
              message.frameInfo.securityOrigin.host == origin.host,
              message.frameInfo.securityOrigin.port == origin.port,
              let body = message.body as? [String: Any], Set(body.keys) == ["action", "payload"],
              let action = body["action"] as? String, let payload = body["payload"] as? [String: Any] else {
            replyHandler(["ok": false, "error": ["status": 403, "code": "invalid_caller", "message": "请求来源无效。"]], nil)
            return
        }
        #if SWITCH_UPDATER
        if action == "checkForUpdates" {
            guard payload.isEmpty else {
                replyHandler(["ok": false, "error": ["status": 400, "code": "invalid_request", "message": "请求格式无效。"]], nil)
                return
            }
            Task { @MainActor in
                do {
                    try await softwareUpdater.check(configurationEditorOpen: mainWindowLayout == .settings)
                    replyHandler(["ok": true, "data": [:]], nil)
                } catch {
                    replyHandler(["ok": false, "error": ["status": 409, "code": "update_unavailable", "message": error.localizedDescription]], nil)
                }
            }
            return
        }
        #endif
        Task { @MainActor in replyHandler(await runtime.handle(action: action, payload: payload), nil) }
    }
    #if SWITCH_UPDATER
    @objc fileprivate func checkSoftwareUpdates() {
        Task { @MainActor in
            do { try await softwareUpdater.check(configurationEditorOpen: mainWindowLayout == .settings) }
            catch {
                let alert = NSAlert()
                alert.messageText = "暂时无法检查更新"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "好")
                if let mainWindow { alert.beginSheetModal(for: mainWindow, completionHandler: nil) }
            }
        }
    }
    #endif
    @objc fileprivate func restoreCodex() { restoreFromMenu("codex") }
    @objc fileprivate func restoreClaude() { restoreFromMenu("claude") }
    private func restoreFromMenu(_ tool: String) {
        Task { @MainActor in
            let result = await runtime.handle(action: "restore", payload: ["tool": tool])
            let alert = NSAlert()
            alert.messageText = result["ok"] as? Bool == true ? "原机配置已恢复" : "未能恢复配置"
            alert.informativeText = (result["error"] as? [String: Any])?["message"] as? String ?? "请重启对应客户端以读取配置。"
            alert.addButton(withTitle: "好")
            if let mainWindow { alert.beginSheetModal(for: mainWindow, completionHandler: nil) }
            mainWebView?.reload()
        }
    }
}
#endif

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
