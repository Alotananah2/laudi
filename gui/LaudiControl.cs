// Laudi Control - a small Windows app to start/stop Laudi, switch features on/off,
// press quick actions, watch his log, and start/stop your own programs.
// Built on the PC with Windows' built-in C# compiler (no installs needed).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Text;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

class LaudiControl : Form
{
    string root;
    string Data { get { return Path.Combine(root, "data"); } }
    string Settings { get { return Path.Combine(root, "local-settings.txt"); } }
    string ProgramsFile { get { return Path.Combine(root, "my-programs.txt"); } }

    Label status;
    Button startBtn, stopBtn, restartBtn;
    TextBox logBox;
    CheckedListBox features;
    ListView programs;
    Dictionary<string, Process> running = new Dictionary<string, Process>();
    bool loadingFeatures;
    bool botOn;
    float phase;             // drives all animations
    Panel stripe;            // moving glow under the top bar
    Label toastBar;          // slides up from the bottom
    int toastTarget, toastTicks;
    TabControl tabs;

    // label, setting key, value when ON, value when OFF
    static readonly string[][] FEATURES = new string[][] {
        new[] { "Discord (chat + voice calls)", "DISCORD_ENABLED", "1", "0" },
        new[] { "Element (rings you + calls)", "ELEMENT_ENABLED", "1", "0" },
        new[] { "Random calls (2 a day, never 11pm-5am)", "CALLS_PER_DAY", "2", "0" },
        new[] { "Group chats (talks to everyone)", "GROUPS", "1", "0" },
        new[] { "Posting his own TikToks (8 a day)", "POSTS_PER_DAY", "8", "0" },
        new[] { "Rararo live support", "LIVE_SUPPORT", "1", "0" },
        new[] { "Roblox (friends, /play, stats)", "ROBLOX_ENABLED", "1", "0" },
        new[] { "Watch my Gmail / WhatsApp / Instagram", "WATCH_ACCOUNTS", "1", "0" },
        new[] { "Extras (health check, games, school nudges, Rararo drops)", "EXTRAS_ENABLED", "1", "0" },
    };

    static bool startMin;
    [STAThread]
    static void Main(string[] args)
    {
        startMin = args.Any(a => a.ToLower() == "/min");
        Application.EnableVisualStyles();
        Application.Run(new LaudiControl());
    }

    LaudiControl()
    {
        root = FindRoot();
        Text = "Laudi Control";
        Width = 980; Height = 680;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(24, 24, 32);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);

