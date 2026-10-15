import Foundation
import CryptoKit
import Darwin

/// Edits only explicitly selected user-level configuration files. Account credentials
/// and Codex auth.json are deliberately outside this component's interface.
final class ConfigurationManager {
    struct Failure: Error, LocalizedError {
        let status: Int
        let code: String
        let message: String
        var errorDescription: String? { message }
    }

    private struct Snapshot: Codable, Equatable {
        let data: Data?
        let permissions: UInt16
        var digest: String { data.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "absent" }
    }
    private struct Record: Codable, Equatable {
        let version: Int
        let target: String
        let original: Snapshot
        let appliedDigest: String?
        let keyId: String?
    }
    private struct Journal: Codable {
        let version: Int
        let target: String
        let before: Snapshot
        let after: Snapshot
        let previous: Record?
        let next: Record
    }
    private struct SettingsUndo: Codable {
        let target: String
        let before: Snapshot
        let afterDigest: String
        let previous: Record?
        let next: Record
    }
    private let home: URL
    private let targets: [String: URL]
    private let stateDirectory: URL
    private let maximumFileSize = 4 * 1024 * 1024

    init(home: URL, codexDirectory: URL? = nil, claudeDirectory: URL? = nil, stateDirectory: URL? = nil) {
        self.home = home
        self.targets = [
            "codex": (codexDirectory ?? home.appendingPathComponent(".codex")).appendingPathComponent("config.toml"),
            "claude": (claudeDirectory ?? home.appendingPathComponent(".claude")).appendingPathComponent("settings.json"),
        ]
        self.stateDirectory = (stateDirectory ?? home.appendingPathComponent("Library/Application Support/Conpera Switch/configuration"))
    }

    func status() throws -> [String: Any] {
        try withLock { directory in
            try recoverAll(directory)
            return try result(directory)
        }
    }

    func configurationDetails(tool: String) throws -> [String: Any] {
        try validateTool(tool)
        return try withLock { directory in
            try recoverAll(directory)
            return try details(tool, directory)
        }
    }

    func saveConfiguration(tool: String, revision: String, content: String) throws -> [String: Any] {
        try validateTool(tool)
        return try withLock { directory in
            try recoverAll(directory)
            let target = targets[tool]!
            let previous = try record(tool, directory)
            try validateRecord(previous, target: target)
            let before = try snapshot(target)
            try validateSettingsRevision(revision, before: before, record: previous)
            let source = try ConfigurationDocument.source(before.data, tool: tool)
            let restored = try ConfigurationDocument.restore(content, original: source, tool: tool, active: previous?.appliedDigest != nil)
            let data = Data(restored.utf8)
            if data == before.data { return try details(tool, directory) }
            let after = Snapshot(data: data, permissions: 0o600)
            let active = previous?.appliedDigest != nil
            let next = Record(version: 1, target: target.path, original: active ? previous!.original : after,
                              appliedDigest: active ? after.digest : nil, keyId: active ? previous?.keyId : nil)
            let undo = SettingsUndo(target: target.path, before: before, afterDigest: after.digest, previous: previous, next: next)
            try save(undo, name: tool + ".settings-undo.json", directory: directory)
            try transact(tool: tool, before: before, after: after, previous: previous, next: next, directory: directory)
            return try details(tool, directory)
        }
    }

    func undoConfiguration(tool: String, revision: String) throws -> [String: Any] {
        try validateTool(tool)
        return try withLock { directory in
            try recoverAll(directory)
            let target = targets[tool]!
            let previous = try record(tool, directory)
            try validateRecord(previous, target: target)
            let before = try snapshot(target)
            try validateSettingsRevision(revision, before: before, record: previous)
            guard let undo = try settingsUndo(tool, directory), undo.target == target.path,
                  undo.afterDigest == before.digest, undo.next == previous else {
                throw failure(409, "settings_undo_unavailable", "配置已变化，无法撤销上次保存。备份仍保留。")
            }
            let next = undo.previous ?? Record(version: 1, target: target.path, original: undo.before, appliedDigest: nil, keyId: nil)
            try transact(tool: tool, before: before, after: undo.before, previous: previous, next: next, directory: directory)
            try directory.remove(tool + ".settings-undo.json")
            return try details(tool, directory)
        }
    }

