import Foundation
import WebKit

/// Bundled-mode completion of provider sign-in (ADR 2026-10-16 v2, Rulings 5 and 6).
///
/// The exchange URL is loaded once in an off-screen web view built on the hosted web view's own
/// website data store and process pool, so the request carries the browser-binding cookie the
/// sign-in leg set there and the binding cookie the answer clears is cleared there. It is not the
/// ephemeral URLSession of fetchHost, which has no cookies. Only that exact URL may load: any
/// other navigation, a redirect included, is cancelled and refused. Only a 200 application/json
/// answer is read, from the document's text; its token pair goes to the caller and nowhere else.
final class ShellSessionExchange: NSObject, WKNavigationDelegate {
    enum Outcome {
        case signedIn(ShellSessionStore.Tokens, returnTo: String)
        case refused
        case malformed
        case unreachable
        case cancelled
    }

    private static let readBody = "document.body ? document.body.textContent : ''"

    private let url: URL
    private let webView: WKWebView
    private var completion: ((Outcome) -> Void)?

    init(url: URL, sharing hosted: WKWebView, completion: @escaping (Outcome) -> Void) {
        self.url = url
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = hosted.configuration.websiteDataStore
        configuration.processPool = hosted.configuration.processPool
        webView = WKWebView(frame: .zero, configuration: configuration)
        self.completion = completion
        super.init()
        webView.navigationDelegate = self
    }

    func start() {
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
    }

    /// Ends the exchange without reading an answer; the caller hears `.cancelled`.
    func cancel() {
        finish(.cancelled)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame == true, navigationAction.request.url == url else {
            decisionHandler(.cancel)
            finish(.refused)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let response = navigationResponse.response as? HTTPURLResponse, response.statusCode == 200 else {
            decisionHandler(.cancel)
            finish(.refused)
            return
        }
        guard response.mimeType == "application/json" else {
            decisionHandler(.cancel)
            finish(.malformed)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(Self.readBody) { [weak self] result, _ in
            self?.finish(Self.outcome(from: result as? String))
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(Self.failure(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(Self.failure(error))
    }

    /// The outcome of a 200 JSON answer: a pair of non-empty strings and a returnTo, or malformed.
    static func outcome(from text: String?) -> Outcome {
        guard let data = text?.data(using: .utf8),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let access = body["accessToken"] as? String, !access.isEmpty,
              let refresh = body["refreshToken"] as? String, !refresh.isEmpty,
              let returnTo = body["returnTo"] as? String else {
            return .malformed
        }
        return .signedIn(ShellSessionStore.Tokens(accessToken: access, refreshToken: refresh), returnTo: returnTo)
    }

    /// A network error means the host could not be reached; anything else is a refusal.
    private static func failure(_ error: Error) -> Outcome {
        (error as NSError).domain == NSURLErrorDomain ? .unreachable : .refused
    }

    /// Answers once; later callbacks of the same load are dropped.
    private func finish(_ outcome: Outcome) {
        guard let completion = completion else { return }
        self.completion = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        completion(outcome)
    }
}
