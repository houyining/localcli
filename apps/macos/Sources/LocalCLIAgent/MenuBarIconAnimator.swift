import AppKit

@MainActor
final class MenuBarIconAnimator {
    private weak var button: NSStatusBarButton?
    private var timer: Timer?
    private var state: MenuBarAgentState?
    private var frames: [NSImage] = []
    private var frameIndex = 0

    func setButton(_ button: NSStatusBarButton?) {
        self.button = button
        button?.imagePosition = .imageOnly
        button?.imageScaling = .scaleNone
        button?.title = ""
        if let state {
            setState(state)
        }
    }

    func setState(_ nextState: MenuBarAgentState) {
        button?.toolTip = "Local CLI Agent: \(nextState.displayName)"
        guard state != nextState else { return }

        state = nextState
        frames = PixelWhaleIconRenderer.imageFrames(for: nextState)
        frameIndex = 0
        renderCurrentFrame()
        restartTimer(for: nextState)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func restartTimer(for state: MenuBarAgentState) {
        timer?.invalidate()
        timer = nil

        guard frames.count > 1 else { return }
        scheduleNextFrame(after: frameInterval(for: state))
    }

    private func scheduleNextFrame(after interval: TimeInterval) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.advanceFrame()
            }
        }
    }

    private func frameInterval(for state: MenuBarAgentState) -> TimeInterval {
        switch state {
        case .serviceRunning:
            return 0.5
        case .serviceStopped:
            return 1.0
        case .requestProcessing:
            return 0.18
        case .requestSucceeded:
            return 0.3
        case .requestFailed:
            return 0.35
        case .serviceStartFailed:
            return 0.7
        }
    }

    private func advanceFrame() {
        guard !frames.isEmpty, let state else { return }
        frameIndex = (frameIndex + 1) % frames.count
        renderCurrentFrame()
        guard frames.count > 1 else { return }

        scheduleNextFrame(after: frameInterval(for: state))
    }

    private func renderCurrentFrame() {
        guard !frames.isEmpty else { return }
        button?.image = frames[frameIndex]
    }
}
