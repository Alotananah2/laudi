package com.murdhi.laudi

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL

/** The Laudi app: the dashboard from the Fedora computer + real phone alarms. */
class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0B0B14"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webChromeClient = WebChromeClient()
            addJavascriptInterface(Bridge(this@MainActivity), "LaudiApp")
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                    if (req.isForMainFrame) runOnUiThread { offline() }
                }
            }
        }
        setContentView(web)
        askPermissions()
        if (Store.server(this).isEmpty()) askServer() else load()
    }

    override fun onResume() {
        super.onResume()
        syncAlarms() // keeps phone alarms in sync even when the dashboard is closed (8pm-10am only)
    }

    private fun load() = web.loadUrl(Store.server(this) + "/")

    private fun offline() {
        web.loadData(
            "<body style='background:#0b0b14;color:#fff;font-family:sans-serif;text-align:center;padding-top:30vh'>" +
                "<h2>Can't reach Laudi 😴</h2><p style='color:#aaa'>Is the Fedora computer on, and is Tailscale on here?</p></body>",
            "text/html", "utf-8",
        )
        AlertDialog.Builder(this).setTitle("Can't reach Laudi")
            .setMessage(Store.server(this))
            .setPositiveButton("Try again") { _, _ -> load() }
            .setNeutralButton("Change address") { _, _ -> askServer() }
            .show()
    }

    private fun askServer() {
        val box = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(Store.server(this@MainActivity).ifEmpty { "http://" })
        }
        AlertDialog.Builder(this).setTitle("Laudi's address")
            .setMessage("The address the installer showed, like http://100.x.x.x:8787")
            .setView(box)
            .setCancelable(false)
            .setPositiveButton("Connect") { _, _ ->
                var s = box.text.toString().trim()
                if (!s.startsWith("http")) s = "http://$s"
                if (!Regex(":\\d+").containsMatchIn(s.substringAfter("://"))) s = s.trimEnd('/') + ":8787"
                Store.setServer(this, s)
                load()
            }.show()
    }

    private fun syncAlarms() {
        val server = Store.server(this)
        val token = Store.token(this)
        if (server.isEmpty() || token.isEmpty()) return
        Thread {
            try {
                val c = URL("$server/api/alarms").openConnection() as HttpURLConnection
                c.connectTimeout = 5000; c.readTimeout = 8000
                c.setRequestProperty("X-Token", token)
                if (c.responseCode == 200) Alarms.schedule(this, c.inputStream.bufferedReader().readText())
            } catch (_: Exception) {}
        }.start()
    }

    private fun askPermissions() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        if (Build.VERSION.SDK_INT >= 34) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (!nm.canUseFullScreenIntent()) {
                AlertDialog.Builder(this).setTitle("Let alarms show on the lock screen")
                    .setMessage("Turn on \"Full screen notifications\" for Laudi so alarms ring like a real alarm.")
                    .setPositiveButton("Open settings") { _, _ ->
                        startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
                    }.setNegativeButton("Later", null).show()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    /** What the dashboard page can call: window.LaudiApp.* */
    class Bridge(private val a: MainActivity) {
        @JavascriptInterface fun getToken(): String = Store.token(a)
        @JavascriptInterface fun saveToken(t: String) = Store.setToken(a, t)
        @JavascriptInterface fun scheduleAlarms(json: String) = Alarms.schedule(a, json)
        @JavascriptInterface fun changeServer() = a.runOnUiThread { a.askServer() }
        @JavascriptInterface fun testAlarm() = AlarmReceiver.ring(a, "Test alarm")
        @JavascriptInterface fun toast(t: String) = a.runOnUiThread { Toast.makeText(a, t, Toast.LENGTH_SHORT).show() }
    }
}
