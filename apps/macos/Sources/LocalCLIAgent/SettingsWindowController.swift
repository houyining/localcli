import AppKit

@MainActor
final class SettingsWindowController: NSWindowController {
    private let adminClient: AdminClient
    private let getStartAtLogin: () -> Bool
    private let setStartAtLogin: (Bool) throws -> Void
    private let onSaved: (AgentSettings) -> Void

    private let portField = NSTextField()
    private let retentionField = NSTextField()
    private let logsEnabledButton = NSButton(checkboxWithTitle: "Request logs enabled", target: nil, action: nil)
    private let startAtLoginButton = NSButton(checkboxWithTitle: "Start at Login", target: nil, action: nil)
    private let statusLabel = NSTextField(labelWithString: "")

    init(
        settings: AgentSettings,
        adminClient: AdminClient,
        getStartAtLogin: @escaping () -> Bool,
        setStartAtLogin: @escaping (Bool) throws -> Void,
        onSaved: @escaping (AgentSettings) -> Void
    ) {
        self.adminClient = adminClient
        self.getStartAtLogin = getStartAtLogin
        self.setStartAtLogin = setStartAtLogin
        self.onSaved = onSaved

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 250),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Settings"
        window.center()
        super.init(window: window)

        window.contentView = buildView()
        populate(settings: settings)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func buildView() -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        stack.translatesAutoresizingMaskIntoConstraints = false

        stack.addArrangedSubview(row(label: "Host", value: NSTextField(labelWithString: "localhost")))
        stack.addArrangedSubview(row(label: "Port", value: portField))
        stack.addArrangedSubview(row(label: "Log Retention", value: retentionField))
        stack.addArrangedSubview(logsEnabledButton)
        stack.addArrangedSubview(startAtLoginButton)

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2
        stack.addArrangedSubview(statusLabel)

        let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
        let buttonRow = NSStackView(views: [saveButton])
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .trailing
        stack.addArrangedSubview(buttonRow)

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        return container
    }

    private func row(label: String, value: NSView) -> NSView {
        let labelView = NSTextField(labelWithString: label)
        labelView.widthAnchor.constraint(equalToConstant: 110).isActive = true
        if let field = value as? NSTextField, field.isEditable {
            field.widthAnchor.constraint(equalToConstant: 180).isActive = true
        }
        let stack = NSStackView(views: [labelView, value])
        stack.orientation = .horizontal
        stack.spacing = 10
        return stack
    }

    private func populate(settings: AgentSettings) {
        portField.stringValue = String(settings.port)
        retentionField.stringValue = String(settings.logRetentionDays)
        logsEnabledButton.state = settings.logsEnabled ? .on : .off
        startAtLoginButton.state = getStartAtLogin() ? .on : .off
    }

    @objc private func save() {
        guard let port = Int(portField.stringValue), (1...65535).contains(port) else {
            statusLabel.stringValue = "Port must be between 1 and 65535."
            return
        }
        guard let retention = Int(retentionField.stringValue), (1...365).contains(retention) else {
            statusLabel.stringValue = "Log retention must be between 1 and 365 days."
            return
        }

        Task {
            do {
                let startAtLogin = startAtLoginButton.state == .on
                try setStartAtLogin(startAtLogin)
                let response = try await adminClient.updateSettings(
                    port: port,
                    logRetentionDays: retention,
                    logsEnabled: logsEnabledButton.state == .on,
                    startAtLogin: startAtLogin
                )
                statusLabel.stringValue = response.restartRequired == true
                    ? "Saved. Restart service for the port change to take effect."
                    : "Saved."
                onSaved(response.settings)
            } catch {
                statusLabel.stringValue = error.localizedDescription
            }
        }
    }
}
