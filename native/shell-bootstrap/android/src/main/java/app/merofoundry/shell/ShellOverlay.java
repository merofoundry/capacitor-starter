package app.merofoundry.shell;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import org.json.JSONObject;

/**
 * The bundled shell screens (shell/index.html) in a plain WebView laid over the hosted one.
 * It has no Capacitor bridge: its only native surface is the MeroShellNative interface, and
 * it can load nothing but the app's own bundled assets.
 */
final class ShellOverlay {

    interface Listener {
        void onOverlayMessage(String json);
    }

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String INDEX_URL = "https://" + ASSET_HOST + "/assets/public/index.html";

    private final WebView webView;

    ShellOverlay(Activity activity, Listener listener) {
        webView = new WebView(activity);
        boolean night =
            (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        webView.setBackgroundColor(night ? Color.rgb(0x11, 0x14, 0x18) : Color.WHITE);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(activity))
            .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                WebResourceResponse local = ASSET_HOST.equals(url.getHost()) ? assets.shouldInterceptRequest(url) : null;
                if (local != null) {
                    return local;
                }
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }
        });
        webView.addJavascriptInterface(new NativeChannel(listener), "MeroShellNative");
    }

    View view() {
        return webView;
    }

    void load() {
        webView.loadUrl(INDEX_URL);
    }

    void show() {
        webView.setVisibility(View.VISIBLE);
        webView.bringToFront();
    }

    void hide() {
        webView.setVisibility(View.GONE);
    }

    void send(JSONObject message) {
        webView.evaluateJavascript("window.MeroShellChannel&&window.MeroShellChannel.receive(" + message + ")", null);
    }

    /** Receives overlay commands on the WebView's binder thread and hands them to the UI thread. */
    static final class NativeChannel {

        private final Listener listener;
        private final Handler main = new Handler(Looper.getMainLooper());

        NativeChannel(Listener listener) {
            this.listener = listener;
        }

        @JavascriptInterface
        public void postMessage(String json) {
            main.post(() -> listener.onOverlayMessage(json));
        }
    }
}