    private func settingsUndo(_ tool: String, _ directory: SafeDirectory) throws -> SettingsUndo? {
        guard let data = try directory.read(tool + ".settings-undo.json", maximum: maximumFileSize * 8, privateFile: true)?.data else { return nil }
        guard let undo = try? JSONDecoder().decode(SettingsUndo.self, from: data) else {
            throw failure(409, "invalid_backup", "配置编辑备份无法读取，未修改配置。")
        }
        return undo
    }

    private func settingsRevision(_ snapshot: Snapshot, _ record: Record?) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let recordData = try encoder.encode(record)
        return SHA256.hash(data: Data((snapshot.digest + ":" + String(snapshot.permissions)).utf8) + recordData).map { String(format: "%02x", $0) }.joined()
    }

    private func validateSettingsRevision(_ revision: String, before: Snapshot, record: Record?) throws {
        guard revision == (try settingsRevision(before, record)), record?.appliedDigest == nil || record?.appliedDigest == before.digest else {
            throw failure(409, "configuration_changed", "配置已被其他操作修改，未覆盖文件。请重新读取后再编辑。")
        }
    }

    private func details(_ tool: String, _ directory: SafeDirectory) throws -> [String: Any] {
        let target = targets[tool]!, current = try record(tool, directory)
        try validateRecord(current, target: target)
        let snapshot = try snapshot(target)
        let content = try ConfigurationDocument.redact(ConfigurationDocument.source(snapshot.data, tool: tool), tool: tool).content
        let conflict = current?.appliedDigest != nil && current?.appliedDigest != snapshot.digest
        let undo = try settingsUndo(tool, directory)
        return ["tool": tool, "content": content, "fields": try ConfigurationDocument.fields(content, tool: tool),
                "revision": try settingsRevision(snapshot, current), "mode": conflict ? "conflict" : current?.appliedDigest != nil ? "conpera" : "original",
                "canUndo": !conflict && undo?.target == target.path && undo?.afterDigest == snapshot.digest && undo?.next == current,
                "restartRequired": true]
    }

    func apply(tool: String, keyId: String, apiKey: String, baseURL: String, model: String? = nil) throws -> [String: Any] {
        try validateTool(tool)
        guard !keyId.isEmpty, keyId.utf8.count <= 256,
              !apiKey.isEmpty, apiKey.utf8.count <= 16384,
              !apiKey.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let endpoint = URLComponents(string: baseURL), endpoint.scheme == "https",
              let host = endpoint.host, !host.isEmpty, endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil,
              !baseURL.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }) else {
            throw failure(400, "invalid_configuration", "密钥或服务地址格式无效。")
        }
        if let model, model.isEmpty || model.utf8.count > 256 || model.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) {
            throw failure(400, "invalid_configuration", "模型名称格式无效。")
        }
        return try withLock { directory in
            try recoverAll(directory)
            let target = targets[tool]!
            let previous = try record(tool, directory)
            try validateRecord(previous, target: target)
            let before = try snapshot(target)
            if let digest = previous?.appliedDigest, digest != before.digest {
                throw failure(409, "configuration_changed", "配置已被其他程序修改，请先处理冲突。原机备份已保留。")
            }
            let data: Data
            if tool == "codex" {
                data = try CodexConfigurationEditor.edit(before.data, key: apiKey, endpoint: baseURL, model: model)
            } else {
                data = try claudeConfiguration(before.data, key: apiKey, endpoint: baseURL)
            }
            guard data.count <= maximumFileSize else {
                throw failure(422, "configuration_too_large", "配置文件超过支持的大小，未作修改。")
            }
            let after = Snapshot(data: data, permissions: 0o600)
            let original = previous?.appliedDigest != nil ? previous!.original : before
            let next = Record(version: 1, target: target.path, original: original, appliedDigest: after.digest, keyId: keyId)
            try transact(tool: tool, before: before, after: after, previous: previous, next: next, directory: directory)
            return try result(directory)
        }
    }

    /// Recovery remains available without an online account session.
    func restore(tool: String) throws -> [String: Any] {
        try validateTool(tool)
        return try withLock { directory in
            try recoverAll(directory)
            let target = targets[tool]!
            guard let previous = try record(tool, directory), let digest = previous.appliedDigest else {
                return try result(directory)
            }
            try validateRecord(previous, target: target)
            let before = try snapshot(target)
            guard before.digest == digest else {
                throw failure(409, "configuration_changed", "配置已被其他程序修改，无法覆盖恢复。原机备份已保留。")
            }
            let next = Record(version: 1, target: target.path, original: previous.original, appliedDigest: nil, keyId: nil)
            try transact(tool: tool, before: before, after: previous.original, previous: previous, next: next, directory: directory)
            return try result(directory)
        }
    }

    private func validateTool(_ tool: String) throws {
        guard targets[tool] != nil else { throw failure(400, "unsupported_tool", "不支持此客户端。") }
    }

    private func failure(_ status: Int, _ code: String, _ message: String) -> Failure {
        Failure(status: status, code: code, message: message)
    }

    private func validateRecord(_ record: Record?, target: URL) throws {
        if let record, record.version != 1 || record.target != target.path {
            throw failure(409, "configuration_location_changed", "配置目录与已保存的备份不一致，请恢复原目录后重试。")
        }
    }

    private func claudeConfiguration(_ data: Data?, key: String, endpoint: String) throws -> Data {
        var object: [String: Any] = [:]
        if let data {
            guard let parsed = try? JSONSerialization.jsonObject(with: data), let value = parsed as? [String: Any] else {
                throw failure(422, "unsupported_configuration", "Claude Code 配置不是有效的 JSON 对象，未作修改。")
            }
            object = value
        }
        guard object["env"] == nil || object["env"] is [String: Any] else {
            throw failure(422, "unsupported_configuration", "Claude Code 的 env 配置格式不受支持，未作修改。")
        }
        var environment = object["env"] as? [String: Any] ?? [:]
        environment["ANTHROPIC_BASE_URL"] = endpoint
        environment["ANTHROPIC_AUTH_TOKEN"] = key
        environment.removeValue(forKey: "ANTHROPIC_API_KEY")
        object["env"] = environment
        var output = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        output.append(10)
        return output
    }

    private func result(_ directory: SafeDirectory) throws -> [String: Any] {
        var tools: [String: Any] = [:]
        for tool in ["codex", "claude"] {
            let current = try record(tool, directory)
            try validateRecord(current, target: targets[tool]!)
            var value: [String: Any] = ["mode": "original"]
            if let current, let digest = current.appliedDigest {
                value["mode"] = try snapshot(targets[tool]!).digest == digest ? "conpera" : "conflict"
                if let keyId = current.keyId { value["keyId"] = keyId }
            }
            tools[tool] = value
        }
        return ["tools": tools, "restartRequired": true,
                "notice": "配置写入后请重启客户端。项目配置、受管理配置或启动环境可能覆盖用户配置。"]
    }

    private func record(_ tool: String, _ directory: SafeDirectory) throws -> Record? {
        guard let data = try directory.read(tool + ".backup.json", maximum: maximumFileSize * 2, privateFile: true)?.data else { return nil }
        guard let record = try? JSONDecoder().decode(Record.self, from: data) else {
            throw failure(409, "invalid_backup", "原机备份无法读取，未修改客户端配置。")
        }
        return record
    }

    private func snapshot(_ target: URL) throws -> Snapshot {
        guard let parent = try SafeDirectory.open(target.deletingLastPathComponent(), create: false) else {
            return Snapshot(data: nil, permissions: 0o600)
        }
        guard let file = try parent.read(target.lastPathComponent, maximum: maximumFileSize) else {
            return Snapshot(data: nil, permissions: 0o600)
        }
        return Snapshot(data: file.data, permissions: file.permissions)
    }

    private func save<T: Encodable>(_ value: T, name: String, directory: SafeDirectory) throws {
        let data = try JSONEncoder().encode(value)
        try directory.replace(name, data: data, permissions: 0o600)
    }

    private func transact(tool: String, before: Snapshot, after: Snapshot, previous: Record?, next: Record, directory: SafeDirectory) throws {
        let journal = Journal(version: 1, target: targets[tool]!.path, before: before, after: after, previous: previous, next: next)
        // The durable journal contains the original bytes before any target mutation.
        try save(journal, name: tool + ".journal.json", directory: directory)
        do {
            try replaceTarget(targets[tool]!, expected: before, replacement: after)
            try save(next, name: tool + ".backup.json", directory: directory)
            try directory.remove(tool + ".journal.json")
        } catch {
            // A journal intentionally remains when state is uncertain. A later call
            // reconciles known before/after bytes; it never overwrites a third version.
            throw error
        }
    }

    private func replaceTarget(_ target: URL, expected: Snapshot, replacement: Snapshot) throws {
        guard try snapshot(target).digest == expected.digest else {
            throw failure(409, "configuration_changed", "配置在操作期间发生变化，已保留恢复记录。")
        }
        guard let parent = try SafeDirectory.open(target.deletingLastPathComponent(), create: replacement.data != nil) else { return }
        if let data = replacement.data {
            try parent.replace(target.lastPathComponent, data: data, permissions: replacement.permissions)
        } else {
            try parent.remove(target.lastPathComponent)
        }
        guard try snapshot(target).digest == replacement.digest else {
            throw failure(409, "configuration_changed", "配置写入后的校验未通过，已保留恢复记录。")
        }
    }

    private func recoverAll(_ directory: SafeDirectory) throws {
        for tool in ["codex", "claude"] {
            let name = tool + ".journal.json"
            guard let data = try directory.read(name, maximum: maximumFileSize * 8, privateFile: true)?.data else { continue }
            guard let journal = try? JSONDecoder().decode(Journal.self, from: data), journal.version == 1,
                  journal.target == targets[tool]!.path, journal.next.target == journal.target,
                  journal.previous == nil || journal.previous?.target == journal.target else {
                throw failure(409, "invalid_journal", "恢复记录无法验证，未修改客户端配置。")
            }
            let current = try snapshot(targets[tool]!)
            if current.digest == journal.after.digest {
                try save(journal.next, name: tool + ".backup.json", directory: directory)
            } else if current.digest == journal.before.digest {
                if let previous = journal.previous {
                    try save(previous, name: tool + ".backup.json", directory: directory)
                } else {
                    try directory.remove(tool + ".backup.json")
                }
            } else {
                throw failure(409, "recovery_conflict", "未完成操作的配置已发生外部修改。恢复记录和原机备份均已保留。")
            }
            try directory.remove(name)
        }
    }

    private func withLock<T>(_ operation: (SafeDirectory) throws -> T) throws -> T {
        guard home.isFileURL, home.path.hasPrefix("/"),
              targets.values.allSatisfy({ $0.isFileURL && $0.path.hasPrefix("/") }),
              let _ = try SafeDirectory.open(home, create: false),
              let directory = try SafeDirectory.open(stateDirectory, create: true) else {
            throw failure(400, "invalid_directory", "本机配置目录无效。")
        }
        try directory.makePrivate()
        let lock = try directory.lock()
        defer { flock(lock, LOCK_UN); close(lock) }
        return try operation(directory)
    }

    /// Directory-relative operations never follow symlinks, including intermediate
    /// path components. This also prevents a renamed parent from redirecting writes.
    private final class SafeDirectory {
        let descriptor: Int32
        init(_ descriptor: Int32) { self.descriptor = descriptor }
        deinit { close(descriptor) }

        static func error(_ code: String = "unsafe_configuration_path") -> Failure {
            Failure(status: 409, code: code, message: "配置文件或目录不可安全访问，未覆盖原有数据。")
        }

        static func open(_ url: URL, create: Bool) throws -> SafeDirectory? {
            guard url.isFileURL, url.path.hasPrefix("/"), !url.path.contains("\0") else { throw error() }
            var current = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            guard current >= 0 else { throw error() }
            do {
                for component in url.path.split(separator: "/").map(String.init) {
                    guard component != ".", component != ".." else { throw error() }
                    var next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    if next < 0 && errno == ENOENT {
                        guard create else { close(current); return nil }
                        if mkdirat(current, component, 0o700) != 0 && errno != EEXIST { throw error("configuration_io_error") }
                        next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    }
                    guard next >= 0 else { throw error() }
                    close(current)
                    current = next
                }
                var metadata = stat()
                guard fstat(current, &metadata) == 0, metadata.st_uid == getuid() else { throw error() }
                return SafeDirectory(current)
            } catch {
                close(current)
                throw error
            }
        }

        func makePrivate() throws {
            guard fchmod(descriptor, 0o700) == 0 else { throw Self.error("configuration_io_error") }
        }

        func lock() throws -> Int32 {
            let file = openat(descriptor, ".lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard file >= 0 else { throw Self.error() }
            do {
                try validate(file)
                guard fchmod(file, 0o600) == 0 else { throw Self.error() }
                guard flock(file, LOCK_EX | LOCK_NB) == 0 else {
                    throw Failure(status: 409, code: "configuration_busy", message: "另一个 Conpera Switch 正在修改配置，请稍后重试。")
                }
                return file
            } catch { close(file); throw error }
        }

        private func validate(_ file: Int32) throws {
            var metadata = stat()
            guard fstat(file, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
                  metadata.st_uid == getuid(), metadata.st_nlink == 1 else { throw Self.error() }
        }

        func read(_ name: String, maximum: Int, privateFile: Bool = false) throws -> (data: Data, permissions: UInt16)? {
            let file = openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            if file < 0 && errno == ENOENT { return nil }
            guard file >= 0 else { throw Self.error() }
            defer { close(file) }
            try validate(file)
            var metadata = stat()
            guard fstat(file, &metadata) == 0, metadata.st_size >= 0, metadata.st_size <= maximum,
                  !privateFile || metadata.st_mode & 0o077 == 0 else { throw Self.error() }
            var data = Data()
            var bytes = [UInt8](repeating: 0, count: 16384)
            while true {
                let count = Darwin.read(file, &bytes, bytes.count)
                if count < 0 && errno == EINTR { continue }
                guard count >= 0 else { throw Self.error("configuration_io_error") }
                if count == 0 { break }
                data.append(contentsOf: bytes.prefix(count))
                guard data.count <= maximum else { throw Self.error() }
            }
            return (data, UInt16(metadata.st_mode & 0o777))
        }

        func replace(_ name: String, data: Data, permissions: UInt16) throws {
            // Validate an existing destination even though rename itself would not
            // follow its symlink. Replacing a link would destroy user intent.
            _ = try read(name, maximum: 32 * 1024 * 1024)
            let temporary = ".conpera-" + UUID().uuidString + ".tmp"
            let file = openat(descriptor, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard file >= 0 else { throw Self.error("configuration_io_error") }
            defer { close(file); unlinkat(descriptor, temporary, 0) }
            try data.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let written = Darwin.write(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if written < 0 && errno == EINTR { continue }
                    guard written > 0 else { throw Self.error("configuration_io_error") }
                    offset += written
                }
            }
            guard fchmod(file, mode_t(permissions)) == 0, fsync(file) == 0,
                  renameat(descriptor, temporary, descriptor, name) == 0,
                  fsync(descriptor) == 0 else { throw Self.error("configuration_io_error") }
        }

        func remove(_ name: String) throws {
            guard try read(name, maximum: 32 * 1024 * 1024) != nil else { return }
            guard unlinkat(descriptor, name, 0) == 0, fsync(descriptor) == 0 else { throw Self.error("configuration_io_error") }
        }
    }
}

/// A deliberately restricted, string-aware TOML editor. Unsupported constructs
/// fail before journaling. Unrelated source lines are preserved byte-for-byte.
enum CodexConfigurationEditor {
    struct Entry { let line: Int; let path: [String]; let value: String; let prefix: String; let suffix: String }
    struct Header { let line: Int; let path: [String] }
    struct Document { let lines: [String]; let newline: String; let entries: [Entry]; let headers: [Header] }

    static func unsupported() -> ConfigurationManager.Failure {
        .init(status: 422, code: "unsupported_configuration", message: "Codex 配置包含暂不支持或无效的 TOML 格式，未作修改。")
    }

    static func parse(_ data: Data?) throws -> Document {
        let source: String
        if let data {
            guard let string = String(data: data, encoding: .utf8), !string.hasPrefix("\u{FEFF}") else { throw unsupported() }
            source = string
        } else { source = "" }
        let newline = source.contains("\r\n") ? "\r\n" : "\n"
        guard !source.replacingOccurrences(of: "\r\n", with: "").contains("\r") else { throw unsupported() }
        var lines = source.components(separatedBy: newline)
        if lines.last == "" { lines.removeLast() }
        var section: [String] = []
        var entries: [Entry] = []
        var headers: [Header] = []
        var assigned = Set<String>()
        var sections = Set<String>()
        for (index, line) in lines.enumerated() {
            var parser = Parser(line)
            parser.whitespace()
            if parser.atEnd || parser.peek == "#" { continue }
            if parser.peek == "[" {
                parser.advance()
                guard parser.peek != "[" else { throw unsupported() }
                section = try parser.path()
                parser.whitespace()
                guard parser.take("]") else { throw unsupported() }
                try parser.finish()
                guard sections.insert(identity(section)).inserted else { throw unsupported() }
                headers.append(Header(line: index, path: section))
            } else {
                let keys = try parser.path()
                parser.whitespace()
                guard parser.take("=") else { throw unsupported() }
                parser.whitespace()
                let start = parser.index
                try parser.value()
                let value = String(parser.characters[start..<parser.index])
                let prefix = String(parser.characters[..<start])
                let suffix = String(parser.characters[parser.index...])
                try parser.finish()
                let full = section + keys
                guard assigned.insert(identity(full)).inserted else { throw unsupported() }
                // Prefix assignments (inline tables / dotted keys) could collide
                // with an owned table. Refuse them instead of guessing semantics.
                entries.append(Entry(line: index, path: full, value: value, prefix: prefix, suffix: suffix))
            }
        }
        for entry in entries {
            for end in 1..<entry.path.count {
                guard !assigned.contains(identity(Array(entry.path.prefix(end)))) else { throw unsupported() }
            }
        }
        for header in headers {
            for end in 1...header.path.count {
                guard !assigned.contains(identity(Array(header.path.prefix(end)))) else { throw unsupported() }
            }
        }
        return Document(lines: lines, newline: newline, entries: entries, headers: headers)
    }

    static func edit(_ data: Data?, key: String, endpoint: String, model: String?) throws -> Data {
        let document = try parse(data)
        let (lines, newline, entries, headers) = (document.lines, document.newline, document.entries, document.headers)
        let provider = ["model_providers", "conpera_switch"]
        guard !headers.contains(where: { ["model", "model_provider"].contains($0.path.first ?? "") }),
              !entries.contains(where: { entry in
                  guard entry.path.first == "model_providers" else { return false }
                  let section = headers.last(where: { $0.line < entry.line })?.path ?? []
                  return section.count + 1 != entry.path.count || section.isEmpty
              }) else { throw unsupported() }
        let ownedHeaders = headers.filter { $0.path.starts(with: provider) }
        guard ownedHeaders.allSatisfy({ $0.path == provider }) else { throw unsupported() }
        let providerEntries = entries.filter { $0.path.starts(with: provider) }
        let allowed = Set(["name", "base_url", "wire_api", "experimental_bearer_token", "requires_openai_auth"])
        guard providerEntries.allSatisfy({ $0.path.count == 3 && allowed.contains($0.path[2]) }) else { throw unsupported() }
        guard !entries.contains(where: { ($0.path.first == "model_provider" || $0.path.first == "model") && $0.path.count != 1 }) else { throw unsupported() }

        var replacements: [Int: String] = [:]
        var root: [String] = []
        if let entry = entries.first(where: { $0.path == ["model_provider"] }) {
            replacements[entry.line] = "model_provider = \"conpera_switch\""
        } else { root.append("model_provider = \"conpera_switch\"") }
        if !entries.contains(where: { $0.path == ["model"] }), let model {
            root.append("model = " + quote(model))
        }
        let values = ["name = \"Conpera\"", "base_url = " + quote(endpoint), "wire_api = \"responses\"",
                      "experimental_bearer_token = " + quote(key), "requires_openai_auth = false"]
        let firstHeader = headers.first?.line ?? lines.count
        let removed = Set(providerEntries.map(\.line))
        var output: [String] = []
        for index in 0...lines.count {
            if index == firstHeader { output.append(contentsOf: root) }
            if index == lines.count { break }
            if removed.contains(index) { continue }
            output.append(replacements[index] ?? lines[index])
            if ownedHeaders.first?.line == index { output.append(contentsOf: values) }
        }
        if ownedHeaders.isEmpty {
            if !output.isEmpty && output.last != "" { output.append("") }
            output.append("[model_providers.conpera_switch]")
            output.append(contentsOf: values)
        }
        return Data((output.joined(separator: newline) + newline).utf8)
    }

    static func string(_ value: String) throws -> String {
        var parser = Parser(value)
        let result = try parser.string()
        guard parser.atEnd else { throw unsupported() }
        return result
    }

    static func replacing(_ document: Document, values: [Int: String]) -> String {
        document.lines.enumerated().map { index, line in values[index] ?? line }.joined(separator: document.newline) + document.newline
    }

    static func assignment(_ entry: Entry, value: String) -> String {
        entry.prefix + value + entry.suffix
    }

    static func updateRoots(_ source: String, updates: [String: String?]) throws -> String {
        let document = try parse(Data(source.utf8))
        guard !document.headers.contains(where: { updates.keys.contains($0.path.first ?? "") }),
              !document.entries.contains(where: { updates.keys.contains($0.path.first ?? "") && $0.path.count != 1 }) else { throw unsupported() }
        let roots = document.entries.filter { $0.path.count == 1 && updates.keys.contains($0.path[0]) }
        let removed = Set(roots.map(\.line))
        let firstHeader = document.headers.first?.line ?? document.lines.count
        var output: [String] = []
        for index in 0...document.lines.count {
            if index == firstHeader {
                for key in updates.keys.sorted() { if let value = updates[key]! { output.append(key + " = " + value) } }
            }
            if index < document.lines.count && !removed.contains(index) { output.append(document.lines[index]) }
        }
        return output.joined(separator: document.newline) + document.newline
    }

    static func containsSensitiveValues(_ source: String, matching predicate: (String) -> Bool) throws -> Bool {
        var parser = Parser(source)
        try parser.value()
        return parser.keysAndStrings.contains(where: predicate)
    }

    private static func identity(_ path: [String]) -> String { path.map { "\($0.utf8.count):\($0)" }.joined(separator: "/") }
    static func quote(_ value: String) -> String {
        // JSON strings are valid TOML basic strings for the accepted control-free
        // inputs. JSONSerializer does not introduce unsupported slash escapes here.
        let data = try! JSONSerialization.data(withJSONObject: [value], options: [.withoutEscapingSlashes])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }

    private struct Parser {
        let characters: [Character]
        var index = 0
        var keysAndStrings: [String] = []
        init(_ text: String) { characters = Array(text) }
        var atEnd: Bool { index >= characters.count }
        var peek: Character? { atEnd ? nil : characters[index] }
        mutating func advance() { index += 1 }
        mutating func take(_ character: Character) -> Bool {
            guard peek == character else { return false }; advance(); return true
        }
        mutating func whitespace() { while peek == " " || peek == "\t" { advance() } }
        mutating func finish() throws { whitespace(); guard atEnd || peek == "#" else { throw unsupported() } }

        mutating func path() throws -> [String] {
            var components: [String] = []
            while true {
                whitespace()
                if peek == "\"" || peek == "'" { components.append(try string()) }
                else {
                    let start = index
                    while let character = peek, character.isASCII && (character.isLetter || character.isNumber || character == "_" || character == "-") { advance() }
                    guard index > start else { throw unsupported() }
                    components.append(String(characters[start..<index]))
                }
                whitespace()
                if !take(".") { return components }
            }
        }

        mutating func string() throws -> String {
            guard let delimiter = peek, delimiter == "\"" || delimiter == "'" else { throw unsupported() }
            advance()
            // Triple-quoted strings are deliberately outside the supported subset.
            if index + 1 < characters.count, characters[index] == delimiter, characters[index + 1] == delimiter { throw unsupported() }
            var output = ""
            while let character = peek {
                advance()
                if character == delimiter { return output }
                guard character.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 || $0.value == 9 }) else { throw unsupported() }
                if delimiter == "\"" && character == "\\" {
                    guard let escape = peek else { throw unsupported() }
                    advance()
                    switch escape {
                    case "\"", "\\": output.append(escape)
                    case "b": output.append("\u{8}")
                    case "t": output.append("\t")
                    case "n": output.append("\n")
                    case "f": output.append("\u{c}")
                    case "r": output.append("\r")
                    case "u", "U":
                        let count = escape == "u" ? 4 : 8
                        guard index + count <= characters.count else { throw unsupported() }
                        let digits = String(characters[index..<(index + count)])
                        guard digits.allSatisfy({ $0.isASCII && $0.isHexDigit }), let scalar = UInt32(digits, radix: 16).flatMap(UnicodeScalar.init) else { throw unsupported() }
                        output.unicodeScalars.append(scalar); index += count
                    default: throw unsupported()
                    }
                } else { output.append(character) }
            }
            throw unsupported()
        }

        mutating func value(depth: Int = 0) throws {
            guard depth < 32 else { throw unsupported() }
            whitespace()
            if peek == "\"" || peek == "'" { keysAndStrings.append(try string()); return }
            if take("[") {
                whitespace()
                if take("]") { return }
                while true {
                    try value(depth: depth + 1); whitespace()
                    if take("]") { return }
                    guard take(",") else { throw unsupported() }
                    whitespace()
                    if take("]") { return }
                }
            }
            if take("{") {
                whitespace()
                if take("}") { return }
                var keys = Set<String>()
                while true {
                    let key = try path()
                    keysAndStrings.append(contentsOf: key)
                    guard keys.insert(identity(key)).inserted, take("=") else { throw unsupported() }
                    try value(depth: depth + 1); whitespace()
                    if take("}") { return }
                    guard take(",") else { throw unsupported() }
                    whitespace()
                    guard peek != "}" else { throw unsupported() }
                }
            }
            let start = index
            while let character = peek, ![" ", "\t", "#", ",", "]", "}"].contains(character) { advance() }
            let token = String(characters[start..<index])
            guard !token.isEmpty else { throw unsupported() }
            if ["true", "false", "inf", "+inf", "-inf", "nan", "+nan", "-nan"].contains(token) { return }
            let patterns = [
                "^[+-]?(0|[1-9](?:_?[0-9])*)$", "^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$",
                "^0o[0-7](?:_?[0-7])*$", "^0b[01](?:_?[01])*$",
                "^[+-]?(0|[1-9](?:_?[0-9])*)(?:\\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$",
                "^[+-]?(0|[1-9](?:_?[0-9])*)[eE][+-]?[0-9](?:_?[0-9])*$",
                "^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})?)?$",
                "^[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?$",
            ]
            guard patterns.contains(where: { token.range(of: $0, options: .regularExpression) != nil }) else { throw unsupported() }
        }
    }
}
