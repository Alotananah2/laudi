# Controls the Roblox app window for the bot: focus it, hold/release keys, type in chat, take screenshots.
# Reads one command per line on stdin and answers one line on stdout.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RbxInput {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static bool Front(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    uint target = GetWindowThreadProcessId(h, IntPtr.Zero);
    AttachThreadInput(me, fg, true); AttachThreadInput(me, target, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(me, fg, false); AttachThreadInput(me, target, false);
    return GetForegroundWindow() == h;
  }
  public static void Click() {
    INPUT[] i = new INPUT[2];
    i[0].type = 0; i[0].u.mi = new MOUSEINPUT(); i[0].u.mi.dwFlags = 0x2;
    i[1].type = 0; i[1].u.mi = new MOUSEINPUT(); i[1].u.mi.dwFlags = 0x4;
    SendInput(2, i, Marshal.SizeOf(typeof(INPUT)));
  }
  const uint KEYUP = 0x2, UNICODE = 0x4, SCANCODE = 0x8, EXTENDED = 0x1;
  static void Send(ushort scan, uint flags) {
    INPUT[] i = new INPUT[1];
    i[0].type = 1;
    i[0].u.ki = new KEYBDINPUT();
    i[0].u.ki.wScan = scan;
    i[0].u.ki.dwFlags = flags;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Down(ushort scan, bool ext) { Send(scan, SCANCODE | (ext ? EXTENDED : 0)); }
  public static void Up(ushort scan, bool ext) { Send(scan, SCANCODE | KEYUP | (ext ? EXTENDED : 0)); }
  public static void Char(char c) { Send((ushort)c, UNICODE); Send((ushort)c, UNICODE | KEYUP); }
}
"@
[void][RbxInput]::SetProcessDPIAware()

$scan = @{ c = 0x2E; e = 0x12; f = 0x21; q = 0x10; r = 0x13; shift = 0x2A; '1' = 0x02; '2' = 0x03; '3' = 0x04; w = 0x11; a = 0x1E; s = 0x1F; d = 0x20; space = 0x39; slash = 0x35; enter = 0x1C; esc = 0x01; left = 0x4B; right = 0x4D; up = 0x48; down = 0x50; alt = 0x38 }
$ext = @{ left = $true; right = $true; up = $true; down = $true }

function Get-Rbx {
  Get-Process -Name RobloxPlayerBeta -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
}

function Run-Command([string]$cmd, [string]$arg) {
  switch ($cmd) {
    'running' { $p = Get-Rbx; if ($p) { return "yes $($p.Id)" } else { return 'no' } }
    'open' { Start-Process -FilePath $arg; return 'ok' }
    'focus' {
      $p = Get-Rbx
      if (-not $p) { return 'none' }
      $h = $p.MainWindowHandle
      if ([RbxInput]::IsIconic($h)) { [void][RbxInput]::ShowWindow($h, 9) }
      if ([RbxInput]::Front($h)) { return 'ok' }
      # Tapping Alt lets a background program bring a window to the front.
      [RbxInput]::Down($scan['alt'], $false); [RbxInput]::Up($scan['alt'], $false)
      [void][RbxInput]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 100
      if ([RbxInput]::GetForegroundWindow() -eq $h) { return 'ok' }
      # Last resort: click on the window's title bar (a real click always brings it to the front)
      $r = New-Object 'RbxInput+RECT'
      [void][RbxInput]::GetWindowRect($h, [ref]$r)
      [void][RbxInput]::SetCursorPos([int](($r.Left + $r.Right) / 2), $r.Top + 12)
      [RbxInput]::Click()
      Start-Sleep -Milliseconds 150
      if ([RbxInput]::GetForegroundWindow() -eq $h) { return 'ok' } else { return 'notfront' }
    }
    'down' { if (-not $scan.ContainsKey($arg)) { return 'badkey' }; [RbxInput]::Down([uint16]$scan[$arg], [bool]$ext[$arg]); return 'ok' }
    'up' { if (-not $scan.ContainsKey($arg)) { return 'badkey' }; [RbxInput]::Up([uint16]$scan[$arg], [bool]$ext[$arg]); return 'ok' }
    'text' { foreach ($c in $arg.ToCharArray()) { [RbxInput]::Char($c); Start-Sleep -Milliseconds 20 }; return 'ok' }
    'shot' {
      $p = Get-Rbx
      if (-not $p) { return 'none' }
      $r = New-Object 'RbxInput+RECT'
      [void][RbxInput]::GetWindowRect($p.MainWindowHandle, [ref]$r)
      $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
      if ($w -lt 50 -or $hgt -lt 50) { return 'none' }
      $bmp = New-Object System.Drawing.Bitmap $w, $hgt
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
      $tw = 768; $th = [int]($hgt * $tw / $w)
      $small = New-Object System.Drawing.Bitmap $bmp, $tw, $th
      $small.Save($arg, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $g.Dispose(); $bmp.Dispose(); $small.Dispose()
      return 'ok'
    }
    'click' {
      # x y are 0-1000 across the Roblox window (what the bot sees in the screenshot)
      $p = Get-Rbx
      if (-not $p) { return 'none' }
      $xy = $arg.Split(' ')
      $r = New-Object 'RbxInput+RECT'
      [void][RbxInput]::GetWindowRect($p.MainWindowHandle, [ref]$r)
      $x = $r.Left + [int](($r.Right - $r.Left) * [double]$xy[0] / 1000)
      $y = $r.Top + [int](($r.Bottom - $r.Top) * [double]$xy[1] / 1000)
      [void][RbxInput]::SetCursorPos($x, $y)
      Start-Sleep -Milliseconds 80
      [RbxInput]::Click()
      return 'ok'
    }
    'kill' { Stop-Process -Id ([int]$arg) -Force -ErrorAction SilentlyContinue; return 'ok' }
    default { return 'unknown' }
  }
}

[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $i = $line.IndexOf(' ')
  if ($i -ge 0) { $cmd = $line.Substring(0, $i); $arg = $line.Substring($i + 1) } else { $cmd = $line; $arg = '' }
  try { $out = Run-Command $cmd $arg } catch { $out = "error $($_.Exception.Message)" }
  [Console]::Out.WriteLine([string]$out); [Console]::Out.Flush()
}
