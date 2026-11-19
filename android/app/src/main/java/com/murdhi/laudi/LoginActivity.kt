package com.murdhi.laudi

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * You log in to TikTok yourself here (the real tiktok.com, Laudi isn't touching it).
 * Then press Ctrl+R (or the button) and your login is handed to Laudi on the server.
 */
class LoginActivity : Activity() {
    private lateinit var web: WebView
    private val site = "https://www.tiktok.com"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CookieManager.getInstance().setAcceptCookie(true)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // desktop version of TikTok (the phone version keeps pushing the app)
            settings.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            loadUrl("$site/login")
        }
        val save = Button(this).apply {
            text = "✓ I'm logged in, save for Laudi  (Ctrl+R)"
            isAllCaps = false; textSize = 16f; setTextColor(Color.WHITE)
            background = GradientDrawable().apply { cornerRadius = 60f; setColor(Color.parseColor("#E65B5BD6")) }
            setOnClickListener { saveLogin() }
        }
        val back = Button(this).apply {
            text = "←"; textSize = 20f; setTextColor(Color.WHITE)
            background = GradientDrawable().apply { cornerRadius = 60f; setColor(Color.parseColor("#AA222233")) }
            setOnClickListener { if (web.canGoBack()) web.goBack() else finish() }
        }
        setContentView(FrameLayout(this).apply {
            addView(web)
            addView(save, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, 150, Gravity.BOTTOM).apply { setMargins(170, 0, 30, 40) })
            addView(back, FrameLayout.LayoutParams(130, 150, Gravity.BOTTOM or Gravity.START).apply { setMargins(30, 0, 0, 40) })
        })
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_R && event.isCtrlPressed) { saveLogin(); return true }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }

    private fun saveLogin() {
        CookieManager.getInstance().flush()
        val cookies = CookieManager.getInstance().getCookie(site) ?: ""
        if (!cookies.contains("sessionid=")) {
            Toast.makeText(this, "You're not logged in yet - finish logging in first", Toast.LENGTH_LONG).show()
            return
        }
        val server = Store.server(this)
        val token = Store.token(this)
        Toast.makeText(this, "Sending your login to Laudi…", Toast.LENGTH_SHORT).show()
        Thread {
            val msg = try {
                val c = URL("$server/api/session").openConnection() as HttpURLConnection
                c.requestMethod = "POST"; c.doOutput = true
                c.connectTimeout = 8000; c.readTimeout = 30000
                c.setRequestProperty("Content-Type", "application/json")
                c.setRequestProperty("X-Token", token)
                c.outputStream.use { it.write(JSONObject().put("site", "tiktok").put("cookies", cookies).put("ua", web.settings.userAgentString).toString().toByteArray()) }
                val body = (if (c.responseCode < 400) c.inputStream else c.errorStream).bufferedReader().readText()
                JSONObject(body).optString("msg", JSONObject(body).optString("error", "done"))
            } catch (e: Exception) { "Couldn't reach Laudi: ${e.message}" }
            runOnUiThread {
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                if (msg.startsWith("✅")) finish()
            }
        }.start()
    }
}
