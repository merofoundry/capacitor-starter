import Foundation
import LocalAuthentication

/// Device authentication for the app lock: Face ID or Touch ID with the passcode as fallback.
final class ShellBiometrics {
    func status() -> [String: Any] {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        let kind: String
        switch context.biometryType {
        case .faceID:
            kind = "faceId"
        case .touchID:
            kind = "touchId"
        case .none:
            kind = available ? "passcode" : "none"
        default:
            kind = "biometric"
        }
        return ["available": available, "kind": kind]
    }

    func authenticate(reason: String, completion: @escaping ([String: Any]) -> Void) {
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
            DispatchQueue.main.async {
                if success {
                    completion(["ok": true])
                } else {
                    completion([
                        "ok": false,
                        "code": Self.code(for: error),
                        "message": error?.localizedDescription ?? ""
                    ])
                }
            }
        }
    }

    static func code(for error: Error?) -> String {
        guard let laError = error as? LAError else { return "failed" }
        switch laError.code {
        case .userCancel, .appCancel, .systemCancel, .userFallback:
            return "cancelled"
        case .biometryLockout:
            return "lockout"
        case .passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled:
            return "unavailable"
        default:
            return "failed"
        }
    }
}
