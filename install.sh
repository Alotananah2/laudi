#!/usr/bin/env bash
# ======================================================================
#  Laudi 2 installer for Fedora (works with no screen / over SSH)
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
command -v dnf >/dev/null || { echo -e "${R}This installer is for Fedora (dnf).${N}"; exit 1; }

step "1/6  System packages (Chromium, virtual screen, Node.js)… type your password if asked"
sudo dnf install -y git chromium xorg-x11-server-Xvfb xorg-x11-xauth nodejs npm google-noto-color-emoji-fonts curl
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || { sudo dnf install -y nodejs22 nodejs22-npm || true; }
ok "Node $(node -v), $(chromium-browser --version 2>/dev/null || chromium --version 2>/dev/null)"

step "2/6  Laudi's packages"
npm install --omit=dev --legacy-peer-deps --no-audit --no-fund
mkdir -p data && chmod 700 data
[ -f local-settings.txt ] && { sed -i 's/\r$//' local-settings.txt; chmod 600 local-settings.txt; }
ok "installed"

step "3/6  Run Laudi + the dashboard in the background (also after reboots, no login needed)"
UNIT="$HOME/.config/systemd/user"; mkdir -p "$UNIT"
NODE_BIN="$(command -v node)"
cat > "$UNIT/laudi-dashboard.service" <<UNITEOF
[Unit]
Description=Laudi dashboard (phone app + alarms)
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/dashboard.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNITEOF
cat > "$UNIT/laudi.service" <<UNITEOF
[Unit]
Description=Laudi (TikTok friend bot, no screen)
After=network-online.target laudi-dashboard.service

[Service]
WorkingDirectory=$DIR
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1366x900x24" $NODE_BIN $DIR/src/tiktok.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNITEOF
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now laudi-dashboard.service
systemctl --user enable laudi.service
ok "Laudi starts by himself after you finish setup in the dashboard"

step "4/6  Let your phone reach the dashboard"
if command -v firewall-cmd >/dev/null; then
  sudo firewall-cmd --permanent --add-port=8787/tcp >/dev/null && sudo firewall-cmd --reload >/dev/null && ok "port 8787 open"
fi

step "5/6  Use the app from anywhere (Tailscale, free)"
read -rp "Set up Tailscale so the phone app works outside your house too? [Y/n] " ts
if [ "${ts,,}" != "n" ]; then
  if ! command -v tailscale >/dev/null; then
    sudo dnf config-manager addrepo --from-repofile=https://pkgs.tailscale.com/stable/fedora/tailscale.repo 2>/dev/null \
      || sudo dnf config-manager --add-repo https://pkgs.tailscale.com/stable/fedora/tailscale.repo
    sudo dnf install -y tailscale
  fi
  sudo systemctl enable --now tailscaled
  echo "A login link shows up next - open it and sign in (Google is fine). Then install Tailscale on your phone with the same account."
  sudo tailscale up || warn "Tailscale didn't finish - run: sudo tailscale up"
fi

step "6/6  Updates from GitHub ($REPO)"
if [ ! -d .git ]; then
  read -rp "Link to github.com/$REPO so '!update' works? [Y/n] " gl
  if [ "${gl,,}" != "n" ]; then
    command -v gh >/dev/null || sudo dnf install -y gh
    gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web
    gh auth setup-git
    git init -q && git remote add origin "https://github.com/$REPO.git"
    if git fetch -q origin main; then git reset -q --hard origin/main && git branch -q -M main && git branch -q --set-upstream-to=origin/main && ok "linked"; else warn "couldn't reach the repo, skipped"; fi
  fi
fi

LAN=$(hostname -I | awk '{print $1}')
TSIP=$(tailscale ip -4 2>/dev/null | head -1 || true)
echo -e "\n${G}${B}Done! 🎉${N}"
echo -e "Open the dashboard on your phone (between 8 PM and 10 AM) and do the setup:"
echo -e "   at home:   ${B}http://$LAN:8787${N}"
[ -n "$TSIP" ] && echo -e "   anywhere:  ${B}http://$TSIP:8787${N}   (phone needs Tailscale on)"
echo -e "The phone app: download Laudi.apk from github.com/$REPO/releases (tag 'app') and type that address."
echo -e "Stop Laudi on the Windows PC so two Laudis don't fight: DM him !stop or press Stop in Laudi Control."
