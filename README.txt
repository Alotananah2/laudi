LAUDI 2  (Fedora, no screen)

INSTALL (on the Fedora computer, in this folder):   bash install.sh
Then on your phone, between 8 PM and 10 AM, open the address it shows and do the setup:
  Laudi's TikTok + password, Element + password, Discord token, Groq/Gemini keys, a PIN.

DASHBOARD  http://<fedora>:8787   (open 8 PM - 10 AM, change in Setup)
  Home    - start/stop/restart, which accounts are logged in, quick buttons
  Screen  - Laudi's invisible browser: tap/type to finish logins, puzzles, WhatsApp QR
  Alarms  - your phone rings (Laudi app) + Laudi calls you on Element/Discord
  Setup   - accounts, keys, what Laudi does, log
  For Murdhi's Server: add a tab/iframe that opens  http://<fedora>:8787/embed

PHONE APP  github.com/Alotananah2/laudi/releases (tag "app") -> Laudi.apk
  Type the dashboard address once. Alarms ring even when the app is closed.
  Outside the house: install Tailscale on the phone (same account) and use the 100.x address.

UPDATES  DM Laudi !update (or Update button). Phone app rebuilds itself on GitHub.
OFF FOR GOOD  Roblox playing and Rararo support are removed.
COMMANDS  systemctl --user status laudi | journalctl --user -u laudi -f
