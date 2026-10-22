import Foundation
import UIKit
import UserNotifications
import Capacitor

/// Native APNs push for the starter shell (ADR 2026-10-16 v2, Rulings 1 to 3), without a
/// JavaScript push plugin.
///
/// `install()` runs from the plugin's `load()`: it makes this object the notification center's
/// delegate, so foreground notifications show as banners and taps are reported, and it listens
/// for the APNs registration results that the app's AppDelegate posts as Capacitor's
/// `capacitorDidRegisterForRemoteNotifications` and `capacitorDidFailToRegisterForRemoteNotifications`
/// notifications (`npm run ios:prepare` adds those two AppDelegate methods). Permission is asked
/// only by `register` and only while it is undetermined. The enabled flag and the last token live
/// in the Keychain beside the saved session (`ShellSessionStore`). Nothing here logs a token.
final class ShellPush: NSObject, UNUserNotificationCenterDelegate {
    enum Registration {
        case granted(String)
        case denied
        case unavailable(String)
    }

    /// How long a registration waits for APNs before it answers unavailable.
    private static let registrationTimeout: TimeInterval = 30

    /// Called on the main queue with a tapped notification's path value ("" when it has none).
    var onTap: ((Any) -> Void)?
    /// Called on the main queue with a changed APNs token while push is enabled.
    var onToken: ((String) -> Void)?

    private let store: ShellSessionStore?
    private var waiting: [(Registration) -> Void] = []
    private var attempt = 0

    init(store: ShellSessionStore?) {
        self.store = store
    }

    /// Installs the notification-center delegate and the APNs observers. While push is enabled it
    /// also asks APNs for the current token, so a changed token reaches `onToken`.
    func install() {
        UNUserNotificationCenter.current().delegate = self
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didRegister(_:)), name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        center.addObserver(self, selector: #selector(didFailToRegister(_:)), name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
        if enabled {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Whether the user turned push on and has not turned it off or signed out since.
    var enabled: Bool {
        stored()?.enabled ?? false
    }

    /// Whether a registration may exist on the server: push is on or a token is still held.
    var registered: Bool {
        guard let state = stored() else { return false }
        return state.enabled || state.token != nil
    }

    /// Asks for permission when it is undetermined, then for the APNs token. Answers on the main queue.
    func register(_ completion: @escaping (Registration) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            DispatchQueue.main.async {
                switch settings.authorizationStatus {
                case .denied:
                    completion(.denied)
                case .notDetermined:
                    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                        DispatchQueue.main.async {
                            if granted {
                                self.requestToken(completion)
                            } else {
                                completion(.denied)
                            }
                        }
                    }
                default:
                    self.requestToken(completion)
                }
            }
        }
    }

    /// Unregisters from APNs and forgets the token; returns the token it held, for the page's DELETE.
    func unregister() throws -> String? {
        let previous = stored()?.token
        try store?.savePush(ShellSessionStore.PushState(enabled: false, token: nil))
        UIApplication.shared.unregisterForRemoteNotifications()
        return previous
    }

    /// {enabled, permission, platform}, answered on the main queue. Never prompts.
    func state(_ completion: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let permission: String
            switch settings.authorizationStatus {
            case .denied:
                permission = "denied"
            case .notDetermined:
                permission = "prompt"
            default:
                permission = "granted"
            }
            DispatchQueue.main.async {
                completion(["enabled": self.enabled, "permission": permission, "platform": "apns"])
            }
        }
    }

    // MARK: APNs registration

    private func requestToken(_ completion: @escaping (Registration) -> Void) {
        waiting.append(completion)
        guard waiting.count == 1 else { return }
        attempt += 1
        let current = attempt
        UIApplication.shared.registerForRemoteNotifications()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.registrationTimeout) { [weak self] in
            guard let self = self, self.attempt == current else { return }
            self.answer(.unavailable("registration_timeout"))
        }
    }

    @objc private func didRegister(_ notification: Notification) {
        guard let deviceToken = notification.object as? Data else { return }
        let token = Self.hex(deviceToken)
        DispatchQueue.main.async { self.finishRegistration(token) }
    }

    @objc private func didFailToRegister(_ notification: Notification) {
        DispatchQueue.main.async { self.answer(.unavailable("registration_failed")) }
    }

    private func finishRegistration(_ token: String) {
        guard !waiting.isEmpty else {
            // A launch-time refresh: report a changed token only while push is on.
            guard let state = stored(), state.enabled, state.token != token else { return }
            _ = try? store?.savePush(ShellSessionStore.PushState(enabled: true, token: token))
            onToken?(token)
            return
        }
        do {
            try store?.savePush(ShellSessionStore.PushState(enabled: true, token: token))
        } catch {
            answer(.unavailable("storage"))
            return
        }
        answer(.granted(token))
    }

    private func answer(_ registration: Registration) {
        attempt += 1
        let completions = waiting
        waiting.removeAll()
        completions.forEach { $0(registration) }
    }

    private func stored() -> ShellSessionStore.PushState? {
        guard let store = store else { return nil }
        return try? store.loadPush()
    }

    /// The APNs device token as lowercase hex, the form APNs addresses a device by.
    static func hex(_ deviceToken: Data) -> String {
        deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    /// The tapped notification's "path" value, "" when it has none; the controller validates it.
    static func tapPath(_ userInfo: [AnyHashable: Any]) -> Any {
        guard let value = userInfo["path"] else { return "" }
        return JSONSerialization.isValidJSONObject([value]) ? value : false
    }

    // MARK: UNUserNotificationCenterDelegate

    /// A notification that arrives while the app is open shows as a banner, as it would outside it.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// A tap on a notification, including the one that launched the app, reports its path.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            let path = Self.tapPath(response.notification.request.content.userInfo)
            DispatchQueue.main.async { self.onTap?(path) }
        }
        completionHandler()
    }
}
