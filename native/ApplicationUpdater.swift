import AppKit
import Sparkle

/// Sparkle owns version comparison, signed downloads, installation and relaunch.
/// The runtime lease prevents account/configuration writes during an update.
@MainActor final class ApplicationUpdater: NSObject, SPUUpdaterDelegate {
    private let runtime: SwitchRuntime
    private var controller: SPUStandardUpdaterController?
    private var starting = false
    private var ownsLease = false

    init(runtime: SwitchRuntime) { self.runtime = runtime }

    func check(configurationEditorOpen: Bool) async throws {
        guard !configurationEditorOpen else {
            throw AccountError("configuration_editor_open", "请先保存或关闭配置编辑，再检查更新。", status: 409)
        }
        guard !starting else { throw AccountError("operation_in_progress", "正在打开更新窗口，请稍候。", status: 409) }
        if let controller, controller.updater.sessionInProgress {
            guard controller.updater.canCheckForUpdates else {
                throw AccountError("operation_in_progress", "更新正在处理，请在更新窗口中继续。", status: 409)
            }
            controller.checkForUpdates(nil)
            return
        }
        starting = true
        defer { starting = false }
        try await runtime.beginSoftwareUpdate()
        ownsLease = true
        do {
            if controller == nil {
                let next = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
                try next.updater.start()
                controller = next
            }
            guard let controller, controller.updater.canCheckForUpdates else {
                throw AccountError("updater_unavailable", "更新组件暂未就绪，请重试。", status: 503)
            }
            controller.checkForUpdates(nil)
        } catch {
            ownsLease = false
            await runtime.endSoftwareUpdate()
            if let error = error as? AccountError { throw error }
            throw AccountError("updater_unavailable", "更新组件未能启动，请重新打开应用后重试。", status: 503)
        }
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        guard ownsLease else { return }
        ownsLease = false
        // Clear the native lease before allowing another check to acquire it.
        starting = true
        Task { @MainActor in
            await runtime.endSoftwareUpdate()
            starting = false
        }
    }
}
