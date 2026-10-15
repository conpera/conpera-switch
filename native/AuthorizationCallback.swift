import Foundation
import Network

protocol AccountAuthorizationCallback: AnyObject {
    func start() async throws -> URL
    func code() async throws -> String
    func cancel()
}

/// One login attempt owns one ephemeral IPv4 loopback listener. Invalid requests
/// cannot consume a valid attempt, and no callback data is written to disk.
final class AuthorizationCallback: AccountAuthorizationCallback, @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.conpera.switch.authorization-callback")
    private let expectedState: String
    private let timeout: TimeInterval
    private var listener: NWListener?
    private var host: String?
    private var startContinuation: CheckedContinuation<URL, Error>?
    private var codeContinuation: CheckedContinuation<String, Error>?
    private var result: Result<String, Error>?
    private var timer: DispatchSourceTimer?
    private var started = false
    private var clients: [UUID: Client] = [:]
    private static let maximumRequest = 8192

    init(state: String, timeout: TimeInterval = 300) {
        expectedState = state
        self.timeout = max(0.01, min(timeout, 300))
    }

    func start() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                guard !started, result == nil else {
                    continuation.resume(throwing: AccountError("cancelled", "登录已取消。")); return
                }
                started = true
                startContinuation = continuation
                do {
                    let parameters = NWParameters.tcp
                    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                    parameters.allowLocalEndpointReuse = false
                    let listener = try NWListener(using: parameters)
                    self.listener = listener
                    listener.newConnectionHandler = { [weak self] connection in
                        guard let self, self.result == nil, self.clients.count < 16,
                              case .hostPort(let peer, _) = connection.endpoint,
                              peer == NWEndpoint.Host("127.0.0.1") else { connection.cancel(); return }
                        let client = Client(connection: connection, owner: self)
                        self.clients[client.id] = client
                        client.start()
                    }
                    listener.stateUpdateHandler = { [weak self, weak listener] state in
                        guard let self, self.result == nil else { return }
                        switch state {
                        case .ready:
                            guard let port = listener?.port else {
                                self.finish(.failure(AccountError("callback_unavailable", "无法启动本地登录回调。"))); return
                            }
                            self.host = "127.0.0.1:\(port.rawValue)"
                            let continuation = self.startContinuation
                            self.startContinuation = nil
                            continuation?.resume(returning: URL(string: "http://\(self.host!)/oauth/callback")!)
                        case .failed:
                            self.finish(.failure(AccountError("callback_unavailable", "无法启动本地登录回调。")))
                        default: break
                        }
                    }
                    let timer = DispatchSource.makeTimerSource(queue: queue)
                    timer.schedule(deadline: .now() + self.timeout)
                    timer.setEventHandler { [weak self] in self?.finish(.failure(AccountError("login_timeout", "登录已超时，请重试。"))) }
                    self.timer = timer
                    timer.resume()
                    listener.start(queue: queue)
                } catch { finish(.failure(AccountError("callback_unavailable", "无法启动本地登录回调。"))) }
            }
        }
    }

    func code() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                if let result { continuation.resume(with: result) }
                else if codeContinuation == nil { codeContinuation = continuation }
                else { continuation.resume(throwing: AccountError("login_in_progress", "登录正在进行中。")) }
            }
        }
    }

    func cancel() {
        queue.async { [self] in finish(.failure(AccountError("cancelled", "登录已取消。"))) }
    }

    private func finish(_ value: Result<String, Error>, keeping clientID: UUID? = nil) {
        guard result == nil else { return }
        result = value
        timer?.cancel(); timer = nil
        listener?.cancel(); listener = nil
        let start = startContinuation; startContinuation = nil
        switch value {
        case .failure(let error): start?.resume(throwing: error)
        case .success: start?.resume(throwing: AccountError("invalid_response", "登录回调状态异常。"))
        }
        let code = codeContinuation; codeContinuation = nil
        code?.resume(with: value)
        for client in Array(clients.values) where client.id != clientID { client.close() }
    }

    private func handle(_ bytes: Data, client: Client) {
        guard result == nil, let host,
              let text = String(data: bytes, encoding: .ascii),
              text.hasSuffix("\r\n\r\n") else { client.respond(400); return }
        let header = String(data: bytes.dropLast(4), encoding: .ascii)!
        let lines = header.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").components(separatedBy: " ")
        guard first.count == 3, first[0] == "GET", first[2] == "HTTP/1.1",
              first[1].hasPrefix("/oauth/callback?"),
              first[1].utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              !first[1].contains("#") else { client.respond(400); return }
        var headers: [String: String] = [:]
        let tokenBytes = Set("!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { client.respond(400); return }
            let key = String(line[..<colon]).lowercased()
            let raw = String(line[line.index(after: colon)...])
            guard !key.isEmpty, key.utf8.allSatisfy({ tokenBytes.contains($0) }),
                  raw.utf8.allSatisfy({ $0 == 9 || ($0 >= 32 && $0 < 127) }),
                  headers[key] == nil else { client.respond(400); return }
            headers[key] = raw.trimmingCharacters(in: .whitespaces)
        }
        guard headers["host"] == host, headers["transfer-encoding"] == nil,
              headers["expect"] == nil, headers["content-length"] == nil || headers["content-length"] == "0" else {
            client.respond(400); return
        }
        guard let components = URLComponents(string: first[1]), components.percentEncodedPath == "/oauth/callback",
              let items = components.queryItems, items.count == 2 else { client.respond(400); return }
        var query: [String: String] = [:]
        for item in items {
            guard query[item.name] == nil, let value = item.value else { client.respond(400); return }
            query[item.name] = value
        }
        guard let state = query["state"], Self.equal(state, expectedState) else { client.respond(400); return }
        let accepted: Result<String, Error>
        if let code = query["code"], query["error"] == nil,
           (32...256).contains(code.utf8.count), code.utf8.allSatisfy({ Self.unreserved.contains($0) }) {
            accepted = .success(code)
        } else if query["error"] == "access_denied", query["code"] == nil {
            accepted = .failure(AccountError("access_denied", "已取消授权，或此账户尚未获得内测权限。", status: 403))
        } else { client.respond(400); return }
        client.respond(200)
        finish(accepted, keeping: client.id)
    }

    private static let unreserved = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".utf8)
    private static func equal(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8), b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var mismatch: UInt8 = 0
        for index in a.indices { mismatch |= a[index] ^ b[index] }
        return mismatch == 0
    }

    private final class Client: @unchecked Sendable {
        let id = UUID()
        let connection: NWConnection
        weak var owner: AuthorizationCallback?
        var data = Data()
        var closed = false
        var responding = false
        var timer: DispatchSourceTimer?
        init(connection: NWConnection, owner: AuthorizationCallback) { self.connection = connection; self.owner = owner }
        func start() {
            guard let owner else { close(); return }
            let timer = DispatchSource.makeTimerSource(queue: owner.queue)
            timer.schedule(deadline: .now() + 5)
            timer.setEventHandler { [weak self] in self?.close() }
            self.timer = timer; timer.resume()
            connection.start(queue: owner.queue)
            receive()
        }
        func receive() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: AuthorizationCallback.maximumRequest + 1) { [weak self] bytes, _, complete, error in
                guard let self, !self.closed, !self.responding else { return }
                if let bytes { self.data.append(bytes) }
                if self.data.count > AuthorizationCallback.maximumRequest { self.respond(413); return }
                if let boundary = self.data.range(of: Data("\r\n\r\n".utf8)) {
                    guard boundary.upperBound == self.data.count else { self.respond(400); return }
                    self.owner?.handle(self.data, client: self)
                } else if complete || error != nil { self.close() }
                else { self.receive() }
            }
        }
        func respond(_ status: Int) {
            guard !closed, !responding else { return }
            responding = true
            let body = status == 200 ? "授权结果已返回 Conpera Switch。现在可以关闭此页面。" : "无效的登录回调。请返回 Conpera Switch 重试。"
            let payload = Data(body.utf8)
            let header = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Bad Request")\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(payload.count)\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(header.utf8) + payload, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in self?.close() })
        }
        func close() {
            guard !closed else { return }; closed = true
            timer?.cancel(); timer = nil
            connection.cancel()
            owner?.clients.removeValue(forKey: id)
        }
    }
}
