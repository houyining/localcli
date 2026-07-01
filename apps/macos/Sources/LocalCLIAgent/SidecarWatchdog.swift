import Foundation

struct SidecarWatchdog {
    let maxRestarts: Int
    let windowSeconds: TimeInterval
    private(set) var restartAttempts: [Date] = []

    init(maxRestarts: Int = 3, windowSeconds: TimeInterval = 60) {
        self.maxRestarts = maxRestarts
        self.windowSeconds = windowSeconds
    }

    var restartCount: Int {
        restartAttempts.count
    }

    mutating func canRestart(now: Date) -> Bool {
        trim(now: now)
        return restartAttempts.count < maxRestarts
    }

    mutating func recordRestart(now: Date) {
        trim(now: now)
        restartAttempts.append(now)
    }

    mutating func reset() {
        restartAttempts.removeAll()
    }

    private mutating func trim(now: Date) {
        restartAttempts = restartAttempts.filter { now.timeIntervalSince($0) <= windowSeconds }
    }
}
