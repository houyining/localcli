import Foundation
@testable import LocalCLIAgent
import XCTest

final class SidecarControllerTests: XCTestCase {
    func testMergedProviderPathPreservesExistingPathAndAddsProviderDefaults() throws {
        let home = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("local-cli-agent-tests-\(UUID().uuidString)")
        let nvmBin = home
            .appendingPathComponent(".nvm")
            .appendingPathComponent("versions")
            .appendingPathComponent("node")
            .appendingPathComponent("v22.12.0")
            .appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: nvmBin, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: home)
        }

        let providerPaths = SidecarController.providerPathDefaults(homeDirectory: home)
        let comparableProviderPaths = Set(providerPaths.map(normalizeTemporaryPath))
        let localBinPath = normalizeTemporaryPath(home.appendingPathComponent(".local").appendingPathComponent("bin").path)
        let nvmBinPath = normalizeTemporaryPath(nvmBin.path)
        XCTAssertTrue(comparableProviderPaths.contains(localBinPath))
        XCTAssertTrue(comparableProviderPaths.contains(nvmBinPath), "Expected \(nvmBinPath) in \(comparableProviderPaths)")

        let path = SidecarController.mergedProviderPath(existingPath: "/custom/bin:/usr/bin")
        let parts = path.split(separator: ":").map(String.init)

        XCTAssertEqual(parts.first, "/custom/bin")
        XCTAssertTrue(parts.contains(
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".local")
                .appendingPathComponent("bin")
                .path
        ))
        XCTAssertTrue(parts.contains("/opt/homebrew/bin"))
        XCTAssertTrue(parts.contains("/opt/homebrew/sbin"))
        XCTAssertTrue(parts.contains("/usr/local/bin"))
        XCTAssertTrue(parts.contains("/usr/bin"))
        XCTAssertEqual(parts.filter { $0 == "/usr/bin" }.count, 1)
    }

    func testWaitUntilProcessExitsReturnsAfterProcessFinishes() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["0.1"]

        try process.run()

        XCTAssertTrue(SidecarController.waitUntilProcessExits(process, timeout: 2.0))
    }

    private func normalizeTemporaryPath(_ path: String) -> String {
        path.replacingOccurrences(of: "/private/var/", with: "/var/")
    }
}
