import Foundation

enum MenuBarAgentState: Equatable, CaseIterable {
    case serviceRunning
    case serviceStopped
    case requestProcessing
    case requestSucceeded
    case requestFailed
    case serviceStartFailed

    var displayName: String {
        switch self {
        case .serviceRunning:
            return "Running"
        case .serviceStopped:
            return "Stopped"
        case .requestProcessing:
            return "Processing Request"
        case .requestSucceeded:
            return "Request Succeeded"
        case .requestFailed:
            return "Request Failed"
        case .serviceStartFailed:
            return "Service Start Failed"
        }
    }
}

struct MenuBarAgentStateModel {
    private enum ServiceState: Equatable {
        case running
        case stopped
        case startFailed
    }

    private struct CompletionFeedback {
        let state: MenuBarAgentState
        let expiresAt: Date
    }

    private let feedbackDuration: TimeInterval
    private var serviceState: ServiceState = .stopped
    private var activeRequests = 0
    private var activeRequestIds = Set<String>()
    private var completionFeedback: CompletionFeedback?

    init(feedbackDuration: TimeInterval = 5.0) {
        self.feedbackDuration = feedbackDuration
    }

    var feedbackExpiresAt: Date? {
        completionFeedback?.expiresAt
    }

    mutating func serviceDidStart(now: Date = Date()) {
        expireFeedbackIfNeeded(now: now)
        serviceState = .running
    }

    mutating func serviceDidStop(now: Date = Date()) {
        expireFeedbackIfNeeded(now: now)
        serviceState = .stopped
        activeRequests = 0
        activeRequestIds.removeAll()
        completionFeedback = nil
    }

    mutating func serviceStartDidFail(now: Date = Date()) {
        expireFeedbackIfNeeded(now: now)
        serviceState = .startFailed
        activeRequests = 0
        activeRequestIds.removeAll()
        completionFeedback = nil
    }

    mutating func requestDidStart(requestId: String? = nil, now: Date = Date()) {
        expireFeedbackIfNeeded(now: now)
        guard serviceState != .startFailed else { return }
        serviceState = .running
        if let requestId {
            activeRequestIds.insert(requestId)
            activeRequests = max(activeRequests, activeRequestIds.count)
        } else {
            activeRequests = max(0, activeRequests) + 1
        }
        completionFeedback = nil
    }

    mutating func requestDidFinish(succeeded: Bool, requestId: String? = nil, now: Date = Date()) {
        expireFeedbackIfNeeded(now: now)
        guard serviceState != .startFailed else { return }
        serviceState = .running
        if let requestId {
            if activeRequestIds.remove(requestId) != nil {
                activeRequests = activeRequestIds.count
            } else {
                activeRequests = max(0, activeRequests - 1)
            }
        } else {
            activeRequests = max(0, activeRequests - 1)
        }
        guard activeRequests == 0, activeRequestIds.isEmpty else { return }

        completionFeedback = CompletionFeedback(
            state: succeeded ? .requestSucceeded : .requestFailed,
            expiresAt: now.addingTimeInterval(feedbackDuration)
        )
    }

    mutating func statusDidRefresh(serviceStatus: String, activeRequests: Int, now: Date = Date()) {
        expireFeedbackIfNeeded(now: now)
        if serviceStatus == "running" {
            serviceState = .running
            let refreshedActiveRequests = max(0, activeRequests)
            if completionFeedback == nil {
                self.activeRequests = max(refreshedActiveRequests, activeRequestIds.count)
            } else if refreshedActiveRequests == 0 {
                self.activeRequests = 0
                activeRequestIds.removeAll()
            }
        } else {
            serviceState = .stopped
            self.activeRequests = 0
            activeRequestIds.removeAll()
            completionFeedback = nil
        }
    }

    mutating func statusRefreshFailed(sidecarRunning: Bool, now: Date = Date()) {
        expireFeedbackIfNeeded(now: now)
        if !sidecarRunning, serviceState != .startFailed {
            serviceDidStop(now: now)
        }
    }

    mutating func expireFeedbackIfNeeded(now: Date = Date()) {
        if let expiresAt = completionFeedback?.expiresAt, now >= expiresAt {
            completionFeedback = nil
        }
    }

    mutating func currentState(now: Date = Date()) -> MenuBarAgentState {
        expireFeedbackIfNeeded(now: now)

        switch serviceState {
        case .startFailed:
            return .serviceStartFailed
        case .stopped:
            return .serviceStopped
        case .running:
            if let completionFeedback {
                return completionFeedback.state
            }
            if activeRequests > 0 || !activeRequestIds.isEmpty {
                return .requestProcessing
            }
            return .serviceRunning
        }
    }
}
