import Foundation
import Network
import CryptoKit

// This executable never constructs KeychainCredentialStore or opens a browser.
// Requests to production URLs are intercepted by SyntheticTransport; only the
// isolated authorization callback is exercised through real loopback sockets.
final class MemoryCredentials: AccountCredentialStore {
    var value: AccountCredential?
    var saves = 0
    var deletes = 0
    var failSave = false
    var failDelete = false
    init(_ value: AccountCredential? = nil) { self.value = value }
    func load() throws -> AccountCredential? { value }
    func save(_ credential: AccountCredential) throws {
        if failSave { throw AccountError("keychain_error", "synthetic storage failure") }
        saves += 1; value = credential
    }
    func delete() throws {
        if failDelete { throw AccountError("keychain_error", "synthetic keychain delete failure") }
        deletes += 1; value = nil
    }
}

actor SyntheticTransport: AccountTransport {
    typealias Handler = (URLRequest) async throws -> (Int, [String: Any])
    var handler: Handler
    var requests: [URLRequest] = []
    init(_ handler: @escaping Handler) { self.handler = handler }
    func set(_ handler: @escaping Handler) { self.handler = handler }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard request.url?.scheme == "https", request.url?.host == "code.conpera.ai" else { throw TestFailure("remote origin escaped") }
        requests.append(request)
        let (status, payload) = try await handler(request)
        let data = status == 204 ? Data() : try JSONSerialization.data(withJSONObject: payload)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!)
    }
}
actor Recorder {
    var urls: [URL] = []
    func add(_ value: URL) { urls.append(value) }
}
actor Gate {
    var opened = false
    var waiting: [CheckedContinuation<Void, Never>] = []
    func wait() async { if !opened { await withCheckedContinuation { waiting.append($0) } } }
    func open() { opened = true; let current = waiting; waiting = []; current.forEach { $0.resume() } }
}
struct TestFailure: Error, CustomStringConvertible { let description: String; init(_ value: String) { description = value } }
var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) throws {
    guard condition() else { throw TestFailure(label) }
    checks += 1
    print("PASS: \(label)")
}
func expected(_ code: String, _ operation: () async throws -> Void) async throws {
    do { try await operation(); throw TestFailure("expected \(code)") }
    catch let failure as AccountError { try check(failure.code == code, "error \(code)") }
}
let expiry = "2099-01-01T00:00:00.000Z"
let token = "csw_" + String(repeating: "a", count: 43)
let baseSession: [String: Any] = ["user": ["id": "account-test", "name": "Test User", "email": "test@example.invalid", "internalFlag": "secret"], "expiresAt": expiry]
func tokenPayload(_ value: String = token) -> [String: Any] { var result = baseSession; result["accessToken"] = value; return result }

func callbackURL(_ authorization: URL, stateOverride: String? = nil, error: Bool = false) throws -> URL {
    let items = URLComponents(url: authorization, resolvingAgainstBaseURL: false)!.queryItems!
    let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
    guard let redirect = URL(string: values["redirect_uri"]!) else { throw TestFailure("missing redirect") }
    var url = URLComponents(url: redirect, resolvingAgainstBaseURL: false)!
    url.queryItems = [URLQueryItem(name: "state", value: stateOverride ?? values["state"]!),
                      URLQueryItem(name: error ? "error" : "code", value: error ? "access_denied" : String(repeating: "c", count: 43))]
    return url.url!
}
func localRequest(_ url: URL, method: String = "GET", host: String? = nil) async throws -> Int {
    guard url.host == "127.0.0.1", url.scheme == "http" else { throw TestFailure("test network must remain loopback") }
    var request = URLRequest(url: url, timeoutInterval: 2)
    request.httpMethod = method
    if let host { request.setValue(host, forHTTPHeaderField: "Host") }
    let (_, response) = try await URLSession.shared.data(for: request)
    return (response as! HTTPURLResponse).statusCode
}
func acceptingBrowser(_ recorder: Recorder = Recorder()) -> AccountClient.BrowserOpener {
    { url in
        await recorder.add(url)
        do { return try await localRequest(callbackURL(url)) == 200 }
        catch { return false }
    }
}
func rawRequest(_ url: URL, _ wire: Data) async throws -> String {
    guard url.host == "127.0.0.1", let port = url.port else { throw TestFailure("invalid test port") }
    return try await withCheckedThrowingContinuation { continuation in
        let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!, using: .tcp)
        let queue = DispatchQueue(label: "account-test.raw")
        var finished = false
        var buffer = Data()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        func finish(_ result: Result<String, Error>) {
            guard !finished else { return }; finished = true
            timer.cancel(); connection.cancel(); continuation.resume(with: result)
        }
        func receive() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { data, _, complete, error in
                if let data { buffer.append(data) }
                if complete { finish(.success(String(data: buffer, encoding: .utf8) ?? "")) }
                else if let error { finish(.failure(error)) }
                else { receive() }
            }
        }
        timer.schedule(deadline: .now() + 3)
        timer.setEventHandler { finish(.failure(TestFailure("raw callback timed out"))) }
        timer.resume()
        connection.stateUpdateHandler = { state in
            if case .ready = state {
                connection.send(content: wire, completion: .contentProcessed { error in
                    if let error { finish(.failure(error)) } else { receive() }
                })
            }
            if case .failed(let error) = state { finish(.failure(error)) }
        }
        connection.start(queue: queue)
    }
}