        // ---- top bar
        var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 64, Padding = new Padding(12), BackColor = Color.FromArgb(34, 34, 46) };
        status = new Label { AutoSize = true, Font = new Font("Segoe UI", 14, FontStyle.Bold), Margin = new Padding(4, 6, 24, 0), Text = "..." };
        startBtn = MakeButton("▶ Start", Color.FromArgb(46, 160, 67), delegate { StartLaudi(); });
        stopBtn = MakeButton("■ Stop", Color.FromArgb(200, 60, 60), delegate { StopLaudi(); });
        restartBtn = MakeButton("↻ Restart", Color.FromArgb(80, 90, 200), delegate { Remote("restart"); Toast("Restarting…"); });
        top.Controls.AddRange(new Control[] { status, startBtn, stopBtn, restartBtn,
            MakeButton("⚙ Settings file", Color.FromArgb(70, 70, 90), delegate { OpenFile(Settings); }),
            MakeButton("📄 Full log", Color.FromArgb(70, 70, 90), delegate { OpenFile(Path.Combine(Data, "bot.log")); }) });
        Controls.Add(top);
        stripe = new GlowStripe(this) { Dock = DockStyle.Top, Height = 5 };
        Controls.Add(stripe);
        stripe.BringToFront();
        toastBar = new Label { Dock = DockStyle.Bottom, Height = 0, TextAlign = ContentAlignment.MiddleCenter,
            BackColor = Color.FromArgb(80, 90, 200), ForeColor = Color.White, Font = new Font("Segoe UI", 10.5f, FontStyle.Bold) };
        Controls.Add(toastBar);

        // ---- tabs
        tabs = new TabControl { Dock = DockStyle.Fill };
        tabs.TabPages.Add(LogTab());
        tabs.TabPages.Add(FeaturesTab());
        tabs.TabPages.Add(ActionsTab());
        tabs.TabPages.Add(ProgramsTab());
        tabs.TabPages.Add(CommandsTab());
        StartPhoneServer();
        tabs.TabPages.Add(PhoneTab());
        AutoStartWithWindows();
        if (startMin) WindowState = FormWindowState.Minimized;
        tabs.SelectedIndexChanged += delegate { SlideIn(tabs.SelectedTab); };
        Controls.Add(tabs);
        tabs.BringToFront();

        var timer = new Timer { Interval = 2000 };
        timer.Tick += delegate { Refresh2(); };
        timer.Start();
        Refresh2();

        // ---- animation clock (~60 fps)
        Opacity = 0;
        var anim = new Timer { Interval = 16 };
        anim.Tick += delegate { Animate(); };
        anim.Start();
        Shown += delegate { SlideIn(tabs.SelectedTab); };
    }

    // ------------------------------------------------------------------ animation

    void Animate()
    {
        phase += 0.016f;
        if (Opacity < 1) Opacity = Math.Min(1, Opacity + 0.06);          // fade in on open
        // status dot "breathes"
        double k = (Math.Sin(phase * 3) + 1) / 2;
        Color a = botOn ? Color.FromArgb(60, 190, 95) : Color.FromArgb(200, 70, 70);
        Color b = botOn ? Color.FromArgb(150, 255, 170) : Color.FromArgb(255, 150, 150);
        status.ForeColor = Mix(a, b, k);
        stripe.Invalidate();
        // toast slides up / down
        if (toastTicks > 0 && --toastTicks == 0) toastTarget = 0;
        if (toastBar.Height != toastTarget) toastBar.Height += Math.Sign(toastTarget - toastBar.Height) * Math.Max(1, Math.Abs(toastTarget - toastBar.Height) / 4);
        // slide-in of the open tab's contents
        foreach (var kv in sliding.ToList())
        {
            var c = kv.Key; int left = kv.Value;
            left = left * 3 / 4;
            c.Padding = new Padding(12 + left, 12, 12, 12);
            if (left <= 1) { c.Padding = new Padding(12); sliding.Remove(c); } else sliding[c] = left;
        }
    }

    Dictionary<Control, int> sliding = new Dictionary<Control, int>();
    void SlideIn(Control page)
    {
        if (page == null || page is TabPage && ((TabPage)page).Text == "Live log") return;
        sliding[page] = 120;
    }

    static Color Mix(Color a, Color b, double k)
    {
        return Color.FromArgb((int)(a.R + (b.R - a.R) * k), (int)(a.G + (b.G - a.G) * k), (int)(a.B + (b.B - a.B) * k));
    }

    // A thin bar with a glow that slides left -> right forever (faster + green when Laudi is running).
    class GlowStripe : Panel
    {
        LaudiControl f;
        public GlowStripe(LaudiControl owner) { f = owner; DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Color.FromArgb(34, 34, 46));
            if (Width < 2) return;
            float speed = f.botOn ? 260 : 90;
            float w = Math.Max(120, Width / 3f);
            float x = (f.phase * speed) % (Width + w) - w;
            Color c = f.botOn ? Color.FromArgb(90, 220, 120) : Color.FromArgb(120, 130, 255);
            var rect = new RectangleF(x, 0, w, Height);
            using (var br = new System.Drawing.Drawing2D.LinearGradientBrush(new RectangleF(x - 1, 0, w + 2, Height), Color.FromArgb(0, c), Color.FromArgb(0, c), 0f))
            {
                var blend = new System.Drawing.Drawing2D.ColorBlend();
                blend.Colors = new[] { Color.FromArgb(0, c), c, Color.FromArgb(0, c) };
                blend.Positions = new[] { 0f, 0.5f, 1f };
                br.InterpolationColors = blend;
                g.FillRectangle(br, rect);
            }
        }
    }

    // ------------------------------------------------------------------ tabs

    TabPage LogTab()
    {
        var p = new TabPage("Live log") { BackColor = BackColor };
        logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(14, 14, 20), ForeColor = Color.FromArgb(180, 255, 200), Font = new Font("Consolas", 9.5f), WordWrap = true };
        p.Controls.Add(logBox);
        return p;
    }

    TabPage FeaturesTab()
    {
        var p = new TabPage("Features") { BackColor = BackColor, Padding = new Padding(12) };
        var info = new Label { Dock = DockStyle.Top, Height = 40, Text = "Tick what Laudi should do. Changes save right away and Laudi restarts to apply them." };
        features = new CheckedListBox { Dock = DockStyle.Fill, CheckOnClick = true, BackColor = Color.FromArgb(34, 34, 46), ForeColor = Color.White, BorderStyle = BorderStyle.None, Font = new Font("Segoe UI", 11) };
        var s = ReadSettings();
        loadingFeatures = true;
        foreach (var f in FEATURES)
        {
            string v;
            bool on = !s.TryGetValue(f[1], out v) || (v != f[3] && v != "" && v != "false" && v != "off");
            features.Items.Add(f[0], on);
        }
        loadingFeatures = false;
        features.ItemCheck += (o, e) =>
        {
            if (loadingFeatures) return;
            var f = FEATURES[e.Index];
            WriteSetting(f[1], e.NewValue == CheckState.Checked ? f[2] : f[3]);
            Remote("restart");
            Toast(f[0] + (e.NewValue == CheckState.Checked ? " ON" : " OFF") + " - restarting Laudi");
        };
        p.Controls.Add(features);
        p.Controls.Add(info);
        return p;
    }

    TabPage ActionsTab()
    {
        var p = new TabPage("Quick actions") { BackColor = BackColor, Padding = new Padding(12) };
        var flow = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
        flow.Controls.Add(BigButton("🎬 Send me a video", "vid"));
        flow.Controls.Add(BigButton("📤 Post a TikTok now", "post-now"));
        flow.Controls.Add(BigButton("💬 Text me first", "hi"));
        flow.Controls.Add(BigButton("📞 Call me on Element", "elring"));
        flow.Controls.Add(BigButton("📞 Call me on Discord", "ring"));
        flow.Controls.Add(BigButton("📴 Hang up the call", "hangup"));
        flow.Controls.Add(BigButton("🩺 Health check (DMs you)", "health"));
        var sayRow = new FlowLayoutPanel { Width = 700, Height = 46 };
        var sayBox = new TextBox { Width = 480, Font = new Font("Segoe UI", 11) };
        var sayBtn = MakeButton("Make him say this on TikTok", Color.FromArgb(80, 90, 200), delegate
        {
            if (sayBox.Text.Trim().Length > 0) { Remote("say " + sayBox.Text.Trim().Replace("\r", " ").Replace("\n", " ")); sayBox.Text = ""; Toast("Sent"); }
        });
        sayRow.Controls.Add(sayBox); sayRow.Controls.Add(sayBtn);
        flow.Controls.Add(sayRow);
        p.Controls.Add(flow);
        return p;
    }

    TabPage ProgramsTab()
    {
        var p = new TabPage("My programs") { BackColor = BackColor, Padding = new Padding(12) };
        var info = new Label { Dock = DockStyle.Top, Height = 40, Text = "Add any program or script (.exe .bat .cmd .py .js .lnk) and start / stop it from here." };
        programs = new ListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, BackColor = Color.FromArgb(34, 34, 46), ForeColor = Color.White, Font = new Font("Segoe UI", 10.5f) };
        programs.Columns.Add("Name", 220); programs.Columns.Add("Status", 100); programs.Columns.Add("Path", 560);
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52 };
        bar.Controls.Add(MakeButton("＋ Add program", Color.FromArgb(46, 160, 67), delegate { AddProgram(); }));
        bar.Controls.Add(MakeButton("▶ Start", Color.FromArgb(46, 120, 67), delegate { foreach (ListViewItem i in programs.SelectedItems) StartProgram(i); }));
        bar.Controls.Add(MakeButton("■ Stop", Color.FromArgb(200, 60, 60), delegate { foreach (ListViewItem i in programs.SelectedItems) StopProgram(i); }));
        bar.Controls.Add(MakeButton("✕ Remove", Color.FromArgb(90, 70, 70), delegate { RemoveProgram(); }));
        p.Controls.Add(programs);
        p.Controls.Add(bar);
        p.Controls.Add(info);
        LoadPrograms();
        return p;
    }

    static readonly string[][] COMMANDS = new string[][] {
        new[] { "TikTok DM", "/help", "Shows everything he can do" },
        new[] { "TikTok DM", "/vid", "Sends you a funny video right now" },
        new[] { "TikTok DM", "/post [idea]", "Posts a TikTok now (optional idea)" },
        new[] { "TikTok DM", "/live", "Is Rararo live?" },
        new[] { "TikTok DM", "/streak", "Your streak with him" },
        new[] { "TikTok DM", "/reminders", "Lists your reminders" },
        new[] { "TikTok DM", "/memory", "What he remembers about you" },
        new[] { "TikTok DM", "/forget", "Clears your chat history" },
        new[] { "TikTok DM", "/inbox", "What's new in your Gmail / WhatsApp / Insta" },
        new[] { "TikTok DM", "/call", "Rings you on Element" },
        new[] { "TikTok DM", "/end", "Hangs up the call" },
        new[] { "TikTok DM", "/health", "Health check of the bot" },
        new[] { "TikTok DM", "/stats", "Your stats" },
        new[] { "TikTok DM", "/recap", "Recap of your week" },
        new[] { "TikTok DM", "/countdown nov 19 big drop", "Counts down to a date" },
        new[] { "TikTok DM", "/bday rayan march 3", "Saves a birthday and reminds you" },
        new[] { "Games", "/trivia", "One trivia question" },
        new[] { "Games", "/quiz", "5-question quiz" },
        new[] { "Games", "/wyr", "Would you rather" },
        new[] { "Games", "/score", "Scoreboard" },
        new[] { "Games", "/story", "Make a story together" },
        new[] { "Games", "/8ball question", "Magic 8 ball" },
        new[] { "Games", "/pick a or b", "Picks for you" },
        new[] { "Games", "/roast", "Friendly roast" },
        new[] { "Roblox", "/play", "Joins you in Roblox and follows you" },
        new[] { "Roblox", "/stop", "Leaves Roblox" },
        new[] { "Roblox", "/clip", "Posts the last 30 seconds of play" },
        new[] { "Roblox", "/stats", "Roblox stats" },
        new[] { "Roblox", "/rate", "Rates your avatar" },
        new[] { "Roblox", "/game", "Game ideas" },
        new[] { "Roblox", "(say) clip that", "Clips the moment while playing" },
        new[] { "Group chats", "/trivia /score /8ball /pick /roast /wyr", "Trivia battles + fun for everyone" },
        new[] { "Discord", "!trivia !score !8ball !pick !roast !wyr !help", "Same games in your server" },
        new[] { "Element", "call", "He rings you" },
        new[] { "Element", "/end", "He hangs up" },
        new[] { "Just talk", "Remind me at 6pm to…", "Sets a reminder" },
        new[] { "Just talk", "Remember that…", "Saves a fact about you" },
        new[] { "Just talk", "Any important emails today?", "Checks your Gmail" },
    };

    TabPage CommandsTab()
    {
        var p = new TabPage("Commands") { BackColor = BackColor, Padding = new Padding(12) };
        var search = new TextBox { Dock = DockStyle.Top, Font = new Font("Segoe UI", 11) };
        var hint = new Label { Dock = DockStyle.Top, Height = 28, Text = "Type to search · double-click a command to copy it" };
        var list = new ListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, BackColor = Color.FromArgb(34, 34, 46), ForeColor = Color.White, Font = new Font("Segoe UI", 10.5f) };
        list.Columns.Add("Where", 120); list.Columns.Add("Command", 330); list.Columns.Add("What it does", 420);
        Action fill = delegate
        {
            list.BeginUpdate(); list.Items.Clear();
            string q = search.Text.Trim().ToLower();
            foreach (var c in COMMANDS)
            {
                if (q.Length > 0 && !(c[0] + " " + c[1] + " " + c[2]).ToLower().Contains(q)) continue;
                var it = new ListViewItem(c[0]); it.SubItems.Add(c[1]); it.SubItems.Add(c[2]);
                list.Items.Add(it);
            }
            list.EndUpdate();
        };
        search.TextChanged += delegate { fill(); };
        list.DoubleClick += delegate
        {
            if (list.SelectedItems.Count == 0) return;
            string cmd = list.SelectedItems[0].SubItems[1].Text;
            try { Clipboard.SetText(cmd); Toast("Copied " + cmd); } catch { }
        };
        fill();
        p.Controls.Add(list); p.Controls.Add(hint); p.Controls.Add(search);
        return p;
    }

    // ------------------------------------------------------------------ phone remote (works on your home Wi-Fi)

    const int PORT = 8787;
    string pin, phoneErr;

    string Pin()
    {
        if (pin != null) return pin;
        string v;
        if (ReadSettings().TryGetValue("PHONE_PIN", out v) && v.Length >= 4) return pin = v;
        pin = new Random().Next(100000, 999999).ToString();
        try { WriteSetting("PHONE_PIN", pin); } catch { }
        return pin;
    }

    static string LocalIp()
    {
        try
        {
            var ips = Dns.GetHostEntry(Dns.GetHostName()).AddressList.Where(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a)).Select(a => a.ToString()).ToList();
            var best = ips.FirstOrDefault(a => a.StartsWith("192.168.")) ?? ips.FirstOrDefault(a => a.StartsWith("10.")) ?? ips.FirstOrDefault();
            return best ?? "localhost";
        }
        catch { return "localhost"; }
    }

    void StartPhoneServer()
    {
        Pin();
        try
        {
            var l = new TcpListener(IPAddress.Any, PORT);
            l.Start();
            var th = new Thread(delegate ()
            {
                while (true)
                {
                    try { var c = l.AcceptTcpClient(); ThreadPool.QueueUserWorkItem(delegate { Serve(c); }); }
                    catch { Thread.Sleep(500); }
                }
            });
            th.IsBackground = true;
            th.Start();
        }
        catch (Exception e) { phoneErr = e.Message; }
    }

    static Dictionary<string, string> Query(string q)
    {
        var d = new Dictionary<string, string>();
        foreach (var kv in q.Split('&'))
        {
            if (kv.Length == 0) continue;
            int i = kv.IndexOf('=');
            string k = Uri.UnescapeDataString((i < 0 ? kv : kv.Substring(0, i)).Replace('+', ' '));
            string v = i < 0 ? "" : Uri.UnescapeDataString(kv.Substring(i + 1).Replace('+', ' '));
            d[k] = v;
        }
        return d;
    }

    static string J(string t)
    {
        var sb = new StringBuilder("\"");
        foreach (char ch in t ?? "")
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch == '\n') sb.Append("\\n");
            else if (ch == '\r') { }
            else if (ch < ' ') sb.Append(' ');
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }

    void Serve(TcpClient c)
    {
        try
        {
            using (c)
            {
                c.ReceiveTimeout = 5000; c.SendTimeout = 5000;
                var s = c.GetStream();
                var r = new StreamReader(s, Encoding.ASCII);
                string first = r.ReadLine();
                if (first == null) return;
                string h;
                while (!string.IsNullOrEmpty(h = r.ReadLine())) { }
                var parts = first.Split(' ');
                string url = parts.Length > 1 ? parts[1] : "/";
                int qi = url.IndexOf('?');
                string path = qi < 0 ? url : url.Substring(0, qi);
                var qs = Query(qi < 0 ? "" : url.Substring(qi + 1));
                int code = 200; string type = "application/json; charset=utf-8"; string body;
                if (path == "/" || path == "/index.html")
                {
                    type = "text/html; charset=utf-8";
                    try { body = File.ReadAllText(Path.Combine(root, "gui", "phone.html")); } catch { body = "phone.html missing"; }
                }
                else if (path == "/manifest.json")
                {
                    type = "application/manifest+json";
                    body = "{\"name\":\"Laudi Remote\",\"short_name\":\"Laudi\",\"start_url\":\"/\",\"display\":\"standalone\",\"background_color\":\"#181820\",\"theme_color\":\"#181820\",\"icons\":[{\"src\":\"/icon.svg\",\"sizes\":\"any\",\"type\":\"image/svg+xml\"}]}";
                }
                else if (path == "/icon.svg")
                {
                    type = "image/svg+xml";
                    body = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='#5a63d6'/><text x='50' y='68' font-size='56' text-anchor='middle' fill='white' font-family='Arial' font-weight='bold'>L</text></svg>";
                }
                else if (path.StartsWith("/api/"))
                {
                    string p;
                    if (!qs.TryGetValue("pin", out p) || p != Pin()) { Thread.Sleep(1500); code = 401; body = "{\"error\":\"wrong pin\"}"; }
                    else body = (string)Invoke(new Func<string>(delegate { return Api(path, qs); }));
                }
                else { code = 404; body = "{}"; }
                var bytes = Encoding.UTF8.GetBytes(body);
                var head = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + (code == 200 ? " OK" : " Error") + "\r\nContent-Type: " + type + "\r\nContent-Length: " + bytes.Length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
                s.Write(head, 0, head.Length);
                s.Write(bytes, 0, bytes.Length);
            }
        }
        catch { }
    }

    string LogTail(int lines)
    {
        try
        {
            using (var fs = new FileStream(Path.Combine(Data, "bot.log"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                fs.Seek(Math.Max(0, fs.Length - 8000), SeekOrigin.Begin);
                var all = new StreamReader(fs, Encoding.UTF8).ReadToEnd().Replace("\r", "").Split('\n');
                return string.Join("\n", all.Skip(Math.Max(0, all.Length - lines)).ToArray());
            }
        }
        catch { return ""; }
    }

    static readonly string[] PHONE_CMDS = { "restart", "vid", "post-now", "hi", "health", "elring", "ring", "hangup", "build-gui" };

    string Api(string path, Dictionary<string, string> qs)
    {
        if (path == "/api/status")
            return "{\"running\":" + (BotRunning() ? "true" : "false") + ",\"pc\":" + J(Environment.MachineName) + ",\"log\":" + J(LogTail(30)) + "}";
        if (path == "/api/cmd")
        {
            string c; qs.TryGetValue("c", out c); c = (c ?? "").Trim().ToLower();
            if (c == "start") { StartLaudi(); return "{\"ok\":true,\"msg\":\"Starting Laudi… (~15 s)\"}"; }
            if (c == "stop") { StopLaudi(); return "{\"ok\":true,\"msg\":\"Stopping Laudi\"}"; }
            if (c == "say")
            {
                string t; qs.TryGetValue("t", out t);
                t = (t ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
                if (t.Length == 0) return "{\"ok\":false,\"error\":\"empty\"}";
                Remote("say " + t); return "{\"ok\":true}";
            }
            if (PHONE_CMDS.Contains(c)) { Remote(c); Toast("📱 phone: " + c); return "{\"ok\":true,\"msg\":" + J("Sent: " + c) + "}"; }
            return "{\"ok\":false,\"error\":\"unknown command\"}";
        }
        return "{}";
    }

    TabPage PhoneTab()
    {
        var p = new TabPage("📱 Phone") { BackColor = BackColor, Padding = new Padding(12) };
        string link = "http://" + LocalIp() + ":" + PORT;
        var big = new Label { Dock = DockStyle.Top, Height = 90, Font = new Font("Segoe UI", 20, FontStyle.Bold), ForeColor = Color.FromArgb(150, 160, 255),
            Text = phoneErr == null ? link + "\nPIN: " + Pin() : "Phone remote couldn't start: " + phoneErr };
        var info = new Label { Dock = DockStyle.Fill, Font = new Font("Segoe UI", 11), Text =
            "Control Laudi from your phone:\n\n" +
            "1. Phone on the SAME Wi-Fi as this PC.\n" +
            "2. Open Chrome on the phone and type the link above.\n" +
            "3. Enter the PIN.\n" +
            "4. Chrome menu (⋮) → \"Add to Home screen\" / \"Install app\" → it becomes the Laudi app icon.\n\n" +
            "If Windows asks to allow \"Laudi Control\" on the network, click Allow (Private networks).\n" +
            "Keep this app open (it starts by itself with Windows, minimized). Away from home? DM Laudi on Discord or Element: !status !restart !log !help" };
        var copy = MakeButton("Copy link", Color.FromArgb(80, 90, 200), delegate { try { Clipboard.SetText(link); Toast("Copied"); } catch { } });
        copy.Dock = DockStyle.Bottom;
        p.Controls.Add(info); p.Controls.Add(copy); p.Controls.Add(big);
        return p;
    }

    void AutoStartWithWindows()
    {
        try
        {
            string bat = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "LaudiControl.bat");
            string want = "@start \"\" \"" + Application.ExecutablePath + "\" /min\r\n";
            if (!File.Exists(bat) || File.ReadAllText(bat) != want) File.WriteAllText(bat, want);
        }
        catch { }
    }

    // ------------------------------------------------------------------ Laudi start/stop

    int BotPid()
    {
        try { return int.Parse(File.ReadAllText(Path.Combine(Data, "bot.pid")).Trim()); } catch { return 0; }
    }

    bool BotRunning()
    {
        int pid = BotPid();
        if (pid == 0) return false;
        try { var p = Process.GetProcessById(pid); return !p.HasExited && p.ProcessName.ToLower().Contains("node"); } catch { return false; }
    }

    void StartLaudi()
    {
        if (BotRunning()) { Toast("Laudi is already running"); return; }
        try { File.Delete(Path.Combine(Data, "stop.flag")); } catch { }
        var psi = new ProcessStartInfo("cmd.exe", "/c start \"Laudi\" /min start.bat") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true };
        Process.Start(psi);
        Toast("Starting Laudi… (takes ~15 seconds)");
    }

    void StopLaudi()
    {
        try { Directory.CreateDirectory(Data); File.WriteAllText(Path.Combine(Data, "stop.flag"), "stop"); } catch { }
        Remote("shutdown");
        Toast("Stopping Laudi…");
        var t = new Timer { Interval = 10000 };
        t.Tick += delegate
        {
            t.Stop();
            int pid = BotPid();
            if (BotRunning()) { try { Process.GetProcessById(pid).Kill(); } catch { } }
        };
        t.Start();
    }

    void Remote(string line)
    {
        try
        {
            Directory.CreateDirectory(Data);
            File.AppendAllText(Path.Combine(Data, "remote.txt"), line + Environment.NewLine);
        }
        catch (Exception e) { Toast("Couldn't send: " + e.Message); }
    }

    void Refresh2()
    {
        bool on = BotRunning();
        status.Text = on ? "● Laudi is running" : "● Laudi is stopped";
        botOn = on;
        startBtn.Enabled = !on; stopBtn.Enabled = on; restartBtn.Enabled = on;
        // log tail
        try
        {
            string log = Path.Combine(Data, "bot.log");
            using (var fs = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                long start = Math.Max(0, fs.Length - 40000);
                fs.Seek(start, SeekOrigin.Begin);
                var text = new StreamReader(fs, Encoding.UTF8).ReadToEnd().Replace("\r\n", "\n").Replace("\n", "\r\n");
                if (logBox != null && logBox.Text.Length != text.Length)
                {
                    logBox.Text = text;
                    logBox.SelectionStart = logBox.Text.Length;
                    logBox.ScrollToCaret();
                }
            }
        }
        catch { }
        // programs status
        if (programs != null)
            foreach (ListViewItem i in programs.Items)
            {
                Process pr;
                bool alive = running.TryGetValue(i.Text, out pr) && pr != null && !pr.HasExited;
                string st = alive ? "running" : "stopped";
                if (i.SubItems[1].Text != st) i.SubItems[1].Text = st;
            }
    }

    // ------------------------------------------------------------------ settings file

    Dictionary<string, string> ReadSettings()
    {
        var d = new Dictionary<string, string>();
        try
        {
            foreach (var raw in File.ReadAllLines(Settings))
            {
                var l = raw.Trim();
                if (l.StartsWith("#") || !l.Contains("=")) continue;
                var k = l.Substring(0, l.IndexOf('=')).Trim();
                d[k] = l.Substring(l.IndexOf('=') + 1).Trim();
            }
        }
        catch { }
        return d;
    }

    void WriteSetting(string key, string value)
    {
        var lines = File.Exists(Settings) ? File.ReadAllLines(Settings).ToList() : new List<string>();
        bool found = false;
        for (int i = 0; i < lines.Count; i++)
        {
            var l = lines[i].Trim();
            if (!l.StartsWith("#") && l.StartsWith(key + "="))
            {
                lines[i] = key + "=" + value;
                found = true;
            }
        }
        if (!found) lines.Add(key + "=" + value);
        File.WriteAllLines(Settings, lines.ToArray());
    }

    // ------------------------------------------------------------------ my programs

    void LoadPrograms()
    {
        programs.Items.Clear();
        if (!File.Exists(ProgramsFile)) return;
        foreach (var l in File.ReadAllLines(ProgramsFile))
        {
            var parts = l.Split('|');
            if (parts.Length < 2) continue;
            var it = new ListViewItem(parts[0]);
            it.SubItems.Add("stopped");
            it.SubItems.Add(parts[1]);
            programs.Items.Add(it);
        }
    }

    void SavePrograms()
    {
        var lines = new List<string>();
        foreach (ListViewItem i in programs.Items) lines.Add(i.Text + "|" + i.SubItems[2].Text);
        File.WriteAllLines(ProgramsFile, lines.ToArray());
    }

    void AddProgram()
    {
        using (var d = new OpenFileDialog { Title = "Pick a program or script", Filter = "Programs and scripts|*.exe;*.bat;*.cmd;*.py;*.js;*.lnk;*.ps1|All files|*.*" })
        {
            if (d.ShowDialog() != DialogResult.OK) return;
            var name = Path.GetFileNameWithoutExtension(d.FileName);
            var it = new ListViewItem(name);
            it.SubItems.Add("stopped");
            it.SubItems.Add(d.FileName);
            programs.Items.Add(it);
            SavePrograms();
        }
    }

    void RemoveProgram()
    {
        foreach (ListViewItem i in programs.SelectedItems.Cast<ListViewItem>().ToList()) { StopProgram(i); programs.Items.Remove(i); }
        SavePrograms();
    }

    void StartProgram(ListViewItem i)
    {
        Process old;
        if (running.TryGetValue(i.Text, out old) && old != null && !old.HasExited) return;
        var path = i.SubItems[2].Text;
        var ext = Path.GetExtension(path).ToLower();
        ProcessStartInfo psi;
        if (ext == ".py") psi = new ProcessStartInfo("python", "\"" + path + "\"");
        else if (ext == ".js") psi = new ProcessStartInfo("node", "\"" + path + "\"");
        else if (ext == ".ps1") psi = new ProcessStartInfo("powershell", "-ExecutionPolicy Bypass -File \"" + path + "\"");
        else if (ext == ".bat" || ext == ".cmd") psi = new ProcessStartInfo("cmd.exe", "/c \"" + path + "\"");
        else psi = new ProcessStartInfo(path) { UseShellExecute = true };
        psi.WorkingDirectory = Path.GetDirectoryName(path);
        try { running[i.Text] = Process.Start(psi); }
        catch (Exception e) { Toast("Couldn't start " + i.Text + ": " + e.Message); }
    }

    void StopProgram(ListViewItem i)
    {
        Process p;
        if (!running.TryGetValue(i.Text, out p) || p == null || p.HasExited) return;
        try
        {
            // stop the whole program, including anything it started
            Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + p.Id) { CreateNoWindow = true, UseShellExecute = false });
        }
        catch { try { p.Kill(); } catch { } }
    }

    // ------------------------------------------------------------------ helpers

    Button MakeButton(string text, Color color, EventHandler onClick)
    {
        var b = new Button { Text = text, AutoSize = true, Height = 36, BackColor = color, ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Margin = new Padding(4), Padding = new Padding(10, 2, 10, 2) };
        b.FlatAppearance.BorderSize = 0;
        b.Click += onClick;
        // smooth hover glow + a little "press" bounce
        Color baseC = color, hot = Mix(color, Color.White, 0.28);
        double t = 0; int dir = 0;
        var hov = new Timer { Interval = 15 };
        hov.Tick += delegate
        {
            t = Math.Max(0, Math.Min(1, t + dir * 0.12));
            b.BackColor = Mix(baseC, hot, t);
            if (t <= 0 || t >= 1) hov.Stop();
        };
        b.MouseEnter += delegate { dir = 1; hov.Start(); };
        b.MouseLeave += delegate { dir = -1; hov.Start(); };
        b.MouseDown += delegate { b.BackColor = Mix(baseC, Color.Black, 0.25); };
        b.MouseUp += delegate { b.BackColor = hot; };
        return b;
    }

    Button BigButton(string text, string command)
    {
        var b = MakeButton(text, Color.FromArgb(60, 64, 90), delegate { Remote(command); Toast("Done: " + text); });
        b.AutoSize = false; b.Width = 360; b.Height = 44; b.TextAlign = ContentAlignment.MiddleLeft;
        return b;
    }

    void OpenFile(string f)
    {
        try { Process.Start(new ProcessStartInfo(f) { UseShellExecute = true }); } catch (Exception e) { Toast(e.Message); }
    }

    void Toast(string msg)
    {
        toastBar.Text = msg;
        toastTarget = 34;
        toastTicks = 220; // ~3.5 s
    }

    static string FindRoot()
    {
        var here = AppDomain.CurrentDomain.BaseDirectory;
        foreach (var c in new[] { here, Path.Combine(here, "tiktok-bot"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), "tiktok-bot"), Path.GetDirectoryName(here.TrimEnd('\\')) })
        {
            try { if (c != null && File.Exists(Path.Combine(c, "start.bat"))) return c; } catch { }
        }
        return here;
    }
}
