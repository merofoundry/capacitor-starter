package app.merofoundry.shell;

import android.app.Activity;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Device authentication for the app lock: biometrics with the device credential as fallback.
 * The prompt is created while the activity is being created, as BiometricPrompt requires.
 */
final class ShellBiometrics {

    interface Callback {
        void done(JSONObject result);
    }

    private static final int AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private final Activity activity;
    private final BiometricPrompt prompt;
    private Callback pending;

    ShellBiometrics(Activity activity) {
        this.activity = activity;
        this.prompt = activity instanceof FragmentActivity
            ? new BiometricPrompt((FragmentActivity) activity, ContextCompat.getMainExecutor(activity), new PromptCallback())
            : null;
    }

    JSONObject status() {
        BiometricManager manager = BiometricManager.from(activity);
        boolean available = prompt != null && manager.canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS;
        boolean biometric =
            manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS;
        JSONObject status = new JSONObject();
        try {
            status.put("available", available);
            status.put("kind", biometric ? "biometric" : available ? "passcode" : "none");
        } catch (JSONException error) {
            throw new IllegalStateException(error);
        }
        return status;
    }

    void authenticate(String reason, Callback callback) {
        if (prompt == null || pending != null) {
            callback.done(failure(prompt == null ? "unavailable" : "failed", "authentication already in progress"));
            return;
        }
        pending = callback;
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(reason)
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build();
        prompt.authenticate(info);
    }

    private void finish(JSONObject result) {
        Callback callback = pending;
        pending = null;
        if (callback != null) {
            callback.done(result);
        }
    }

    private static JSONObject failure(String code, String message) {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", false);
            result.put("code", code);
            result.put("message", message);
        } catch (JSONException error) {
            throw new IllegalStateException(error);
        }
        return result;
    }

    static String codeFor(int errorCode) {
        switch (errorCode) {
            case BiometricPrompt.ERROR_USER_CANCELED:
            case BiometricPrompt.ERROR_CANCELED:
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
            case BiometricPrompt.ERROR_TIMEOUT:
                return "cancelled";
            case BiometricPrompt.ERROR_LOCKOUT:
            case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                return "lockout";
            case BiometricPrompt.ERROR_NO_BIOMETRICS:
            case BiometricPrompt.ERROR_HW_NOT_PRESENT:
            case BiometricPrompt.ERROR_HW_UNAVAILABLE:
            case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
            case BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED:
                return "unavailable";
            default:
                return "failed";
        }
    }

    private final class PromptCallback extends BiometricPrompt.AuthenticationCallback {

        @Override
        public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
            JSONObject ok = new JSONObject();
            try {
                ok.put("ok", true);
            } catch (JSONException error) {
                throw new IllegalStateException(error);
            }
            finish(ok);
        }

        @Override
        public void onAuthenticationError(int errorCode, @NonNull CharSequence message) {
            finish(failure(codeFor(errorCode), String.valueOf(message)));
        }
    }
}
