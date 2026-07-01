import AppKit

final class TextWindowController: NSWindowController {
    private let body: String

    init(title: String, body: String) {
        self.body = body
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 620, height: 420))
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.string = body

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.documentView = textView
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let copyButton = NSButton(title: "Copy", target: nil, action: nil)

        let buttonRow = NSStackView(views: [copyButton])
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .trailing
        buttonRow.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [scrollView, buttonRow])
        stack.orientation = .vertical
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 460),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.center()
        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        window.contentView = container
        super.init(window: window)
        copyButton.target = self
        copyButton.action = #selector(copyBody)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func copyBody() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(body, forType: .string)
    }
}
