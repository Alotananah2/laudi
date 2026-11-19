#!/usr/bin/env bash
# ======================================================================
#  Laudi 2 installer for Ubuntu Server (also Fedora) - no screen needed, works over SSH
#  Run inside the laudi folder:   bash install.sh
#  Then open the dashboard on your phone and finish the setup there.
# ======================================================================
set -e
cd "$(dirname "$(readlink -f "$0")")"
DIR="$(pwd)"; REPO="${1:-Alotananah2/laudi}"
B="\e[1m"; G="\e[32m"; Y="\e[33m"; R="\e[31m"; N="\e[0m"
step() { echo -e "\n${B}==> $*${N}"; }
ok() { echo -e "${G}✔ $*${N}"; }
warn() { echo -e "${Y}! $*${N}"; }
[ "$(id -u)" -eq 0 ] && { echo -e "${R}Run it as your normal user (not sudo): bash install.sh${N}"; exit 1; }
[ -f src/tiktok.js ] || { echo -e "${R}Run this inside the laudi folder.${N}"; exit 1; }
if command -v apt-get >/dev/null; then PM=apt; elif command -v dnf >/dev/null; then PM=dnf; else echo -e "${R}Needs Ubuntu (apt) or Fedora (dnf).${N}"; exit 1; fi

step "System packages (virtual screen, Node.js)… type your password if asked"
if [ $PM = apt ]; then
  sudo apt-get update -y
  sudo apt-get install -y git curl ca-certificates xvfb xauth fonts-noto-color-emoji iw iputils-ping
  NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/'); NODE_MAJOR=${NODE_MAJOR:-0}
  if [ "$NODE_MAJOR" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
else
  sudo dnf install -y git curl xorg-x11-server-Xvfb xorg-x11-xauth nodejs npm google-noto-color-emoji-fonts
fi
ok "Node $(node -v)"

step "Laudi's packages + his own Chromium (a few minutes)"
npm install --omit=dev --legacy-peer-deps --no-audit --no-fund
# Ubuntu's chromium is a snap that doesn't work well as a background service, so use Playwright's own Chromium
sudo -E env "PATH=$PATH" npx --yes playwright-core install-deps chromium || warn "couldn't install Chromium's system libraries"
npx --yes playwright-core install chromium
mkdir -p data && chmod 700 data
[ -f local-settings.txt ] && { sed -i 's/\r$//' local-settings.txt; chmod 600 local-settings.txt; }
ok "installed"

step "Run Laudi + the dashboard in the background (also after reboots)"
NODE_BIN="$(command -v node)"
ME="$(id -un)"
sudo tee /etc/systemd/system/laudi-dashboard.service >/dev/null <<UNITEOF
[Unit]
Description=Laudi dashboard (phone app + alarms)
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$DIR
Environment=HOME=$HOME
ExecStart=$NODE_BIN $DIR/dashboard.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF
sudo tee /etc/systemd/system/laudi.service >/dev/null <<UNITEOF
[Unit]
Description=Laudi (TikTok friend bot, no screen)
After=network-online.target laudi-dashboard.service
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$DIR
Environment=HOME=$HOME
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1366x900x24" $NODE_BIN $DIR/src/tiktok.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNITEOF
# let the dashboard (running as you) start/stop Laudi without a password
SC="$(command -v systemctl)"
echo "$ME ALL=(root) NOPASSWD: $SC start laudi.service, $SC stop laudi.service, $SC restart laudi.service, $SC restart hostapd.service, $SC restart NetworkManager.service, $SC reboot" | sudo tee /etc/sudoers.d/laudi >/dev/null
sudo chmod 440 /etc/sudoers.d/laudi
sudo visudo -cf /etc/sudoers.d/laudi >/dev/null || { sudo rm -f /etc/sudoers.d/laudi; warn "couldn't set up the start/stop permission"; }
# remove the old per-user services from a previous try (if any)
rm -f "$HOME/.config/systemd/user/laudi.service" "$HOME/.config/systemd/user/laudi-dashboard.service"
sudo systemctl daemon-reload
sudo systemctl enable --now laudi-dashboard.service
sudo systemctl enable laudi.service
touch local-settings.txt
echo
read -rp "Does Laudi run on your Windows PC (this server is just the hub)? [Y/n] " hub
if [ "${hub,,}" != "n" ]; then
  echo "In Laudi Control on the PC, open the 📱 Phone tab: it shows the PC's address and PIN."
  read -rp "PC address (like http://192.168.1.20:8787): " PCURL
  read -rp "PC PIN: " PCPIN
  sed -i '/^LAUDI_PC_URL=/d;/^LAUDI_PC_PIN=/d' local-settings.txt
  [ -n "$PCURL" ] && { case "$PCURL" in http*) ;; *) PCURL="http://$PCURL";; esac; echo "LAUDI_PC_URL=$PCURL" >> local-settings.txt; }
  [ -n "$PCPIN" ] && echo "LAUDI_PC_PIN=$PCPIN" >> local-settings.txt
  # Laudi himself runs on the PC, not here
  sudo systemctl disable --now laudi.service 2>/dev/null || true
  sudo systemctl restart laudi-dashboard.service
  ok "hub mode: this server controls Laudi on the PC (you can change it in the dashboard > Setup)"
