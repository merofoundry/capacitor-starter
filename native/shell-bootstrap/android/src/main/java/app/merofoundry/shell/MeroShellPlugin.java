package app.merofoundry.shell;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.verify.domain.DomainVerificationManager;
import android.content.pm.verify.domain.DomainVerificationUserState;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native bootstrap of the starter shell.
 *
 * <p>Capacitor calls {@link #load()} while the bridge activity is being created, before the
 * site is loaded: the hosted site at server.url in remote mode, the bundled site from the local
 * origin in bundled mode. The application host and the mode come from the MeroShell plugin
 * configuration, not from server.url. The plugin hides the site's WebView, puts the shell
 * overlay (public/meroshell/) on top of it and lets the overlay's controller decide when the
 * page may be shown. It only executes the overlay's commands and reports platform events; the
 * decisions (lock before display, offline, settings, deep-link validation) live in
 * shell/controller.js.
 *
 * <p>Provider sign-in (ADR 2026-10-16 v2, Ruling 6): while a sign-in leg is pending, the first
 * main-frame https navigation off the configured host is cancelled and reported; the controller
 * then has the provider URL opened in a Custom Tab, never in the WebView, and the return comes
 * back as an app link to the exact exchange path the controller named.
 *
 * <p>The page keeps its bearer token pair through loadSession, saveSession and clearSession,
 * backed by {@link ShellSessionStore}. The tokens are never logged or sent to the overlay.
 *
 * <p>In bundled mode the controller completes provider sign-in with exchangeSession: the exchange
 * route alone, asked for the bearer transport, is redeemed by {@link ShellSessionExchange} in the
 * WebView cookie context, the pair is saved here and only an outcome and returnTo are answered.
 * sessionChanged then tells the page, with no token, through _sessionChanged.
 *
 * <p>Push (ADR 2026-10-16 v2, Rulings 1 to 3) is native FCM through {@link ShellPush} and
 * {@link MeroShellMessagingService}. The page calls registerPush, unregisterPush and getPushState
 * and registers the token with its own session; a refreshed token reaches it through _pushToken.
 * Without google-services.json push answers unavailable. Taps arrive on the launch intent or
 * through {@link #handleOnNewIntent} and are reported to the overlay as pushTapped with only the
 * path. Before sign-out the overlay's disablePush has the page remove its registration
 * (_pushDisable, answered through pushDisabled).
 */
@CapacitorPlugin(
    name = "MeroShell",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = ShellPush.PERMISSION) }
)
public class MeroShellPlugin extends Plugin implements ShellOverlay.Listener, ShellWebViewClient.Listener {

    private static final String TAG = "MeroShell";
    private static final String PREFS = "meroshell";
    private static final String PREF_LOCK_ENABLED = "lockEnabled";
    private static final String HOSTED_INTEGRATION_ASSET = "public/meroshell/hosted-integration.js";
    private static final Pattern CALLBACK_SERVICE_PATH = Pattern.compile("^/api/v1/services/[0-9a-fA-F-]{36}/inbound/?$");
    private static final Pattern EXCHANGE_PATH = Pattern.compile("^/api/v1/applications/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/auth/oauth/exchange$");
    private static final String HOSTED_BEARER_ASSET = "public/meroshell/bearer-client.js";
    private static final int FETCH_TIMEOUT_MS = 10000;
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    private ShellOverlay overlay;
    private ShellBiometrics biometrics;
    private WebView hosted;
    private String host;
    private boolean bundled;
    private String localOrigin;
    private ShellSessionStore sessionStore;
    private String hostedScript;
    private boolean documentStartInjected;
    private boolean overlayReady;
    private boolean authInProgress;
    private boolean coveredForPause;
    private boolean stoppedWhileCovered;
    private volatile boolean providerSignInEnabled;
    private int signInLeg;
    private int webAuthLeg;
    private String webAuthCallbackPath;
    private boolean webAuthOpen;
    private ShellSessionExchange sessionExchange;
    private boolean pushAvailable;
    private volatile String pushApplicationId = "";
    private int pushDisableReply;
    private final List<JSONObject> queuedEvents = new ArrayList<>();

