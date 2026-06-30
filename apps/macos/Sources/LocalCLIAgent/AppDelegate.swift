import AppKit
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let sidecar = SidecarController()
    private let iconAnimator = MenuBarIconAnimator()
    private var adminClient: AdminClient?
    private var statusItem: NSStatusItem?
    private var status: AdminStatus?
    private var timer: Timer?
    private var completionFeedbackTimer: Timer?
    private var menuBarState = MenuBarAgentStateModel()
    private var windows: [NSWindowController] = []
    private var seenPairRequests = Set<String>()
    private var adminPort: Int {
        get {
            let saved = UserDefaults.standard.integer(forKey: "AgentPort")
            return saved == 0 ? 17624 : saved
        }
        set {
            UserDefaults.standard.set(newValue, forKey: "AgentPort")
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: 26)
        iconAnimator.setButton(statusItem?.button)
        refreshMenuBarPresentation()
        startSidecar()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refreshStatus()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        completionFeedbackTimer?.invalidate()
        iconAnimator.stop()
        sidecar.stop()
    }

    private func startSidecar() {
        do {
            try sidecar.start()
            adminClient = AdminClient(port: adminPort, adminToken: sidecar.adminToken)
            adminClient?.startEvents { [weak self] type, payload in
                self?.handleAdminEvent(type: type, payload: payload)
            }
            Task { await refreshStatus() }
        } catch {
            adminClient = nil
            status = nil
            menuBarState.serviceStartDidFail()
            refreshMenuBarPresentation()
            showError(error)
        }
    }

    private func handleAdminEvent(type: String, payload: [String: Any]) {
        let now = Date()
        if type == "request.started" {
            let requestId = payload["requestId"] as? String
            menuBarState.requestDidStart(requestId: requestId, now: now)
            refreshMenuBarPresentation(now: now)
        } else if type == "request.finished" {
            let requestId = payload["requestId"] as? String
            let succeeded = payload["status"] as? String == "success"
            menuBarState.requestDidFinish(succeeded: succeeded, requestId: requestId, now: now)
            refreshMenuBarPresentation(now: now)
        }

        if type == "pairing.requested", let requestId = payload["requestId"] as? String {
            guard !seenPairRequests.contains(requestId) else { return }
            seenPairRequests.insert(requestId)
            showPairingPrompt(requestId: requestId, payload: payload)
        }
        Task { await refreshStatus() }
    }

    private func refreshStatus() async {
        guard let adminClient else {
            if !sidecar.isRunning {
                menuBarState.statusRefreshFailed(sidecarRunning: false)
                refreshMenuBarPresentation()
            }
            return
        }
        do {
            let nextStatus = try await adminClient.status()
            let now = Date()
            status = nextStatus
            menuBarState.statusDidRefresh(
                serviceStatus: nextStatus.status,
                activeRequests: nextStatus.activeRequests,
                now: now
            )
            refreshMenuBarPresentation(now: now)

            for request in nextStatus.pendingPairRequests where !seenPairRequests.contains(request.requestId) {
                seenPairRequests.insert(request.requestId)
                showPairingPrompt(requestId: request.requestId, payload: [
                    "clientName": request.clientName,
                    "clientType": request.clientType,
                    "origin": request.origin ?? "CLI/no-origin client",
                    "requestedCapabilities": request.requestedCapabilities,
                    "requestedProviders": request.requestedProviders
                ])
            }
        } catch {
            status = nil
            menuBarState.statusRefreshFailed(sidecarRunning: sidecar.isRunning)
            refreshMenuBarPresentation()
        }
    }

    private func refreshMenuBarPresentation(now: Date = Date()) {
        renderMenu(now: now)
        applyMenuBarIcon(now: now)
    }

    private func renderMenu(now: Date = Date()) {
        let menu = NSMenu()
        let agentState = menuBarState.currentState(now: now)
        let title = "Status: \(agentState.displayName)"
        menu.addItem(NSMenuItem(title: "Local CLI Agent", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: title, action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Address: \(status?.address ?? "http://localhost:\(adminPort)")", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Providers: \(status?.providersReady ?? 0)/\(status?.providersTotal ?? 0) ready", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Paired Clients: \(status?.pairedClients ?? 0)", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Active Requests: \(status?.activeRequests ?? 0)", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Settings", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Providers", action: #selector(showProviders), keyEquivalent: "p"))
        menu.addItem(NSMenuItem(title: "Paired Clients", action: #selector(showClients), keyEquivalent: "c"))
        menu.addItem(NSMenuItem(title: "Logs", action: #selector(showLogs), keyEquivalent: "l"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Restart Service", action: #selector(restartService), keyEquivalent: "r"))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items {
            item.target = self
        }
        statusItem?.menu = menu
    }

    private func applyMenuBarIcon(now: Date = Date()) {
        iconAnimator.setState(menuBarState.currentState(now: now))
        scheduleFeedbackExpiry(now: now)
    }

    private func scheduleFeedbackExpiry(now: Date) {
        completionFeedbackTimer?.invalidate()
        completionFeedbackTimer = nil

        guard let expiresAt = menuBarState.feedbackExpiresAt else { return }
        let interval = max(0.05, expiresAt.timeIntervalSince(now))
        completionFeedbackTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let now = Date()
                self.menuBarState.expireFeedbackIfNeeded(now: now)
                self.refreshMenuBarPresentation(now: now)
            }
        }
    }

    private func showPairingPrompt(requestId: String, payload: [String: Any]) {
        let clientName = payload["clientName"] as? String ?? "Unknown Client"
        let clientType = payload["clientType"] as? String ?? "unknown"
        let origin = payload["origin"] as? String ?? "CLI/no-origin client"
        let capabilities = (payload["requestedCapabilities"] as? [String])?.joined(separator: ", ") ?? "Unknown"
        let providers = (payload["requestedProviders"] as? [String])?.joined(separator: ", ") ?? "Unknown"

        let alert = NSAlert()
        alert.messageText = "Allow \(clientName)?"
        alert.informativeText = """
        Type: \(clientType)
        Origin: \(origin.isEmpty ? "CLI/no-origin client" : origin)
        Capabilities: \(capabilities)
        Providers: \(providers)

        V1 cannot strongly verify every client-reported identity.
        """
        alert.addButton(withTitle: "Allow")
        alert.addButton(withTitle: "Deny")

        let response = alert.runModal()
        Task {
            do {
                if response == .alertFirstButtonReturn {
                    try await adminClient?.allowPairing(requestId: requestId)
                } else {
                    try await adminClient?.denyPairing(requestId: requestId)
                }
                await refreshStatus()
            } catch {
                showError(error)
            }
        }
    }

    @objc private func showSettings() {
        Task {
            do {
                guard let adminClient else { return }
                let settings = try await adminClient.settings()
                let controller = SettingsWindowController(
                    settings: settings,
                    adminClient: adminClient,
                    getStartAtLogin: { [weak self] in self?.startAtLoginEnabled() ?? false },
                    setStartAtLogin: { [weak self] enabled in try self?.setStartAtLogin(enabled: enabled) },
                    onSaved: { [weak self] settings in
                        self?.adminPort = settings.port
                        Task { await self?.refreshStatus() }
                    }
                )
                windows.append(controller)
                controller.showWindow(nil)
                NSApplication.shared.activate(ignoringOtherApps: true)
            } catch {
                showError(error)
            }
        }
    }

    @objc private func showProviders() {
        Task {
            do {
                let providers = try await adminClient?.providers() ?? []
                let body = providers.map { provider in
                    let state = provider.ready ? "Ready" : (provider.installed ? "Not ready" : "Not installed")
                    return "\(provider.name)\n  ID: \(provider.id)\n  State: \(state)\n  Version: \(provider.version ?? "-")\n  Message: \(provider.message ?? "-")"
                }.joined(separator: "\n\n")
                showTextWindow(title: "Providers", body: body.isEmpty ? "No providers found." : body)
            } catch {
                showError(error)
            }
        }
    }

    @objc private func showClients() {
        Task {
            do {
                guard let adminClient else { return }
                let clients = try await adminClient.clients()
                let providers = try await adminClient.providers()
                let controller = ClientsWindowController(
                    clients: clients,
                    providers: providers,
                    adminClient: adminClient,
                    onChanged: { [weak self] in Task { await self?.refreshStatus() } }
                )
                windows.append(controller)
                controller.showWindow(nil)
                NSApplication.shared.activate(ignoringOtherApps: true)
            } catch {
                showError(error)
            }
        }
    }

    @objc private func showLogs() {
        Task {
            do {
                let logs = try await adminClient?.logs() ?? []
                let body = logs.map { log in
                    "\(log.startedAt) \(log.status) \(log.provider) \(log.clientName) duration=\(log.durationMs)ms input=\(log.inputChars) output=\(log.outputChars) error=\(log.errorCode ?? "-") requestId=\(log.requestId)"
                }.joined(separator: "\n")
                showTextWindow(title: "Logs", body: body.isEmpty ? "No request logs." : body)
            } catch {
                showError(error)
            }
        }
    }

    @objc private func restartService() {
        do {
            let now = Date()
            adminClient = nil
            status = nil
            menuBarState.serviceDidStop(now: now)
            refreshMenuBarPresentation(now: now)
            try sidecar.restart()
            adminClient = AdminClient(port: adminPort, adminToken: sidecar.adminToken)
            adminClient?.startEvents { [weak self] type, payload in
                self?.handleAdminEvent(type: type, payload: payload)
            }
            Task { await refreshStatus() }
        } catch {
            adminClient = nil
            status = nil
            menuBarState.serviceStartDidFail()
            refreshMenuBarPresentation()
            showError(error)
        }
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }

    private func showTextWindow(title: String, body: String) {
        let controller = TextWindowController(title: title, body: body)
        windows.append(controller)
        controller.showWindow(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func showError(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.runModal()
    }

    private func startAtLoginEnabled() -> Bool {
        if #available(macOS 13.0, *) {
            return SMAppService.mainApp.status == .enabled
        }
        return false
    }

    private func setStartAtLogin(enabled: Bool) throws {
        guard #available(macOS 13.0, *) else { return }
        if enabled && SMAppService.mainApp.status != .enabled {
            try SMAppService.mainApp.register()
        } else if !enabled && SMAppService.mainApp.status == .enabled {
            try SMAppService.mainApp.unregister()
        }
    }
}
