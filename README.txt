LAUDI 2  (Windows PC)

INSTALL (on the Windows PC):  double-click install.bat inside the laudi folder.
  It installs Node.js/Git if needed, Laudi's packages, auto-start with Windows,
  opens port 8787 for your phone, offers Tailscale, starts Laudi and shows the address.
Then on your phone, between 8 PM and 10 AM, open the Laudi app, type that address and do the setup:
  Laudi's TikTok + password, Element + password, Discord token, Groq/Gemini keys, a PIN.

START / STOP on the PC:  start.bat / stop.bat   (or the Start/Stop buttons in the phone app)
  Laudi runs in a minimized "Laudi" window and restarts himself if he crashes.
  The "Laudi dashboard" window is what the phone app talks to - leave it running.

DASHBOARD  http://<pc-address>:8787   (open 8 PM - 10 AM, change in Setup)
  Home    - start/stop/restart, which accounts are logged in, quick buttons
  Screen  - Laudi's browser: tap/type to finish logins, puzzles, WhatsApp QR
  Alarms  - your phone rings (Laudi app) + Laudi calls you on Element/Discord
  Setup   - accounts, keys, what Laudi does, log
  For Murdhi's Server / Jarvis: show  http://<pc-address>:8787/embed

PHONE APP  github.com/Alotananah2/laudi/releases (tag "app") -> Laudi.apk
  Type the PC address once. Alarms ring even when the app is closed.
  Outside the house: install Tailscale on the phone (same account) and use the 100.x address.

LINUX  install.sh still works on Ubuntu/Fedora (systemd) if you ever move him back.
OFF FOR GOOD  Roblox playing and Rararo support are removed.
