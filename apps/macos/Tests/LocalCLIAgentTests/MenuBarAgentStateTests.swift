import AppKit
@testable import LocalCLIAgent
import XCTest

final class MenuBarAgentStateTests: XCTestCase {
    func testInitialStateIsStopped() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)

        XCTAssertEqual(model.currentState(now: referenceDate), .serviceStopped)
    }

    func testStartFailureHasPriorityOverStoppedRefreshFailure() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)

        model.serviceStartDidFail(now: referenceDate)
        model.statusRefreshFailed(sidecarRunning: false, now: referenceDate.addingTimeInterval(1))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(1)), .serviceStartFailed)
    }

    func testStatusRefreshWithActiveRequestsShowsProcessing() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)

        model.statusDidRefresh(serviceStatus: "running", activeRequests: 1, now: referenceDate)

        XCTAssertEqual(model.currentState(now: referenceDate), .requestProcessing)
    }

    func testSuccessfulRequestFeedbackExpiresAfterFiveSeconds() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 0, now: referenceDate)

        model.requestDidStart(now: referenceDate.addingTimeInterval(1))
        model.requestDidFinish(succeeded: true, now: referenceDate.addingTimeInterval(2))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(6.9)), .requestSucceeded)
        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(7.0)), .serviceRunning)
    }

    func testFailedRequestFeedbackExpiresAfterFiveSeconds() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 0, now: referenceDate)

        model.requestDidStart(now: referenceDate.addingTimeInterval(1))
        model.requestDidFinish(succeeded: false, now: referenceDate.addingTimeInterval(2))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(6.9)), .requestFailed)
        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(7.0)), .serviceRunning)
    }

    func testCompletionFeedbackSurvivesStaleActiveRequestRefresh() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 0, now: referenceDate)

        model.requestDidStart(now: referenceDate.addingTimeInterval(1))
        model.requestDidFinish(succeeded: true, now: referenceDate.addingTimeInterval(2))
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 1, now: referenceDate.addingTimeInterval(2.1))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(2.1)), .requestSucceeded)
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 0, now: referenceDate.addingTimeInterval(3))
        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(6.9)), .requestSucceeded)
        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(7.0)), .serviceRunning)
    }

    func testDuplicateStartedEventForSameRequestStillShowsCompletionFeedback() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 0, now: referenceDate)

        model.requestDidStart(requestId: "req_1", now: referenceDate.addingTimeInterval(1))
        model.requestDidStart(requestId: "req_1", now: referenceDate.addingTimeInterval(1.5))
        model.requestDidFinish(succeeded: true, requestId: "req_1", now: referenceDate.addingTimeInterval(2))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(2)), .requestSucceeded)
    }

    func testNewRequestCancelsCompletionFeedback() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 0, now: referenceDate)
        model.requestDidStart(now: referenceDate.addingTimeInterval(1))
        model.requestDidFinish(succeeded: true, now: referenceDate.addingTimeInterval(2))

        model.requestDidStart(now: referenceDate.addingTimeInterval(3))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(3)), .requestProcessing)
        XCTAssertNil(model.feedbackExpiresAt)
    }

    func testMultipleRequestsStayProcessingUntilAllFinish() {
        var model = MenuBarAgentStateModel(feedbackDuration: 5)
        model.statusDidRefresh(serviceStatus: "running", activeRequests: 0, now: referenceDate)

        model.requestDidStart(now: referenceDate.addingTimeInterval(1))
        model.requestDidStart(now: referenceDate.addingTimeInterval(2))
        model.requestDidFinish(succeeded: true, now: referenceDate.addingTimeInterval(3))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(3)), .requestProcessing)

        model.requestDidFinish(succeeded: true, now: referenceDate.addingTimeInterval(4))

        XCTAssertEqual(model.currentState(now: referenceDate.addingTimeInterval(4)), .requestSucceeded)
    }

    func testWhalePixelFramesAreWellFormed() {
        for state in MenuBarAgentState.allCases {
            let frames = PixelWhaleIconRenderer.pixelFrames(for: state)
            XCTAssertFalse(frames.isEmpty, "\(state) should have at least one frame")

            for frame in frames {
                XCTAssertEqual(frame.count, PixelWhaleIconRenderer.gridSize, "\(state) frame should be \(PixelWhaleIconRenderer.gridSize) pixels tall")
                XCTAssertTrue(frame.contains { $0.contains("#") }, "\(state) frame should draw pixels")
                for row in frame {
                    XCTAssertEqual(row.count, PixelWhaleIconRenderer.gridSize, "\(state) rows should be \(PixelWhaleIconRenderer.gridSize) pixels wide")
                }
            }
        }
    }

    func testAnimatedWhaleStatesHaveMultipleFrames() {
        XCTAssertEqual(PixelWhaleIconRenderer.pixelFrames(for: .serviceStopped).count, 1)
        XCTAssertGreaterThan(PixelWhaleIconRenderer.pixelFrames(for: .serviceRunning).count, 1)
        XCTAssertGreaterThan(PixelWhaleIconRenderer.pixelFrames(for: .requestProcessing).count, 1)
        XCTAssertGreaterThan(PixelWhaleIconRenderer.pixelFrames(for: .requestSucceeded).count, 1)
        XCTAssertGreaterThan(PixelWhaleIconRenderer.pixelFrames(for: .requestFailed).count, 1)
        XCTAssertEqual(PixelWhaleIconRenderer.pixelFrames(for: .serviceStartFailed).count, 1)
    }

    func testGeneratedWhaleImagesAreTemplateImages() {
        for state in MenuBarAgentState.allCases {
            let images = PixelWhaleIconRenderer.imageFrames(for: state)
            XCTAssertFalse(images.isEmpty)
            for image in images {
                XCTAssertEqual(image.size, PixelWhaleIconRenderer.iconSize)
                XCTAssertTrue(image.isTemplate)
                XCTAssertNotNil(image.tiffRepresentation)
            }
        }
    }

    private var referenceDate: Date {
        Date(timeIntervalSince1970: 1_000)
    }
}
