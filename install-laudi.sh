#!/usr/bin/env bash
# =====================================================================
#  Laudi installer for Raspberry Pi (Raspberry Pi OS with desktop)
#  Run it from the unzipped laudi folder:   bash install-laudi.sh
#  Optional: bash install-laudi.sh owner/repo   (links the GitHub repo for !update)
# =====================================================================
set -e
cd "$(dirname "$(readlink -f "$0")")"
DIR="$(pwd)"
REPO="${1:-}"
B="\e[1m"; G="\e[32m"; Y="\e[33m"; R="\e[31m"; N="\e[0m"
step() { echo -e "\n${B}==> $*${N}"; }
ok()   { echo -e "${G}✔ $*${N}"; }
warn() { echo -e "${Y}! $*${N}"; }

[ "$(id -u)" -eq 0 ] && { echo -e "${R}Don't run this with sudo. Run: bash install-laudi.sh${N}"; exit 1; }
[ -f src/tiktok.js ] || { echo -e "${R}Run this from inside the laudi folder (the one with src/ in it).${N}"; exit 1; }
FEDORA=0; command -v dnf >/dev/null && FEDORA=1

step "1/7  Installing system stuff (Chromium, ffmpeg, git)… you may need to type your Pi password"
if [ $FEDORA = 1 ]; then
  sudo dnf install -y git curl chromium nodejs npm gh google-noto-color-emoji-fonts || true
else
  sudo apt-get update -y
  CHROMIUM=chromium
  apt-cache show chromium >/dev/null 2>&1 || CHROMIUM=chromium-browser
  sudo apt-get install -y git curl ffmpeg "$CHROMIUM" fonts-noto-color-emoji ca-certificates
  sudo apt-get install -y gh >/dev/null 2>&1 || warn "GitHub CLI (gh) not available from apt - updates can still use plain git"
fi
ok "system packages ready"

step "2/7  Node.js"
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 20 ] && [ $FEDORA = 1 ]; then
  sudo dnf install -y nodejs22 nodejs22-npm || sudo dnf install -y nodejs npm
