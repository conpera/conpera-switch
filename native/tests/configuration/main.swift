import Foundation
import CryptoKit
import Darwin

// Invoked only by test-configuration.mjs with a newly-created temporary root.
guard CommandLine.arguments.count == 2 else { fatalError("Expected isolated fixture directory") }
let root = URL(fileURLWithPath: CommandLine.arguments[1])
guard root.path.contains("conpera-configuration-test-"), root.path != NSHomeDirectory() else { fatalError("Unsafe test root") }
let fm = FileManager.default
let syntheticKey = "synthetic-key-for-local-tests"
let endpoint = "https://code.conpera.ai/v1"
var count = 0

@MainActor func check(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
    guard try condition() else { throw NSError(domain: "ConfigurationTest", code: 1, userInfo: [NSLocalizedDescriptionKey: label]) }
    count += 1
    print("PASS: \(label)")
}
@MainActor func fixture(_ name: String) throws -> (URL, ConfigurationManager) {
    let home = root.appendingPathComponent(name)
    try fm.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return (home, ConfigurationManager(home: home))
}
@MainActor func target(_ home: URL, _ tool: String) -> URL {
    home.appendingPathComponent(tool == "codex" ? ".codex/config.toml" : ".claude/settings.json")
}
@MainActor func state(_ home: URL) -> URL { home.appendingPathComponent("Library/Application Support/Conpera Switch/configuration") }
@MainActor func write(_ url: URL, _ data: Data, mode: Int = 0o600) throws {
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try data.write(to: url)
    try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
}
@MainActor func text(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }
@MainActor func mode(_ url: URL) throws -> Int { (try fm.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber).intValue }
@MainActor func toolState(_ response: [String: Any], _ tool: String) -> [String: Any] { (response["tools"] as! [String: Any])[tool] as! [String: Any] }
@MainActor func expect(_ code: String, _ action: () throws -> Void) throws {
    do { try action() }
    catch let error as ConfigurationManager.Failure {
        try check(error.code == code && !error.message.contains(syntheticKey), "safe failure \(code)")
        return
    }
    throw NSError(domain: "ConfigurationTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected \(code)"])
}
@MainActor func digest(_ data: Data?) -> String { data.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "absent" }
@MainActor func snapshot(_ data: Data?) -> [String: Any] {
    var value: [String: Any] = ["permissions": 384]
    if let data { value["data"] = data.base64EncodedString() }
    return value
}
@MainActor func backup(_ target: URL, original: Data?, applied: Data?, key: String?) -> [String: Any] {
    var value: [String: Any] = ["version": 1, "target": target.path, "original": snapshot(original)]
    if let applied { value["appliedDigest"] = digest(applied) }
    if let key { value["keyId"] = key }
    return value
}
@MainActor func journal(_ home: URL, tool: String, before: Data?, after: Data?, original: Data?, previous: [String: Any]? = nil, restore: Bool = false) throws {
    let destination = target(home, tool)
    var value: [String: Any] = ["version": 1, "target": destination.path, "before": snapshot(before), "after": snapshot(after),
                               "next": backup(destination, original: original, applied: restore ? nil : after, key: restore ? nil : "recovered-key")]
    if let previous { value["previous"] = previous }
    try write(state(home).appendingPathComponent(tool + ".journal.json"), JSONSerialization.data(withJSONObject: value))
}

