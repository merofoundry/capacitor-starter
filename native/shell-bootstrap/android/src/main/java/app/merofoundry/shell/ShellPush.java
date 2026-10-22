package app.merofoundry.shell;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Logger;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Native FCM push for the starter shell (ADR 2026-10-16 v2, Rulings 1 to 3), without a JavaScript
 * push plugin.
 *
 * <p>Firebase is configured only when android/app/google-services.json was present at build
 * time (app/build.gradle applies the google-services plugin then). {@link #available(Context)}
 * checks that before anything touches {@link FirebaseMessaging}, so a build without the file
 * reports push as unavailable instead of crashing. A tap on a notification launches the app with
 * the notification's data as intent extras: FCM adds google.message_id for the notifications it
 * shows in the background, and {@link #showForeground} adds {@link #EXTRA_TAP} for the ones the
 * shell shows in the foreground. Nothing here logs a token.
 */
final class ShellPush {

    /** The Capacitor permission alias for POST_NOTIFICATIONS (Android 13 and later). */
    static final String PERMISSION = "notifications";
    static final String PLATFORM = "fcm";
    static final String EXTRA_PATH = "path";
    static final String EXTRA_TAP = "app.merofoundry.shell.PUSH_TAP";
    private static final String FCM_MESSAGE_ID = "google.message_id";
    private static final String CHANNEL = "meroshell";
    private static final String TAG = "MeroShell";

    /** Answers a token request. */
    interface Result {
        void granted(String registration);

        void unavailable(String reason);
    }

    /** Receives FCM token refreshes while the plugin runs. */
    interface RefreshListener {
        void onRefresh(String registration);
    }

    private static RefreshListener refreshListener;

    private ShellPush() {}

    /** True when Firebase is configured for this build; never throws. */
    static boolean available(Context context) {
        try {
            return !FirebaseApp.getApps(context).isEmpty() || FirebaseApp.initializeApp(context) != null;
        } catch (IllegalStateException error) {
            return false;
        }
    }

    static synchronized void listen(RefreshListener listener) {
        refreshListener = listener;
    }

    /** Called by {@link MeroShellMessagingService} with a refreshed token. */
    static void tokenRefreshed(String registration) {
        RefreshListener listener;
        synchronized (ShellPush.class) {
            listener = refreshListener;
        }
        if (listener != null) {
            listener.onRefresh(registration);
        }
    }

    /** Asks FCM for this install's token. Only call when {@link #available(Context)}. */
    static void requestToken(Result result) {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            String registration = task.isSuccessful() ? task.getResult() : null;
            if (registration == null || registration.isEmpty()) {
                result.unavailable("token_unavailable");
            } else {
                result.granted(registration);
            }
        });
    }

    /** Deletes this install's FCM token, so FCM refuses it from now on. */
    static void deleteToken() {
        FirebaseMessaging.getInstance().deleteToken();
    }

    /** True when the intent is a tap on a notification, shown by FCM or by the shell. */
    static boolean isTap(Intent intent) {
        Bundle extras = intent == null ? null : intent.getExtras();
        return extras != null && (extras.containsKey(FCM_MESSAGE_ID) || extras.getBoolean(EXTRA_TAP, false));
    }

    /** The tapped notification's path, "" when it carries none; the controller validates it. */
    static String tapPath(Intent intent) {
        String path = intent.getStringExtra(EXTRA_PATH);
        return path == null ? "" : path;
    }

    /** Removes the tap extras, so a re-delivered intent is not reported twice. */
    static void consumeTap(Intent intent) {
        intent.removeExtra(FCM_MESSAGE_ID);
        intent.removeExtra(EXTRA_TAP);
        intent.removeExtra(EXTRA_PATH);
    }

    /** Android 13 and later need POST_NOTIFICATIONS granted before a notification is posted. */
    private static boolean maySend(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Shows a notification that arrived while the app is in the foreground. A tap relaunches the
     * app's launcher activity with the notification's path, like a background notification.
     */
    static void showForeground(Context context, RemoteMessage message) {
        RemoteMessage.Notification notification = message.getNotification();
        NotificationManagerCompat notifications = NotificationManagerCompat.from(context);
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (notification == null || launch == null || !notifications.areNotificationsEnabled() || !maySend(context)) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            CharSequence name = context.getApplicationInfo().loadLabel(context.getPackageManager());
            context.getSystemService(NotificationManager.class)
                .createNotificationChannel(new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_DEFAULT));
        }
        launch.putExtra(EXTRA_TAP, true);
        String path = message.getData().get(EXTRA_PATH);
        if (path != null) {
            launch.putExtra(EXTRA_PATH, path);
        }
        int id = message.getMessageId() == null ? (int) System.currentTimeMillis() : message.getMessageId().hashCode();
        PendingIntent tap = PendingIntent.getActivity(context, id, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification shown = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle(notification.getTitle())
            .setContentText(notification.getBody())
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build();
        try {
            notifications.notify(id, shown);
        } catch (SecurityException revoked) {
            Logger.info(TAG, "a foreground notification was not shown: the permission was revoked");
        }
    }
}