    @Override
    public void load() {
        hosted = getBridge().getWebView();
        host = getConfig().getString("host", "");
        bundled = "bundled".equals(getConfig().getString("mode", "remote"));
        localOrigin = bundled ? getBridge().getLocalUrl() : null;
        if (host.isEmpty()) {
            Logger.error(TAG, "no host in the MeroShell plugin configuration; run npx cap sync android", null);
        }
        sessionStore = new ShellSessionStore(getContext());
        pushAvailable = ShellPush.available(getContext());
        if (pushAvailable) {
            ShellPush.listen(refreshed -> getActivity().runOnUiThread(() -> deliverPushToken(refreshed)));
        }
        hosted.setVisibility(View.INVISIBLE);
        getBridge().setWebViewClient(new ShellWebViewClient(getBridge(), this));
        injectHostedIntegration();

        overlay = new ShellOverlay(getActivity(), this);
        ViewGroup parent = (ViewGroup) hosted.getParent();
        parent.addView(overlay.view(), new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(overlay.view(), (view, insets) -> {
            emitInsets(insets);
            return insets;
        });
        overlay.load();

        biometrics = new ShellBiometrics(getActivity());

        Intent launch = getActivity().getIntent();
        if (ShellPush.isTap(launch)) {
            emitPushTap(launch);
        } else if (launch != null && Intent.ACTION_VIEW.equals(launch.getAction()) && launch.getData() != null) {
            emit("deepLink", object("url", launch.getData().toString()));
        }
    }

    @Override
    protected void handleOnDestroy() {
        ShellPush.listen(null);
    }

    /** Called from the hosted page through window.MeroFoundryShell.openSettings(). */
    @PluginMethod
    public void openSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> emit("openSettings", new JSONObject()));
        call.resolve();
    }

    /**
     * Called by the hosted page's pull-to-refresh gesture. A pull on a covered page is dropped
     * here; otherwise the overlay's controller decides whether to reload the application host.
     */
    @PluginMethod
    public void refresh(PluginCall call) {
        String url = call.getString("url", "");
        getActivity().runOnUiThread(() -> {
            if (hosted.getVisibility() == View.VISIBLE) {
                emit("refreshRequested", object("url", url));
            }
        });
        call.resolve();
    }

    /**
     * Called by the hosted page's provider sign-in. A request from a covered page is dropped here;
     * otherwise the overlay's controller decides whether a sign-in leg may start.
     */
    @PluginMethod
    public void providerSignIn(PluginCall call) {
        String url = call.getString("url", "");
        getActivity().runOnUiThread(() -> {
            if (hosted.getVisibility() == View.VISIBLE) {
                emit("providerSignInRequested", object("url", url));
            }
        });
        call.resolve();
    }

    /** Asked by each hosted document at install: the capability the controller last announced. */
    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("providerSignIn", providerSignInEnabled);
        call.resolve(result);
    }

    /** Called by the page through MeroFoundryShell.session.load(): the stored pair, or {} when none. */
    @PluginMethod
    public void loadSession(PluginCall call) {
        ShellSessionStore.Tokens tokens;
        try {
            tokens = sessionStore.load();
        } catch (GeneralSecurityException | IOException error) {
            call.reject("secure session storage is unavailable");
            return;
        }
        JSObject result = new JSObject();
        if (tokens != null) {
            result.put("accessToken", tokens.accessToken);
            result.put("refreshToken", tokens.refreshToken);
        }
        call.resolve(result);
    }

    /** Called by the page through MeroFoundryShell.session.save(pair). */
    @PluginMethod
    public void saveSession(PluginCall call) {
        String access = call.getString("accessToken", "");
        String refresh = call.getString("refreshToken", "");
        if (access.isEmpty() || refresh.isEmpty()) {
            call.reject("session.save needs a non-empty accessToken and refreshToken");
            return;
        }
        try {
            sessionStore.save(access, refresh);
        } catch (GeneralSecurityException | IOException error) {
            call.reject("secure session storage is unavailable");
            return;
        }
        call.resolve();
    }

    /** Called by the page through MeroFoundryShell.session.clear(). */
    @PluginMethod
    public void clearSession(PluginCall call) {
        try {
            sessionStore.clear();
        } catch (GeneralSecurityException | IOException error) {
            call.reject("secure session storage is unavailable");
            return;
        }
        call.resolve();
    }

    // Push

    /**
     * Called by the page through MeroFoundryShell.push.enable(): asks for POST_NOTIFICATIONS on
     * Android 13 and later only while it can still be asked, then for the FCM token. Answers
     * {status: "granted", token, platform}, {status: "denied"} or {status: "unavailable", reason}.
     */
    @PluginMethod
    public void registerPush(PluginCall call) {
        if (!pushAvailable) {
            call.resolve(pushOutcome("unavailable", "not_configured"));
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionState permission = getPermissionState(ShellPush.PERMISSION);
            if (permission == PermissionState.DENIED) {
                call.resolve(pushOutcome("denied", null));
                return;
            }
            if (permission != PermissionState.GRANTED) {
                requestPermissionForAlias(ShellPush.PERMISSION, call, "pushPermissionAnswered");
                return;
            }
        }
        acquirePushRegistration(call);
    }

    @PermissionCallback
    private void pushPermissionAnswered(PluginCall call) {
        if (getPermissionState(ShellPush.PERMISSION) == PermissionState.GRANTED) {
            acquirePushRegistration(call);
        } else {
            call.resolve(pushOutcome("denied", null));
        }
    }

    private void acquirePushRegistration(PluginCall call) {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            call.resolve(pushOutcome("denied", null));
            return;
        }
        ShellPush.requestToken(new ShellPush.Result() {
            @Override
            public void granted(String registration) {
                try {
                    sessionStore.savePush(true, registration);
                } catch (GeneralSecurityException | IOException error) {
                    call.reject("secure session storage is unavailable");
                    return;
                }
                JSObject result = pushOutcome("granted", null);
                result.put("token", registration);
                result.put("platform", ShellPush.PLATFORM);
                call.resolve(result);
            }

            @Override
            public void unavailable(String reason) {
                call.resolve(pushOutcome("unavailable", reason));
            }
        });
    }

    /**
     * Called by the page through MeroFoundryShell.push.disable(): deletes the FCM token, turns
     * push off and answers {status: "unregistered", token} with the token it held, or null.
     */
    @PluginMethod
    public void unregisterPush(PluginCall call) {
        String previous;
        try {
            previous = forgetPush();
        } catch (GeneralSecurityException | IOException error) {
            call.reject("secure session storage is unavailable");
            return;
        }
        JSObject result = pushOutcome("unregistered", null);
        result.put("token", previous == null ? JSONObject.NULL : previous);
        call.resolve(result);
    }

    /** Called by the page: {enabled, permission, platform, appVersion, applicationId}. Never prompts. */
    @PluginMethod
    public void getPushState(PluginCall call) {
        call.resolve(pushState());
    }

    /** Called by the page when its _pushDisable has finished: answers the overlay's disablePush. */
    @PluginMethod
    public void pushDisabled(PluginCall call) {
        boolean ok = Boolean.TRUE.equals(call.getBoolean("ok", false));
        getActivity().runOnUiThread(() -> {
            if (pushDisableReply == 0) {
                return;
            }
            int pending = pushDisableReply;
            pushDisableReply = 0;
            reply(pending, object("ok", ok));
        });
        call.resolve();
    }

    private static JSObject pushOutcome(String status, String reason) {
        JSObject result = new JSObject();
        result.put("status", status);
        if (reason != null) {
            result.put("reason", reason);
        }
        return result;
    }

    private JSObject pushState() {
        JSObject state = new JSObject();
        state.put("enabled", storedPushEnabled());
        state.put("permission", pushPermission());
        state.put("platform", ShellPush.PLATFORM);
        state.put("appVersion", appVersion());
        state.put("applicationId", pushApplicationId.isEmpty() ? JSONObject.NULL : pushApplicationId);
        return state;
    }

    private boolean storedPushEnabled() {
        try {
            return sessionStore.pushEnabled();
        } catch (GeneralSecurityException | IOException error) {
            return false;
        }
    }

    /** Whether a registration may exist on the server: push is on or a token is still held. */
    private boolean pushRegistered() {
        try {
            return sessionStore.pushEnabled() || sessionStore.pushToken() != null;
        } catch (GeneralSecurityException | IOException error) {
            return false;
        }
    }

    /** "granted", "denied", "prompt" or "unavailable" (no google-services.json). */
    private String pushPermission() {
        if (!pushAvailable) {
            return "unavailable";
        }
        boolean shown = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return shown ? "granted" : "denied";
        }
        PermissionState permission = getPermissionState(ShellPush.PERMISSION);
        if (permission == PermissionState.GRANTED) {
            return shown ? "granted" : "denied";
        }
        return permission == PermissionState.DENIED ? "denied" : "prompt";
    }

    /** Turns push off and deletes the FCM token; returns the token it held. */
    private String forgetPush() throws GeneralSecurityException, IOException {
        String previous = sessionStore.pushToken();
        sessionStore.savePush(false, null);
        if (pushAvailable) {
            ShellPush.deleteToken();
        }
        return previous;
    }

    /** A refreshed FCM token goes to the page while push is on; the page registers it. */
    private void deliverPushToken(String refreshed) {
        try {
            if (!sessionStore.pushEnabled()) {
                return;
            }
            sessionStore.savePush(true, refreshed);
        } catch (GeneralSecurityException | IOException error) {
            Logger.error(TAG, "secure push storage is unavailable", null);
            return;
        }
        JSONObject payload = object("token", refreshed);
        put(payload, "platform", ShellPush.PLATFORM);
        hosted.evaluateJavascript("window.MeroFoundryShell&&window.MeroFoundryShell._pushToken(" + payload + ")", null);
    }

    private void emitPushTap(Intent intent) {
        String path = ShellPush.tapPath(intent);
        ShellPush.consumeTap(intent);
        emit("pushTapped", object("path", path));
    }

    /**
     * Settings sign-out: the page removes its registration with its own session and answers
     * through pushDisabled. With nothing registered the answer is immediate; with no page to ask
     * it is a failure, and the overlay then resets push natively.
     */
    private void disablePush(int id) {
        if (!pushRegistered()) {
            reply(id, object("ok", true));
            return;
        }
        if (pushDisableReply != 0) {
            reply(pushDisableReply, object("ok", false));
        }
        pushDisableReply = id;
        hosted.evaluateJavascript("window.MeroFoundryShell?(window.MeroFoundryShell._pushDisable(),true):false", asked -> {
            if (!"true".equals(asked) && pushDisableReply == id) {
                pushDisableReply = 0;
                reply(id, object("ok", false));
            }
        });
    }

    /** The application id the overlay read from the host, kept for getPushState and told to the page. */
    private void setPushApplication(String applicationId) {
        pushApplicationId = UUID.matcher(applicationId).matches() ? applicationId : "";
        String argument = pushApplicationId.isEmpty() ? "null" : "\"" + pushApplicationId + "\"";
        hosted.evaluateJavascript("window.MeroFoundryShell&&window.MeroFoundryShell._setApplicationId(" + argument + ")", null);
    }

    // Lifecycle

    // Opening the Custom Tab pauses the activity; that must not lock the app.
    @Override
    protected void handleOnPause() {
        if (lockEnabled() && !authInProgress && !webAuthOpen) {
            cover();
            coveredForPause = true;
        }
    }

    @Override
    protected void handleOnStop() {
        if (coveredForPause) {
            stoppedWhileCovered = true;
        }
    }

    @Override
    protected void handleOnResume() {
        if (webAuthOpen) {
            webAuthOpen = false;
            emit("webAuthClosed", object("leg", webAuthLeg));
        }
        if (!coveredForPause) {
            return;
        }
        boolean backgrounded = stoppedWhileCovered;
        coveredForPause = false;
        stoppedWhileCovered = false;
        emit("resume", object("backgrounded", backgrounded));
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (ShellPush.isTap(intent)) {
            emitPushTap(intent);
            return;
        }
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri link = intent.getData();
            if (!routeWebAuthReturn(link)) {
                emit("deepLink", object("url", link.toString()));
            }
        }
    }

    /**
     * While a Custom Tab leg is open, an app link to the exact exchange path is its return. The
     * provider's redirect to the application's callback service can also arrive as an app link,
     * because the association claims the whole host; that link is an intermediate step, so it is
     * ignored and the leg stays open. Returns true when the link was consumed here.
     */
    private boolean routeWebAuthReturn(Uri link) {
        if (webAuthLeg == 0 || !"https".equals(link.getScheme()) || !host.equals(link.getHost())) {
            return false;
        }
        if (webAuthCallbackPath.equals(link.getPath())) {
            JSONObject payload = object("url", link.toString());
            put(payload, "leg", webAuthLeg);
            clearWebAuth();
            emit("webAuthReturned", payload);
            return true;
        }
        String path = link.getPath();
        if (path != null && CALLBACK_SERVICE_PATH.matcher(path).matches()) {
            Logger.info(TAG, "ignored an intermediate callback-service link during web authentication");
            return true;
        }
        return false;
    }

    // Hosted WebView events

    @Override
    public void onMainFrameLoaded(String url) {
        if (!documentStartInjected && hostedScript != null) {
            hosted.evaluateJavascript(hostedScript, null);
        }
        emit("pageLoaded", object("url", url));
    }

    /**
     * Cancels the first main-frame https navigation off the configured host while a sign-in leg
     * is pending, and reports it; every other navigation keeps Capacitor's handling.
     */
    @Override
    public boolean onMainFrameNavigation(Uri url) {
        if (signInLeg == 0 || !"https".equals(url.getScheme()) || host.equals(url.getHost())) {
            return false;
        }
        int leg = signInLeg;
        signInLeg = 0;
        JSONObject payload = object("url", url.toString());
        put(payload, "leg", leg);
        emit("providerRedirect", payload);
        return true;
    }

    @Override
    public void onMainFrameFailed(String url, int errorCode, String description) {
        JSONObject payload = object("url", url);
        put(payload, "code", errorCode);
        put(payload, "description", description);
        emit("pageFailed", payload);
    }

    // Overlay commands

    @Override
    public void onOverlayMessage(String json) {
        int id = 0;
        try {
            JSONObject message = new JSONObject(json);
            id = message.optInt("id");
            JSONObject args = message.optJSONObject("args");
            dispatch(id, message.optString("cmd"), args == null ? new JSONObject() : args);
        } catch (JSONException | RuntimeException error) {
            Logger.error(TAG, "overlay command failed", error);
            replyError(id, String.valueOf(error.getMessage()));
        }
    }

    private void dispatch(int id, String cmd, JSONObject args) {
        switch (cmd) {
            case "ready":
                reply(id, launchState());
                overlayReady = true;
                for (JSONObject event : queuedEvents) {
                    overlay.send(event);
                }
                queuedEvents.clear();
                ViewCompat.requestApplyInsets(overlay.view());
                break;
            case "reveal":
                hosted.setVisibility(View.VISIBLE);
                overlay.hide();
                reply(id, null);
                break;
            case "cover":
                cover();
                reply(id, null);
                break;
            case "authenticate":
                authInProgress = true;
                biometrics.authenticate(args.optString("reason", "Unlock"), result -> {
                    authInProgress = false;
                    reply(id, result);
                });
                break;
            case "setLockEnabled":
                prefs().edit().putBoolean(PREF_LOCK_ENABLED, args.optBoolean("enabled")).apply();
                reply(id, null);
                break;
            case "clearCookies":
                CookieManager cookies = CookieManager.getInstance();
                cookies.removeAllCookies(removed -> {
                    cookies.flush();
                    reply(id, null);
                });
                break;
            case "loadHost":
                loadHost(id, args.optString("path", "/"));
                break;
            case "setHostCapabilities":
                providerSignInEnabled = args.optBoolean("providerSignIn");
                hosted.evaluateJavascript("window.MeroFoundryShell&&window.MeroFoundryShell._setProviderSignIn(" + providerSignInEnabled + ")", null);
                reply(id, null);
                break;
            case "fetchHost":
                fetchHost(id, args.optString("path", "/"));
                break;
            case "startProviderSignIn":
                startProviderSignIn(id, args.optString("path", "/"), args.optInt("leg"));
                break;
            case "openWebAuth":
                openWebAuth(id, args);
                break;
            case "cancelProviderSignIn":
                signInLeg = 0;
                clearWebAuth();
                if (sessionExchange != null) {
                    sessionExchange.cancel();
                }
                reply(id, null);
                break;
            case "exchangeSession":
                exchangeSession(id, args.optString("path", ""));
                break;
            case "clearSavedSession":
                clearSavedSession(id);
                break;
            case "sessionChanged":
                boolean signedIn = args.optBoolean("signedIn");
                hosted.evaluateJavascript("window.MeroFoundryShell&&window.MeroFoundryShell._sessionChanged({signedIn:" + signedIn + "})", null);
                reply(id, null);
                break;
            case "applyHostInsets":
                hosted.evaluateJavascript("window.MeroFoundryShell&&window.MeroFoundryShell._applyInsets(" + args + ")", null);
                reply(id, null);
                break;
            case "getPushState":
                reply(id, pushState());
                break;
            case "setPushApplication":
                setPushApplication(args.optString("applicationId", ""));
                reply(id, null);
                break;
            case "disablePush":
                disablePush(id);
                break;
            case "resetPush":
                resetPush(id);
                break;
            case "pushEvent":
                JSONObject event = object("type", args.optString("type", ""));
                put(event, "reason", args.optString("reason", ""));
                hosted.evaluateJavascript("window.MeroFoundryShell&&window.MeroFoundryShell._pushEvent(" + event + ")", null);
                reply(id, null);
                break;
            default:
                replyError(id, "unknown command " + cmd);
        }
    }

    private void loadHost(int id, String path) {
        Uri target = pageUri(path);
        if (target == null) {
            replyError(id, "refused to load a URL outside the application host");
            return;
        }
        hosted.loadUrl(target.toString());
        reply(id, null);
    }

    /**
     * The URL of a page path: on the local origin in bundled mode, on the configured https host
     * in remote mode; null if it would leave that origin.
     */
    private Uri pageUri(String path) {
        Uri base = Uri.parse(bundled ? localOrigin : "https://" + host);
        Uri target = Uri.parse(base + path);
        if (!path.startsWith("/") || !base.getScheme().equals(target.getScheme()) || !base.getHost().equals(target.getHost())) {
            return null;
        }
        return target;
    }

    /** The https URL of a path on the configured host, or null if it would leave the host. */
    private Uri hostUri(String path) {
        Uri target = Uri.parse("https://" + host + path);
        if (!path.startsWith("/") || !"https".equals(target.getScheme()) || !host.equals(target.getHost())) {
            return null;
        }
        return target;
    }

    /**
     * The bearer exchange URL: https on the configured host, exactly an application's OAuth
     * exchange path, with session=bearer as its only session value; null for anything else.
     */
    private Uri exchangeUri(String path) {
        Uri target = hostUri(path);
        if (target == null || target.getPath() == null || !EXCHANGE_PATH.matcher(target.getPath()).matches()) {
            return null;
        }
        List<String> session = target.getQueryParameters("session");
        return session.size() == 1 && "bearer".equals(session.get(0)) ? target : null;
    }

    /**
     * Bundled mode only: redeems the validated exchange in the WebView cookie context and saves
     * the pair. Replies {status} and, when signed in, returnTo; never a token.
     */
    private void exchangeSession(int id, String path) {
        Uri target = exchangeUri(path);
        if (!bundled || target == null) {
            replyError(id, "refused to exchange outside the application exchange route");
            return;
        }
        if (sessionExchange != null) {
            sessionExchange.cancel();
        }
        ShellSessionExchange[] current = new ShellSessionExchange[1];
        current[0] = new ShellSessionExchange(getContext(), target, outcome -> {
            if (sessionExchange == current[0]) {
                sessionExchange = null;
            }
            finishExchange(id, outcome);
        });
        sessionExchange = current[0];
        sessionExchange.start();
    }

    private void finishExchange(int id, ShellSessionExchange.Outcome outcome) {
        if (!ShellSessionExchange.SIGNED_IN.equals(outcome.status)) {
            reply(id, object("status", outcome.status));
            return;
        }
        try {
            sessionStore.save(outcome.accessToken, outcome.refreshToken);
        } catch (GeneralSecurityException | IOException error) {
            reply(id, object("status", "storageFailed"));
            return;
        }
        JSONObject result = object("status", ShellSessionExchange.SIGNED_IN);
        put(result, "returnTo", outcome.returnTo);
        reply(id, result);
    }

    /** Sign-out after a failed or timed-out page cleanup: push is turned off natively anyway. */
    private void resetPush(int id) {
        try {
            forgetPush();
        } catch (GeneralSecurityException | IOException error) {
            replyError(id, "secure session storage is unavailable");
            return;
        }
        reply(id, null);
    }

    /** Settings sign-out in bundled mode: removes the saved pair before the cookies are cleared. */
    private void clearSavedSession(int id) {
        try {
            sessionStore.clear();
        } catch (GeneralSecurityException | IOException error) {
            replyError(id, "secure session storage is unavailable");
            return;
        }
        reply(id, null);
    }

    private void startProviderSignIn(int id, String path, int leg) {
        Uri target = hostUri(path);
        if (target == null || leg <= 0) {
            replyError(id, "refused to start sign-in outside the application host");
            return;
        }
        signInLeg = leg;
        hosted.loadUrl(target.toString());
        reply(id, null);
    }

    /** Opens the provider URL in a Custom Tab; the return is an app link to callbackPath. */
    private void openWebAuth(int id, JSONObject args) {
        Uri provider = Uri.parse(args.optString("url", ""));
        String callbackHost = args.optString("callbackHost", "");
        String callbackPath = args.optString("callbackPath", "");
        int leg = args.optInt("leg");
        if (!"https".equals(provider.getScheme()) || !host.equals(callbackHost) || !callbackPath.startsWith("/") || leg <= 0) {
            replyError(id, "refused to open web authentication");
            return;
        }
        webAuthLeg = leg;
        webAuthCallbackPath = callbackPath;
        webAuthOpen = true;
        try {
            new CustomTabsIntent.Builder().build().launchUrl(getActivity(), provider);
        } catch (ActivityNotFoundException error) {
            clearWebAuth();
            replyError(id, "no Custom Tabs provider");
            return;
        }
        reply(id, null);
    }

    private void clearWebAuth() {
        webAuthLeg = 0;
        webAuthCallbackPath = null;
        webAuthOpen = false;
    }

    /** GET a path on the configured host without cookies or redirects; replies {status, body}. */
    private void fetchHost(int id, String path) {
        Uri target = hostUri(path);
        if (target == null) {
            replyError(id, "refused to load a URL outside the application host");
            return;
        }
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(target.toString()).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setConnectTimeout(FETCH_TIMEOUT_MS);
                connection.setReadTimeout(FETCH_TIMEOUT_MS);
                connection.setRequestProperty("Accept", "application/json");
                int status = connection.getResponseCode();
                String body = status == 200 ? readStream(connection.getInputStream()) : "";
                JSONObject result = object("status", status);
                put(result, "body", body);
                getActivity().runOnUiThread(() -> reply(id, result));
            } catch (IOException error) {
                String message = String.valueOf(error.getMessage());
                getActivity().runOnUiThread(() -> replyError(id, "could not reach the application host: " + message));
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    private void cover() {
        overlay.show();
        hosted.setVisibility(View.INVISIBLE);
    }

    // State

    private JSONObject launchState() {
        JSONObject state = new JSONObject();
        put(state, "platform", "android");
        put(state, "host", host);
        put(state, "mode", bundled ? "bundled" : "remote");
        put(state, "appName", String.valueOf(getContext().getApplicationInfo().loadLabel(getContext().getPackageManager())));
        put(state, "appVersion", appVersion());
        put(state, "starterVersion", getConfig().getString("starterVersion", ""));
        put(state, "lockEnabled", lockEnabled());
        put(state, "localOrigin", localOrigin == null ? "" : localOrigin);
        put(state, "biometry", biometrics.status());
        put(state, "providerSignInSupported", providerSignInSupported());
        put(state, "pushSupported", pushAvailable);
        return state;
    }

    /**
     * Provider sign-in needs a Custom Tabs provider and, from Android 12, a verified app-link
     * association for the configured host: without it the exchange return would stay in the
     * Custom Tab, whose cookie jar has no browser-binding cookie.
     */
    private boolean providerSignInSupported() {
        if (CustomTabsClient.getPackageName(getContext(), null) == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        DomainVerificationManager manager = getContext().getSystemService(DomainVerificationManager.class);
        try {
            DomainVerificationUserState state = manager == null ? null : manager.getDomainVerificationUserState(getContext().getPackageName());
            Integer hostState = state == null ? null : state.getHostToStateMap().get(host);
            return hostState != null && hostState == DomainVerificationUserState.DOMAIN_STATE_VERIFIED;
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        }
    }

    private String appVersion() {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return info.versionName + " (" + PackageInfoCompat.getLongVersionCode(info) + ")";
        } catch (PackageManager.NameNotFoundException error) {
            return "";
        }
    }

    private boolean lockEnabled() {
        return prefs().getBoolean(PREF_LOCK_ENABLED, false);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Injects the page integration at document start, for the local origin in bundled mode and
     * for the configured https host in remote mode: the bearer client, then
     * hosted-integration.js, which exposes it as MeroFoundryShell.bearer.
     */
    private void injectHostedIntegration() {
        JSONObject config = object("host", host);
        put(config, "mode", bundled ? "bundled" : "remote");
        put(config, "localOrigin", localOrigin == null ? "" : localOrigin);
        put(config, "platform", "android");
        put(config, "starterVersion", getConfig().getString("starterVersion", ""));
        String bearer = readAsset(HOSTED_BEARER_ASSET);
        String source = readAsset(HOSTED_INTEGRATION_ASSET);
        if (bearer == null || source == null) {
            Logger.error(TAG, "missing " + HOSTED_BEARER_ASSET + " or " + HOSTED_INTEGRATION_ASSET + "; run npx cap sync android", null);
            return;
        }
        hostedScript = "window.__meroShellConfig=" + config + ";\n" + bearer + "\n" + source;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            String origin = bundled ? localOrigin : "https://" + host;
            WebViewCompat.addDocumentStartJavaScript(hosted, hostedScript, Collections.singleton(origin));
            documentStartInjected = true;
        }
    }

    private String readAsset(String name) {
        try (InputStream in = getContext().getAssets().open(name)) {
            return readStream(in);
        } catch (IOException error) {
            return null;
        }
    }

    private static String readStream(InputStream in) throws IOException {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int read = in.read(buffer); read != -1; read = in.read(buffer)) {
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void emitInsets(WindowInsetsCompat windowInsets) {
        Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        float density = getContext().getResources().getDisplayMetrics().density;
        JSONObject insets = new JSONObject();
        put(insets, "top", Math.round(bars.top / density));
        put(insets, "right", Math.round(bars.right / density));
        put(insets, "bottom", Math.round(bars.bottom / density));
        put(insets, "left", Math.round(bars.left / density));
        emit("insets", insets);
    }

    // Channel

    private void emit(String name, JSONObject payload) {
        JSONObject event = object("type", "event");
        put(event, "name", name);
        put(event, "payload", payload);
        if (overlayReady) {
            overlay.send(event);
        } else {
            queuedEvents.add(event);
        }
    }

    private void reply(int id, Object value) {
        JSONObject result = object("type", "result");
        put(result, "id", id);
        put(result, "ok", true);
        put(result, "value", value == null ? JSONObject.NULL : value);
        overlay.send(result);
    }

    private void replyError(int id, String error) {
        JSONObject result = object("type", "result");
        put(result, "id", id);
        put(result, "ok", false);
        put(result, "error", error);
        overlay.send(result);
    }

    private static JSONObject object(String key, Object value) {
        JSONObject object = new JSONObject();
        put(object, key, value);
        return object;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException error) {
            throw new IllegalArgumentException(error);
        }
    }
}
