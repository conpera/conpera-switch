import Foundation
import CoreFoundation

/// Pure transformations of configuration text. Secrets are replaced before any
/// document crosses the native bridge and restored only against the current file.
enum ConfigurationDocument {
    static let maximumSize = 512 * 1024
    private static let marker = "__CONPERA_PRIVATE_"
    struct ProtectedValue { let path: [String]; let value: Any; let placeholder: String }
    struct Redacted { let content: String; let protected: [ProtectedValue] }

    static func failure(_ message: String, code: String = "invalid_settings") -> ConfigurationManager.Failure {
        .init(status: 422, code: code, message: message)
    }

    static func source(_ data: Data?, tool: String) throws -> String {
        guard let data else { return tool == "claude" ? "{}\n" : "" }
        guard data.count <= maximumSize, let text = String(data: data, encoding: .utf8) else {
            throw failure("配置文件过大或不是 UTF-8 文本，无法在此编辑。")
        }
        return text
    }

    static func validate(_ content: String, tool: String) throws {
        guard ["codex", "claude"].contains(tool), content.utf8.count <= maximumSize else {
            throw failure("配置内容超过支持的大小。")
        }
        if tool == "codex" { _ = try CodexConfigurationEditor.parse(Data(content.utf8)) }
        else { _ = try json(content) }
    }

