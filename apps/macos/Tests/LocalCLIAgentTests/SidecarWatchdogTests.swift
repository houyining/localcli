import Foundation
@testable import LocalCLIAgent
import XCTest

final class SidecarWatchdogTests: XCTestCase {
    func testRestartLimitAppliesWithinWindow() {
        var watchdog = SidecarWatchdog(maxRestarts: 3, windowSeconds: 60)
        let start = Date(timeIntervalSince1970: 100)

        XCTAssertTrue(watchdog.canRestart(now: start))
        watchdog.recordRestart(now: start)
        XCTAssertTrue(watchdog.canRestart(now: start.addingTimeInterval(10)))
        watchdog.recordRestart(now: start.addingTimeInterval(10))
        XCTAssertTrue(watchdog.canRestart(now: start.addingTimeInterval(20)))
        watchdog.recordRestart(now: start.addingTimeInterval(20))

        XCTAssertFalse(watchdog.canRestart(now: start.addingTimeInterval(30)))
        XCTAssertEqual(watchdog.restartCount, 3)
    }

    func testRestartWindowExpiresOldAttempts() {
        var watchdog = SidecarWatchdog(maxRestarts: 3, windowSeconds: 60)
        let start = Date(timeIntervalSince1970: 100)

        watchdog.recordRestart(now: start)
        watchdog.recordRestart(now: start.addingTimeInterval(10))
        watchdog.recordRestart(now: start.addingTimeInterval(20))

        XCTAssertTrue(watchdog.canRestart(now: start.addingTimeInterval(90)))
        XCTAssertEqual(watchdog.restartCount, 0)
    }
}
