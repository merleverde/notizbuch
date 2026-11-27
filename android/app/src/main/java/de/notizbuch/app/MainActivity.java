package de.notizbuch.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hülle für die Notizbuch-Web-App.
 * Die Web-App (index.html, app.js …) liegt in den Assets und läuft in einer WebView.
 * Android übernimmt, was der Browser nicht zuverlässig kann:
 *  - Dateien öffnen/speichern über den Android-Speicherzugriff (z. B. Nextcloud), siehe {@link Bridge}
 *  - „Öffnen mit …“ für PDFs aus anderen Apps
 *  - die Seitentaste des S Pen
 *  - die Zurück-Taste
 * Gegenstück im Web-Teil: native.js
 */
public class MainActivity extends ComponentActivity {

    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    /** Hier steht, welche App-Version aktuell ist (wird beim Bauen von Gradle geschrieben). */
    private static final String UPDATE_INFO_URL = "https://merleverde.github.io/notizbuch/download/version.json";
    private static final String INSTALL_ACTION = "de.notizbuch.app.INSTALL_STATUS";

    private WebView web;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private boolean pageReady = false;
    private Uri pendingOpen;
    private boolean pendingWritable;
    private boolean penButtonDown = false;

    private int openReq, createReq;
    private ValueCallback<Uri[]> fileChooserCallback;
    private ActivityResultLauncher<Intent> openDocument, createDocument, fileChooser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        openDocument = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), r -> onPicked(openReq, r));
        createDocument = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), r -> onPicked(createReq, r));
        fileChooser = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), r -> {
            if (fileChooserCallback == null) return;
            fileChooserCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.getResultCode(), r.getData()));
            fileChooserCallback = null;
        });

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        root.setBackgroundColor(0xFFF1F2EF);
        // Dunkle Symbole in Status- und Navigationsleiste, passend zum hellen Papiergrund
        androidx.core.view.WindowInsetsControllerCompat bars = androidx.core.view.WindowCompat.getInsetsController(getWindow(), root);
        bars.setAppearanceLightStatusBars(true);
        bars.setAppearanceLightNavigationBars(true);
        // Inhalt nicht unter Statusleiste, Navigationsleiste oder Tastatur legen
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets b = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                // Links nach außen (z. B. Quellen) im normalen Browser öffnen
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                deliverPendingOpen();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Meldungen und Fehler der Web-App im Android-Protokoll (adb logcat -s NotizbuchJS)
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.println(m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR ? android.util.Log.ERROR : android.util.Log.INFO,
                        "NotizbuchJS", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            // <input type="file"> der Web-App, z. B. „Bild einfügen“
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                try {
                    fileChooser.launch(params.createIntent());
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileChooserCallback = null;
                    return false;
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Erst die Web-App fragen (Menü schließen, Notiz schließen …); sonst App in den Hintergrund
                web.evaluateJavascript("(window.nativeBack && window.nativeBack()) ? 'yes' : 'no'", value -> {
                    if (!"\"yes\"".equals(value)) moveTaskToBack(true);
                });
            }
        });

        handleIntent(getIntent());
        web.loadUrl(START_URL);

        // Rückmeldung des Android-Installers bei „Nach Updates suchen“
        android.content.BroadcastReceiver installStatus = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                int status = i.getIntExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, -999);
                if (status == android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    // Android zeigt jetzt „Diese App aktualisieren?“ – der Nutzer bestätigt selbst
                    Intent confirm = Build.VERSION.SDK_INT >= 33
                            ? i.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                            : i.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(confirm);
                    }
                } else if (status != android.content.pm.PackageInstaller.STATUS_SUCCESS) {
                    String msg = i.getStringExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE);
                    String js = "window.nativeUpdateFailed && window.nativeUpdateFailed(" + JSONObject.quote(msg == null ? "Installation abgebrochen" : msg) + ")";
                    runOnUiThread(() -> web.evaluateJavascript(js, null));
                }
            }
        };
        android.content.IntentFilter installFilter = new android.content.IntentFilter(INSTALL_ACTION);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(installStatus, installFilter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(installStatus, installFilter);

        // Nur in Test-Versionen: JavaScript per adb ausführen, Ergebnis landet im Protokoll
        //   adb shell am broadcast -a de.notizbuch.app.EVAL --es js "1+1"
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            android.content.BroadcastReceiver r = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent i) {
                    String js = i.getStringExtra("js");
                    if (js != null) web.evaluateJavascript(js, v -> android.util.Log.i("NotizbuchEval", String.valueOf(v)));
                }
            };
            android.content.IntentFilter f = new android.content.IntentFilter("de.notizbuch.app.EVAL");
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(r, f, Context.RECEIVER_EXPORTED);
            else registerReceiver(r, f);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();      // löst in der Web-App „visibilitychange“ aus → lokales Speichern
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        web.destroy();
        super.onDestroy();
    }

    /* ---------------- S-Pen-Seitentaste ---------------- */

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        checkPenButton(ev);
        return super.dispatchTouchEvent(ev);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent ev) {
        checkPenButton(ev);          // Schweben über dem Display
        return super.dispatchGenericMotionEvent(ev);
    }

    private void checkPenButton(MotionEvent ev) {
        if (ev.getPointerCount() == 0 || ev.getToolType(0) != MotionEvent.TOOL_TYPE_STYLUS) return;
        boolean down = (ev.getButtonState() & (MotionEvent.BUTTON_STYLUS_PRIMARY | MotionEvent.BUTTON_SECONDARY)) != 0;
        if (down && !penButtonDown) web.evaluateJavascript("window.nativePenButton && window.nativePenButton()", null);
        penButtonDown = down;
    }

    /* ---------------- Dateien ---------------- */

    private void handleIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        String a = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(a) && !Intent.ACTION_EDIT.equals(a)) return;
        Uri uri = intent.getData();
        pendingWritable = (intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
        try {
            int f = Intent.FLAG_GRANT_READ_URI_PERMISSION | (pendingWritable ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
            getContentResolver().takePersistableUriPermission(uri, f);
        } catch (SecurityException ignored) { }      // nicht jede App erlaubt dauerhaften Zugriff
        pendingOpen = uri;
        deliverPendingOpen();
    }

    private void deliverPendingOpen() {
        if (!pageReady || pendingOpen == null) return;
        Uri uri = pendingOpen;
        pendingOpen = null;
        try {
            JSONObject o = new JSONObject()
                    .put("uri", uri.toString())
                    .put("name", displayName(uri))
                    .put("writable", pendingWritable && canWrite(uri));
            web.evaluateJavascript("window.nativeOpenFile && window.nativeOpenFile(" + o + ")", null);
        } catch (JSONException ignored) { }
    }

    private void onPicked(int req, ActivityResult r) {
        Intent data = r.getData();
        if (r.getResultCode() != RESULT_OK || data == null || data.getData() == null) {
            fail(req, "AbortError", "Abgebrochen");
            return;
        }
        Uri uri = data.getData();
        try {
            getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
        }
        try {
            done(req, new JSONObject().put("uri", uri.toString()).put("name", displayName(uri)).put("writable", canWrite(uri)));
        } catch (JSONException e) {
            fail(req, "Error", e.getMessage());
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) { }
        String s = uri.getLastPathSegment();
        return s != null ? s : "Dokument.pdf";
    }

    private long sizeOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) { }
        return -1;
    }

    private boolean canWrite(Uri uri) {
        if (checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) return false;
        // Bietet der Speicherort (z. B. Nextcloud) Schreiben überhaupt an?
        try (Cursor c = getContentResolver().query(uri, new String[]{DocumentsContract.Document.COLUMN_FLAGS}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return (c.getInt(0) & DocumentsContract.Document.FLAG_SUPPORTS_WRITE) != 0;
        } catch (Exception ignored) { }
        return true;
    }

    private void done(int id, JSONObject res) {
        final String js = "window.__nb && window.__nb.done(" + id + "," + res + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private void fail(int id, String name, String message) {
        try {
            done(id, new JSONObject().put("error", message == null ? name : message).put("name", name));
        } catch (JSONException ignored) { }
    }

    /** Von der Web-App aus aufrufbar (window.AndroidBridge). Antworten kommen asynchron über window.__nb.done. */
    private class Bridge {

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (PackageManager.NameNotFoundException e) {
                return "?";
            }
        }

        @JavascriptInterface
        public int appVersionCode() {
            try {
                android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
            } catch (PackageManager.NameNotFoundException e) {
                return 0;
            }
        }

        /** Liest version.json von der GitHub-Seite (ohne Zwischenspeicher). */
        @JavascriptInterface
        public void checkUpdate(int id, String url) {
            io.execute(() -> {
                try {
                    String base = url == null || url.isEmpty() ? UPDATE_INFO_URL : url;
                    java.net.HttpURLConnection c = openHttp(base + "?t=" + System.currentTimeMillis());
                    try (InputStream in = c.getInputStream()) {
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                        done(id, new JSONObject(out.toString("UTF-8")));
                    } finally { c.disconnect(); }
                } catch (Exception e) {
                    fail(id, "NetworkError", e.getMessage());
                }
            });
        }

        /** Lädt die neue APK und übergibt sie dem Android-Installer. Bestätigen muss der Nutzer selbst. */
        @JavascriptInterface
        public void installUpdate(int id, String apkUrl) {
            io.execute(() -> {
                if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                    // Einmalig erlauben: Einstellungen → „Unbekannte Apps installieren“ → Notizbuch
                    runOnUiThread(() -> {
                        try {
                            startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                        } catch (ActivityNotFoundException ignored) { }
                    });
                    try { done(id, new JSONObject().put("needsPermission", true)); } catch (JSONException ignored) { }
                    return;
                }
                try {
                    java.net.HttpURLConnection c = openHttp(apkUrl);
                    long total = c.getContentLengthLong();
                    android.content.pm.PackageInstaller installer = getPackageManager().getPackageInstaller();
                    android.content.pm.PackageInstaller.SessionParams params =
                            new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    params.setAppPackageName(getPackageName());
                    int sid = installer.createSession(params);
                    try (android.content.pm.PackageInstaller.Session s = installer.openSession(sid)) {
                        try (InputStream in = c.getInputStream(); OutputStream out = s.openWrite("update.apk", 0, total)) {
                            byte[] buf = new byte[65536];
                            long got = 0; int last = -1;
                            for (int n; (n = in.read(buf)) > 0; ) {
                                out.write(buf, 0, n);
                                got += n;
                                int pct = total > 0 ? (int) (got * 100 / total) : -1;
                                if (pct != last && pct % 10 == 0) {
                                    last = pct;
                                    final String js = "window.nativeUpdateProgress && window.nativeUpdateProgress(" + pct + ")";
                                    runOnUiThread(() -> web.evaluateJavascript(js, null));
                                }
                            }
                            s.fsync(out);
                        } finally { c.disconnect(); }
                        Intent cb = new Intent(INSTALL_ACTION).setPackage(getPackageName());
                        int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? android.app.PendingIntent.FLAG_MUTABLE : 0);
                        s.commit(android.app.PendingIntent.getBroadcast(MainActivity.this, sid, cb, flags).getIntentSender());
                    }
                    done(id, new JSONObject().put("started", true));
                } catch (Exception e) {
                    fail(id, "Error", e.getMessage());
                }
            });
        }

        private java.net.HttpURLConnection openHttp(String url) throws java.io.IOException {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            if (c.getResponseCode() != 200) throw new java.io.IOException("Server antwortet mit " + c.getResponseCode());
            return c;
        }

        @JavascriptInterface
        public void openDocument(int id, String mimesJson) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                setMimeTypes(i, mimesJson);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                openReq = id;
                try { openDocument.launch(i); } catch (ActivityNotFoundException e) { fail(id, "Error", "Kein Dateiauswahl-Dialog verfügbar"); }
            });
        }

        @JavascriptInterface
        public void createDocument(int id, String name, String mime) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                createReq = id;
                try { createDocument.launch(i); } catch (ActivityNotFoundException e) { fail(id, "Error", "Kein Speicherdialog verfügbar"); }
            });
        }

        @JavascriptInterface
        public void readUri(int id, String uri) {
            io.execute(() -> {
                Uri u = Uri.parse(uri);
                try (InputStream in = getContentResolver().openInputStream(u)) {
                    if (in == null) throw new java.io.IOException("Datei lässt sich nicht öffnen");
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    String type = getContentResolver().getType(u);
                    done(id, new JSONObject().put("b64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)).put("mime", type == null ? "" : type));
                } catch (Exception e) {
                    fail(id, "NotReadableError", e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void writeUri(int id, String uri, String b64) {
            io.execute(() -> {
                Uri u = Uri.parse(uri);
                try {
                    byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                    // vorhandene Datei ersetzen ("wt" = schreiben + kürzen); manche Speicherorte kennen nur "rwt" oder "w"
                    OutputStream out = null;
                    boolean truncated = true;
                    for (String mode : new String[]{"wt", "rwt"}) {
                        try { out = getContentResolver().openOutputStream(u, mode); } catch (Exception ignored) { }
                        if (out != null) break;
                    }
                    if (out == null) { out = getContentResolver().openOutputStream(u, "w"); truncated = false; }
                    if (out == null) throw new java.io.IOException("Datei lässt sich nicht schreiben");
                    try (OutputStream o = out) {
                        o.write(bytes);
                        o.flush();
                        if (o instanceof java.io.FileOutputStream) {
                            java.io.FileOutputStream fo = (java.io.FileOutputStream) o;
                            // ohne Kürzen bliebe bei einer vorher längeren Datei deren Rest am Ende hängen
                            if (!truncated) try { fo.getChannel().truncate(bytes.length); truncated = true; } catch (Exception ignored) { }
                            try { fo.getFD().sync(); } catch (Exception ignored) { }
                        }
                    }
                    long size = sizeOf(u);
                    if (!truncated && size > bytes.length)
                        throw new java.io.IOException("Die alte, längere Datei ließ sich nicht kürzen (" + size + " statt " + bytes.length + " Bytes). Bitte „Speichern unter …“ benutzen.");
                    done(id, new JSONObject().put("size", size).put("written", bytes.length));
                } catch (Exception e) {
                    fail(id, "NoModificationAllowedError", e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void sizeUri(int id, String uri) {
            io.execute(() -> {
                try { done(id, new JSONObject().put("size", sizeOf(Uri.parse(uri)))); } catch (JSONException e) { fail(id, "Error", e.getMessage()); }
            });
        }

        /** PDF über das Android-Teilen-Menü weitergeben (z. B. Nextcloud „Hochladen“). Die Datei liegt im Cache. */
        @JavascriptInterface
        public void shareFile(int id, String name, String mime, String b64) {
            io.execute(() -> {
                try {
                    java.io.File dir = new java.io.File(getCacheDir(), "share");
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("Zwischenablage-Ordner fehlt");
                    // alte geteilte Dateien (älter als 1 Tag) aufräumen – neuere evtl. noch beim Hochladen
                    java.io.File[] old = dir.listFiles();
                    if (old != null) for (java.io.File f : old) if (System.currentTimeMillis() - f.lastModified() > 86400000L) f.delete();
                    String safe = (name == null || name.isEmpty() ? "Notiz.pdf" : name).replaceAll("[\\\\/:*?\"<>|]", "-");
                    java.io.File f = new java.io.File(dir, safe);
                    try (java.io.FileOutputStream o = new java.io.FileOutputStream(f)) { o.write(Base64.decode(b64, Base64.DEFAULT)); }
                    Uri u = androidx.core.content.FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".share", f);
                    Intent s = new Intent(Intent.ACTION_SEND);
                    s.setType(mime == null || mime.isEmpty() ? "application/pdf" : mime);
                    s.putExtra(Intent.EXTRA_STREAM, u);
                    s.putExtra(Intent.EXTRA_TITLE, safe);
                    s.setClipData(android.content.ClipData.newRawUri(safe, u));
                    s.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(s, "PDF teilen");
                    runOnUiThread(() -> {
                        try { startActivity(chooser); done(id, new JSONObject()); }
                        catch (Exception e) { fail(id, "Error", e.getMessage()); }
                    });
                } catch (Exception e) {
                    fail(id, "Error", e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void deleteUri(int id, String uri) {
            io.execute(() -> {
                try {
                    boolean ok = DocumentsContract.deleteDocument(getContentResolver(), Uri.parse(uri));
                    done(id, new JSONObject().put("ok", ok));
                } catch (Exception e) {
                    fail(id, "Error", e.getMessage());
                }
            });
        }

        /** FolderSync (Pro oder kostenlos) alle Ordnerpaare synchronisieren lassen – offizielle Schnittstelle von FolderSync.
         *  Liefert true, wenn FolderSync installiert ist. */
        @JavascriptInterface
        public boolean folderSync() {
            boolean any = false;
            for (String pkg : new String[]{"dk.tacit.android.foldersync.full", "dk.tacit.android.foldersync.lite"}) {
                try {
                    getPackageManager().getPackageInfo(pkg, 0);
                    Intent i = new Intent("com.tacit.foldersync.action.SYNC_ALL");
                    i.setPackage(pkg);
                    i.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
                    sendBroadcast(i);
                    any = true;
                } catch (Exception ignored) { }
            }
            return any;
        }

        @JavascriptInterface
        public void keepAwake(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(Math.max(1, ms), VibrationEffect.DEFAULT_AMPLITUDE));
        }

        private void setMimeTypes(Intent i, String mimesJson) {
            try {
                JSONArray a = new JSONArray(mimesJson == null ? "[]" : mimesJson);
                if (a.length() == 1) { i.setType(a.getString(0)); return; }
                i.setType("*/*");
                if (a.length() > 1) {
                    String[] m = new String[a.length()];
                    for (int k = 0; k < m.length; k++) m[k] = a.getString(k);
                    i.putExtra(Intent.EXTRA_MIME_TYPES, m);
                }
            } catch (JSONException e) {
                i.setType("*/*");
            }
        }
    }
}
