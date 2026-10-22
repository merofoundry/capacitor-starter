package app.merofoundry.shell;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * The shell's Firebase Cloud Messaging service, declared in the bootstrap's manifest. A refreshed
 * token goes to the running plugin through {@link ShellPush#tokenRefreshed(String)}; a
 * notification that arrives while the app is in the foreground is shown by
 * {@link ShellPush#showForeground}, because FCM shows only background ones itself. Nothing here
 * logs a token. Without google-services.json Firebase is not configured and this never runs.
 */
public class MeroShellMessagingService extends FirebaseMessagingService {

    @Override
    public void onNewToken(@NonNull String refreshed) {
        ShellPush.tokenRefreshed(refreshed);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        ShellPush.showForeground(getApplicationContext(), message);
    }
}
