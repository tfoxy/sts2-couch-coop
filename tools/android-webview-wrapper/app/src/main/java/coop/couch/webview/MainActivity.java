package coop.couch.webview;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewRenderProcess;
import android.webkit.WebViewRenderProcessClient;

/** A profiling shell. It intentionally ships no HTML: the measured frontend is served externally. */
public final class MainActivity extends Activity {
    private static final String TAG = "CouchCoopWebView";
    public static final String EXTRA_URL = "coop.couch.webview.URL";
    public static final String EXTRA_RUN_ID = "coop.couch.webview.RUN_ID";
    public static final String EXTRA_CONTENT_WIDTH_PX = "coop.couch.webview.CONTENT_WIDTH_PX";
    public static final String EXTRA_CONTENT_HEIGHT_PX = "coop.couch.webview.CONTENT_HEIGHT_PX";
    public static final String EXTRA_CONTENT_LEFT_PX = "coop.couch.webview.CONTENT_LEFT_PX";
    public static final String EXTRA_CONTENT_TOP_PX = "coop.couch.webview.CONTENT_TOP_PX";
    public static final String EXTRA_DENSITY_DPI = "coop.couch.webview.DENSITY_DPI";
    public static final String EXTRA_DEFER_LOAD = "coop.couch.webview.DEFER_LOAD";
    public static final String EXTRA_REFRESH_RATE_HZ = "coop.couch.webview.REFRESH_RATE_HZ";
    private static final String DEFAULT_URL = "http://127.0.0.1:13400/";
    private WebView webView;
    private String runId;
    private ContentGeometry contentGeometry;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        hideSystemBars();
        applyRequestedRefreshRate(getIntent());
        logProvider();
        String url = checkedUrl(getIntent());
        if (url == null) {
            Log.e(TAG, "refusing invalid launch URL");
            finish();
            return;
        }
        runId = intentRunId(getIntent());
        contentGeometry = requestedGeometry(getIntent());
        createWebView(url, shouldDeferLoad(getIntent()));
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = checkedUrl(intent);
        if (url == null) {
            Log.e(TAG, "refusing invalid replacement URL");
            return;
        }
        runId = intentRunId(intent);
        contentGeometry = requestedGeometry(intent);
        applyRequestedRefreshRate(intent);
        Log.i(TAG, "loading requested URL=" + url);
        recreateWebView(url, shouldDeferLoad(intent));
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override protected void onDestroy() {
        Log.i(TAG, "activity destroy deviceNs=" + SystemClock.elapsedRealtimeNanos());
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createWebView(String url, boolean deferLoad) {
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
            webView.addJavascriptInterface(new MarkerBridge(), "CouchCoopMarker");
        }
        webView.setBackgroundColor(Color.BLACK);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i(TAG, "console " + message.messageLevel() + " " + message.sourceId()
                        + ":" + message.lineNumber() + " " + message.message());
                return false;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageCommitVisible(WebView view, String visibleUrl) {
                Log.i(TAG, "ready pageCommitVisible deviceNs=" + SystemClock.elapsedRealtimeNanos()
                        + " run=" + runId + " url=" + visibleUrl);
            }
            @Override public void onPageFinished(WebView view, String finishedUrl) {
                Log.i(TAG, "ready pageFinished deviceNs=" + SystemClock.elapsedRealtimeNanos()
                        + " run=" + runId + " url=" + finishedUrl);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                Log.e(TAG, "resource error main=" + request.isForMainFrame() + " url=" + request.getUrl()
                        + " code=" + error.getErrorCode() + " description=" + error.getDescription());
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                Log.e(TAG, "http error main=" + request.isForMainFrame() + " url=" + request.getUrl()
                        + " status=" + response.getStatusCode() + " reason=" + response.getReasonPhrase());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isLoopbackHttp(request.getUrl())) return false;
                Log.e(TAG, "refusing navigation main=" + request.isForMainFrame() + " url=" + request.getUrl());
                return true;
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                Log.e(TAG, "renderer gone didCrash=" + detail.didCrash() + " priority=" + detail.rendererPriorityAtExit());
                view.destroy();
                finish();
                return true;
            }
        });
        webView.setWebViewRenderProcessClient(getMainExecutor(), new WebViewRenderProcessClient() {
            @Override public void onRenderProcessResponsive(WebView view, WebViewRenderProcess renderer) {
                Log.i(TAG, "renderer responsive deviceNs=" + SystemClock.elapsedRealtimeNanos());
            }
            @Override public void onRenderProcessUnresponsive(WebView view, WebViewRenderProcess renderer) {
                Log.w(TAG, "renderer unresponsive deviceNs=" + SystemClock.elapsedRealtimeNanos());
            }
        });
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(
                contentGeometry == null ? FrameLayout.LayoutParams.MATCH_PARENT : contentGeometry.widthPx,
                contentGeometry == null ? FrameLayout.LayoutParams.MATCH_PARENT : contentGeometry.heightPx);
        if (contentGeometry != null) {
            layout.leftMargin = contentGeometry.leftPx;
            layout.topMargin = contentGeometry.topPx;
        }
        root.addView(webView, layout);
        setContentView(root);
        logGeometry();
        Log.i(TAG, "loading URL=" + url + " deferred=" + deferLoad
                + " nativeDpr=" + getResources().getDisplayMetrics().density);
        if (deferLoad) {
            Log.i(TAG, "calibration waiting run=" + runId + " url=" + url);
        } else {
            webView.loadUrl(url);
        }
    }

    private void recreateWebView(String url, boolean deferLoad) {
        if (webView != null) webView.destroy();
        createWebView(url, deferLoad);
    }

    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private static String checkedUrl(Intent intent) {
        String raw = intent.getStringExtra(EXTRA_URL);
        if (raw == null) raw = DEFAULT_URL;
        try {
            Uri uri = Uri.parse(raw);
            if (!isLoopbackHttp(uri)) return null;
            return uri.toString();
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    private static boolean isLoopbackHttp(Uri uri) {
        return "http".equalsIgnoreCase(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
                && uri.getUserInfo() == null;
    }

    private static String intentRunId(Intent intent) {
        String value = intent.getStringExtra(EXTRA_RUN_ID);
        return value == null ? "manual-" + SystemClock.elapsedRealtimeNanos() : value;
    }

    private static boolean shouldDeferLoad(Intent intent) {
        return BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_DEFER_LOAD, false);
    }

    private void applyRequestedRefreshRate(Intent intent) {
        float requested = BuildConfig.DEBUG ? intent.getFloatExtra(EXTRA_REFRESH_RATE_HZ, 0f) : 0f;
        WindowManager windowManager = getSystemService(WindowManager.class);
        android.view.Display display = windowManager == null ? null : windowManager.getDefaultDisplay();
        if (display == null || requested <= 0f) {
            Log.i(TAG, "display refreshHz=" + (display == null ? "unknown" : display.getRefreshRate()) + " override=none");
            return;
        }
        if (!Float.isFinite(requested) || requested < 1f || requested > 240f) {
            Log.e(TAG, "refusing invalid refreshHz=" + requested);
            return;
        }
        android.view.Display.Mode current = display.getMode();
        android.view.Display.Mode selected = null;
        float distance = Float.MAX_VALUE;
        for (android.view.Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() != current.getPhysicalWidth() || mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
            float candidateDistance = Math.abs(mode.getRefreshRate() - requested);
            if (candidateDistance < distance) { selected = mode; distance = candidateDistance; }
        }
        if (selected == null) {
            Log.e(TAG, "no same-resolution display mode for refreshHz=" + requested);
            return;
        }
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        attributes.preferredDisplayModeId = selected.getModeId();
        attributes.preferredRefreshRate = selected.getRefreshRate();
        getWindow().setAttributes(attributes);
        Log.i(TAG, "display refreshHz=" + display.getRefreshRate() + " requestedHz=" + requested
                + " selectedHz=" + selected.getRefreshRate() + " modeId=" + selected.getModeId()
                + " widthPx=" + selected.getPhysicalWidth() + " heightPx=" + selected.getPhysicalHeight());
    }

    private ContentGeometry requestedGeometry(Intent intent) {
        if (!BuildConfig.DEBUG) return null;
        String[] keys = {EXTRA_CONTENT_WIDTH_PX, EXTRA_CONTENT_HEIGHT_PX, EXTRA_CONTENT_LEFT_PX,
                EXTRA_CONTENT_TOP_PX, EXTRA_DENSITY_DPI};
        int present = 0;
        for (String key : keys) if (intent.hasExtra(key)) present++;
        if (present == 0) return null;
        if (present != keys.length) {
            Log.e(TAG, "refusing partial content geometry extras");
            return null;
        }
        int width = intent.getIntExtra(EXTRA_CONTENT_WIDTH_PX, -1);
        int height = intent.getIntExtra(EXTRA_CONTENT_HEIGHT_PX, -1);
        int left = intent.getIntExtra(EXTRA_CONTENT_LEFT_PX, -1);
        int top = intent.getIntExtra(EXTRA_CONTENT_TOP_PX, -1);
        int density = intent.getIntExtra(EXTRA_DENSITY_DPI, -1);
        android.util.DisplayMetrics display = getResources().getDisplayMetrics();
        if (width <= 0 || height <= 0 || left < 0 || top < 0 || density < 120 || density > 1000
                || width > display.widthPixels || height > display.heightPixels
                || left + width > display.widthPixels || top + height > display.heightPixels) {
            Log.e(TAG, "refusing invalid content geometry extras");
            return null;
        }
        return new ContentGeometry(width, height, left, top, density);
    }

    private void logGeometry() {
        android.util.DisplayMetrics display = getResources().getDisplayMetrics();
        if (contentGeometry == null) {
            Log.i(TAG, "geometry native widthPx=" + display.widthPixels + " heightPx=" + display.heightPixels
                    + " densityDpi=" + display.densityDpi + " density=" + display.density);
        } else {
            Log.i(TAG, "geometry override widthPx=" + contentGeometry.widthPx + " heightPx=" + contentGeometry.heightPx
                    + " leftPx=" + contentGeometry.leftPx + " topPx=" + contentGeometry.topPx
                    + " requestedDensityDpi=" + contentGeometry.densityDpi + " nativeWidthPx=" + display.widthPixels
                    + " nativeHeightPx=" + display.heightPixels + " nativeDensityDpi=" + display.densityDpi);
        }
    }

    private static final class ContentGeometry {
        final int widthPx, heightPx, leftPx, topPx, densityDpi;
        ContentGeometry(int widthPx, int heightPx, int leftPx, int topPx, int densityDpi) {
            this.widthPx = widthPx; this.heightPx = heightPx; this.leftPx = leftPx; this.topPx = topPx;
            this.densityDpi = densityDpi;
        }
    }

    private static void logProvider() {
        android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
        Log.i(TAG, "provider=" + (provider == null ? "none" : provider.packageName + " " + provider.versionName));
    }

    /** Explicit sparse milestones from the frontend. Calls are bounded to prevent frame-rate logging. */
    private static final class MarkerBridge {
        private static final long MIN_MARKER_INTERVAL_NS = 100_000_000L;
        private long lastMarkerNs;
        @JavascriptInterface public synchronized void mark(String marker) {
            long now = SystemClock.elapsedRealtimeNanos();
            if (now - lastMarkerNs < MIN_MARKER_INTERVAL_NS) return;
            if (marker == null || marker.length() > 256 || !marker.matches("[\\x20-\\x7e]+")) return;
            lastMarkerNs = now;
            Log.i(TAG, "marker deviceNs=" + now + " value=" + marker);
        }
    }
}
