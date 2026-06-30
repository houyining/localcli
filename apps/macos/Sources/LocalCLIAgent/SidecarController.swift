import Foundation

final class SidecarController {
    private(set) var adminToken = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private var process: Process?
    private static let systemProviderPathDefaults = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin"
    ]

    private struct NodeLaunch {
        let executableURL: URL
        let argumentPrefix: [String]
    }

    var isRunning: Bool {
        process?.isRunning == true
    }

    func restart() throws {
        try stopAndWait()
        try start()
    }

    func start() throws {
        guard process?.isRunning != true else { return }

        adminToken = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let sidecarPath = try resolveSidecarPath()
        let nodeLaunch = resolveNodeLaunch()
        let process = Process()
        process.executableURL = nodeLaunch.executableURL
        process.arguments = nodeLaunch.argumentPrefix + [
            "--experimental-strip-types",
            sidecarPath.path,
            "--admin-token",
            adminToken
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = Self.mergedProviderPath(existingPath: environment["PATH"])
        environment["LOCAL_CLI_AGENT_ENABLE_FAKE_PROVIDER"] = "0"
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        self.process = process
    }

    func stop() {
        try? stopAndWait()
    }

    private func stopAndWait(timeout: TimeInterval = 3.0) throws {
        guard let process else { return }
        if process.isRunning {
            process.terminate()
            if !Self.waitUntilProcessExits(process, timeout: timeout) {
                throw NSError(domain: "LocalCLIAgent.Sidecar", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Timed out waiting for the sidecar to stop."
                ])
            }
        }
        self.process = nil
    }

    static func waitUntilProcessExits(_ process: Process, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        return !process.isRunning
    }

    static func mergedProviderPath(existingPath: String?) -> String {
        var paths: [String] = []
        var seen = Set<String>()

        func appendPath(_ path: String) {
            guard !path.isEmpty, !seen.contains(path) else { return }
            paths.append(path)
            seen.insert(path)
        }

        existingPath?
            .split(separator: ":", omittingEmptySubsequences: false)
            .map(String.init)
            .forEach(appendPath)
        providerPathDefaults().forEach(appendPath)
        return paths.joined(separator: ":")
    }

    static func providerPathDefaults(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) -> [String] {
        var paths = [
            homePath(homeDirectory, ".local", "bin"),
            homePath(homeDirectory, ".npm-global", "bin"),
            homePath(homeDirectory, ".yarn", "bin"),
            homePath(homeDirectory, ".bun", "bin"),
            homePath(homeDirectory, ".deno", "bin"),
            homePath(homeDirectory, ".cargo", "bin")
        ]
        paths.append(contentsOf: nvmNodeBinPaths(homeDirectory: homeDirectory, fileManager: fileManager))
        paths.append(contentsOf: systemProviderPathDefaults)
        return paths
    }

    private static func homePath(_ homeDirectory: URL, _ components: String...) -> String {
        components.reduce(homeDirectory) { url, component in
            url.appendingPathComponent(component)
        }.path
    }

    private static func nvmNodeBinPaths(homeDirectory: URL, fileManager: FileManager) -> [String] {
        let versionsDirectory = homeDirectory
            .appendingPathComponent(".nvm")
            .appendingPathComponent("versions")
            .appendingPathComponent("node")
        guard let versions = try? fileManager.contentsOfDirectory(
            at: versionsDirectory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        ) else {
            return []
        }

        return versions
            .compactMap { versionDirectory -> URL? in
                let binDirectory = versionDirectory.appendingPathComponent("bin")
                return fileManager.fileExists(atPath: binDirectory.path) ? binDirectory : nil
            }
            .sorted {
                $0.deletingLastPathComponent().lastPathComponent
                    .localizedStandardCompare($1.deletingLastPathComponent().lastPathComponent) == .orderedDescending
            }
            .map(\.path)
    }

    private func resolveSidecarPath() throws -> URL {
        if let explicit = ProcessInfo.processInfo.environment["LOCAL_CLI_AGENT_SIDECAR_PATH"] {
            return URL(fileURLWithPath: explicit)
        }

        if let resourceURL = Bundle.main.resourceURL {
            let bundled = resourceURL.appendingPathComponent("sidecar/src/main.ts")
            if FileManager.default.fileExists(atPath: bundled.path) {
                return bundled
            }
        }

        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let dev = cwd.appendingPathComponent("sidecar/src/main.ts")
        if FileManager.default.fileExists(atPath: dev.path) {
            return dev
        }

        throw NSError(domain: "LocalCLIAgent.Sidecar", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Unable to find sidecar/src/main.ts. Set LOCAL_CLI_AGENT_SIDECAR_PATH for development."
        ])
    }

    private func resolveNodeLaunch() -> NodeLaunch {
        if let explicit = ProcessInfo.processInfo.environment["LOCAL_CLI_AGENT_NODE_PATH"] {
            return NodeLaunch(executableURL: URL(fileURLWithPath: explicit), argumentPrefix: [])
        }

        if let resourceURL = Bundle.main.resourceURL {
            let bundled = resourceURL.appendingPathComponent("node/bin/node")
            if FileManager.default.isExecutableFile(atPath: bundled.path) {
                return NodeLaunch(executableURL: bundled, argumentPrefix: [])
            }
        }

        return NodeLaunch(
            executableURL: URL(fileURLWithPath: "/usr/bin/env"),
            argumentPrefix: ["node"]
        )
    }
}