elif grep -q '^DASHBOARD_PIN=.' local-settings.txt 2>/dev/null; then
  sudo systemctl restart laudi.service
  ok "dashboard + Laudi are running here"
else
  ok "dashboard is running; Laudi starts after you finish setup in the dashboard"
fi

step "Voice: say \"wake up\" near the server"
read -rp "Turn on the voice (uses the MacBook's mic + speakers)? [Y/n] " vo
if [ "${vo,,}" != "n" ]; then
  if [ $PM = apt ]; then sudo apt-get install -y python3-venv alsa-utils mpg123 espeak-ng unzip; else sudo dnf install -y python3 alsa-utils mpg123 espeak-ng unzip; fi
  [ -d voice/venv ] || python3 -m venv voice/venv
  voice/venv/bin/pip install -q --upgrade pip >/dev/null
  voice/venv/bin/pip install -q vosk edge-tts
  if [ ! -d voice/model ]; then
    curl -fL -o /tmp/vosk-model.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
    unzip -q -o /tmp/vosk-model.zip -d voice && mv voice/vosk-model-small-en-us-0.15 voice/model && rm -f /tmp/vosk-model.zip
  fi
  sudo usermod -aG audio "$ME"
  amixer -q sset Master 85% unmute 2>/dev/null || true
  amixer -q sset Capture 80% cap 2>/dev/null || true
  sudo tee /etc/systemd/system/laudi-voice.service >/dev/null <<UNITEOF
[Unit]
Description=Laudi voice (says "I'm already awake!" when it hears "wake up")
After=sound.target network-online.target

[Service]
User=$ME
SupplementaryGroups=audio
WorkingDirectory=$DIR/voice
Environment=HOME=$HOME
ExecStart=$DIR/voice/venv/bin/python $DIR/voice/voice.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now laudi-voice.service
  echo "Testing the speakers…"; voice/venv/bin/python voice/voice.py test || warn "no sound? check the volume: alsamixer"
  ok "voice is on - say \"wake up\" near the MacBook (logs: journalctl -u laudi-voice -f)"
fi

step "Let your phone reach the dashboard"
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 8787/tcp >/dev/null && ok "port 8787 open (ufw)"
elif command -v firewall-cmd >/dev/null; then
  sudo firewall-cmd --permanent --add-port=8787/tcp >/dev/null && sudo firewall-cmd --reload >/dev/null && ok "port 8787 open"
else
  ok "no firewall to change"
fi

step "Use the app from anywhere (Tailscale, free)"
read -rp "Set up Tailscale so the phone app works outside your house too? [Y/n] " ts
if [ "${ts,,}" != "n" ]; then
  if ! command -v tailscale >/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  sudo systemctl enable --now tailscaled
  echo "A login link shows up next - open it and sign in (Google is fine). Then install Tailscale on your phone with the same account."
  sudo tailscale up || warn "Tailscale didn't finish - run: sudo tailscale up"
fi

step "Updates from GitHub ($REPO)"
if [ ! -d .git ]; then
  read -rp "Link to github.com/$REPO so '!update' works? [Y/n] " gl
  if [ "${gl,,}" != "n" ]; then
    command -v gh >/dev/null || { [ $PM = apt ] && sudo apt-get install -y gh || sudo dnf install -y gh; }
    # no browser on a server: it shows a code, type it at github.com/login/device on your phone
    gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web
    gh auth setup-git
    git init -q && git remote add origin "https://github.com/$REPO.git"
    if git fetch -q origin main; then git reset -q --hard origin/main && git branch -q -M main && git branch -q --set-upstream-to=origin/main && ok "linked"; else warn "couldn't reach the repo, skipped"; fi
  fi
fi

LAN=$(hostname -I | awk '{print $1}')
TSIP=$(tailscale ip -4 2>/dev/null | head -1 || true)
echo -e "\n${G}${B}Done! 🎉${N}"
echo -e "Check: ${B}systemctl status laudi-dashboard${N}   Logs: ${B}journalctl -u laudi -f${N}"
echo -e "Open the dashboard on your phone (between 8 PM and 10 AM) and do the setup:"
echo -e "   at home:   ${B}http://$LAN:8787${N}   (or on the \"Murdhi's server\" Wi-Fi)"
[ -n "$TSIP" ] && echo -e "   anywhere:  ${B}http://$TSIP:8787${N}   (phone needs Tailscale on)"
echo -e "The phone app: download Laudi.apk from github.com/$REPO/releases (tag 'app') and type that address."
echo -e "Stop Laudi on the Windows PC so two Laudis don't fight: DM him !stop or press Stop in Laudi Control."
