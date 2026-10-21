package app.merofoundry.shell;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native bootstrap of the starter shell.
 *
 * <p>Capacitor calls {@link #load()} while the bridge activity is being created, before the
 * hosted site at server.url is loaded. The plugin hides the hosted WebView, puts the bundled
 * shell overlay on top of it and lets the overlay's controller decide when the hosted page
 * may be shown. It only executes the overlay's commands and reports platform events; the
 * decisions (lock before display, offline, settings, deep-link validation) live in
 * shell/controller.js.
 */
@CapacitorPlugin(name = "MeroShell")
public class MeroShellPlugin extends Plugin implements ShellOverlay.Listener, ShellWebViewClient.Listener {

    private static final String TAG = "MeroShell";
    private static final String PREFS = "meroshell";
    private static final String PREF_LOCK_ENABLED = "lockEnabled";
    private static final String HOSTED_INTEGRATION_ASSET = "public/hosted-integration.js";

    private ShellOverlay overlay;
    private ShellBiometrics biometrics;
    private WebView hosted;
    private String host;
    private String hostedScript;
    private boolean documentStartInjected;
    private boolean overlayReady;
    private boolean authInProgress;
    private boolean coveredForPause;
    private boolean stoppedWhileCovered;
    private final List<JSONObject> queuedEvents = new ArrayList<>();

    @Override
    public void load() {
        hosted = getBridge().getWebView();
        host = Uri.parse(getBridge().getConfig().getServerUrl()).getHost();
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
        if (launch != null && Intent.ACTION_VIEW.equals(launch.getAction()) && launch.getData() != null) {
            emit("deepLink", object("url", launch.getData().toString()));
        }
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

    // Lifecycle

    @Override
    protected void handleOnPause() {
        if (lockEnabled() && !authInProgress) {
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
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            emit("deepLink", object("url", intent.getData().toString()));
        }
    }

    // Hosted WebView events

    @Override
    public void onMainFrameLoaded(String url) {
        if (!documentStartInjected && hostedScript != null) {
            hosted.evaluateJavascript(hostedScript, null);
        }
        emit("pageLoaded", object("url", url));
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
            case "applyHostInsets":
                hosted.evaluateJavascript("window.MeroFoundryShell&&window.MeroFoundryShell._applyInsets(" + args + ")", null);
                reply(id, null);
                break;
            default:
                replyError(id, "unknown command " + cmd);
        }
    }

    private void loadHost(int id, String path) {
        Uri target = Uri.parse("https://" + host + path);
        if (!path.startsWith("/") || !"https".equals(target.getScheme()) || !host.equals(target.getHost())) {
            replyError(id, "refused to load a URL outside the application host");
            return;
        }
        hosted.loadUrl(target.toString());
        reply(id, null);
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
        put(state, "appName", String.valueOf(getContext().getApplicationInfo().loadLabel(getContext().getPackageManager())));
        put(state, "appVersion", appVersion());
        put(state, "starterVersion", getConfig().getString("starterVersion", ""));
        put(state, "lockEnabled", lockEnabled());
        put(state, "biometry", biometrics.status());
        return state;
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

    private void injectHostedIntegration() {
        JSONObject config = object("host", host);
        put(config, "platform", "android");
        put(config, "starterVersion", getConfig().getString("starterVersion", ""));
        String source = readAsset(HOSTED_INTEGRATION_ASSET);
        if (source == null) {
            Logger.error(TAG, "missing " + HOSTED_INTEGRATION_ASSET + "; run npx cap sync android", null);
            return;
        }
        hostedScript = "window.__meroShellConfig=" + config + ";\n" + source;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(hosted, hostedScript, Collections.singleton("https://" + host));
            documentStartInjected = true;
        }
    }

    private String readAsset(String name) {
        try (InputStream in = getContext().getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int read = in.read(buffer); read != -1; read = in.read(buffer)) {
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException error) {
            return null;
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