func run() async throws {
    guard CommandLine.arguments.count == 2 else { throw TestFailure("Expected isolated fixture directory") }
    let fixtureRoot = URL(fileURLWithPath: CommandLine.arguments[1])
    guard fixtureRoot.path.contains("conpera-account-test-"), fixtureRoot.path != NSHomeDirectory() else { throw TestFailure("Unsafe fixture root") }
    let empty = MemoryCredentials()
    let transport = SyntheticTransport { _ in (200, baseSession) }
    let client = AccountClient(credentials: empty, transport: transport, openBrowser: acceptingBrowser())
    try await expected("unauthenticated") { _ = try await client.session() }
    let requestCount = await transport.requests.count
    try check(requestCount == 0, "no credential makes no remote request")

    let recorder = Recorder()
    let loginTransport = SyntheticTransport { request in
        guard request.url?.path == "/api/switch/token", request.httpMethod == "POST", request.value(forHTTPHeaderField: "Authorization") == nil else { throw TestFailure("invalid exchange request") }
        return (200, tokenPayload())
    }
    let logged = AccountClient(credentials: empty, transport: loginTransport, openBrowser: acceptingBrowser(recorder))
    let login = try await logged.login()
    try check(login["accessToken"] == nil && (login["user"] as? [String: Any])?["internalFlag"] == nil, "login projects only public fields")
    try check(empty.value?.accessToken == token && empty.saves == 1, "login stores token through credential store")
    let authURL = await recorder.urls[0]
    let query = Dictionary(uniqueKeysWithValues: URLComponents(url: authURL, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
    let exchange = await loginTransport.requests[0]
    let body = try JSONSerialization.jsonObject(with: exchange.httpBody!) as! [String: String]
    let challenge = Data(SHA256.hash(data: Data(body["codeVerifier"]!.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    try check(authURL.host == "code.conpera.ai" && authURL.path == "/api/switch/authorize" && query["client_id"] == "conpera-switch" && query["code_challenge_method"] == "S256", "browser authorization uses fixed service and S256")
    try check(challenge == query["code_challenge"] && body["redirectUri"] == query["redirect_uri"] && query["state"]!.count == 43 && body["codeVerifier"]!.count == 43, "cryptographic state and PKCE match exchange")
    try check(!authURL.absoluteString.contains(body["codeVerifier"]!), "verifier never enters browser URL")
    await loginTransport.set { request in
        guard request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)" else { throw TestFailure("missing bearer") }
        return (200, baseSession)
    }
    let current = try await logged.session()
    try check(current["accessToken"] == nil, "restored session omits token")
    await loginTransport.set { _ in (503, ["accessToken": "must-not-echo", "message": "must-not-echo"]) }
    try await expected("service_unavailable") { _ = try await logged.session() }
    try check(empty.value?.accessToken == token && empty.deletes == 0, "5xx preserves credential")
    await loginTransport.set { _ in throw URLError(.notConnectedToInternet) }
    try await expected("network_error") { _ = try await logged.balance() }
    try check(empty.value?.accessToken == token && empty.deletes == 0, "network failure preserves credential")
    await loginTransport.set { _ in (403, [:]) }
    try await expected("forbidden") { _ = try await logged.keys() }
    try check(empty.value?.accessToken == token, "permission denial preserves credential")
    await loginTransport.set { _ in (404, [:]) }
    try await expected("service_unavailable") { _ = try await logged.session() }
    await loginTransport.set { _ in (302, [:]) }
    try await expected("invalid_response") { _ = try await logged.session() }
    await loginTransport.set { _ in (200, ["balance": 128.5, "currency": "CNY", "updatedAt": expiry, "accessToken": token]) }
    let balance = try await logged.balance()
    try check(balance["balance"] as? Double == 128.5 && balance["accessToken"] == nil, "balance public projection")
    await loginTransport.set { _ in (200, ["balance": -3.25, "currency": "USD", "updatedAt": expiry]) }
    let dollarBalance = try await logged.balance()
    try check(dollarBalance["balance"] as? Double == -3.25 && dollarBalance["currency"] as? String == "USD", "USD negative balance preserves amount and currency")
    await loginTransport.set { _ in (200, ["balance": 128.5, "currency": "UNKNOWN", "updatedAt": expiry]) }
    try await expected("invalid_response") { _ = try await logged.balance() }
    await loginTransport.set { _ in (200, ["balance": 128.5, "updatedAt": expiry]) }
    try await expected("invalid_response") { _ = try await logged.balance() }
    await loginTransport.set { _ in (200, ["keys": [["id": "key-a", "tool": "codex", "name": "Test", "channel": "standard", "suffix": "abcd", "apiKey": "never-expose"]]]) }
    let keys = try await logged.keys()
    try check((keys["keys"] as! [[String: Any]])[0]["apiKey"] == nil, "key metadata cannot expose secrets")
    let movedKey: [String: Any] = ["id": "key-a", "tool": "codex", "name": "Test", "channel": "available", "channelId": "group:28", "suffix": "abcd", "apiKey": "never-expose"]
    await loginTransport.set { _ in (200, ["keys": [movedKey], "channels": [["id": "group:28", "name": "available", "tool": "codex", "secret": "never-expose"]]]) }
    let catalog = try await logged.keys()
    try check((catalog["channels"] as! [[String: Any]])[0]["secret"] == nil && (catalog["keys"] as! [[String: Any]])[0]["channelId"] as? String == "group:28", "catalog includes stable channel identifiers and projects public fields")
    await loginTransport.set { request in
        try check(request.httpMethod == "PATCH" && request.url!.path == "/api/switch/keys/channel", "channel change uses the scoped mutation endpoint")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
        try check(body == ["tool": "codex", "keyId": "key-a", "channelId": "group:28", "expectedChannelId": "group:1"], "channel change sends current key and expected channel without a secret")
        return (200, ["key": movedKey])
    }
    let moved = try await logged.changeChannel(tool: "codex", keyId: "key-a", channelId: "group:28", expectedChannelId: "group:1")
    try check((moved["key"] as! [String: Any])["apiKey"] == nil, "channel mutation response cannot expose key material")
    await loginTransport.set { _ in (200, ["key": movedKey.merging(["id": "different-key"]) { _, value in value }]) }
    try await expected("invalid_response") { _ = try await logged.changeChannel(tool: "codex", keyId: "key-a", channelId: "group:28", expectedChannelId: "group:1") }
    await loginTransport.set { _ in (200, ["keys": [], "channels": [["id": "group:0", "name": "invalid", "tool": "codex"]]]) }
    try await expected("invalid_response") { _ = try await logged.keys() }
    await loginTransport.set { _ in (200, ["tool": "codex", "keyId": "key-a", "apiKey": "synthetic-api-key", "baseUrl": "https://code.conpera.ai/v1"]) }
    let configuration = try await logged.configuration(tool: "codex", keyId: "key-a")
    try check(configuration["apiKey"] as? String == "synthetic-api-key", "native configuration gets authorized API credential")
    await loginTransport.set { _ in (200, ["tool": "codex", "keyId": "key-a", "apiKey": "synthetic-api-key", "baseUrl": "https://evil.example/v1"]) }
    try await expected("invalid_response") { _ = try await logged.configuration(tool: "codex", keyId: "key-a") }
    await loginTransport.set { _ in (401, [:]) }
    try await expected("unauthenticated") { _ = try await logged.session() }
    try check(empty.value == nil && empty.deletes == 1, "401 clears only own credential")

    let state = String(repeating: "s", count: 43)
    let callback = AuthorizationCallback(state: state, timeout: 20)
    let redirect = try await callback.start()
    let validTarget = "/oauth/callback?state=\(state)&code=\(String(repeating: "c", count: 43))"
    let host = "127.0.0.1:\(redirect.port!)"
    let invalidWires = [
        "GET /oauth/callback?state=wrong&code=\(String(repeating: "c", count: 43)) HTTP/1.1\r\nHost: \(host)\r\n\r\n",
        "GET \(validTarget) HTTP/1.1\r\nHost: evil.test\r\n\r\n",
        "POST \(validTarget) HTTP/1.1\r\nHost: \(host)\r\n\r\n",
        "GET \(validTarget) HTTP/1.1\r\nHost: \(host)\r\nHost: \(host)\r\n\r\n",
        "GET \(validTarget)&state=\(state) HTTP/1.1\r\nHost: \(host)\r\n\r\n",
        "GET \(validTarget) HTTP/1.1\r\nHost: \(host)\r\nTransfer-Encoding: chunked\r\n\r\n",
        "GET /other?state=\(state)&code=\(String(repeating: "c", count: 43)) HTTP/1.1\r\nHost: \(host)\r\n\r\n",
    ]
    for (index, wire) in invalidWires.enumerated() {
        let reply = try await rawRequest(redirect, Data(wire.utf8))
        try check(reply.hasPrefix("HTTP/1.1 400"), "callback rejects invalid request \(index + 1)")
    }
    let oversize = try await rawRequest(redirect, Data(("GET \(validTarget) HTTP/1.1\r\nHost: \(host)\r\nX-Padding: " + String(repeating: "x", count: 9000) + "\r\n\r\n").utf8))
    try check(oversize.hasPrefix("HTTP/1.1 413"), "callback bounds request size")
    let validReply = try await rawRequest(redirect, Data("GET \(validTarget) HTTP/1.1\r\nHost: \(host)\r\n\r\n".utf8))
    try check(validReply.hasPrefix("HTTP/1.1 200"), "valid callback HTTP response")
    let grantedCode = try await callback.code()
    try check(validReply.hasPrefix("HTTP/1.1 200") && grantedCode == String(repeating: "c", count: 43), "invalid callbacks do not consume valid transaction")
    let timeout = AuthorizationCallback(state: state, timeout: 0.03)
    _ = try await timeout.start()
    try await expected("login_timeout") { _ = try await timeout.code() }
    let cancelled = AuthorizationCallback(state: state)
    _ = try await cancelled.start()
    cancelled.cancel()
    try await expected("cancelled") { _ = try await cancelled.code() }
    let deniedStore = MemoryCredentials()
    let denied = AccountClient(credentials: deniedStore, transport: transport, openBrowser: { url in
        do { return try await localRequest(callbackURL(url, error: true)) == 200 } catch { return false }
    })
    try await expected("access_denied") { _ = try await denied.login() }
    try check(deniedStore.saves == 0, "denied authorization cannot create session")
    let failedStore = MemoryCredentials(); failedStore.failSave = true
    let storageFailure = AccountClient(credentials: failedStore, transport: SyntheticTransport { _ in (200, tokenPayload()) }, openBrowser: acceptingBrowser())
    try await expected("keychain_error") { _ = try await storageFailure.login() }
    try check(failedStore.value == nil, "keychain error never falls back to plaintext")

    let raceStore = MemoryCredentials(AccountCredential(accessToken: token, expiresAt: expiry))
    let started = Gate(), release = Gate()
    let raceTransport = SyntheticTransport { request in
        if request.url?.path == "/api/switch/session" { await started.open(); await release.wait(); return (401, [:]) }
        return (200, tokenPayload("csw_" + String(repeating: "b", count: 43)))
    }
    let racing = AccountClient(credentials: raceStore, transport: raceTransport, openBrowser: acceptingBrowser())
    let staleSession = Task { try await racing.session() }
    await started.wait()
    _ = try await racing.login()
    await release.open()
    try await expected("cancelled") { _ = try await staleSession.value }
    try check(raceStore.value?.accessToken.hasSuffix(String(repeating: "b", count: 43)) == true && raceStore.deletes == 0, "stale 401 cannot clear newer login")

    let pendingStore = MemoryCredentials()
    let exchangeStarted = Gate(), exchangeRelease = Gate()
    let pendingTransport = SyntheticTransport { _ in await exchangeStarted.open(); await exchangeRelease.wait(); return (200, tokenPayload()) }
    let pending = AccountClient(credentials: pendingStore, transport: pendingTransport, openBrowser: acceptingBrowser())
    let pendingLogin = Task { try await pending.login() }
    await exchangeStarted.wait()
    await pending.cancelLogin()
    await exchangeRelease.open()
    try await expected("cancelled") { _ = try await pendingLogin.value }
    try check(pendingStore.value == nil && pendingStore.saves == 0, "cancelled exchange cannot recreate session")
    let logoutStore = MemoryCredentials(AccountCredential(accessToken: token, expiresAt: expiry))
    let logoutClient = AccountClient(credentials: logoutStore, transport: SyntheticTransport { _ in (503, [:]) }, openBrowser: acceptingBrowser())
    try await expected("logout_remote_unconfirmed") { try await logoutClient.logout() }
    try check(logoutStore.value == nil && logoutStore.deletes == 1, "explicit logout clears local token and reports remote revocation failure")
    let deletionStore = MemoryCredentials(AccountCredential(accessToken: token, expiresAt: expiry))
    deletionStore.failDelete = true
    let deletionTransport = SyntheticTransport { _ in (204, [:]) }
    let deletionClient = AccountClient(credentials: deletionStore, transport: deletionTransport, openBrowser: acceptingBrowser())
    try await expected("keychain_error") { try await deletionClient.logout() }
    let deletionRequests = await deletionTransport.requests.count
    try check(deletionStore.value?.accessToken == token && deletionRequests == 0, "failed local logout preserves session and avoids claiming remote revocation")

    // The real runtime and file manager are composed with synthetic account
    // transport and a newly allocated fixture root, never the user's HOME.
    let fm = FileManager.default
    let runtimeHome = fixtureRoot.appendingPathComponent("runtime-home")
    try fm.createDirectory(at: runtimeHome, withIntermediateDirectories: true)
    let codexPath = runtimeHome.appendingPathComponent(".codex/config.toml")
    let claudePath = runtimeHome.appendingPathComponent(".claude/settings.json")
    try fm.createDirectory(at: codexPath.deletingLastPathComponent(), withIntermediateDirectories: true)
    let originalCodex = Data("# fixture original\nmodel = \"fixture-model\"\n".utf8)
    try originalCodex.write(to: codexPath)
    let runtimeStore = MemoryCredentials()
    let runtimeTransport = SyntheticTransport { request in
        switch request.url!.path {
        case "/api/switch/token": return (200, tokenPayload())
        case "/api/switch/session": return request.httpMethod == "DELETE" ? (204, [:]) : (200, baseSession)
        case "/api/switch/keys": return (200, ["keys": [["id": "key-a", "tool": "codex", "name": "Test", "channel": "standard", "suffix": "abcd"]]])
        case "/api/switch/keys/channel":
            return (200, ["key": ["id": "key-a", "tool": "codex", "name": "Test", "channel": "new channel", "channelId": "group:28", "suffix": "abcd", "apiKey": "runtime-secret-api-key"]])
        case "/api/switch/configuration":
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
            return (200, ["tool": body["tool"]!, "keyId": body["keyId"]!, "apiKey": "runtime-secret-api-key",
                          "baseUrl": body["tool"] == "codex" ? "https://code.conpera.ai/v1" : "https://code.conpera.ai"])
        default: return (404, [:])
        }
    }
    let runtimeAccount = AccountClient(credentials: runtimeStore, transport: runtimeTransport, openBrowser: acceptingBrowser())
    let runtime = SwitchRuntime(account: runtimeAccount, configuration: ConfigurationManager(home: runtimeHome))
    let remoteLogoutRuntime = SwitchRuntime(account: AccountClient(credentials: MemoryCredentials(AccountCredential(accessToken: token, expiresAt: expiry)), transport: SyntheticTransport { _ in throw TestFailure("runtime-secret-api-key") }, openBrowser: acceptingBrowser()), configuration: ConfigurationManager(home: runtimeHome))
    let remoteLogoutReply = await remoteLogoutRuntime.handle(action: "logout", payload: [:])
    let remoteLogoutError = remoteLogoutReply["error"] as? [String: Any]
    let remoteLogoutText = String(decoding: try JSONSerialization.data(withJSONObject: remoteLogoutReply), as: UTF8.self)
    try check(remoteLogoutError?["code"] as? String == "logout_remote_unconfirmed" && remoteLogoutError?["status"] as? Int == 503 && !remoteLogoutText.contains("runtime-secret-api-key") && !remoteLogoutText.contains(token), "runtime logout distinguishes local clearing without leaking transport diagnostics")
    let blockedLogoutRuntime = SwitchRuntime(account: deletionClient, configuration: ConfigurationManager(home: runtimeHome))
    let blockedLogoutReply = await blockedLogoutRuntime.handle(action: "logout", payload: [:])
    try check((blockedLogoutReply["error"] as? [String: Any])?["code"] as? String == "keychain_error" && deletionStore.value?.accessToken == token, "runtime logout keychain failure remains distinguishable and signed in")
    func bridge(_ action: String, _ payload: [String: Any] = [:]) async throws -> [String: Any] {
        let reply = await runtime.handle(action: action, payload: payload)
        let serialized = String(decoding: try JSONSerialization.data(withJSONObject: reply), as: UTF8.self)
        try check(!serialized.contains("runtime-secret-api-key") && !serialized.contains(token), "runtime \(action) response contains no credential")
        return reply
    }
    func isOkay(_ reply: [String: Any]) -> Bool { reply["ok"] as? Bool == true }
    func errorCode(_ reply: [String: Any]) -> String? { (reply["error"] as? [String: Any])?["code"] as? String }
    func mode(_ reply: [String: Any], _ tool: String) -> String? {
        (((reply["data"] as? [String: Any])?["tools"] as? [String: Any])?[tool] as? [String: Any])?["mode"] as? String
    }
    let localSettingsRead = try await bridge("configurationDetails", ["tool": "codex"])
    let localDetails = localSettingsRead["data"] as! [String: Any]
    try check(isOkay(localSettingsRead) && runtimeStore.value == nil, "local settings remain accessible without an account")
    let localPreview = try await bridge("previewConfiguration", ["tool": "codex", "content": localDetails["content"]!, "updates": ["model": "edited-fixture-model"]])
    let localSaved = try await bridge("saveConfiguration", ["tool": "codex", "revision": localDetails["revision"]!, "content": (localPreview["data"] as! [String: Any])["content"]!])
    let editedLocalDisk = try String(contentsOf: codexPath, encoding: .utf8)
    try check(isOkay(localSaved) && editedLocalDisk.contains("edited-fixture-model"), "runtime settings writes reach the isolated configuration file")
    let localUndone = try await bridge("undoConfiguration", ["tool": "codex", "revision": (localSaved["data"] as! [String: Any])["revision"]!])
    let localRestored = try Data(contentsOf: codexPath)
    try check(isOkay(localUndone) && localRestored == originalCodex, "runtime undo restores the fixture before login")
    let localRequests = await runtimeTransport.requests.count
    try check(localRequests == 0, "local settings never contact account or model APIs")
    let invalidEditor = await runtime.handle(action: "saveConfiguration", payload: ["tool": "codex", "revision": "wrong", "content": "model = \"bad\"", "path": "/arbitrary"])
    try check(errorCode(invalidEditor) == "invalid_request", "settings bridge refuses arbitrary file paths and malformed payloads")
    let runtimeLogin = try await bridge("login")
    let runtimeKeys = try await bridge("keys")
    try check(isOkay(runtimeLogin) && isOkay(runtimeKeys), "runtime login and key metadata flow")
    let applyCodex = try await bridge("apply", ["tool": "codex", "keyId": "key-a"])
    let applyClaude = try await bridge("apply", ["tool": "claude", "keyId": "key-a"])
    try check(mode(applyCodex, "codex") == "conpera" && mode(applyClaude, "claude") == "conpera", "runtime applies both CLI formats")
    let codexWritten = try String(contentsOf: codexPath, encoding: .utf8)
    let claudeWritten = try String(contentsOf: claudePath, encoding: .utf8)
    try check(codexWritten.contains("runtime-secret-api-key") && claudeWritten.contains("runtime-secret-api-key"), "runtime writes authorized configuration only in fixture")
    let movedRuntime = try await bridge("changeChannel", ["tool": "codex", "keyId": "key-a", "channelId": "group:28", "expectedChannelId": "group:1"])
    let activeSettings = try await bridge("configurationDetails", ["tool": "codex"])
    try check(((activeSettings["data"] as? [String: Any])?["content"] as? String)?.contains("__CONPERA_PRIVATE_") == true, "active account credentials are replaced in raw configuration")
    let afterChannelCodex = try String(contentsOf: codexPath, encoding: .utf8)
    let afterChannelClaude = try String(contentsOf: claudePath, encoding: .utf8)
    try check(isOkay(movedRuntime) && afterChannelCodex == codexWritten && afterChannelClaude == claudeWritten, "changing a current key channel never rewrites either local CLI configuration")
    let runtimeStatus = try await bridge("status")
    try check(mode(runtimeStatus, "codex") == "conpera" && mode(runtimeStatus, "claude") == "conpera", "runtime reports real on-disk state")
    let restoreCodex = try await bridge("restore", ["tool": "codex"])
    let restoreClaude = try await bridge("restore", ["tool": "claude"])
    try check(mode(restoreCodex, "codex") == "original" && mode(restoreClaude, "claude") == "original", "runtime restores both CLI formats")
    let restoredBytes = try Data(contentsOf: codexPath)
    try check(restoredBytes == originalCodex && !fm.fileExists(atPath: claudePath.path), "runtime restoration preserves original bytes and absence")
    let runtimeLogout = try await bridge("logout")
    let restoreOffline = try await bridge("restore", ["tool": "codex"])
    let missingSession = try await bridge("apply", ["tool": "codex", "keyId": "key-a"])
    try check(isOkay(runtimeLogout) && isOkay(restoreOffline) && errorCode(missingSession) == "unauthenticated", "runtime allows offline recovery and rejects unauthenticated apply")
    let extraPayload = try await bridge("apply", ["tool": "codex", "keyId": "key-a", "apiKey": "injected-secret"])
    let unknownAction = try await bridge("configuration")
    try check(errorCode(extraPayload) == "invalid_request" && errorCode(unknownAction) == "invalid_request", "runtime rejects arbitrary secrets and unknown bridge actions")

    let applyStarted = Gate(), applyReleased = Gate()
    let busyStore = MemoryCredentials(AccountCredential(accessToken: token, expiresAt: expiry))
    let busyTransport = SyntheticTransport { _ in
        await applyStarted.open(); await applyReleased.wait()
        return (200, ["tool": "codex", "keyId": "key-a", "apiKey": "runtime-secret-api-key", "baseUrl": "https://code.conpera.ai/v1"])
    }
    let busyRuntime = SwitchRuntime(account: AccountClient(credentials: busyStore, transport: busyTransport, openBrowser: acceptingBrowser()), configuration: ConfigurationManager(home: runtimeHome))
    let pendingApply = Task { await busyRuntime.handle(action: "apply", payload: ["tool": "codex", "keyId": "key-a"]) }
    await applyStarted.wait()
    for action in ["apply", "restore", "login", "logout", "cancelLogin", "changeChannel"] {
        let payload: [String: Any] = action == "apply" ? ["tool": "claude", "keyId": "key-a"] : action == "restore" ? ["tool": "codex"] : action == "changeChannel" ? ["tool": "codex", "keyId": "key-a", "channelId": "group:28", "expectedChannelId": "group:1"] : [:]
        let reply = await busyRuntime.handle(action: action, payload: payload)
        try check(errorCode(reply) == "operation_in_progress", "mutation lock rejects \(action) during apply")
    }
    for (action, payload) in [
        ("configurationDetails", ["tool": "codex"] as [String: Any]),
        ("saveConfiguration", ["tool": "codex", "revision": String(repeating: "a", count: 64), "content": ""]),
        ("undoConfiguration", ["tool": "codex", "revision": String(repeating: "a", count: 64)])
    ] {
        let reply = await busyRuntime.handle(action: action, payload: payload)
        try check(errorCode(reply) == "operation_in_progress", "mutation lock rejects \(action) during apply")
    }
    do {
        try await busyRuntime.beginSoftwareUpdate()
        throw NSError(domain: "UpdateTest", code: 1)
    } catch let error as AccountError {
        try check(error.code == "operation_in_progress", "software update cannot interrupt an active configuration write")
    }
    // An unowned release must not unlock a configuration mutation.
    await busyRuntime.endSoftwareUpdate()
    let stillBusy = await busyRuntime.handle(action: "restore", payload: ["tool": "codex"])
    try check(errorCode(stillBusy) == "operation_in_progress", "software update release cannot clear another mutation lease")
    await applyReleased.open()
    let completedApply = await pendingApply.value
    try check(isOkay(completedApply), "mutation holder completes safely")
    _ = await busyRuntime.handle(action: "restore", payload: ["tool": "codex"])

    try await busyRuntime.beginSoftwareUpdate()
    for (action, payload) in [
        ("apply", ["tool": "codex", "keyId": "key-a"] as [String: Any]),
        ("restore", ["tool": "codex"]),
        ("configurationDetails", ["tool": "codex"]),
        ("saveConfiguration", ["tool": "codex", "revision": String(repeating: "a", count: 64), "content": ""]),
        ("login", [:]), ("logout", [:])
    ] {
        let reply = await busyRuntime.handle(action: action, payload: payload)
        try check(errorCode(reply) == "operation_in_progress", "software update blocks \(action) until completion")
    }
    let duringUpdateStatus = await busyRuntime.handle(action: "status", payload: [:])
    try check(isOkay(duringUpdateStatus), "configuration status stays readable during software updates")
    await busyRuntime.endSoftwareUpdate()
    let afterUpdateRead = await busyRuntime.handle(action: "configurationDetails", payload: ["tool": "codex"])
    try check(isOkay(afterUpdateRead), "configuration editing resumes after an update finishes or is cancelled")

    let waitingRecorder = Recorder()
    let waitingAccount = AccountClient(credentials: MemoryCredentials(), transport: runtimeTransport, openBrowser: { url in await waitingRecorder.add(url); return true })
    let waitingRuntime = SwitchRuntime(account: waitingAccount, configuration: ConfigurationManager(home: runtimeHome))
    let waitingLogin = Task { await waitingRuntime.handle(action: "login", payload: [:]) }
    while await waitingRecorder.urls.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
    let cancelledReply = await waitingRuntime.handle(action: "cancelLogin", payload: [:])
    let cancelledLogin = await waitingLogin.value
    try check(isOkay(cancelledReply) && errorCode(cancelledLogin) == "cancelled", "runtime cancels active browser login")

    let invalidEnvironment = SwitchRuntime(account: runtimeAccount, environment: ["CODEX_HOME": "relative/private-secret-path"], home: runtimeHome)
    let invalidStatus = await invalidEnvironment.handle(action: "status", payload: [:])
    let invalidEncoded = String(decoding: try JSONSerialization.data(withJSONObject: invalidStatus), as: UTF8.self)
    try check(errorCode(invalidStatus) == "invalid_directory" && !invalidEncoded.contains("private-secret-path"), "invalid environment path fails without disclosure")
    let customHome = fixtureRoot.appendingPathComponent("custom-runtime-home")
    try fm.createDirectory(at: customHome, withIntermediateDirectories: true)
    let customCodex = customHome.appendingPathComponent("codex-custom")
    let customClaude = customHome.appendingPathComponent("claude-custom")
    let customRuntime = SwitchRuntime(account: AccountClient(credentials: MemoryCredentials(AccountCredential(accessToken: token, expiresAt: expiry)), transport: runtimeTransport, openBrowser: acceptingBrowser()), environment: ["CODEX_HOME": customCodex.path, "CLAUDE_CONFIG_DIR": customClaude.path], home: customHome)
    let customResult = await customRuntime.handle(action: "apply", payload: ["tool": "codex", "keyId": "key-a"])
    try check(isOkay(customResult) && fm.fileExists(atPath: customCodex.appendingPathComponent("config.toml").path) && !fm.fileExists(atPath: customHome.appendingPathComponent(".codex/config.toml").path), "runtime respects absolute CODEX_HOME")
    _ = await customRuntime.handle(action: "restore", payload: ["tool": "codex"])
    let customClaudeResult = await customRuntime.handle(action: "apply", payload: ["tool": "claude", "keyId": "key-a"])
    try check(isOkay(customClaudeResult) && fm.fileExists(atPath: customClaude.appendingPathComponent("settings.json").path), "runtime respects absolute CLAUDE_CONFIG_DIR")
    _ = await customRuntime.handle(action: "restore", payload: ["tool": "claude"])
    print("\n\(checks) isolated native account and runtime checks passed.")
}

Task {
    do { try await run(); exit(0) }
    catch { FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8)); exit(1) }
}
dispatchMain()
