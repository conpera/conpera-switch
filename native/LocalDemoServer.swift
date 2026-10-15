import Foundation
import Network
import CryptoKit
import Security

/// An isolated, in-memory demo service. Its only file access is the bundled web build.
/// All mutable state is confined to `queue`; callbacks arrive on that queue.
final class LocalDemoServer: @unchecked Sendable {
    private let resourceRoot: URL
    private let demoEnabled: Bool
    private let queue = DispatchQueue(label: "ai.conpera.switch.local-demo")
    private var listener: NWListener?
    private var connections: [UUID: Client] = [:]
    private var startCallback: (@Sendable (Result<URL, Error>) -> Void)?
    private var origin: String?
    private var host: String?
    private var started = false
    private var requests: [String: Authorization] = [:]
    private var codes: [String: Grant] = [:]
    private var sessions: [String: Date] = [:]

    private static let account = ["name": "Conpera Creator", "email": "creator@example.test"]
    private static let cookieName = "conpera_demo_session"
    private static let requestLimit = 8 * 1024

    init(resourceRoot: URL, demoEnabled: Bool = true) {
        self.demoEnabled = demoEnabled
        self.resourceRoot = resourceRoot.standardizedFileURL.resolvingSymlinksInPath()
    }

    func start(completion: @escaping @Sendable (Result<URL, Error>) -> Void) {
        queue.async { [self] in
            guard !started else {
                completion(.failure(Failure(500, "already_started", "The local demo is already started.")))
                return
            }
            started = true
            startCallback = completion
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                parameters.allowLocalEndpointReuse = false
                let newListener = try NWListener(using: parameters)
                listener = newListener
                newListener.newConnectionHandler = { [weak self] connection in
                    guard let self, self.connections.count < 64 else {
                        connection.cancel()
                        return
                    }
                    let identifier = UUID()
                    let client = Client(connection: connection, queue: self.queue, identifier: identifier, server: self)
                    self.connections[identifier] = client
                    client.start()
                }
                newListener.stateUpdateHandler = { [weak self, weak newListener] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        guard let port = newListener?.port else {
                            self.finishStart(.failure(Failure(500, "bind_failed", "The local demo could not select a port.")))
                            return
                        }
                        let host = "127.0.0.1:\(port.rawValue)"
                        self.host = host
                        self.origin = "http://\(host)"
                        self.finishStart(.success(URL(string: "http://\(host)/")!))
                    case .failed(let error):
                        self.finishStart(.failure(error))
                        newListener?.cancel()
                    case .cancelled:
                        self.finishStart(.failure(Failure(500, "server_stopped", "The local demo was stopped.")))
                    default: break
                    }
                }
                newListener.start(queue: queue)
            } catch {
                finishStart(.failure(error))
            }
        }
    }

    func stop() {
        queue.async { [self] in
            listener?.cancel()
            listener = nil
            for client in Array(connections.values) { client.close() }
            requests.removeAll()
            codes.removeAll()
            sessions.removeAll()
            origin = nil
            host = nil
            finishStart(.failure(Failure(500, "server_stopped", "The local demo was stopped.")))
        }
    }

    private func finishStart(_ result: Result<URL, Error>) {
        let callback = startCallback
        startCallback = nil
        callback?(result)
    }

    private struct Authorization {
        let challenge: String
        let state: String
        let expiresAt: Date
        var approved = false
        var codeHash: String?
    }

    private struct Grant {
        let challenge: String
        let expiresAt: Date
        let requestID: String
    }

    private struct Failure: Error, LocalizedError {
        let status: Int
        let code: String
        let message: String
        init(_ status: Int, _ code: String, _ message: String) {
            self.status = status
            self.code = code
            self.message = message
        }
        var errorDescription: String? { message }
    }

    private struct Request {
        let method: String
        let target: String
        let headers: [String: String]
        var body = Data()
    }

    private struct Response {
        var status: Int
        var body = Data()
        var headers: [String: String] = [:]
        var omitBody = false

        static func json(_ status: Int, _ object: [String: Any], headers: [String: String] = [:]) throws -> Response {
            var headers = headers
            headers["Content-Type"] = "application/json; charset=utf-8"
            return Response(status: status, body: try JSONSerialization.data(withJSONObject: object), headers: headers)
        }

        func encoded() -> Data {
            let reasons = [200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 413: "Content Too Large", 415: "Unsupported Media Type", 417: "Expectation Failed", 429: "Too Many Requests", 500: "Internal Server Error", 505: "HTTP Version Not Supported"]
            var values = headers
            values["Content-Length"] = String(body.count)
            values["Connection"] = "close"
            values["Cache-Control"] = "no-store"
            values["X-Content-Type-Options"] = "nosniff"
            values["Referrer-Policy"] = "no-referrer"
            var header = "HTTP/1.1 \(status) \(reasons[status] ?? "Error")\r\n"
            for key in values.keys.sorted() { header += "\(key): \(values[key]!)\r\n" }
            header += "\r\n"
            var result = Data(header.utf8)
            if !omitBody { result.append(body) }
            return result
        }
    }

    private final class Client: @unchecked Sendable {
        let connection: NWConnection
        let queue: DispatchQueue
        let identifier: UUID
        weak var server: LocalDemoServer?
        var buffer = Data()
        var parsed: Request?
        var headerLength = 0
        var bodyLength = 0
        var timer: DispatchSourceTimer?
        var responded = false
        var closed = false

        init(connection: NWConnection, queue: DispatchQueue, identifier: UUID, server: LocalDemoServer) {
            self.connection = connection
            self.queue = queue
            self.identifier = identifier
            self.server = server
        }

        func start() {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 10)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                if self.responded { self.close() }
                else { self.fail(Failure(408, "request_timeout", "The local request timed out.")) }
            }
            self.timer = timer
            timer.resume()
            connection.stateUpdateHandler = { [weak self] state in
                if case .failed = state { self?.close() }
                if case .cancelled = state { self?.close() }
            }
            connection.start(queue: queue)
            receive()
        }

        func receive() {
            guard !responded, !closed else { return }
            connection.receive(minimumIncompleteLength: 1, maximumLength: LocalDemoServer.requestLimit + 1) { [weak self] data, _, complete, error in
                guard let self, !self.responded, !self.closed else { return }
                if let data { self.buffer.append(data) }
                do {
                    guard self.buffer.count <= LocalDemoServer.requestLimit else {
                        throw Failure(413, "payload_too_large", "The local request exceeds 8 KiB.")
                    }
                    if self.parsed == nil, let boundary = self.buffer.range(of: Data("\r\n\r\n".utf8)) {
                        self.headerLength = boundary.upperBound
                        self.parsed = try self.parseHeaders(Data(self.buffer[..<boundary.lowerBound]))
                        guard self.headerLength + self.bodyLength <= LocalDemoServer.requestLimit else {
                            throw Failure(413, "payload_too_large", "The local request exceeds 8 KiB.")
                        }
                    }
                    if var request = self.parsed, self.buffer.count >= self.headerLength + self.bodyLength {
                        guard self.buffer.count == self.headerLength + self.bodyLength else {
                            throw Failure(400, "invalid_request", "HTTP pipelining is not supported.")
                        }
                        request.body = Data(self.buffer[self.headerLength...])
                        guard let server = self.server else { self.close(); return }
                        self.send(try server.handle(request))
                        return
                    }
                    if error != nil { self.close(); return }
                    if complete { throw Failure(400, "incomplete_request", "The HTTP request is incomplete.") }
                    self.receive()
                } catch { self.fail(error) }
            }
        }

        func parseHeaders(_ data: Data) throws -> Request {
            guard let text = String(data: data, encoding: .ascii) else {
                throw Failure(400, "invalid_request", "HTTP headers must be ASCII.")
            }
            let lines = text.components(separatedBy: "\r\n")
            let first = (lines.first ?? "").components(separatedBy: " ")
            guard first.count == 3, !first[0].isEmpty, first[1].hasPrefix("/"),
                  !first[1].hasPrefix("//"), !first[1].contains("#"),
                  first[0].utf8.allSatisfy({ (65...90).contains($0) }),
                  first[1].utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else {
                throw Failure(400, "invalid_request", "Invalid HTTP request line.")
            }
            guard first[2] == "HTTP/1.1" else { throw Failure(505, "unsupported_http", "Use HTTP/1.1.") }
            var headers: [String: String] = [:]
            let tokenBytes = Set("!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { throw Failure(400, "invalid_headers", "Invalid HTTP header.") }
                let name = String(line[..<colon])
                let raw = String(line[line.index(after: colon)...])
                guard !name.isEmpty, name.utf8.allSatisfy({ tokenBytes.contains($0) }),
                      raw.utf8.allSatisfy({ $0 == 9 || ($0 >= 32 && $0 < 127) }) else {
                    throw Failure(400, "invalid_headers", "Invalid HTTP header.")
                }
                let normalized = name.lowercased()
                guard headers[normalized] == nil else { throw Failure(400, "duplicate_header", "Duplicate HTTP headers are not accepted.") }
                headers[normalized] = raw.trimmingCharacters(in: .whitespaces)
            }
            guard headers["transfer-encoding"] == nil else { throw Failure(400, "unsupported_encoding", "Transfer-Encoding is not supported.") }
            guard headers["expect"] == nil else { throw Failure(417, "unsupported_expectation", "Expect is not supported.") }
            if let length = headers["content-length"] {
                guard !length.isEmpty, length.utf8.allSatisfy({ (48...57).contains($0) }), let number = Int(length) else {
                    throw Failure(400, "invalid_length", "Invalid Content-Length.")
                }
                guard number <= LocalDemoServer.requestLimit else {
                    throw Failure(413, "payload_too_large", "The local request exceeds 8 KiB.")
                }
                bodyLength = number
            }
            return Request(method: first[0], target: first[1], headers: headers)
        }

        func fail(_ error: Error) {
            let failure = error as? Failure ?? Failure(500, "internal_error", "Unexpected local demo error.")
            let response = (try? Response.json(failure.status, ["error": failure.code, "message": failure.message])) ?? Response(status: 500)
            send(response)
        }

        func send(_ response: Response) {
            guard !responded, !closed else { return }
            responded = true
            // Bound the response send as well as request reception.
            timer?.schedule(deadline: .now() + 10)
            connection.send(content: response.encoded(), contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in
                self?.close()
            })
        }

        func close() {
            guard !closed else { return }
            closed = true
            timer?.cancel()
            timer = nil
            connection.stateUpdateHandler = nil
            connection.cancel()
            server?.connections.removeValue(forKey: identifier)
        }
    }

    private func handle(_ request: Request) throws -> Response {
        guard let host, request.headers["host"] == host else {
            throw Failure(403, "invalid_host", "Only this local demo host is accepted.")
        }
        if let suppliedOrigin = request.headers["origin"], suppliedOrigin != origin {
            throw Failure(403, "invalid_origin", "Only this local demo Origin is accepted.")
        }
        if !["GET", "HEAD", "OPTIONS"].contains(request.method), request.headers["origin"] != origin {
            throw Failure(403, "invalid_origin", "A trusted local Origin is required.")
        }
        let encodedPath = String(request.target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        guard let path = encodedPath.removingPercentEncoding, path.hasPrefix("/"), !path.contains("\\"),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else {
            throw Failure(400, "invalid_path", "Invalid request path.")
        }
        if !demoEnabled && (path.hasPrefix("/api/") || path.hasPrefix("/oauth/")) {
            throw Failure(404, "not_found", "Not found.")
        }
        let now = Date()
        requests = requests.filter { $0.value.expiresAt > now }
        codes = codes.filter { $0.value.expiresAt > now }
        sessions = sessions.filter { $0.value > now }

        if path == "/api/demo/authorizations", request.method == "POST" {
            let body = try json(request, fields: ["codeChallenge", "state"])
            let challenge = body["codeChallenge"]!, state = body["state"]!
            guard isID(challenge), let decoded = decodeBase64URL(challenge), base64URL(decoded) == challenge,
                  (32...128).contains(state.utf8.count), isUnreserved(state) else {
                throw Failure(400, "invalid_request", "A canonical S256 challenge and 32–128 character state are required.")
            }
            guard requests.count < 1000 else { throw Failure(429, "too_many_requests", "Too many pending demo authorizations.") }
            let identifier = try token()
            requests[identifier] = Authorization(challenge: challenge, state: state, expiresAt: now.addingTimeInterval(300))
            return try .json(201, ["requestId": identifier, "authorizationUrl": "/authorize?request=\(identifier)"])
        }

        let parts = path.split(separator: "/").map(String.init)
        if (parts.count == 4 || (parts.count == 5 && parts[4] == "approve")),
           Array(parts.prefix(3)) == ["api", "demo", "authorizations"], isID(parts[3]) {
            let identifier = parts[3]
            guard var authorization = requests[identifier] else { throw Failure(404, "authorization_not_found", "Authorization request is missing or expired.") }
            if parts.count == 4, request.method == "GET" {
                return try .json(200, ["clientName": "Conpera Switch", "scopes": ["profile:read", "balance:read"], "account": Self.account, "state": authorization.state])
            }
            if parts.count == 4, request.method == "DELETE" {
                requests.removeValue(forKey: identifier)
                if let codeHash = authorization.codeHash { codes.removeValue(forKey: codeHash) }
                return Response(status: 204)
            }
            if parts.count == 5, request.method == "POST" {
                guard !authorization.approved else { throw Failure(409, "already_approved", "This authorization was already approved.") }
                let code = try token(), codeHash = hash(code)
                authorization.approved = true
                authorization.codeHash = codeHash
                requests[identifier] = authorization
                codes[codeHash] = Grant(challenge: authorization.challenge, expiresAt: now.addingTimeInterval(60), requestID: identifier)
                return try .json(200, ["code": code, "state": authorization.state])
            }
            throw Failure(405, "method_not_allowed", "Unsupported method.")
        }

        if path == "/api/demo/session" {
            switch request.method {
            case "POST":
                let body = try json(request, fields: ["code", "codeVerifier"])
                let code = body["code"]!, verifier = body["codeVerifier"]!
                guard isID(code), (43...128).contains(verifier.utf8.count), isUnreserved(verifier) else {
                    throw Failure(400, "invalid_request", "A valid code and RFC 7636 verifier are required.")
                }
                let grant = codes.removeValue(forKey: hash(code))
                if let grant { requests.removeValue(forKey: grant.requestID) }
                // Valid codes are consumed even on a failed verifier attempt.
                guard let grant, grant.expiresAt > now, constantTimeEqual(hash(verifier), grant.challenge) else {
                    throw Failure(400, "invalid_grant", "Authorization code or PKCE verifier is invalid or expired.")
                }
                guard sessions.count < 1000 else { throw Failure(429, "too_many_sessions", "Too many local demo sessions.") }
                if let oldCookie = cookie(request) { sessions.removeValue(forKey: hash(oldCookie)) }
                let value = try token(), expiry = now.addingTimeInterval(3600)
                sessions[hash(value)] = expiry
                return try .json(200, ["user": Self.account, "expiresAt": timestamp(expiry)], headers: ["Set-Cookie": sessionCookie(value, maxAge: 3600)])
            case "GET":
                let expiry = try session(request)
                return try .json(200, ["user": Self.account, "expiresAt": timestamp(expiry)])
            case "DELETE":
                if let value = cookie(request) { sessions.removeValue(forKey: hash(value)) }
                return Response(status: 204, headers: ["Set-Cookie": sessionCookie("", maxAge: 0)])
            default: throw Failure(405, "method_not_allowed", "Unsupported method.")
            }
        }
        if path == "/api/demo/session/expire", request.method == "POST" {
            _ = try session(request)
            if let value = cookie(request) { sessions.removeValue(forKey: hash(value)) }
            return Response(status: 204, headers: ["Set-Cookie": sessionCookie("", maxAge: 0)])
        }
        if path == "/api/demo/balance", request.method == "GET" {
            _ = try session(request)
            return try .json(200, ["balance": 128.5, "currency": "CNY", "updatedAt": timestamp(now)])
        }
        if path.hasPrefix("/api/") { throw Failure(404, "not_found", "Unknown demo API endpoint.") }
        return try staticFile(path, method: request.method)
    }

    private func staticFile(_ path: String, method: String) throws -> Response {
        guard method == "GET" || method == "HEAD" else { throw Failure(405, "method_not_allowed", "Unsupported method.") }
        var file = resourceRoot.appendingPathComponent(String(path.dropFirst())).standardizedFileURL.resolvingSymlinksInPath()
        let prefix = resourceRoot.path.hasSuffix("/") ? resourceRoot.path : resourceRoot.path + "/"
        guard file.path == resourceRoot.path || file.path.hasPrefix(prefix) else { throw Failure(403, "invalid_path", "File is outside the demo build.") }
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory)
        if !exists || isDirectory.boolValue {
            if !exists && !file.pathExtension.isEmpty { throw Failure(404, "not_found", "File not found.") }
            file = resourceRoot.appendingPathComponent("index.html").resolvingSymlinksInPath()
        }
        guard file.path.hasPrefix(prefix), let values = try? file.resourceValues(forKeys: [.isRegularFileKey]), values.isRegularFile == true,
              let data = try? Data(contentsOf: file) else { throw Failure(404, "build_not_found", "The bundled demo build is unavailable.") }
        let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "json": "application/json; charset=utf-8", "svg": "image/svg+xml", "png": "image/png", "webp": "image/webp", "ico": "image/x-icon", "woff2": "font/woff2", "woff": "font/woff"]
        return Response(status: 200, body: data, headers: ["Content-Type": mime[file.pathExtension.lowercased()] ?? "application/octet-stream"], omitBody: method == "HEAD")
    }

    private func json(_ request: Request, fields: Set<String>) throws -> [String: String] {
        let media = request.headers["content-type"]?.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces).lowercased()
        guard media == "application/json" else { throw Failure(415, "unsupported_media_type", "Use application/json.") }
        guard let object = try? JSONSerialization.jsonObject(with: request.body), let body = object as? [String: String], Set(body.keys) == fields else {
            throw Failure(400, "invalid_request", "A JSON object with the required string fields is expected.")
        }
        return body
    }

    private func session(_ request: Request) throws -> Date {
        guard let value = cookie(request), let expiry = sessions[hash(value)], expiry > Date() else {
            // A late GET failure must never clear a newer session cookie.
            throw Failure(401, "unauthenticated", "Demo session is missing or expired.")
        }
        return expiry
    }

    private func cookie(_ request: Request) -> String? {
        let values = (request.headers["cookie"] ?? "").split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.hasPrefix(Self.cookieName + "=") }
        guard values.count == 1 else { return nil }
        let value = String(values[0].dropFirst(Self.cookieName.count + 1))
        return isID(value) ? value : nil
    }

    private func sessionCookie(_ value: String, maxAge: Int) -> String {
        // HTTP is deliberately loopback-only. Production must use HTTPS + Secure.
        "\(Self.cookieName)=\(value); HttpOnly; SameSite=Strict; Path=/api/demo; Max-Age=\(maxAge)"
    }

    private func token() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw Failure(500, "random_unavailable", "Secure local randomness is unavailable.")
        }
        return base64URL(Data(bytes))
    }

    private func hash(_ value: String) -> String { base64URL(Data(SHA256.hash(data: Data(value.utf8)))) }
    private func base64URL(_ value: Data) -> String { value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    private func decodeBase64URL(_ value: String) -> Data? { Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)) }
    private func isID(_ value: String) -> Bool { value.utf8.count == 43 && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 } }
    private func isUnreserved(_ value: String) -> Bool { !value.isEmpty && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95, 126].contains($0) } }
    private func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let a = Array(left.utf8), b = Array(right.utf8)
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for index in a.indices { difference |= a[index] ^ b[index] }
        return difference == 0
    }
    private func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