elif [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
ok "Node $(node -v)"

step "3/7  Laudi's own packages (takes a few minutes on a Pi)"
npm install --omit=dev --legacy-peer-deps --no-audit --no-fund
ok "packages installed"

step "4/7  Settings + keys"
if [ ! -f local-settings.txt ]; then
  echo "No settings yet. Two options:"
  echo "  1) make them here now (you'll paste 3 keys)   <- easiest"
  echo "  2) copy local-settings.txt (and .env) from the PC's Desktop\\tiktok-bot folder into $DIR"
  read -rp "Type 1 or 2: " a
  if [ "$a" = "1" ]; then bash make-settings.sh; fi
  while [ ! -f local-settings.txt ]; do
    read -rp "Press Enter when local-settings.txt is copied (or type skip): " a
    [ "$a" = "skip" ] && break
  done
fi
if [ -f local-settings.txt ]; then
  # PC-only settings don't make sense on the Pi
  sed -i 's/\r$//' local-settings.txt
  sed -i '/^BROWSER=/d' local-settings.txt
  grep -q '^TIMEZONE=' local-settings.txt || echo "TIMEZONE=Asia/Riyadh" >> local-settings.txt
  ok "settings found"
else
  warn "no settings yet - Laudi won't start until local-settings.txt is in $DIR"
fi
[ -f .env ] && sed -i 's/\r$//' .env
mkdir -p data

step "5/7  More memory (swap) so 4 GB is enough for all of Laudi's tabs"
if [ -f /etc/dphys-swapfile ]; then
  sudo sed -i 's/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/; s/^#\?CONF_MAXSWAP=.*/CONF_MAXSWAP=2048/' /etc/dphys-swapfile
  grep -q '^CONF_MAXSWAP' /etc/dphys-swapfile || echo 'CONF_MAXSWAP=2048' | sudo tee -a /etc/dphys-swapfile >/dev/null
  sudo dphys-swapfile setup >/dev/null && sudo dphys-swapfile swapon
  ok "swap set to 2 GB"
else
  warn "this Pi OS manages swap itself (zram) - current memory:"
  free -h | head -3
fi

step "6/7  Start with the Pi (Laudi + the phone remote)"
mkdir -p "$HOME/.config/autostart" "$HOME/Desktop"
TERM_APP=x-terminal-emulator
for t in lxterminal ptyxis gnome-terminal konsole x-terminal-emulator; do command -v $t >/dev/null && { TERM_APP=$t; break; }; done
TERM_ARGS="-e"; [ "$TERM_APP" = "ptyxis" ] || [ "$TERM_APP" = "gnome-terminal" ] && TERM_ARGS="--"
cat > "$HOME/.config/autostart/laudi.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Laudi
Exec=$TERM_APP $TERM_ARGS bash "$DIR/start.sh"
X-GNOME-Autostart-enabled=true
EOF
cat > "$HOME/.config/autostart/laudi-panel.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Laudi Remote
Exec=bash -c 'cd "$DIR" && node panel.js >> data/panel.log 2>&1'
NoDisplay=true
EOF
cat > "$HOME/Desktop/Laudi.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Start Laudi
Icon=applications-games
Exec=$TERM_APP $TERM_ARGS bash "$DIR/start.sh"
Terminal=false
EOF
chmod +x "$HOME/Desktop/Laudi.desktop" start.sh
ok "Laudi and the phone remote start by themselves when the Pi boots"

step "7/7  GitHub updates (!update)"
if [ -z "$REPO" ] && [ ! -d .git ]; then
  read -rp "GitHub repo for updates, like murdhi/laudi (Enter to skip for now): " REPO
fi
if [ -n "$REPO" ]; then
  if command -v gh >/dev/null; then
    gh auth status >/dev/null 2>&1 || { echo "Log in to GitHub (a code shows here, type it on github.com/login/device):"; gh auth login --hostname github.com --git-protocol https --web; }
    gh auth setup-git
  fi
  [ -d .git ] || git init -q
  git remote remove origin >/dev/null 2>&1 || true
  git remote add origin "https://github.com/$REPO.git"
  if git fetch -q origin; then
    BR=$(git remote show origin | sed -n 's/.*HEAD branch: //p'); BR=${BR:-main}
    git reset -q --hard "origin/$BR" && git branch -q -M "$BR" && git branch -q --set-upstream-to="origin/$BR"
    ok "linked to github.com/$REPO - send Laudi !update to get new versions"
  else
    warn "couldn't reach github.com/$REPO - you can run this installer again later"
  fi
else
  warn "skipped - run  bash install-laudi.sh owner/repo  later to turn on !update"
fi

# phone remote now
pgrep -f "node panel.js" >/dev/null || (nohup node panel.js >> data/panel.log 2>&1 &)
sleep 1
IP=$(hostname -I | awk '{print $1}')
PIN=$(sed -n 's/^PHONE_PIN=//p' local-settings.txt 2>/dev/null | tail -1); [ -n "$PIN" ] || PIN=$(cat data/phone-pin.txt 2>/dev/null)

echo -e "\n${G}${B}All done! 🎉${N}"
echo -e "${B}Before starting:${N} stop Laudi on the PC (Laudi Control > Stop, then double-click retire-pc-laudi.bat on the PC)"
echo -e "                 so two Laudis don't fight over the same accounts."
echo -e "${B}Phone remote:${N}   http://$IP:8787   PIN ${PIN:-(see local-settings.txt)}"
echo -e "${B}First start:${N}    a Chromium window opens. Log Laudi in again there (the PC logins don't move over):"
echo "                 TikTok (alothainah), Element (@laudiai), WhatsApp (scan QR), Gmail, Instagram, Edunation."
echo
read -rp "Start Laudi now? [Y/n] " go
if [ "${go,,}" != "n" ]; then
  setsid "$TERM_APP" $TERM_ARGS bash "$DIR/start.sh" >/dev/null 2>&1 < /dev/null &
  ok "Laudi is starting in a new window"
fi
