import AppKit

@MainActor
final class ClientsWindowController: NSWindowController {
    private let adminClient: AdminClient
    private let providerIds: [String]
    private let onChanged: () -> Void
    private var clients: [PairingRecord]

    private let clientPopup = NSPopUpButton()
    private let detailsLabel = NSTextField(labelWithString: "")
    private let defaultProviderPopup = NSPopUpButton()
    private var providerButtons: [String: NSButton] = [:]
    private var capabilityButtons: [String: NSButton] = [:]
    private let maxConcurrentField = NSTextField()
    private let maxDurationField = NSTextField()
    private let statusLabel = NSTextField(labelWithString: "")

    private let allCapabilities = ["llm.chat", "llm.stream", "llm.listProviders"]

    init(
        clients: [PairingRecord],
        providers: [ProviderStatus],
        adminClient: AdminClient,
        onChanged: @escaping () -> Void
    ) {
        self.clients = clients
        self.adminClient = adminClient
        self.providerIds = Array(Set(providers.map(\.id) + clients.flatMap(\.allowedProviders))).sorted()
        self.onChanged = onChanged

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Paired Clients"
        window.center()
        super.init(window: window)
        window.contentView = buildView()
        renderClients()
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

        clientPopup.target = self
        clientPopup.action = #selector(selectedClientChanged)
        stack.addArrangedSubview(row(label: "Client", value: clientPopup))

        detailsLabel.lineBreakMode = .byWordWrapping
        detailsLabel.maximumNumberOfLines = 5
        stack.addArrangedSubview(detailsLabel)

        stack.addArrangedSubview(row(label: "Default Provider", value: defaultProviderPopup))

        let providersBox = NSBox()
        providersBox.title = "Allowed Providers"
        providersBox.contentView = checkboxStack(ids: providerIds, storage: &providerButtons)
        stack.addArrangedSubview(providersBox)

        let capabilitiesBox = NSBox()
        capabilitiesBox.title = "Capabilities"
        capabilitiesBox.contentView = checkboxStack(ids: allCapabilities, storage: &capabilityButtons)
        stack.addArrangedSubview(capabilitiesBox)

        stack.addArrangedSubview(row(label: "Max Concurrent", value: maxConcurrentField))
        stack.addArrangedSubview(row(label: "Max Duration Ms", value: maxDurationField))

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2
        stack.addArrangedSubview(statusLabel)

        let saveButton = NSButton(title: "Save Changes", target: self, action: #selector(save))
        let removeButton = NSButton(title: "Remove Pairing", target: self, action: #selector(remove))
        let buttonRow = NSStackView(views: [saveButton, removeButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 10
        stack.addArrangedSubview(buttonRow)

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor)
        ])
        return container
    }

    private func row(label: String, value: NSView) -> NSView {
        let labelView = NSTextField(labelWithString: label)
        labelView.widthAnchor.constraint(equalToConstant: 130).isActive = true
        if let field = value as? NSTextField, field.isEditable {
            field.widthAnchor.constraint(equalToConstant: 180).isActive = true
        }
        let stack = NSStackView(views: [labelView, value])
        stack.orientation = .horizontal
        stack.spacing = 10
        return stack
    }

    private func checkboxStack(ids: [String], storage: inout [String: NSButton]) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        for id in ids {
            let button = NSButton(checkboxWithTitle: id, target: self, action: #selector(providerCheckboxChanged))
            storage[id] = button
            stack.addArrangedSubview(button)
        }
        return stack
    }

    private func renderClients() {
        clientPopup.removeAllItems()
        clientPopup.addItems(withTitles: clients.map(\.clientName))
        selectedClientChanged()
    }

    private var selectedClient: PairingRecord? {
        let index = clientPopup.indexOfSelectedItem
        guard clients.indices.contains(index) else { return nil }
        return clients[index]
    }

    @objc private func selectedClientChanged() {
        guard let client = selectedClient else {
            detailsLabel.stringValue = "No paired clients."
            return
        }

        detailsLabel.stringValue = """
        Type: \(client.clientType)
        Origin: \(client.origin ?? "-")
        Last Used: \(client.lastUsedAt ?? "-")
        Requests: \(client.requestCount)
        """

        for (id, button) in providerButtons {
            button.state = client.allowedProviders.contains(id) ? .on : .off
        }
        for (id, button) in capabilityButtons {
            button.state = client.capabilities.contains(id) ? .on : .off
        }
        maxConcurrentField.stringValue = String(client.maxConcurrentRequests)
        maxDurationField.stringValue = String(client.maxRequestDurationMs)
        renderDefaultProviders(selected: client.defaultProvider)
    }

    @objc private func providerCheckboxChanged() {
        renderDefaultProviders(selected: defaultProviderPopup.titleOfSelectedItem)
    }

    private func renderDefaultProviders(selected: String?) {
        let allowed = providerButtons
            .filter { $0.value.state == .on }
            .map(\.key)
            .sorted()
        defaultProviderPopup.removeAllItems()
        defaultProviderPopup.addItems(withTitles: allowed)
        if let selected, allowed.contains(selected) {
            defaultProviderPopup.selectItem(withTitle: selected)
        } else if let first = allowed.first {
            defaultProviderPopup.selectItem(withTitle: first)
        }
    }

    @objc private func save() {
        guard let client = selectedClient else { return }
        let allowedProviders = providerButtons.filter { $0.value.state == .on }.map(\.key).sorted()
        let capabilities = capabilityButtons.filter { $0.value.state == .on }.map(\.key).sorted()
        guard !allowedProviders.isEmpty else {
            statusLabel.stringValue = "Select at least one provider."
            return
        }
        guard !capabilities.isEmpty else {
            statusLabel.stringValue = "Select at least one capability."
            return
        }
        guard let maxConcurrent = Int(maxConcurrentField.stringValue), maxConcurrent > 0 else {
            statusLabel.stringValue = "Max concurrent must be greater than 0."
            return
        }
        guard let maxDuration = Int(maxDurationField.stringValue), maxDuration >= 1000 else {
            statusLabel.stringValue = "Max duration must be at least 1000 ms."
            return
        }
        let defaultProvider = defaultProviderPopup.titleOfSelectedItem ?? allowedProviders[0]

        Task {
            do {
                _ = try await adminClient.updateClient(
                    clientId: client.clientId,
                    defaultProvider: defaultProvider,
                    allowedProviders: allowedProviders,
                    capabilities: capabilities,
                    maxConcurrentRequests: maxConcurrent,
                    maxRequestDurationMs: maxDuration
                )
                clients = try await adminClient.clients()
                statusLabel.stringValue = "Saved."
                renderClients()
                onChanged()
            } catch {
                statusLabel.stringValue = error.localizedDescription
            }
        }
    }

    @objc private func remove() {
        guard let client = selectedClient else { return }
        let alert = NSAlert()
        alert.messageText = "Remove \(client.clientName)?"
        alert.informativeText = "This revokes the local credential for this client."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        Task {
            do {
                try await adminClient.deleteClient(clientId: client.clientId)
                clients = try await adminClient.clients()
                statusLabel.stringValue = "Removed."
                renderClients()
                onChanged()
            } catch {
                statusLabel.stringValue = error.localizedDescription
            }
        }
    }
}
