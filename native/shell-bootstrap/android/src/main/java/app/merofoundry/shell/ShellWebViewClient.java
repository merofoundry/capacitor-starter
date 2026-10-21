package app.merofoundry.shell;

import android.graphics.Bitmap;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Capacitor's WebView client for the hosted site, extended to report whether the main frame
 * loaded or failed. Sub-resource errors and HTTP error statuses are the site's own business
 * and are not reported as offline.
 */
class ShellWebViewClient extends BridgeWebViewClient {

    interface Listener {
        void onMainFrameLoaded(String url);

        void onMainFrameFailed(String url, int errorCode, String description);
    }

    private final Listener listener;
    private boolean mainFrameFailed;

    ShellWebViewClient(Bridge bridge, Listener listener) {
        super(bridge);
        this.listener = listener;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        mainFrameFailed = false;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);
        if (request.isForMainFrame()) {
            mainFrameFailed = true;
            listener.onMainFrameFailed(request.getUrl().toString(), error.getErrorCode(), String.valueOf(error.getDescription()));
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        if (!mainFrameFailed) {
            listener.onMainFrameLoaded(url);
        }
    }
}
