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
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL

/** The Laudi app: the dashboard from the Ubuntu server + real phone alarms. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var cover: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var loaded = false
    private val timeout = Runnable { if (!loaded) { web.stopLoading(); offline() } }

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
                    if (req.isForMainFrame) runOnUiThread { loaded = true; offline() }
                }
                override fun onPageFinished(view: WebView, url: String) {
                    if (url.startsWith("http")) { loaded = true; handler.removeCallbacks(timeout); cover.visibility = View.GONE }
                }
            }
        }
        // shown while connecting, so it's never just a blank screen
        cover = TextView(this).apply {
            setBackgroundColor(Color.parseColor("#0B0B14")); setTextColor(Color.WHITE); textSize = 18f
            gravity = Gravity.CENTER; setPadding(60, 0, 60, 0)
            setOnLongClickListener { askServer(); true }
        }
        setContentView(FrameLayout(this).apply { addView(web); addView(cover) })
        askPermissions()
        cover.text = "Tap here to type Laudi's address"
        cover.setOnClickListener { if (Store.server(this).isEmpty() || !loaded) askServer() }
        if (Store.server(this).isEmpty()) askServer() else load()
    }

    override fun onResume() {
        super.onResume()
        syncAlarms() // keeps phone alarms in sync even when the dashboard is closed (8pm-10am only)
    }

    private fun load() {
        loaded = false
        cover.text = "Connecting to Laudi…\n\n${Store.server(this)}\n\n(hold here to change the address)"
        cover.visibility = View.VISIBLE
        handler.removeCallbacks(timeout)
        handler.postDelayed(timeout, 12_000)
        web.loadUrl(Store.server(this) + "/")
    }

    private fun offline() {
        if (isFinishing) return
        cover.visibility = View.VISIBLE
        cover.text = "Can't reach Laudi 😴\n\n${Store.server(this)}\n\nIs Laudi installed and the server on?\nAway from home: is Tailscale on?\n\n(hold here to change the address)"
        AlertDialog.Builder(this).setTitle("Can't reach Laudi")
            .setMessage("${Store.server(this)}\n\nCheck the server is on and the address is the one install.sh showed. Away from home, turn on Tailscale.")
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
        @JavascriptInterface fun tiktokLogin() = a.runOnUiThread { a.startActivity(Intent(a, LoginActivity::class.java)) }
        @JavascriptInterface fun testAlarm() = AlarmReceiver.ring(a, "Test alarm")
        @JavascriptInterface fun toast(t: String) = a.runOnUiThread { Toast.makeText(a, t, Toast.LENGTH_SHORT).show() }
    }
}
