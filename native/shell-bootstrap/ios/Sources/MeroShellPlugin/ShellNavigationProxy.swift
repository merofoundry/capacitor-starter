import Foundation
import WebKit

/// Sits in front of Capacitor's navigation delegate for the hosted web view: every call is
/// forwarded to Capacitor unchanged, and main-frame completion and failure are reported to
/// the shell. Navigations Capacitor cancels itself (external links, superseded loads) are
/// not failures.
final class ShellNavigationProxy: NSObject, WKNavigationDelegate {
    private weak var target: WKNavigationDelegate?
    var onLoaded: ((URL?) -> Void)?
    var onFailed: ((URL?, Error) -> Void)?

    init(target: WKNavigationDelegate?) {
        self.target = target
        super.init()
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (target?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        (target?.responds(to: aSelector) ?? false) ? target : nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        target?.webView?(webView, didFinish: navigation)
        onLoaded?(webView.url)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        target?.webView?(webView, didFail: navigation, withError: error)
        report(webView.url, error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        target?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        let failing = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL
        report(failing ?? webView.url, error)
    }

    private func report(_ url: URL?, _ error: Error) {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain, nsError.code != NSURLErrorCancelled else { return }
        onFailed?(url, error)
    }
}
