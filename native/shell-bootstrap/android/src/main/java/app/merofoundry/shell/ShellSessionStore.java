package app.merofoundry.shell;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * The consumer session's bearer token pair (ADR 2026-10-16 v2, Ruling 5), kept in
 * EncryptedSharedPreferences: keys and values are encrypted with a master key held in the
 * Android Keystore. Beside the pair the same file keeps whether push is enabled and the last
 * FCM token ({@link ShellPush}). Nothing here logs or reports the tokens.
 */
final class ShellSessionStore {

    /** A stored access and refresh token. */
    static final class Tokens {

        final String accessToken;
        final String refreshToken;

        Tokens(String accessToken, String refreshToken) {
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
        }
    }

    private static final String FILE = "meroshell_session";
    private static final String ACCESS_TOKEN = "accessToken";
    private static final String REFRESH_TOKEN = "refreshToken";
    private static final String PUSH_ENABLED = "pushEnabled";
    private static final String PUSH_TOKEN = "pushToken";

    private final Context context;
    private SharedPreferences preferences;

    ShellSessionStore(Context context) {
        this.context = context.getApplicationContext();
    }

    /** The stored pair, or null when none is stored. */
    synchronized Tokens load() throws GeneralSecurityException, IOException {
        SharedPreferences stored = preferences();
        String access = stored.getString(ACCESS_TOKEN, null);
        String refresh = stored.getString(REFRESH_TOKEN, null);
        return access == null || refresh == null ? null : new Tokens(access, refresh);
    }

    /** Replaces the stored pair. */
    synchronized void save(String accessToken, String refreshToken) throws GeneralSecurityException, IOException {
        boolean written = preferences().edit().putString(ACCESS_TOKEN, accessToken).putString(REFRESH_TOKEN, refreshToken).commit();
        if (!written) {
            throw new IOException("secure session storage could not be written");
        }
    }

    /** Removes the stored pair. The push state is left alone. */
    synchronized void clear() throws GeneralSecurityException, IOException {
        if (!preferences().edit().remove(ACCESS_TOKEN).remove(REFRESH_TOKEN).commit()) {
            throw new IOException("secure session storage could not be cleared");
        }
    }

    /** Whether the user turned push on and has not turned it off or signed out since. */
    synchronized boolean pushEnabled() throws GeneralSecurityException, IOException {
        return preferences().getBoolean(PUSH_ENABLED, false);
    }

    /** The last FCM token push was registered with, or null. */
    synchronized String pushToken() throws GeneralSecurityException, IOException {
        return preferences().getString(PUSH_TOKEN, null);
    }

    /** Replaces the push state; a null token removes it. */
    synchronized void savePush(boolean enabled, String token) throws GeneralSecurityException, IOException {
        SharedPreferences.Editor editor = preferences().edit().putBoolean(PUSH_ENABLED, enabled);
        if (token == null) {
            editor.remove(PUSH_TOKEN);
        } else {
            editor.putString(PUSH_TOKEN, token);
        }
        if (!editor.commit()) {
            throw new IOException("secure push storage could not be written");
        }
    }

    /**
     * Opens the encrypted file. A file that cannot be decrypted (restored from a backup onto a
     * device whose Keystore never held its key) is deleted and recreated once: the stored
     * session is lost and the user signs in again.
     */
    private SharedPreferences preferences() throws GeneralSecurityException, IOException {
        if (preferences == null) {
            try {
                preferences = open();
            } catch (GeneralSecurityException | IOException unreadable) {
                context.deleteSharedPreferences(FILE);
                preferences = open();
            }
        }
        return preferences;
    }

    private SharedPreferences open() throws GeneralSecurityException, IOException {
        MasterKey masterKey = new MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build();
        return EncryptedSharedPreferences.create(
            context,
            FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }
}
