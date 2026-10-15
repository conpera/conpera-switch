import Foundation
import Dispatch

// Disposable command-line harness for scripts/test-native.mjs. It uses only the
// supplied web build and synthetic in-memory data; it never reads CLI settings.
guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("Usage: native-test-server <web-build-directory>\n".utf8))
    exit(2)
}

let server = LocalDemoServer(resourceRoot: URL(fileURLWithPath: CommandLine.arguments[1]))
server.start { result in
    switch result {
    case .success(let url):
        FileHandle.standardOutput.write(Data((url.absoluteString + "\n").utf8))
    case .failure(let error):
        FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
        exit(1)
    }
}
dispatchMain()
