package app.merofoundry.shell;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Bundled-mode completion of provider sign-in (ADR 2026-10-16 v2, Rulings 5 and 6).
 *
 * <p>The exchange URL is loaded once in an off-screen WebView. Every WebView of the app shares
 * the process-wide {@link android.webkit.CookieManager}, so the request carries the
 * browser-binding cookie the sign-in leg set in the hosted WebView and the binding cookie the
 * answer clears is cleared there. It is not the HttpURLConnection of fetchHost, which sends no
 * cookies. Only that exact URL may load: any other navigation, a redirect included, is cancelled
 * and refused, as is any HTTP error status. The JSON answer is read from the document's text; its
 * token pair goes to the callback and nowhere else.
 */
final class ShellSessionExchange {

    static final String SIGNED_IN = "signedIn";
    static final String REFUSED = "refused";
    static final String MALFORMED = "malformed";
    static final String UNREACHABLE = "unreachable";
    static final String CANCELLED = "cancelled";
    private static final String READ_BODY = "document.body ? document.body.textContent : ''";

    /** What the exchange produced. The pair is set only when status is {@link #SIGNED_IN}. */
    static final class Outcome {
        final String status;
        final String accessToken;
        final String refreshToken;
        final String returnTo;

        private Outcome(String status, String accessToken, String refreshToken, String returnTo) {
            this.status = status;
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
            this.returnTo = returnTo;
        }

        static Outcome of(String status) {
            return new Outcome(status, null, null, null);
        }
    }

    interface Callback {
        void onOutcome(Outcome outcome);
    }

    private final Uri url;
    private final WebView webView;
    private Callback callback;

    @SuppressLint("SetJavaScriptEnabled")
    ShellSessionExchange(Context context, Uri url, Callback callback) {
        this.url = url;
        this.callback = callback;
        webView = new WebView(context);
        // Needed only to read the loaded document's text; this WebView runs no page script of ours.
        webView.getSettings().setJavaScriptEnabled(true);
        webView.setWebViewClient(new ExchangeClient());
    }

    void start() {
        webView.loadUrl(url.toString());
    }

    /** Ends the exchange without reading an answer; the callback hears {@link #CANCELLED}. */
    void cancel() {
        finish(Outcome.of(CANCELLED));
    }

    /**
     * The outcome of a loaded answer: a pair of non-empty strings and a returnTo, or malformed.
     * @param evaluated the JSON-encoded string evaluateJavascript answers for READ_BODY
     */
    static Outcome outcome(String evaluated) {
        try {
            Object text = new JSONTokener(evaluated == null ? "" : evaluated).nextValue();
            if (!(text instanceof String)) {
                return Outcome.of(MALFORMED);
            }
            JSONObject body = new JSONObject((String) text);
            String access = body.optString("accessToken", "");
            String refresh = body.optString("refreshToken", "");
            Object returnTo = body.opt("returnTo");
            if (access.isEmpty() || refresh.isEmpty() || !(returnTo instanceof String)) {
                return Outcome.of(MALFORMED);
            }
            return new Outcome(SIGNED_IN, access, refresh, (String) returnTo);
        } catch (JSONException error) {
            return Outcome.of(MALFORMED);
        }
    }

    /** Answers once; later callbacks of the same load are dropped. */
    private void finish(Outcome outcome) {
        Callback current = callback;
        if (current == null) {
            return;
        }
        callback = null;
        webView.stopLoading();
        webView.destroy();
        current.onOutcome(outcome);
    }

    private final class ExchangeClient extends WebViewClient {
        private boolean failed;

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request.isForMainFrame() && url.equals(request.getUrl())) {
                return false;
            }
            failed = true;
            finish(Outcome.of(REFUSED));
            return true;
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame()) {
                failed = true;
                finish(Outcome.of(REFUSED));
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                failed = true;
                finish(Outcome.of(UNREACHABLE));
            }
        }

        @Override
        public void onPageFinished(WebView view, String loaded) {
            if (failed) {
                return;
            }
            view.evaluateJavascript(READ_BODY, evaluated -> finish(outcome(evaluated)));
        }
    }
}