    private static func json(_ content: String) throws -> [String: Any] {
        guard content.utf8.count <= maximumSize,
              let value = try? JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any] else {
            throw failure("Claude Code 配置必须是有效的 JSON 对象。")
        }
        guard value["env"] == nil || value["env"] is [String: Any] else {
            throw failure("Claude Code 的 env 必须是 JSON 对象。")
        }
        return value
    }

    private static func encode(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    private static func sensitive(_ key: String) -> Bool {
        let lower = key.lowercased()
        if ["requires_openai_auth", "preferred_auth_method", "forced_login_method"].contains(lower) { return false }
        if ["model_context_window", "model_auto_compact_token_limit", "claude_code_max_output_tokens", "max_thinking_tokens", "max_tokens", "max_output_tokens"].contains(lower) { return false }
        return ["token", "secret", "password", "credential", "api_key", "apikey", "api-key", "authorization", "cookie"].contains(where: lower.contains)
    }

    static func redact(_ content: String, tool: String) throws -> Redacted {
        try validate(content, tool: tool)
        // Reserved placeholders cannot be supplied by a file and later mistaken
        // for a value held by the native layer.
        guard !content.contains(marker) else { throw failure("配置文件包含保留占位符，无法安全读取。") }
        var protected: [ProtectedValue] = []
        func hide(_ path: [String], _ value: Any) -> String {
            let placeholder = marker + String(protected.count) + "__"
            protected.append(ProtectedValue(path: path, value: value, placeholder: placeholder))
            return placeholder
        }
        if tool == "codex" {
            let doc = try CodexConfigurationEditor.parse(Data(content.utf8))
            var replacements: [Int: String] = [:]
            for entry in doc.entries {
                // Containers with credential keys or command-line auth flags are
                // protected as a unit; ordinary arrays/tables stay editable.
                let privateContainer = try (entry.value.hasPrefix("{") || entry.value.hasPrefix("[")) && (CodexConfigurationEditor.containsSensitiveValues(entry.value, matching: sensitive))
                if entry.path.contains(where: sensitive) || privateContainer {
                    // Keep trailing comments native as well, and restore them
                    // with the complete value instead of dropping their bytes.
                    let placeholder = hide(entry.path, entry.value + entry.suffix)
                    replacements[entry.line] = entry.prefix + CodexConfigurationEditor.quote(placeholder)
                }
            }
            return Redacted(content: CodexConfigurationEditor.replacing(doc, values: replacements), protected: protected)
        }
        func walk(_ value: Any, path: [String]) -> Any {
            if let object = value as? [String: Any] {
                return object.mapValuesWithKeys { key, value in
                    sensitive(key) ? hide(path + [key], value) : walk(value, path: path + [key])
                }
            }
            if let array = value as? [Any] { return array.enumerated().map { walk($0.element, path: path + [String($0.offset)]) } }
            return value
        }
        return Redacted(content: try encode(walk(try json(content), path: [])), protected: protected)
    }

    static func restore(_ edited: String, original: String, tool: String, active: Bool) throws -> String {
        try validate(edited, tool: tool)
        let redacted = try redact(original, tool: tool)
        let privateError = failure("隐藏字段不可修改或删除，请保留原占位符。", code: "protected_settings")
        var restored: String
        if tool == "codex" {
            let doc = try CodexConfigurationEditor.parse(Data(edited.utf8))
            var replacements: [Int: String] = [:]
            for field in redacted.protected {
                guard let entry = doc.entries.first(where: { $0.path == field.path }),
                      (try? CodexConfigurationEditor.string(entry.value)) == field.placeholder else { throw privateError }
                replacements[entry.line] = CodexConfigurationEditor.assignment(entry, value: field.value as! String)
            }
            restored = CodexConfigurationEditor.replacing(doc, values: replacements)
            if active {
                let before = try CodexConfigurationEditor.parse(Data(original.utf8))
                let after = try CodexConfigurationEditor.parse(Data(restored.utf8))
                func connection(_ doc: CodexConfigurationEditor.Document) -> [String: String] {
                    Dictionary(uniqueKeysWithValues: doc.entries.filter { $0.path == ["model_provider"] || $0.path.starts(with: ["model_providers", "conpera_switch"]) }.map { ($0.path.joined(separator: "."), $0.value) })
                }
                guard connection(before) == connection(after) else { throw managedConnectionError() }
            }
        } else {
            var remaining = Set(redacted.protected.map(\.placeholder))
            func walk(_ value: Any, path: [String]) throws -> Any {
                if let field = redacted.protected.first(where: { $0.path == path }) {
                    guard value as? String == field.placeholder else { throw privateError }
                    remaining.remove(field.placeholder)
                    return field.value
                }
                if let object = value as? [String: Any] {
                    return try object.mapValuesWithKeys { try walk($1, path: path + [$0]) }
                }
                if let array = value as? [Any] { return try array.enumerated().map { try walk($0.element, path: path + [String($0.offset)]) } }
                return value
            }
            restored = try encode(walk(try json(edited), path: []))
            guard remaining.isEmpty else { throw privateError }
            if active {
                let before = try json(original)["env"] as? [String: Any] ?? [:]
                let after = try json(restored)["env"] as? [String: Any] ?? [:]
                for key in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] {
                    guard NSDictionary(dictionary: ["value": before[key] ?? NSNull()]).isEqual(to: ["value": after[key] ?? NSNull()]) else { throw managedConnectionError() }
                }
            }
        }
        guard !restored.contains(marker) else { throw privateError }
        try validate(restored, tool: tool)
        return restored
    }

    private static func managedConnectionError() -> ConfigurationManager.Failure {
        failure("Conpera 的连接与密钥由首页管理，请保留这些字段。", code: "protected_settings")
    }

    static func fields(_ content: String, tool: String) throws -> [String: String] {
        try validate(content, tool: tool)
        if tool == "codex" {
            let doc = try CodexConfigurationEditor.parse(Data(content.utf8))
            var result: [String: String] = [:]
            for key in ["model", "model_reasoning_effort", "model_context_window", "model_auto_compact_token_limit", "model_verbosity"] {
                if let entry = doc.entries.first(where: { $0.path == [key] }) {
                    result[key] = (try? CodexConfigurationEditor.string(entry.value)) ?? entry.value.replacingOccurrences(of: "_", with: "")
                } else { result[key] = "" }
            }
            return result
        }
        let object = try json(content), env = object["env"] as? [String: Any] ?? [:]
        var result = ["model": (env["ANTHROPIC_MODEL"] as? String) ?? (object["model"] as? String) ?? "",
                      "alwaysThinkingEnabled": "", "maxOutputTokens": env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] as? String ?? ""]
        if let number = object["alwaysThinkingEnabled"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { result["alwaysThinkingEnabled"] = number.boolValue ? "true" : "false" }
        return result
    }

    static func updating(_ content: String, tool: String, updates: [String: String]) throws -> String {
        try validate(content, tool: tool)
        let current = try fields(content, tool: tool)
        guard Set(updates.keys).isSubset(of: Set(current.keys)) else { throw failure("包含不支持的设置项。") }
        var values: [String: String?] = [:]
        for (key, raw) in updates where current[key] != raw {
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.utf8.count <= 256, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }), !value.contains(marker) else { throw failure("设置值格式无效。") }
            if value.isEmpty { values[key] = .some(nil); continue }
            if ["model_context_window", "model_auto_compact_token_limit", "maxOutputTokens"].contains(key) {
                guard value.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(value), number > 0, number <= 2_147_483_647 else { throw failure("Token 数量必须是有效的正整数。") }
                values[key] = String(number)
            } else if key == "alwaysThinkingEnabled" {
                guard ["true", "false"].contains(value) else { throw failure("思考模式设置无效。") }
                values[key] = value
            } else {
                if key == "model_reasoning_effort", !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].contains(value) { throw failure("思考强度设置无效。") }
                if key == "model_verbosity", !["low", "medium", "high"].contains(value) { throw failure("回答详细程度设置无效。") }
                values[key] = CodexConfigurationEditor.quote(value)
            }
        }
        if tool == "codex" {
            let updated = try CodexConfigurationEditor.updateRoots(content, updates: values)
            let after = try fields(updated, tool: tool)
            if let window = Int(after["model_context_window"] ?? ""), let limit = Int(after["model_auto_compact_token_limit"] ?? ""), limit > window { throw failure("自动压缩阈值不能大于上下文窗口。") }
            return updated
        }
        var object = try json(content), env = object["env"] as? [String: Any] ?? [:]
        if let model = values["model"] {
            let decoded = try model.map(CodexConfigurationEditor.string)
            object["model"] = decoded
            if env["ANTHROPIC_MODEL"] != nil { env["ANTHROPIC_MODEL"] = decoded }
        }
        if let thinking = values["alwaysThinkingEnabled"] { object["alwaysThinkingEnabled"] = thinking.map { $0 == "true" } }
        if let output = values["maxOutputTokens"] { env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = output }
        if object["env"] != nil || !env.isEmpty { object["env"] = env }
        return try encode(object)
    }
}

private extension Dictionary where Key == String, Value == Any {
    func mapValuesWithKeys(_ transform: (String, Any) throws -> Any) rethrows -> [String: Any] {
        var result: [String: Any] = [:]
        for key in keys.sorted() { result[key] = try transform(key, self[key]!) }
        return result
    }
}
