import Foundation
import UIKit
import WebKit

/// The bundled shell screens (public/index.html) in a plain WKWebView laid over the hosted
/// one. It has no Capacitor bridge: its only native surface is the `meroShell` message
/// handler, and it can load nothing but the app's own bundled files.
final class ShellOverlay: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private let onMessage: (String) -> Void
    private var root: URL?

    init(onMessage: @escaping (String) -> Void) {
        self.onMessage = onMessage
        let configuration = WKWebViewConfiguration()
        let controller = WKUserContentController()
        configuration.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        controller.add(WeakMessageHandler(self), name: "meroShell")
        webView.isOpaque = true
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.navigationDelegate = self
    }

    /// Pin the overlay to the edges of the hosted web view, above its content.
    func attach(over hosted: WKWebView) {
        webView.translatesAutoresizingMaskIntoConstraints = false
        hosted.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: hosted.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: hosted.trailingAnchor),
            webView.topAnchor.constraint(equalTo: hosted.topAnchor),
            webView.bottomAnchor.constraint(equalTo: hosted.bottomAnchor)
        ])
    }

    func load() {
        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "public") else {
            return
        }
        root = index.deletingLastPathComponent()
        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    func show() {
        webView.isHidden = false
        webView.superview?.bringSubviewToFront(webView)
    }

    func hide() {
        webView.isHidden = true
    }

    func send(_ message: [String: Any]) {
        guard let json = MeroShellPlugin.json(message) else { return }
        webView.evaluateJavaScript("window.MeroShellChannel&&window.MeroShellChannel.receive(\(json))")
    }

    func received(_ body: Any) {
        if let json = body as? String {
            onMessage(json)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let local = url?.isFileURL == true && root != nil && url!.standardizedFileURL.path.hasPrefix(root!.standardizedFileURL.path)
        decisionHandler(local ? .allow : .cancel)
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with the overlay.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var overlay: ShellOverlay?

    init(_ overlay: ShellOverlay) {
        self.overlay = overlay
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        overlay?.received(message.body)
    }
}
