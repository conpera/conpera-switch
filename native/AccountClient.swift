import AppKit
import Foundation
import CryptoKit
import Security

struct AccountError: Error, LocalizedError {
    let code: String
    let message: String
    let status: Int?
    init(_ code: String, _ message: String, status: Int? = nil) {
        self.code = code; self.message = message; self.status = status
    }
    var errorDescription: String? { message }
}

protocol AccountTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// No shared browser cookies, response cache, disk cache, or credential storage.
/// Redirects are refused, including redirects back to the trusted origin.
final class AccountURLSessionTransport: NSObject, AccountTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private var session: URLSession!
    override init() {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 25
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw AccountError("invalid_response", "账户服务返回了无效响应。")
        }
        return (data, response)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// All session mutations are isolated here. The web view receives explicitly
/// projected public fields, never access tokens or unfiltered service payloads.
actor AccountClient {
    typealias BrowserOpener = (URL) async -> Bool
    typealias CallbackFactory = (String, TimeInterval) -> AccountAuthorizationCallback
    private static let origin = URL(string: "https://code.conpera.ai")!
    private let credentials: AccountCredentialStore
    private let transport: AccountTransport
    private let openBrowser: BrowserOpener
    private let callbackFactory: CallbackFactory
    private let loginTimeout: TimeInterval
    private var credential: AccountCredential?
    private var credentialLoaded = false
    private var generation: UInt64 = 0
    private var activeLogin: (id: UUID, callback: AccountAuthorizationCallback)?

    init(credentials: AccountCredentialStore = KeychainCredentialStore(),
         transport: AccountTransport = AccountURLSessionTransport(),
         openBrowser: @escaping BrowserOpener = { url in await MainActor.run { NSWorkspace.shared.open(url) } },
         callbackFactory: @escaping CallbackFactory = { state, timeout in AuthorizationCallback(state: state, timeout: timeout) },
         loginTimeout: TimeInterval = 300) {
        self.credentials = credentials
        self.transport = transport
        self.openBrowser = openBrowser
        self.callbackFactory = callbackFactory
        self.loginTimeout = max(0.01, min(loginTimeout, 300))
    }

    func session() async throws -> [String: Any] {
        try publicSession(try await authenticated("GET", path: "/api/switch/session"))
    }

    func login() async throws -> [String: Any] {
        cancelLogin()
        let epoch = generation
        let id = UUID()
        let state = try Self.random(), verifier = try Self.random()
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let callback = callbackFactory(state, loginTimeout)
        activeLogin = (id, callback)
        let deadline = Date().addingTimeInterval(loginTimeout)
        defer {
            callback.cancel()
            if activeLogin?.id == id { activeLogin = nil }
        }
        do {
            return try await withTaskCancellationHandler(operation: {
                let redirect = try await callback.start()
                try self.checkLogin(epoch: epoch, id: id, deadline: deadline)
                // A custom callback implementation is permitted only as a test
                // dependency, but still cannot send the verifier off loopback.
                guard redirect.scheme == "http", redirect.host == "127.0.0.1",
                      let port = redirect.port, (1024...65535).contains(port),
                      redirect.path == "/oauth/callback", redirect.user == nil,
                      redirect.password == nil, redirect.query == nil, redirect.fragment == nil else {
                    throw AccountError("callback_unavailable", "本地登录回调地址无效。")
                }
                var url = URLComponents(url: Self.origin.appendingPathComponent("api/switch/authorize"), resolvingAgainstBaseURL: false)!
                url.queryItems = [
                    URLQueryItem(name: "client_id", value: "conpera-switch"),
                    URLQueryItem(name: "redirect_uri", value: redirect.absoluteString),
                    URLQueryItem(name: "state", value: state),
                    URLQueryItem(name: "code_challenge", value: challenge),
                    URLQueryItem(name: "code_challenge_method", value: "S256"),
                ]
                guard let authorizationURL = url.url, await self.openBrowser(authorizationURL) else {
                    throw AccountError("browser_unavailable", "无法打开系统浏览器，请检查默认浏览器设置。")
                }
                try self.checkLogin(epoch: epoch, id: id, deadline: deadline)
                let code = try await callback.code()
                try self.checkLogin(epoch: epoch, id: id, deadline: deadline)
                let payload = try await self.request("POST", path: "/api/switch/token", body: [
                    "code": code, "codeVerifier": verifier, "redirectUri": redirect.absoluteString,
                ])
                try self.checkLogin(epoch: epoch, id: id, deadline: deadline)
                let publicFields = try self.publicSession(payload)
                guard let token = payload["accessToken"] as? String,
                      (32...4096).contains(token.utf8.count), token.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
                      let expiry = publicFields["expiresAt"] as? String,
                      let expiration = Self.date(expiry), expiration > Date() else { throw Self.invalidResponse() }
                let stored = AccountCredential(accessToken: token, expiresAt: expiry)
                try self.credentials.save(stored)
                self.credential = stored
                self.credentialLoaded = true
                self.generation &+= 1
                return publicFields
            }, onCancel: { callback.cancel() })
        } catch {
            if generation != epoch || Task.isCancelled { throw AccountError("cancelled", "登录已取消。") }
            throw error
        }
    }

    func cancelLogin() {
        generation &+= 1
        activeLogin?.callback.cancel()
        activeLogin = nil
    }

    func balance() async throws -> [String: Any] {
        let payload = try await authenticated("GET", path: "/api/switch/balance")
        guard let amount = payload["balance"] as? NSNumber, CFGetTypeID(amount) != CFBooleanGetTypeID(),
              amount.doubleValue.isFinite,
              let currency = payload["currency"] as? String, ["CNY", "USD"].contains(currency),
              let updatedAt = payload["updatedAt"] as? String, Self.date(updatedAt) != nil else { throw Self.invalidResponse() }
        return ["balance": amount, "currency": currency, "updatedAt": updatedAt]
    }

    func keys() async throws -> [String: Any] {
        let payload = try await authenticated("GET", path: "/api/switch/keys")
        guard let keys = payload["keys"] as? [[String: Any]], keys.count <= 1000 else { throw Self.invalidResponse() }
        let publicKeys = try keys.map { key -> [String: Any] in
            guard let id = Self.identifier(key["id"]), let name = key["name"] as? String,
                  let tool = key["tool"] as? String, ["codex", "claude"].contains(tool),
                  let channel = key["channel"] as? String,
                  let suffix = key["suffix"] as? String, suffix.utf8.count <= 8,
                  name.utf8.count <= 256, channel.utf8.count <= 256 else { throw Self.invalidResponse() }
            return ["id": id, "name": name, "tool": tool, "channel": channel, "suffix": suffix]
        }
        return ["keys": publicKeys]
    }

    /// Native-only. Do not return this dictionary through the web view bridge.
    func configuration(tool: String, keyId: String) async throws -> [String: Any] {
        guard ["codex", "claude"].contains(tool), Self.identifier(keyId) != nil else {
            throw AccountError("invalid_request", "请选择有效的工具和密钥。")
        }
        let payload = try await authenticated("POST", path: "/api/switch/configuration", body: ["tool": tool, "keyId": keyId])
        let expectedBase = tool == "codex" ? "https://code.conpera.ai/v1" : "https://code.conpera.ai"
        guard payload["tool"] as? String == tool, Self.identifier(payload["keyId"]) == keyId,
              let apiKey = payload["apiKey"] as? String, (8...4096).contains(apiKey.utf8.count),
              apiKey.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              payload["baseUrl"] as? String == expectedBase else { throw Self.invalidResponse() }
        var projected: [String: Any] = ["tool": tool, "keyId": keyId, "apiKey": apiKey, "baseUrl": expectedBase]
        if let model = payload["model"] {
            guard let value = model as? String, !value.isEmpty, value.utf8.count <= 128,
                  value.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else { throw Self.invalidResponse() }
            projected["model"] = value
        }
        return projected
    }

    /// Explicit logout clears this device even if remote revocation fails. A
    /// network error is still reported so the caller cannot claim revocation.
    func logout() async throws {
        cancelLogin()
        let epoch = generation
        let existing = try loadCredential()
        try credentials.delete()
        credential = nil; credentialLoaded = true
        guard let existing else { return }
        do { _ = try await request("DELETE", path: "/api/switch/session", token: existing.accessToken, allowEmpty: true) }
        catch let error as AccountError where error.status == 401 { return }
        catch {
            guard generation == epoch else { return }
            throw AccountError("logout_remote_unconfirmed", "本机已退出登录，远端会话撤销尚未确认。", status: 503)
        }
    }

    private func loadCredential() throws -> AccountCredential? {
        if !credentialLoaded {
            credential = try credentials.load()
            credentialLoaded = true
        }
        return credential
    }

    private func authenticated(_ method: String, path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let credential = try loadCredential() else { throw AccountError("unauthenticated", "请先登录 Conpera。", status: 401) }
        let epoch = generation
        do {
            let payload = try await request(method, path: path, token: credential.accessToken, body: body)
            guard generation == epoch, self.credential == credential else { throw AccountError("cancelled", "账户已更改，请重试。") }
            return payload
        } catch {
            guard generation == epoch, self.credential == credential else { throw AccountError("cancelled", "账户已更改，请重试。") }
            if let failure = error as? AccountError, failure.status == 401 {
                try credentials.delete()
                self.credential = nil
                generation &+= 1
            }
            throw error
        }
    }

    private func request(_ method: String, path: String, token: String? = nil,
                         body: [String: Any]? = nil, allowEmpty: Bool = false) async throws -> [String: Any] {
        // Callers supply only source-defined paths. Neither the web view nor
        // responses can choose the host, method, or arbitrary request headers.
        guard path.hasPrefix("/api/switch/"), !path.contains("?"), !path.contains("#"), !path.contains("..") else {
            throw AccountError("invalid_request", "账户请求无效。")
        }
        let url = Self.origin.appendingPathComponent(String(path.dropFirst()))
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data, response: HTTPURLResponse
        do { (data, response) = try await transport.send(request) }
        catch let error as AccountError { throw error }
        catch is CancellationError { throw AccountError("cancelled", "请求已取消。") }
        catch { throw AccountError("network_error", "暂时无法连接 Conpera，请检查网络后重试。") }
        guard response.url == url else { throw Self.invalidResponse() }
        switch response.statusCode {
        case 200...299: break
        case 401: throw AccountError("unauthenticated", "登录已过期，请重新登录。", status: 401)
        case 403: throw AccountError("forbidden", "当前账户无法使用 Conpera Switch，请确认账户状态正常。", status: 403)
        case 404, 405, 501: throw AccountError("service_unavailable", "Conpera Switch 账户服务尚未开放，请稍后重试。", status: response.statusCode)
        case 429: throw AccountError("rate_limited", "请求过于频繁，请稍后重试。", status: 429)
        case 500...599: throw AccountError("service_unavailable", "Conpera 账户服务暂时不可用，请稍后重试。", status: response.statusCode)
        case 300...399: throw AccountError("invalid_response", "账户服务返回了不允许的跳转。", status: response.statusCode)
        default: throw AccountError("request_failed", "账户请求未能完成，请重试。", status: response.statusCode)
        }
        if allowEmpty && response.statusCode == 204 && data.isEmpty { return [:] }
        guard data.count <= 1_048_576,
              response.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "application/json",
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Self.invalidResponse() }
        return payload
    }

    private func publicSession(_ payload: [String: Any]) throws -> [String: Any] {
        guard let user = payload["user"] as? [String: Any], let id = Self.identifier(user["id"]),
              let name = user["name"] as? String, !name.isEmpty, name.utf8.count <= 256,
              let email = user["email"] as? String, email.utf8.count <= 320,
              let expiresAt = payload["expiresAt"] as? String, Self.date(expiresAt) != nil else { throw Self.invalidResponse() }
        return ["user": ["id": id, "name": name, "email": email], "expiresAt": expiresAt]
    }

    private func checkLogin(epoch: UInt64, id: UUID, deadline: Date) throws {
        guard !Task.isCancelled, generation == epoch, activeLogin?.id == id else { throw AccountError("cancelled", "登录已取消。") }
        guard Date() < deadline else { throw AccountError("login_timeout", "登录已超时，请重试。") }
    }
    private static func identifier(_ raw: Any?) -> String? {
        if let value = raw as? String, !value.isEmpty, value.utf8.count <= 256,
           value.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) { return value }
        if let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
           number.doubleValue.rounded() == number.doubleValue { return number.stringValue }
        return nil
    }
    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
    private static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw AccountError("random_unavailable", "无法生成安全的登录凭据。")
        }
        return base64URL(Data(bytes))
    }
    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func invalidResponse() -> AccountError { AccountError("invalid_response", "账户服务返回了无效响应，请稍后重试。") }
}