do {
    let containers = "args = [\"--flag\", \"safe-value\"]\noptions = { enabled = true, count = 2 }\nprivate_options = { nested = { api_key = \"hidden-inline\" } }\nrefresh_tokens = [\"hidden-refresh\"]\nmodel_auto_compact_token_limit = 1000\n"
    let redactedContainers = try ConfigurationDocument.redact(containers, tool: "codex").content
    try check(redactedContainers.contains("args = [\"--flag\", \"safe-value\"]") && redactedContainers.contains("options = { enabled = true, count = 2 }"), "ordinary TOML arrays and inline tables remain editable")
    try check(!redactedContainers.contains("hidden-inline") && !redactedContainers.contains("hidden-refresh") && redactedContainers.contains("model_auto_compact_token_limit = 1000"), "nested inline credentials and plural token keys are hidden, while token budgets remain visible")
    let restoredContainers = try ConfigurationDocument.restore(redactedContainers.replacingOccurrences(of: "safe-value", with: "new-argument"), original: containers, tool: "codex", active: false)
    try check(restoredContainers.contains("new-argument") && restoredContainers.contains("hidden-inline") && restoredContainers.contains("hidden-refresh"), "raw array edits preserve nested private values")
    // Settings editing uses isolated files and keeps credential bytes native.
    let (editorHome, editor) = try fixture("settings-editor")
    let editorSource = Data(("# user's config\r\nmodel = \"old-model\"\r\nmodel_reasoning_effort = \"high\"\r\nmodel_context_window = 200_000\r\nmodel_auto_compact_token_limit = 150_000\r\n[mcp_servers.local]\r\ncommand = \"example\"\r\nargs = [\"safe-arg\"]\r\n[mcp_servers.local.env]\r\nAPI_KEY = \"" + syntheticKey + "\"\r\n").utf8)
    try write(target(editorHome, "codex"), editorSource, mode: 0o640)
    let readEditor = try editor.configurationDetails(tool: "codex")
    let editorText = readEditor["content"] as! String
    try check(!editorText.contains(syntheticKey) && editorText.contains("__CONPERA_PRIVATE_"), "raw TOML redacts credentials before bridge exposure")
    let editorFields = readEditor["fields"] as! [String: String]
    try check(editorFields["model_context_window"] == "200000" && editorFields["model_auto_compact_token_limit"] == "150000", "token limits remain readable instead of being redacted as credentials")
    let editedText = try ConfigurationDocument.updating(editorText, tool: "codex", updates: ["model": "custom-model", "model_reasoning_effort": "xhigh", "model_auto_compact_token_limit": "175000"])
    let savedEditor = try editor.saveConfiguration(tool: "codex", revision: readEditor["revision"] as! String, content: editedText)
    let editorDisk = try text(target(editorHome, "codex"))
    try check(editorDisk.contains("model = \"custom-model\"") && editorDisk.contains("model_auto_compact_token_limit = 175000") && editorDisk.contains(syntheticKey) && !editorDisk.contains("__CONPERA_PRIVATE_"), "form save persists native configuration and restores hidden credential values")
    try check(editorDisk.contains("# user's config\r\n") && editorDisk.contains("command = \"example\"\r\n") && editorDisk.contains("args = [\"safe-arg\"]"), "settings editing preserves unrelated tables, values and CRLF")
    try check(savedEditor["canUndo"] as? Bool == true && savedEditor["mode"] as? String == "original", "settings save does not enable Conpera and offers undo")
    try check(try mode(target(editorHome, "codex")) == 0o600 && mode(state(editorHome).appendingPathComponent("codex.settings-undo.json")) == 0o600, "configuration edit and credential-bearing undo backup are private")
    try expect("configuration_changed") { _ = try editor.saveConfiguration(tool: "codex", revision: readEditor["revision"] as! String, content: editedText) }
    let undoEditor = try ConfigurationManager(home: editorHome).undoConfiguration(tool: "codex", revision: savedEditor["revision"] as! String)
    try check(try Data(contentsOf: target(editorHome, "codex")) == editorSource && mode(target(editorHome, "codex")) == 0o640 && undoEditor["canUndo"] as? Bool == false, "undo survives restart and restores exact original bytes and permissions")
    let currentEditor = try editor.configurationDetails(tool: "codex")
    try expect("protected_settings") { _ = try editor.saveConfiguration(tool: "codex", revision: currentEditor["revision"] as! String, content: editorText.replacingOccurrences(of: "__CONPERA_PRIVATE_0__", with: "modified-secret")) }
    try expect("unsupported_configuration") { _ = try editor.saveConfiguration(tool: "codex", revision: currentEditor["revision"] as! String, content: "model = \"unterminated") }
    try expect("invalid_settings") { _ = try ConfigurationDocument.updating(editorText, tool: "codex", updates: ["model_context_window": "12.5"]) }
    try expect("invalid_settings") { _ = try ConfigurationDocument.updating(editorText, tool: "codex", updates: ["model_auto_compact_token_limit": "250000"]) }
    try expect("invalid_settings") { _ = try ConfigurationDocument.updating(editorText, tool: "codex", updates: ["api_key": "new-secret"]) }
    try check(try Data(contentsOf: target(editorHome, "codex")) == editorSource, "invalid edits leave configuration unchanged")
    try write(target(editorHome, "codex"), Data("# external edit\n".utf8))
    try expect("configuration_changed") { _ = try editor.saveConfiguration(tool: "codex", revision: currentEditor["revision"] as! String, content: editedText) }
    try check(try text(target(editorHome, "codex")) == "# external edit\n", "stale settings editor never overwrites external changes")

    let (activeHome, activeEditor) = try fixture("settings-active")
    let activeOriginal = Data("model = \"original-model\"\n".utf8)
    try write(target(activeHome, "codex"), activeOriginal)
    _ = try activeEditor.apply(tool: "codex", keyId: "same-key", apiKey: syntheticKey, baseURL: endpoint)
    let activeRead = try activeEditor.configurationDetails(tool: "codex")
    let activeUpdated = try ConfigurationDocument.updating(activeRead["content"] as! String, tool: "codex", updates: ["model": "active-custom-model"])
    let activeSaved = try activeEditor.saveConfiguration(tool: "codex", revision: activeRead["revision"] as! String, content: activeUpdated)
    try check(toolState(activeEditor.status(), "codex")["mode"] as? String == "conpera" && toolState(activeEditor.status(), "codex")["keyId"] as? String == "same-key", "editing active settings refreshes the applied digest and keeps the same key")
    try expect("protected_settings") { _ = try activeEditor.saveConfiguration(tool: "codex", revision: activeSaved["revision"] as! String, content: (activeSaved["content"] as! String).replacingOccurrences(of: endpoint, with: "https://different.example/v1")) }
    _ = try activeEditor.restore(tool: "codex")
    try check(try Data(contentsOf: target(activeHome, "codex")) == activeOriginal, "restoring original mode retains the pre-Conpera backup after settings edits")
    try check(try activeEditor.configurationDetails(tool: "codex")["canUndo"] as? Bool == false, "mode changes invalidate old settings undo")

    let (jsonHome, jsonEditor) = try fixture("settings-json")
    let jsonOriginal = try JSONSerialization.data(withJSONObject: ["model": "old-claude", "alwaysThinkingEnabled": true, "env": ["ANTHROPIC_MODEL": "env-model", "ANTHROPIC_AUTH_TOKEN": syntheticKey, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "64000", "UNRELATED": "keep"], "permissions": ["allow": ["Read"]], "mcpServers": ["example": ["headers": ["Authorization": "Bearer " + syntheticKey]]]], options: [.sortedKeys])
    try write(target(jsonHome, "claude"), jsonOriginal)
    let jsonRead = try jsonEditor.configurationDetails(tool: "claude")
    try check(!(jsonRead["content"] as! String).contains(syntheticKey) && (jsonRead["fields"] as! [String: String])["maxOutputTokens"] == "64000", "JSON hides nested authorization and keeps output limit visible")
    try check((jsonRead["fields"] as! [String: String])["model"] == "env-model", "Claude form reads the higher-precedence model environment override")
    let jsonEdited = try ConfigurationDocument.updating(jsonRead["content"] as! String, tool: "claude", updates: ["model": "custom-claude", "alwaysThinkingEnabled": "false", "maxOutputTokens": "32000"])
    let jsonSaved = try jsonEditor.saveConfiguration(tool: "claude", revision: jsonRead["revision"] as! String, content: jsonEdited)
    let jsonDisk = try JSONSerialization.jsonObject(with: Data(contentsOf: target(jsonHome, "claude"))) as! [String: Any]
    let jsonEnvironment = jsonDisk["env"] as! [String: String]
    try check(jsonDisk["model"] as? String == "custom-claude" && jsonEnvironment["ANTHROPIC_MODEL"] == "custom-claude" && jsonDisk["alwaysThinkingEnabled"] as? Bool == false && jsonEnvironment["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "32000", "Claude form saves effective model override, thinking flag and output limit")
    try check(jsonEnvironment["ANTHROPIC_AUTH_TOKEN"] == syntheticKey && jsonEnvironment["UNRELATED"] == "keep" && (jsonDisk["permissions"] as! [String: [String]])["allow"] == ["Read"], "Claude save preserves credential and unrelated permission rules")
    try expect("invalid_settings") { _ = try jsonEditor.saveConfiguration(tool: "claude", revision: jsonSaved["revision"] as! String, content: "{invalid}") }
    let jsonCleared = try ConfigurationDocument.updating(jsonSaved["content"] as! String, tool: "claude", updates: ["model": "", "alwaysThinkingEnabled": "", "maxOutputTokens": ""])
    let clearObject = try JSONSerialization.jsonObject(with: Data(jsonCleared.utf8)) as! [String: Any]
    try check(clearObject["model"] == nil && clearObject["alwaysThinkingEnabled"] == nil && (clearObject["env"] as! [String: Any])["ANTHROPIC_MODEL"] == nil && (clearObject["env"] as! [String: Any])["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == nil, "default form selections remove only the chosen overrides")
    _ = try jsonEditor.undoConfiguration(tool: "claude", revision: jsonSaved["revision"] as! String)
    try check(try Data(contentsOf: target(jsonHome, "claude")) == jsonOriginal, "Claude undo restores exact original JSON bytes")

    let (missingSettingsHome, missingSettings) = try fixture("settings-absent")
    let missingRead = try missingSettings.configurationDetails(tool: "claude")
    try check(!fm.fileExists(atPath: target(missingSettingsHome, "claude").path), "reading settings does not create a missing client file")
    let missingSaved = try missingSettings.saveConfiguration(tool: "claude", revision: missingRead["revision"] as! String, content: "{\"model\":\"new-model\"}")
    _ = try missingSettings.undoConfiguration(tool: "claude", revision: missingSaved["revision"] as! String)
    try check(!fm.fileExists(atPath: target(missingSettingsHome, "claude").path), "undo removes a client file created by settings editing")

    let (emptyHome, empty) = try fixture("empty")
    try check(toolState(empty.status(), "codex")["mode"] as? String == "original", "initial status is original")
    try check(!fm.fileExists(atPath: target(emptyHome, "codex").path), "status does not create client configuration")
    let applied = try empty.apply(tool: "codex", keyId: "key-1", apiKey: syntheticKey, baseURL: endpoint, model: "test-model")
    try check(toolState(applied, "codex")["mode"] as? String == "conpera", "empty Codex configuration applied")
    try check(!String(decoding: JSONSerialization.data(withJSONObject: applied), as: UTF8.self).contains(syntheticKey), "response does not expose key")
    try check(try text(target(emptyHome, "codex")).contains("model = \"test-model\""), "default model used only if absent")
    try check(try mode(target(emptyHome, "codex")) == 0o600, "applied configuration is private")
    try check(try mode(state(emptyHome).appendingPathComponent("codex.backup.json")) == 0o600 && mode(state(emptyHome)) == 0o700, "backup and state directory are private")
    let restarted = ConfigurationManager(home: emptyHome)
    try check(toolState(restarted.status(), "codex")["keyId"] as? String == "key-1", "restart discovers saved applied state")
    _ = try restarted.restore(tool: "codex")
    try check(!fm.fileExists(atPath: target(emptyHome, "codex").path), "restore removes only originally absent file")
    _ = try restarted.restore(tool: "codex")
    try check(!fm.fileExists(atPath: target(emptyHome, "codex").path), "restore is idempotent")

    let (codexHome, codex) = try fixture("codex-preserve")
    let source = "# original configuration\r\nmodel_provider = \"old\" # own setting\r\nmodel = \"existing-model\"\r\nmodel_reasoning_effort = \"high\"\r\nfeatures = { fast = true, flags = [\"a#b\", 'literal'] }\r\n[model_providers.old]\r\nbase_url = \"https://old.example/v1\"\r\n[projects.\"/Users/test/project\"]\r\ntrust_level = \"trusted\"\r\n[mcp_servers.example]\r\nargs = [\"--flag\", \"[model_providers.conpera_switch]\"]\r\n"
    let original = Data(source.utf8)
    try write(target(codexHome, "codex"), original, mode: 0o640)
    let auth = codexHome.appendingPathComponent(".codex/auth.json")
    let originalAuth = Data("{\"syntheticOriginalLogin\":true}".utf8)
    try write(auth, originalAuth)
    _ = try codex.apply(tool: "codex", keyId: "key-a", apiKey: syntheticKey, baseURL: endpoint, model: "ignored-model")
    let first = try text(target(codexHome, "codex"))
    try check(first.contains("model = \"existing-model\"") && !first.contains("ignored-model"), "existing model retained")
    try check(first.contains("features = { fast = true, flags = [\"a#b\", 'literal'] }\r\n") && first.contains("[projects.\"/Users/test/project\"]\r\ntrust_level = \"trusted\""), "unrelated TOML text and CRLF retained")
    try check(first.contains("requires_openai_auth = false") && first.contains("wire_api = \"responses\"") && first.contains("experimental_bearer_token = \"\(syntheticKey)\""), "independent Codex provider fields written")
    _ = try codex.apply(tool: "codex", keyId: "key-b", apiKey: "replacement-synthetic-key", baseURL: endpoint)
    try check(try text(target(codexHome, "codex")).components(separatedBy: "[model_providers.conpera_switch]").count == 3, "replacement updates one real provider, preserving string literal")
    _ = try ConfigurationManager(home: codexHome).restore(tool: "codex")
    try check(try Data(contentsOf: target(codexHome, "codex")) == original, "restore preserves original Codex bytes across repeated apply")
    try check(try mode(target(codexHome, "codex")) == 0o640, "restore retains original permissions")
    try check(try Data(contentsOf: auth) == originalAuth, "Codex login file is untouched")

    let (claudeHome, claude) = try fixture("claude-preserve")
    let claudeOriginal = Data("{\"env\":{\"ANTHROPIC_API_KEY\":\"old-synthetic\",\"UNRELATED\":\"retain\"},\"permissions\":{\"allow\":[\"Read\"]}}\n".utf8)
    try write(target(claudeHome, "claude"), claudeOriginal)
    _ = try claude.apply(tool: "claude", keyId: "claude-key", apiKey: syntheticKey, baseURL: "https://code.conpera.ai")
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: target(claudeHome, "claude"))) as! [String: Any]
    let environment = object["env"] as! [String: Any]
    try check(environment["ANTHROPIC_API_KEY"] == nil && environment["ANTHROPIC_AUTH_TOKEN"] as? String == syntheticKey && environment["UNRELATED"] as? String == "retain", "Claude replaces conflicting auth and retains unrelated env")
    try check(object["permissions"] is [String: Any], "Claude non-env settings retained")
    _ = try claude.restore(tool: "claude")
    try check(try Data(contentsOf: target(claudeHome, "claude")) == claudeOriginal, "Claude restores original bytes and auth variable")

    let (conflictHome, conflict) = try fixture("conflict")
    _ = try conflict.apply(tool: "claude", keyId: "k", apiKey: syntheticKey, baseURL: "https://code.conpera.ai")
    let external = Data("{\"external\":true}".utf8)
    try write(target(conflictHome, "claude"), external)
    try check(toolState(conflict.status(), "claude")["mode"] as? String == "conflict", "external edit reported as conflict")
    try expect("configuration_changed") { _ = try conflict.restore(tool: "claude") }
    try expect("configuration_changed") { _ = try conflict.apply(tool: "claude", keyId: "x", apiKey: syntheticKey, baseURL: "https://code.conpera.ai") }
    try check(try Data(contentsOf: target(conflictHome, "claude")) == external, "external edits preserved on both failures")

    for (index, unsupported) in ["model = \"\"\"multiline\nvalue\"\"\"\n", "args = [\n \"x\"\n]\n", "[[array]]\nx = 1\n", "model_provider = \"a\"\nmodel_provider = \"b\"\n", "[model_providers.conpera_switch.auth]\ncommand = \"other\"\n", "[model_provider]\nx = 1\n", "broken = nope\n", "[model_providers.conpera_switch]\nhttp_headers = {}\n"].enumerated() {
        let (invalidHome, invalid) = try fixture("invalid-\(index)")
        let bytes = Data(unsupported.utf8)
        try write(target(invalidHome, "codex"), bytes)
        try expect("unsupported_configuration") { _ = try invalid.apply(tool: "codex", keyId: "k", apiKey: syntheticKey, baseURL: endpoint) }
        try check(try Data(contentsOf: target(invalidHome, "codex")) == bytes && !fm.fileExists(atPath: state(invalidHome).appendingPathComponent("codex.journal.json").path), "unsupported TOML fails before transaction \(index)")
    }
    let (invalidJSONHome, invalidJSON) = try fixture("invalid-json")
    try write(target(invalidJSONHome, "claude"), Data("{\"env\":[]}".utf8))
    try expect("unsupported_configuration") { _ = try invalidJSON.apply(tool: "claude", keyId: "k", apiKey: syntheticKey, baseURL: "https://code.conpera.ai") }

    let (linkHome, links) = try fixture("links")
    let outside = linkHome.appendingPathComponent("outside.toml")
    try write(outside, Data("model = \"outside\"\n".utf8))
    try fm.createDirectory(at: target(linkHome, "codex").deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.createSymbolicLink(at: target(linkHome, "codex"), withDestinationURL: outside)
    try expect("unsafe_configuration_path") { _ = try links.apply(tool: "codex", keyId: "k", apiKey: syntheticKey, baseURL: endpoint) }
    try check(try text(outside) == "model = \"outside\"\n", "symlink destination remains untouched")
    try fm.removeItem(at: target(linkHome, "codex"))
    try fm.linkItem(at: outside, to: target(linkHome, "codex"))
    try expect("unsafe_configuration_path") { _ = try links.apply(tool: "codex", keyId: "k", apiKey: syntheticKey, baseURL: endpoint) }
    let (directoryLinkHome, directoryLinks) = try fixture("directory-links")
    try fm.createSymbolicLink(at: directoryLinkHome.appendingPathComponent(".codex"), withDestinationURL: linkHome)
    try expect("unsafe_configuration_path") { _ = try directoryLinks.apply(tool: "codex", keyId: "k", apiKey: syntheticKey, baseURL: endpoint) }

    let (lockHome, lockManager) = try fixture("lock")
    _ = try lockManager.status()
    let lockDescriptor = open(state(lockHome).appendingPathComponent(".lock").path, O_RDWR)
    guard lockDescriptor >= 0, flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else { fatalError("test lock failed") }
    try expect("configuration_busy") { _ = try ConfigurationManager(home: lockHome).apply(tool: "codex", keyId: "k", apiKey: syntheticKey, baseURL: endpoint) }
    flock(lockDescriptor, LOCK_UN); close(lockDescriptor)
    try check(!fm.fileExists(atPath: target(lockHome, "codex").path), "busy writer makes no client changes")

    let (recoverHome, recover) = try fixture("recover-after")
    let old = Data("model = \"before\"\n".utf8)
    let new = Data("model = \"after\"\n".utf8)
    try write(target(recoverHome, "codex"), new)
    try journal(recoverHome, tool: "codex", before: old, after: new, original: old)
    try check(toolState(recover.status(), "codex")["keyId"] as? String == "recovered-key", "interrupted applied write completes metadata on restart")
    _ = try recover.restore(tool: "codex")
    try check(try Data(contentsOf: target(recoverHome, "codex")) == old, "recovered transaction still restores original")
    let (beforeHome, beforeManager) = try fixture("recover-before")
    try write(target(beforeHome, "codex"), old)
    try journal(beforeHome, tool: "codex", before: old, after: new, original: old)
    try check(toolState(beforeManager.status(), "codex")["mode"] as? String == "original", "interrupted pre-write transaction rolls back metadata")
    try check(try Data(contentsOf: target(beforeHome, "codex")) == old && !fm.fileExists(atPath: state(beforeHome).appendingPathComponent("codex.journal.json").path), "pre-write recovery preserves file and clears journal")
    let (restoreHome, restoreManager) = try fixture("recover-restore")
    let prior = backup(target(restoreHome, "codex"), original: nil, applied: new, key: "old-key")
    try write(state(restoreHome).appendingPathComponent("codex.backup.json"), JSONSerialization.data(withJSONObject: prior))
    try journal(restoreHome, tool: "codex", before: new, after: nil, original: nil, previous: prior, restore: true)
    try check(toolState(restoreManager.status(), "codex")["mode"] as? String == "original", "interrupted restore deletion completes safely")
    let (recoveryConflictHome, recoveryConflict) = try fixture("recovery-conflict")
    try write(target(recoveryConflictHome, "codex"), external)
    try journal(recoveryConflictHome, tool: "codex", before: old, after: new, original: old)
    try expect("recovery_conflict") { _ = try recoveryConflict.status() }
    try check(try Data(contentsOf: target(recoveryConflictHome, "codex")) == external && fm.fileExists(atPath: state(recoveryConflictHome).appendingPathComponent("codex.journal.json").path), "recovery conflict preserves external file and journal")

    let (customHome, _) = try fixture("custom-paths")
    let customCodex = customHome.appendingPathComponent("alternate-codex")
    let customClaude = customHome.appendingPathComponent("alternate-claude")
    let customState = customHome.appendingPathComponent("switch-state")
    let custom = ConfigurationManager(home: customHome, codexDirectory: customCodex, claudeDirectory: customClaude, stateDirectory: customState)
    _ = try custom.apply(tool: "codex", keyId: "k", apiKey: syntheticKey, baseURL: endpoint)
    try check(fm.fileExists(atPath: customCodex.appendingPathComponent("config.toml").path) && !fm.fileExists(atPath: target(customHome, "codex").path), "injected config directory is respected")
    try expect("configuration_location_changed") { _ = try ConfigurationManager(home: customHome, stateDirectory: customState).status() }
    try expect("invalid_configuration") { _ = try custom.apply(tool: "codex", keyId: "k", apiKey: syntheticKey, baseURL: "https://user:pass@example.test/v1") }
    try expect("invalid_configuration") { _ = try custom.apply(tool: "codex", keyId: "k", apiKey: "bad\nkey", baseURL: endpoint) }
    try expect("unsupported_tool") { _ = try custom.restore(tool: "other") }
    print("\n\(count) isolated configuration checks passed.")
} catch {
    FileHandle.standardError.write(Data(("FAIL: \(error.localizedDescription)\n").utf8))
    exit(1)
}
