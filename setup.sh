#!/bin/bash
# Storm Watch DFW — Telegram Bot Setup
# Run this once after: firebase login
# Usage: bash setup.sh

set -e

TG_TOKEN="8660731324:AAFrA2uy0S2Fwg4RRPH3657WlqA36Nd1qI8"
PROJECT="storm-watch-dfw"
REGION="us-central1"
FUNCTION="telegramWebhook"
WEBHOOK_URL="https://${REGION}-${PROJECT}.cloudfunctions.net/${FUNCTION}"

echo "==> Deploying Firebase Function..."
firebase deploy --only functions --project "$PROJECT"

echo ""
echo "==> Registering Telegram webhook..."
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${WEBHOOK_URL}\"}" | python3 -m json.tool

echo ""
echo "==> Setting bot commands..."
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "start",       "description": "Get started & see your settings"},
      {"command": "weather",     "description": "Current forecast for your location"},
      {"command": "alerts",      "description": "Active NWS warnings for your area"},
      {"command": "checkin",     "description": "Mark yourself as safe"},
      {"command": "setlocation", "description": "Change your location (e.g. Dallas TX or 75201)"},
      {"command": "mylocation",  "description": "See your saved location"},
      {"command": "status",      "description": "See who has checked in as safe"},
      {"command": "stop",        "description": "Pause storm alerts"},
      {"command": "resume",      "description": "Re-enable storm alerts"}
    ]
  }' | python3 -m json.tool

echo ""
echo "✅ Done! Bot is live at: https://t.me/StormWatchDFW_bot"
