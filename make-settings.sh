#!/usr/bin/env bash
# Makes Laudi's local-settings.txt on the Pi (when the PC isn't around to copy it from).
# Asks only for the 3 secret keys; everything else is already filled in.
cd "$(dirname "$(readlink -f "$0")")"
if [ -f local-settings.txt ]; then
  read -rp "local-settings.txt already exists. Replace it? [y/N] " a
  [ "${a,,}" = "y" ] || exit 0
  cp local-settings.txt "local-settings.backup-$(date +%s).txt"
fi
echo
echo "Laudi needs 3 keys. Paste each one and press Enter (Enter alone = skip for now)."
echo
echo "1) Groq key - his main brain. Get one free at https://console.groq.com/keys  (Create API Key)"
read -rsp "   GROQ_API_KEY: " GROQ; echo
echo "2) Gemini key - backup brain + seeing videos. Free at https://aistudio.google.com/apikey"
read -rsp "   GEMINI_API_KEY: " GEMINI; echo
echo "3) Discord bot token - https://discord.com/developers/applications > Laudi > Bot > Reset Token"
echo "   (resetting is fine: the PC copy stops working, which is what we want now)"
read -rsp "   DISCORD_TOKEN: " DISCORD; echo

cat > local-settings.txt <<SETTINGS
# ===== Laudi settings (made on the Pi) =====
# --- keys ---
GROQ_API_KEY=$GROQ
GEMINI_API_KEY=$GEMINI
DISCORD_TOKEN=$DISCORD

# --- you ---
OWNER_NAME=Murdhi
OWNER_TIKTOK=@techtokavgeek
OWNER_TIKTOK_NAME=TechtokMurdhi
OWNER_ROBLOX=alotananah2
DISCORD_OWNER=murdhi._46799
ELEMENT_OWNER=@murdhi:matrix.org
TIMEZONE=Asia/Riyadh

# --- Laudi ---
ASSISTANT_NAME=Laudi
BOT_TIKTOK=alothainah
PERSONALITY=friend
AI_PROVIDER=groq
GROQ_MODEL=openai/gpt-oss-120b
GEMINI_MODEL=gemini-flash-latest

# --- what he does ---
GROUPS=1
POSTS_PER_DAY=8
LIVE_SUPPORT=1
STREAMERS=tiktok:rararotherichest1:Rararo
WATCH_ACCOUNTS=1
EDUNATION_URL=https://app.edu-nation.net/
DISCORD_ENABLED=1
ELEMENT_ENABLED=1
CALL_EVERY_MINUTES=60
EXTRAS_ENABLED=1
# Roblox playing doesn't work on a Pi (friend/game checks still do)
ROBLOX_ENABLED=1
SETTINGS
echo
echo "✔ Saved local-settings.txt"
[ -z "$GROQ$GEMINI" ] && echo "! No AI key yet - Laudi can't talk until you add GROQ_API_KEY or GEMINI_API_KEY (run this again, or edit local-settings.txt)"
[ -z "$DISCORD" ] && echo "! No Discord token - Discord is off until you add DISCORD_TOKEN"
exit 0
