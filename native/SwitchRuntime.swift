import Foundation

/// The only account/configuration interface exposed to bundled JavaScript.
/// Credential-bearing dictionaries stay inside this actor and never become
/// bridge responses. A mutation lease covers suspension during remote requests.
actor SwitchRuntime {
    private let account: AccountClient
    private let configuration: ConfigurationManager?
    private let configurationFailure: AccountError?
    private var mutation: String?

    init(account: AccountClient = AccountClient(), configuration: ConfigurationManager? = nil,
         environment: [String: String] = ProcessInfo.processInfo.environment,
         home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.account = account
        if let configuration {
            self.configuration = configuration
            configurationFailure = nil
        } else {
            do {
                let codex = try Self.directory(environment["CODEX_HOME"])
                let claude = try Self.directory(environment["CLAUDE_CONFIG_DIR"])
                guard home.isFileURL, home.path.hasPrefix("/") else { throw Self.invalidDirectory() }
                self.configuration = ConfigurationManager(home: home, codexDirectory: codex, claudeDirectory: claude)
                configurationFailure = nil
            } catch {
                self.configuration = nil
                configurationFailure = Self.invalidDirectory()
            }
        }
    }

    func handle(action: String, payload: [String: Any]) async -> [String: Any] {
        do { return ["ok": true, "data": try await dispatch(action: action, payload: payload)] }
        catch let error as AccountError {
            return Self.failure(error.status ?? Self.status(for: error.code), error.code, error.message)
        } catch let error as ConfigurationManager.Failure {
            return Self.failure(error.status, error.code, error.message)
        } catch {
            // File system and transport diagnostics may contain private paths or
            // secrets; only source-defined safe failures cross the bridge.
            return Self.failure(500, "internal_error", "操作未能完成，请重试。")
        }
    }

    private func dispatch(action: String, payload: [String: Any]) async throws -> [String: Any] {
        let noPayload = Set(["session", "login", "cancelLogin", "balance", "keys", "status", "logout"])
        if noPayload.contains(action), !payload.isEmpty { throw Self.invalidRequest() }
        switch action {
        case "session": return try await account.session()
        case "balance": return try await account.balance()
        case "keys": return try await account.keys()
        case "status": return try Self.publicStatus(manager().status())
        case "configurationDetails", "undoConfiguration":
            let expected: Set<String> = action == "configurationDetails" ? ["tool"] : ["tool", "revision"]
            guard Set(payload.keys) == expected, let tool = payload["tool"] as? String,
                  ["codex", "claude"].contains(tool) else { throw Self.invalidRequest() }
            try begin(action)
            defer { mutation = nil }
            if action == "configurationDetails" { return try manager().configurationDetails(tool: tool) }
            guard let revision = payload["revision"] as? String, revision.utf8.count == 64 else { throw Self.invalidRequest() }
            return try manager().undoConfiguration(tool: tool, revision: revision)
        case "previewConfiguration", "saveConfiguration":
            let expected: Set<String> = action == "previewConfiguration" ? ["tool", "content", "updates"] : ["tool", "content", "revision"]
            guard Set(payload.keys) == expected, let tool = payload["tool"] as? String,
                  ["codex", "claude"].contains(tool), let content = payload["content"] as? String,
                  content.utf8.count <= ConfigurationDocument.maximumSize else { throw Self.invalidRequest() }
            try begin(action)
            defer { mutation = nil }
            if action == "previewConfiguration" {
                guard let updates = payload["updates"] as? [String: String] else { throw Self.invalidRequest() }
                let next = try ConfigurationDocument.updating(content, tool: tool, updates: updates)
                return ["content": next, "fields": try ConfigurationDocument.fields(next, tool: tool)]
            }
            guard let revision = payload["revision"] as? String, revision.utf8.count == 64 else { throw Self.invalidRequest() }
            return try manager().saveConfiguration(tool: tool, revision: revision, content: content)
        case "cancelLogin":
            if let mutation, mutation != "login" { throw Self.busy() }
            await account.cancelLogin()
            return [:]
        case "login":
            try begin(action)
            defer { mutation = nil }
            return try await account.login()
        case "logout":
            try begin(action)
            defer { mutation = nil }
            try await account.logout()
            return [:]
        case "changeChannel":
            guard Set(payload.keys) == Set(["tool", "keyId", "channelId", "expectedChannelId"]),
                  let tool = payload["tool"] as? String, let keyId = payload["keyId"] as? String,
                  let channelId = payload["channelId"] as? String, let expectedChannelId = payload["expectedChannelId"] as? String else { throw Self.invalidRequest() }
            try begin(action)
            defer { mutation = nil }
            return try await account.changeChannel(tool: tool, keyId: keyId, channelId: channelId, expectedChannelId: expectedChannelId)
        case "apply":
            guard Set(payload.keys) == Set(["tool", "keyId"]),
                  let tool = payload["tool"] as? String, ["codex", "claude"].contains(tool),
                  let keyId = payload["keyId"] as? String, !keyId.isEmpty,
                  keyId.utf8.count <= 256,
                  keyId.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else { throw Self.invalidRequest() }
            try begin(action)
            defer { mutation = nil }
            let manager = try manager()
            let grant = try await account.configuration(tool: tool, keyId: keyId)
            guard let apiKey = grant["apiKey"] as? String, let baseURL = grant["baseUrl"] as? String else {
                throw AccountError("invalid_response", "账户服务返回了无效响应，请稍后重试。")
            }
            return try Self.publicStatus(manager.apply(tool: tool, keyId: keyId, apiKey: apiKey,
                                                      baseURL: baseURL, model: grant["model"] as? String))
        case "restore":
            guard Set(payload.keys) == Set(["tool"]), let tool = payload["tool"] as? String,
                  ["codex", "claude"].contains(tool) else { throw Self.invalidRequest() }
            try begin(action)
            defer { mutation = nil }
            return try Self.publicStatus(manager().restore(tool: tool))
        default: throw Self.invalidRequest()
        }
    }

    // Native-only entry points: web callers cannot acquire or release this lease.
    func beginSoftwareUpdate() throws { try begin("softwareUpdate") }
    func endSoftwareUpdate() { if mutation == "softwareUpdate" { mutation = nil } }

    private func begin(_ action: String) throws {
        guard mutation == nil else { throw Self.busy() }
        mutation = action
    }
    private func manager() throws -> ConfigurationManager {
        if let configurationFailure { throw configurationFailure }
        guard let configuration else { throw Self.invalidDirectory() }
        return configuration
    }
    private static func publicStatus(_ result: [String: Any]) throws -> [String: Any] {
        guard let tools = result["tools"] as? [String: Any] else { throw invalidResponse() }
        var projected: [String: Any] = [:]
        for tool in ["codex", "claude"] {
            guard let value = tools[tool] as? [String: Any], let mode = value["mode"] as? String,
                  ["original", "conpera", "conflict"].contains(mode) else { throw invalidResponse() }
            var status: [String: Any] = ["mode": mode]
            if let keyId = value["keyId"] as? String { status["keyId"] = keyId }
            projected[tool] = status
        }
        return ["tools": projected, "restartRequired": true,
                "notice": "配置写入后请重启客户端。项目配置、受管理配置或启动环境可能覆盖用户配置。"]
    }
    private static func directory(_ value: String?) throws -> URL? {
        guard let value else { return nil }
        guard value.hasPrefix("/"), value != "/",
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !value.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else {
            throw invalidDirectory()
        }
        return URL(fileURLWithPath: value, isDirectory: true)
    }
    private static func failure(_ status: Int, _ code: String, _ message: String) -> [String: Any] {
        ["ok": false, "error": ["status": status, "code": code, "message": message]]
    }
    private static func status(for code: String) -> Int {
        switch code {
        case "unauthenticated": return 401
        case "forbidden", "access_denied": return 403
        case "cancelled": return 499
        case "login_timeout": return 408
        case "operation_in_progress", "login_in_progress": return 409
        case "invalid_request", "invalid_directory": return 400
        case "network_error", "service_unavailable": return 503
        default: return 500
        }
    }
    private static func invalidRequest() -> AccountError { AccountError("invalid_request", "请求格式无效。", status: 400) }
    private static func invalidDirectory() -> AccountError {
        AccountError("invalid_directory", "客户端配置目录必须是有效的绝对路径，请检查 CODEX_HOME 和 CLAUDE_CONFIG_DIR。", status: 400)
    }
    private static func busy() -> AccountError { AccountError("operation_in_progress", "正在处理上一项操作，请稍后重试。", status: 409) }
    private static func invalidResponse() -> AccountError { AccountError("invalid_response", "无法读取客户端配置状态。") }
}
