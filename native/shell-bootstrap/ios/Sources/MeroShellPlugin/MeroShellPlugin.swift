import Foundation
import UIKit
import WebKit
import Capacitor

/// Native bootstrap of the starter shell.
///
/// Capacitor calls `load()` from the bridge view controller's `loadView()`, before the hosted
/// site at server.url is requested. The plugin hides the hosted content, lays the bundled shell
/// overlay over it and lets the overlay's controller (shell/controller.js) decide when the
/// hosted page may be shown. It only executes the overlay's commands and reports platform
/// events.
@objc(MeroShellPlugin)
public class MeroShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MeroShellPlugin"
    public let jsName = "MeroShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise)
    ]

    private static let lockEnabledKey = "MeroShell.lockEnabled"

    private var overlay: ShellOverlay?
    private var navigationProxy: ShellNavigationProxy?
    private let biometrics = ShellBiometrics()
    private var host = ""
    private var overlayReady = false
    private var queuedEvents: [[String: Any]] = []
    private var authInProgress = false
    private var coveredForInactive = false
    private var backgroundedWhileCovered = false

    override public func load() {
        guard let hosted = bridge?.webView else {
            CAPLog.print("MeroShell: no web view at load; shell disabled")
            return
        }
        host = bridge?.config.serverURL.host ?? ""
        hosted.scrollView.isHidden = true

        let proxy = ShellNavigationProxy(target: hosted.navigationDelegate)
        proxy.onLoaded = { [weak self] url in self?.emit("pageLoaded", ["url": url?.absoluteString ?? ""]) }
        proxy.onFailed = { [weak self] url, error in
            let nsError = error as NSError
            self?.emit("pageFailed", ["url": url?.absoluteString ?? "", "code": nsError.code, "description": nsError.localizedDescription])
        }
        hosted.navigationDelegate = proxy
        navigationProxy = proxy

        injectHostedIntegration(into: hosted)

        let overlay = ShellOverlay { [weak self] message in self?.handle(message) }
        overlay.attach(over: hosted)
        overlay.load()
        self.overlay = overlay

        observeLifecycle()
    }

    /// Called from the hosted page through window.MeroFoundryShell.openSettings().
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in self?.emit("openSettings", [:]) }
        call.resolve()
    }

    /// Called by the hosted page's pull-to-refresh gesture. A pull on a covered page is dropped
    /// here; otherwise the overlay's controller decides whether to reload the application host.
    @objc func refresh(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.bridge?.webView?.scrollView.isHidden == false else { return }
            self.emit("refreshRequested", ["url": url])
        }
        call.resolve()
    }

    // MARK: Lifecycle

    private func observeLifecycle() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(openUniversalLink(_:)), name: .capacitorOpenUniversalLink, object: nil)
        center.addObserver(self, selector: #selector(layoutChanged), name: .capacitorViewDidAppear, object: nil)
        center.addObserver(self, selector: #selector(layoutChanged), name: UIDevice.orientationDidChangeNotification, object: nil)
    }

    @objc private func willResignActive() {
        // The Face ID sheet itself makes the app inactive; that must not re-lock it.
        guard lockEnabled, !authInProgress else { return }
        cover()
        coveredForInactive = true
    }

    @objc private func didEnterBackground() {
        if coveredForInactive {
            backgroundedWhileCovered = true
        }
    }

    @objc private func didBecomeActive() {
        guard coveredForInactive else { return }
        let backgrounded = backgroundedWhileCovered
        coveredForInactive = false
        backgroundedWhileCovered = false
        emit("resume", ["backgrounded": backgrounded])
    }

    @objc private func openUniversalLink(_ notification: Notification) {
        guard let object = notification.object as? [String: Any], let url = object["url"] as? URL else { return }
        DispatchQueue.main.async { [weak self] in self?.emit("deepLink", ["url": url.absoluteString]) }
    }

    @objc private func layoutChanged() {
        DispatchQueue.main.async { [weak self] in self?.emitInsets() }
    }

    // MARK: Overlay commands

    private func handle(_ json: String) {
        guard let data = json.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return
        }
        let id = message["id"] as? Int ?? 0
        let args = message["args"] as? [String: Any] ?? [:]
        dispatch(id: id, cmd: message["cmd"] as? String ?? "", args: args)
    }

    private func dispatch(id: Int, cmd: String, args: [String: Any]) {
        switch cmd {
        case "ready":
            reply(id, launchState())
            overlayReady = true
            queuedEvents.forEach { overlay?.send($0) }
            queuedEvents.removeAll()
            emitInsets()
        case "reveal":
            bridge?.webView?.scrollView.isHidden = false
            overlay?.hide()
            reply(id, nil)
        case "cover":
            cover()
            reply(id, nil)
        case "authenticate":
            authInProgress = true
            biometrics.authenticate(reason: args["reason"] as? String ?? "Unlock") { [weak self] result in
                self?.authInProgress = false
                self?.reply(id, result)
            }
        case "setLockEnabled":
            UserDefaults.standard.set(args["enabled"] as? Bool ?? false, forKey: Self.lockEnabledKey)
            reply(id, nil)
        case "clearCookies":
            HTTPCookieStorage.shared.removeCookies(since: Date.distantPast)
            WKWebsiteDataStore.default().removeData(ofTypes: [WKWebsiteDataTypeCookies], modifiedSince: Date.distantPast) { [weak self] in
                self?.reply(id, nil)
            }
        case "loadHost":
            loadHost(id: id, path: args["path"] as? String ?? "/")
        case "applyHostInsets":
            let json = Self.json(args) ?? "{}"
            bridge?.webView?.evaluateJavaScript("window.MeroFoundryShell&&window.MeroFoundryShell._applyInsets(\(json))")
            reply(id, nil)
        default:
            replyError(id, "unknown command \(cmd)")
        }
    }

    private func loadHost(id: Int, path: String) {
        guard path.hasPrefix("/"), let url = URL(string: "https://\(host)\(path)"), url.scheme == "https", url.host == host else {
            replyError(id, "refused to load a URL outside the application host")
            return
        }
        bridge?.webView?.load(URLRequest(url: url))
        reply(id, nil)
    }

    private func cover() {
        overlay?.show()
        bridge?.webView?.scrollView.isHidden = true
    }

    // MARK: State

    private var lockEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.lockEnabledKey)
    }

    private func launchState() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        let name = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? ""
        let version = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? ""
        return [
            "platform": "ios",
            "host": host,
            "appName": name,
            "appVersion": "\(version) (\(build))",
            "starterVersion": getConfig().getString("starterVersion", "") ?? "",
            "lockEnabled": lockEnabled,
            "biometry": biometrics.status()
        ]
    }

    private func injectHostedIntegration(into hosted: WKWebView) {
        guard let file = Bundle.main.url(forResource: "hosted-integration", withExtension: "js", subdirectory: "public"),
              let source = try? String(contentsOf: file, encoding: .utf8) else {
            CAPLog.print("MeroShell: missing public/hosted-integration.js; run npx cap sync ios")
            return
        }
        let config: [String: Any] = [
            "host": host,
            "platform": "ios",
            "starterVersion": getConfig().getString("starterVersion", "") ?? ""
        ]
        let script = "window.__meroShellConfig=\(Self.json(config) ?? "null");\n\(source)"
        let userScript = WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        hosted.configuration.userContentController.addUserScript(userScript)
    }

    private func emitInsets() {
        guard let insets = bridge?.viewController?.view.safeAreaInsets else { return }
        emit("insets", [
            "top": Double(insets.top),
            "right": Double(insets.right),
            "bottom": Double(insets.bottom),
            "left": Double(insets.left)
        ])
    }

    // MARK: Channel

    private func emit(_ name: String, _ payload: [String: Any]) {
        let event: [String: Any] = ["type": "event", "name": name, "payload": payload]
        if overlayReady {
            overlay?.send(event)
        } else {
            queuedEvents.append(event)
        }
    }

    private func reply(_ id: Int, _ value: Any?) {
        overlay?.send(["type": "result", "id": id, "ok": true, "value": value ?? NSNull()])
    }

    private func replyError(_ id: Int, _ error: String) {
        overlay?.send(["type": "result", "id": id, "ok": false, "error": error])
    }

    static func json(_ object: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
