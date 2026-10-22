import Foundation
import UIKit
import WebKit
import AuthenticationServices
import Capacitor

/// Native bootstrap of the starter shell.
///
/// Capacitor calls `load()` from the bridge view controller's `loadView()`, before the site is
/// requested: the hosted site at server.url in remote mode, the bundled site from the local
/// origin in bundled mode. The application host and the mode come from the MeroShell plugin
/// configuration, not from server.url. The plugin hides the site's content, lays the shell
/// overlay (public/meroshell/) over it and lets the overlay's controller (shell/controller.js)
/// decide when the page may be shown. It only executes the overlay's commands and reports platform
/// events.
///
/// Provider sign-in (ADR 2026-10-16 v2, Ruling 6): while a sign-in leg is pending, the first
/// main-frame https navigation off the configured host is cancelled and reported; the controller
/// then has the provider URL opened in ASWebAuthenticationSession, never in the web view, with an
/// HTTPS callback for the configured host and the exact exchange path it names.
///
/// The page keeps its bearer token pair through loadSession, saveSession and clearSession,
/// backed by `ShellSessionStore` (the Keychain). The tokens are never logged or sent to the overlay.
///
/// In bundled mode the controller completes provider sign-in with exchangeSession: the exchange
/// route alone, asked for the bearer transport, is redeemed by `ShellSessionExchange` in the
/// hosted web view's cookie context, the pair is saved here and only an outcome and returnTo are
/// answered. sessionChanged then tells the page, with no token, through _sessionChanged.
///
/// Push (ADR 2026-10-16 v2, Rulings 1 to 3) is native APNs through `ShellPush`, installed during
/// `load()`. The page calls registerPush, unregisterPush and getPushState and registers the token
/// with its own session; a changed token reaches it through _pushToken. Taps are reported to the
/// overlay as pushTapped with only the path. Before sign-out the overlay's disablePush has the
/// page remove its registration (_pushDisable, answered through pushDisabled).
@objc(MeroShellPlugin)
public class MeroShellPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "MeroShellPlugin"
    public let jsName = "MeroShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "providerSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregisterPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPushState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushDisabled", returnType: CAPPluginReturnPromise)
    ]

    private static let lockEnabledKey = "MeroShell.lockEnabled"

    private var overlay: ShellOverlay?
    private var navigationProxy: ShellNavigationProxy?
    private let biometrics = ShellBiometrics()
    private var host = ""
    private var bundled = false
    private var localOrigin = ""
    private var sessionStore: ShellSessionStore?
    private var overlayReady = false
    private var queuedEvents: [[String: Any]] = []
    private var authInProgress = false
    private var coveredForInactive = false
    private var backgroundedWhileCovered = false
    private var providerSignInEnabled = false
    private var signInLeg = 0
    private var webAuthOpen = false
    private var webAuthSession: ASWebAuthenticationSession?
    private var sessionExchange: ShellSessionExchange?
    private var exchangeCount = 0
    private var push: ShellPush?
    private var pushApplicationId = ""
    private var pushDisableReply: Int?
    private static let uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    private static let exchangePath = "^/api/v1/applications/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/auth/oauth/exchange$"

    override public func load() {
        host = getConfig().getString("host", "") ?? ""
        bundled = getConfig().getString("mode", "remote") == "bundled"
        localOrigin = bundled ? (bridge?.config.localURL.absoluteString ?? "") : ""
        sessionStore = ShellSessionStore(service: getConfig().getString("appId", "") ?? "")
        installPush()
        if host.isEmpty {
            CAPLog.print("MeroShell: no host in the MeroShell plugin configuration; run npx cap sync ios")
        }
        guard let hosted = bridge?.webView else {
            CAPLog.print("MeroShell: no web view at load; shell disabled")
            return
        }
        hosted.scrollView.isHidden = true

        let proxy = ShellNavigationProxy(target: hosted.navigationDelegate)
        proxy.onLoaded = { [weak self] url in self?.emit("pageLoaded", ["url": url?.absoluteString ?? ""]) }
        proxy.onFailed = { [weak self] url, error in
            let nsError = error as NSError
            self?.emit("pageFailed", ["url": url?.absoluteString ?? "", "code": nsError.code, "description": nsError.localizedDescription])
        }
        proxy.onNavigation = { [weak self] action in self?.interceptProviderRedirect(action) ?? false }
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

    /// Called by the hosted page's provider sign-in. A request from a covered page is dropped here;
    /// otherwise the overlay's controller decides whether a sign-in leg may start.
    @objc func providerSignIn(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.bridge?.webView?.scrollView.isHidden == false else { return }
            self.emit("providerSignInRequested", ["url": url])
        }
        call.resolve()
    }

    /// Asked by each hosted document at install: the capability the controller last announced.
    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            call.resolve(["providerSignIn": providerSignInEnabled])
        }
    }

    /// Called by the page through MeroFoundryShell.session.load(): the stored pair, or {} when none.
    @objc func loadSession(_ call: CAPPluginCall) {
        do {
            guard let tokens = try sessionStore?.load() else {
                call.resolve([:])
                return
            }
            call.resolve(["accessToken": tokens.accessToken, "refreshToken": tokens.refreshToken])
        } catch {
            call.reject("secure session storage is unavailable")
        }
    }

    /// Called by the page through MeroFoundryShell.session.save(pair).
    @objc func saveSession(_ call: CAPPluginCall) {
        let access = call.getString("accessToken") ?? ""
        let refresh = call.getString("refreshToken") ?? ""
        guard !access.isEmpty, !refresh.isEmpty, let store = sessionStore else {
            call.reject("session.save needs a non-empty accessToken and refreshToken")
            return
        }
        do {
            try store.save(ShellSessionStore.Tokens(accessToken: access, refreshToken: refresh))
            call.resolve()
        } catch {
            call.reject("secure session storage is unavailable")
        }
    }

    /// Called by the page through MeroFoundryShell.session.clear().
    @objc func clearSession(_ call: CAPPluginCall) {
        do {
            try sessionStore?.clear()
            call.resolve()
        } catch {
            call.reject("secure session storage is unavailable")
        }
    }

    // MARK: Push

    /// Installs the notification-center delegate and the APNs observers while the plugin loads,
    /// so a tap that launched the app is reported once the overlay is ready.
    private func installPush() {
        let push = ShellPush(store: sessionStore)
        push.onTap = { [weak self] path in self?.emit("pushTapped", ["path": path]) }
        push.onToken = { [weak self] value in self?.deliverPushToken(value) }
        push.install()
        self.push = push
    }

    /// Called by the page through MeroFoundryShell.push.enable(): answers {status: "granted",
    /// token, platform}, {status: "denied"} or {status: "unavailable", reason}.
    @objc func registerPush(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let push = self?.push else {
                call.resolve(["status": "unavailable", "reason": "not_configured"])
                return
            }
            push.register { registration in
                switch registration {
                case .granted(let value):
                    call.resolve(["status": "granted", "token": value, "platform": "apns"])
                case .denied:
                    call.resolve(["status": "denied"])
                case .unavailable(let reason):
                    call.resolve(["status": "unavailable", "reason": reason])
                }
            }
        }
    }

    /// Called by the page through MeroFoundryShell.push.disable(): unregisters from APNs, turns
    /// push off and answers {status: "unregistered", token} with the token it held, or null.
    @objc func unregisterPush(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            do {
                let previous: String? = try self?.push?.unregister()
                call.resolve(["status": "unregistered", "token": (previous as Any?) ?? NSNull()])
            } catch {
                call.reject("secure session storage is unavailable")
            }
        }
    }

    /// Called by the page: {enabled, permission, platform, appVersion, applicationId}. Never prompts.
    @objc func getPushState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.pushState { state in call.resolve(state) }
        }
    }

    /// Called by the page when its _pushDisable has finished: answers the overlay's disablePush.
    @objc func pushDisabled(_ call: CAPPluginCall) {
        let ok = call.getBool("ok") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let pending = self.pushDisableReply else { return }
            self.pushDisableReply = nil
            self.reply(pending, ["ok": ok])
        }
        call.resolve()
    }

    private func pushState(_ completion: @escaping ([String: Any]) -> Void) {
        let applicationId: Any = pushApplicationId.isEmpty ? NSNull() as Any : pushApplicationId as Any
        let version = appVersion
        guard let push = push else {
            completion(["enabled": false, "permission": "unavailable", "platform": "apns", "appVersion": version, "applicationId": applicationId])
            return
        }
        push.state { state in
            var result = state
            result["appVersion"] = version
            result["applicationId"] = applicationId
            completion(result)
        }
    }

    /// A changed APNs token goes to the page, which registers it with its own session.
    private func deliverPushToken(_ value: String) {
        guard let payload = Self.json(["token": value, "platform": "apns"]) else { return }
        bridge?.webView?.evaluateJavaScript("window.MeroFoundryShell&&window.MeroFoundryShell._pushToken(\(payload))")
    }

    /// Settings sign-out: the page removes its registration with its own session and answers
    /// through pushDisabled. With nothing registered the answer is immediate; with no page to ask
    /// it is a failure, and the overlay then resets push natively.
    private func disablePush(id: Int) {
        guard push?.registered == true else {
            reply(id, ["ok": true])
            return
        }
        guard let hosted = bridge?.webView else {
            reply(id, ["ok": false])
            return
        }
        if let previous = pushDisableReply {
            reply(previous, ["ok": false])
        }
        pushDisableReply = id
        hosted.evaluateJavaScript("window.MeroFoundryShell?(window.MeroFoundryShell._pushDisable(),true):false") { [weak self] result, _ in
            guard let self = self, (result as? Bool) != true, self.pushDisableReply == id else { return }
            self.pushDisableReply = nil
            self.reply(id, ["ok": false])
        }
    }

    /// The application id the overlay read from the host, kept for getPushState and told to the page.
    private func setPushApplication(_ value: String) {
        pushApplicationId = value.range(of: Self.uuidPattern, options: .regularExpression) != nil ? value : ""
        let argument = pushApplicationId.isEmpty ? "null" : "\"\(pushApplicationId)\""
        bridge?.webView?.evaluateJavaScript("window.MeroFoundryShell&&window.MeroFoundryShell._setApplicationId(\(argument))")
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
        // The Face ID sheet and the web-authentication sheet make the app inactive; that must not re-lock it.
        guard lockEnabled, !authInProgress, !webAuthOpen else { return }
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
        case "setHostCapabilities":
            providerSignInEnabled = args["providerSignIn"] as? Bool ?? false
            bridge?.webView?.evaluateJavaScript("window.MeroFoundryShell&&window.MeroFoundryShell._setProviderSignIn(\(providerSignInEnabled))")
            reply(id, nil)
        case "fetchHost":
            fetchHost(id: id, path: args["path"] as? String ?? "/")
        case "startProviderSignIn":
            startProviderSignIn(id: id, path: args["path"] as? String ?? "/", leg: args["leg"] as? Int ?? 0)
        case "openWebAuth":
            openWebAuth(id: id, args: args)
        case "cancelProviderSignIn":
            signInLeg = 0
            webAuthSession?.cancel()
            sessionExchange?.cancel()
            reply(id, nil)
        case "exchangeSession":
            exchangeSession(id: id, path: args["path"] as? String ?? "")
        case "clearSavedSession":
            clearSavedSession(id: id)
        case "sessionChanged":
            let signedIn = args["signedIn"] as? Bool ?? false
            bridge?.webView?.evaluateJavaScript("window.MeroFoundryShell&&window.MeroFoundryShell._sessionChanged({signedIn:\(signedIn)})")
            reply(id, nil)
        case "applyHostInsets":
            let json = Self.json(args) ?? "{}"
            bridge?.webView?.evaluateJavaScript("window.MeroFoundryShell&&window.MeroFoundryShell._applyInsets(\(json))")
            reply(id, nil)
        case "getPushState":
            pushState { [weak self] state in self?.reply(id, state) }
        case "setPushApplication":
            setPushApplication(args["applicationId"] as? String ?? "")
            reply(id, nil)
        case "disablePush":
            disablePush(id: id)
        case "resetPush":
            _ = try? push?.unregister()
            reply(id, nil)
        case "pushEvent":
            let event: [String: Any] = ["type": args["type"] as? String ?? "", "reason": args["reason"] as? String ?? ""]
            let json = Self.json(event) ?? "{}"
            bridge?.webView?.evaluateJavaScript("window.MeroFoundryShell&&window.MeroFoundryShell._pushEvent(\(json))")
            reply(id, nil)
        default:
            replyError(id, "unknown command \(cmd)")
        }
    }

    private func loadHost(id: Int, path: String) {
        guard let url = pageURL(path) else {
            replyError(id, "refused to load a URL outside the application host")
            return
        }
        bridge?.webView?.load(URLRequest(url: url))
        reply(id, nil)
    }

    /// The URL of a page path: on the local origin in bundled mode, on the configured https host
    /// in remote mode; nil if it would leave that origin.
    private func pageURL(_ path: String) -> URL? {
        let base = bundled ? localOrigin : "https://\(host)"
        guard path.hasPrefix("/"), let url = URL(string: base + path),
              url.scheme == URL(string: base)?.scheme, url.host == URL(string: base)?.host else {
            return nil
        }
        return url
    }

    /// The https URL of a path on the configured host, or nil if it would leave the host.
    private func hostURL(_ path: String) -> URL? {
        guard path.hasPrefix("/"), let url = URL(string: "https://\(host)\(path)"), url.scheme == "https", url.host == host else {
            return nil
        }
        return url
    }

    /// The bearer exchange URL: https on the configured host, exactly an application's OAuth
    /// exchange path, with session=bearer in its query; nil for anything else.
    private func exchangeURL(_ path: String) -> URL? {
        guard let url = hostURL(path), url.path.range(of: Self.exchangePath, options: .regularExpression) != nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.filter({ $0.name == "session" }).map({ $0.value }) == ["bearer"] else {
            return nil
        }
        return url
    }

    /// Bundled mode only: redeems the validated exchange in the hosted web view's cookie context
    /// and saves the pair. Replies {status} and, when signed in, returnTo; never a token.
    private func exchangeSession(id: Int, path: String) {
        guard bundled, let url = exchangeURL(path), let hosted = bridge?.webView, let store = sessionStore else {
            replyError(id, "refused to exchange outside the application exchange route")
            return
        }
        sessionExchange?.cancel()
        exchangeCount += 1
        let current = exchangeCount
        let exchange = ShellSessionExchange(url: url, sharing: hosted) { [weak self] outcome in
            DispatchQueue.main.async { self?.finishExchange(id: id, current: current, outcome: outcome, store: store) }
        }
        sessionExchange = exchange
        exchange.start()
    }

    private func finishExchange(id: Int, current: Int, outcome: ShellSessionExchange.Outcome, store: ShellSessionStore) {
        if current == exchangeCount {
            sessionExchange = nil
        }
        switch outcome {
        case .signedIn(let pair, let returnTo):
            do {
                try store.save(pair)
            } catch {
                reply(id, ["status": "storageFailed"])
                return
            }
            reply(id, ["status": "signedIn", "returnTo": returnTo])
        case .refused:
            reply(id, ["status": "refused"])
        case .malformed:
            reply(id, ["status": "malformed"])
        case .unreachable:
            reply(id, ["status": "unreachable"])
        case .cancelled:
            reply(id, ["status": "cancelled"])
        }
    }

    /// Settings sign-out in bundled mode: removes the saved pair before the cookies are cleared.
    private func clearSavedSession(id: Int) {
        do {
            try sessionStore?.clear()
            reply(id, nil)
        } catch {
            replyError(id, "secure session storage is unavailable")
        }
    }

    private func startProviderSignIn(id: Int, path: String, leg: Int) {
        guard let url = hostURL(path) else {
            replyError(id, "refused to start sign-in outside the application host")
            return
        }
        guard leg > 0 else {
            replyError(id, "refused to start sign-in without a leg")
            return
        }
        signInLeg = leg
        bridge?.webView?.load(URLRequest(url: url))
        reply(id, nil)
    }

    /// Cancels the first main-frame https navigation off the configured host while a sign-in leg
    /// is pending, and reports it; every other navigation keeps Capacitor's handling.
    private func interceptProviderRedirect(_ action: WKNavigationAction) -> Bool {
        guard signInLeg != 0, action.targetFrame?.isMainFrame == true, let url = action.request.url,
              url.scheme == "https", url.host != host else {
            return false
        }
        let leg = signInLeg
        signInLeg = 0
        emit("providerRedirect", ["url": url.absoluteString, "leg": leg])
        return true
    }

    /// Opens the provider URL in the system web-authentication session. The session shares
    /// Safari's cookies (not ephemeral) and closes when it reaches the HTTPS callback.
    private func openWebAuth(id: Int, args: [String: Any]) {
        guard #available(iOS 17.4, *) else {
            replyError(id, "web authentication with an HTTPS callback needs iOS 17.4 or later")
            return
        }
        guard let raw = args["url"] as? String, let url = URL(string: raw), url.scheme == "https",
              let callbackHost = args["callbackHost"] as? String, callbackHost == host,
              let callbackPath = args["callbackPath"] as? String, callbackPath.hasPrefix("/"),
              let leg = args["leg"] as? Int, leg > 0 else {
            replyError(id, "refused to open web authentication")
            return
        }
        let session = ASWebAuthenticationSession(url: url, callback: .https(host: callbackHost, path: callbackPath)) { [weak self] callbackURL, error in
            DispatchQueue.main.async { self?.finishWebAuth(leg: leg, callbackURL: callbackURL, error: error) }
        }
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = self
        webAuthSession = session
        webAuthOpen = true
        guard session.start() else {
            webAuthSession = nil
            webAuthOpen = false
            replyError(id, "web authentication did not start")
            return
        }
        reply(id, nil)
    }

    private func finishWebAuth(leg: Int, callbackURL: URL?, error: Error?) {
        webAuthSession = nil
        webAuthOpen = false
        if let callbackURL = callbackURL {
            emit("webAuthReturned", ["url": callbackURL.absoluteString, "leg": leg])
        } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
            emit("webAuthCancelled", ["leg": leg])
        } else {
            emit("webAuthFailed", ["leg": leg, "message": error?.localizedDescription ?? "web authentication failed"])
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }

    /// GET a path on the configured host without cookies or redirects; replies {status, body}.
    private func fetchHost(id: Int, path: String) {
        guard let url = hostURL(path) else {
            replyError(id, "refused to load a URL outside the application host")
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let session = URLSession(configuration: .ephemeral, delegate: ShellNoRedirects(), delegateQueue: nil)
        session.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = status == 200 ? String(data: data ?? Data(), encoding: .utf8) ?? "" : ""
            DispatchQueue.main.async {
                if let error = error {
                    self?.replyError(id, "could not reach the application host: \(error.localizedDescription)")
                } else {
                    self?.reply(id, ["status": status, "body": body])
                }
            }
        }.resume()
        session.finishTasksAndInvalidate()
    }

    private func cover() {
        overlay?.show()
        bridge?.webView?.scrollView.isHidden = true
    }

    // MARK: State

    private var lockEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.lockEnabledKey)
    }

    /// The native app version, "<short version> (<build>)".
    private var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? ""
        return "\(version) (\(build))"
    }

    private func launchState() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        let name = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? ""
        return [
            "platform": "ios",
            "host": host,
            "mode": bundled ? "bundled" : "remote",
            "appName": name,
            "appVersion": appVersion,
            "starterVersion": getConfig().getString("starterVersion", "") ?? "",
            "lockEnabled": lockEnabled,
            "localOrigin": localOrigin,
            "biometry": biometrics.status(),
            "providerSignInSupported": providerSignInSupported,
            "pushSupported": push != nil
        ]
    }

    /// ASWebAuthenticationSession accepts an HTTPS callback only from iOS 17.4.
    private var providerSignInSupported: Bool {
        if #available(iOS 17.4, *) {
            return true
        }
        return false
    }

    /// Injects the page integration at document start into every main-frame document: the bearer
    /// client, then hosted-integration.js, which exposes it as MeroFoundryShell.bearer. The
    /// script installs itself only on the local origin in bundled mode and on the configured
    /// https host in remote mode.
    private func injectHostedIntegration(into hosted: WKWebView) {
        guard let bearerFile = Bundle.main.url(forResource: "bearer-client", withExtension: "js", subdirectory: "public/meroshell"),
              let bearer = try? String(contentsOf: bearerFile, encoding: .utf8),
              let file = Bundle.main.url(forResource: "hosted-integration", withExtension: "js", subdirectory: "public/meroshell"),
              let source = try? String(contentsOf: file, encoding: .utf8) else {
            CAPLog.print("MeroShell: missing public/meroshell/bearer-client.js or hosted-integration.js; run npm run web and npx cap sync ios")
            return
        }
        let config: [String: Any] = [
            "host": host,
            "mode": bundled ? "bundled" : "remote",
            "localOrigin": localOrigin,
            "platform": "ios",
            "starterVersion": getConfig().getString("starterVersion", "") ?? ""
        ]
        let script = "window.__meroShellConfig=\(Self.json(config) ?? "null");\n\(bearer)\n\(source)"
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

/// Leaves redirects unfollowed for the shell's own host fetches, so a probe answers only for the
/// configured host.
final class ShellNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
