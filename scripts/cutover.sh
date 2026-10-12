#!/bin/sh
# Move the Feishu bot "Robin" from lark-channel-bridge to robin-hub.
# One Feishu app delivers each event to a single connection, so the two must not run together.
set -eu
OLD=lark-channel-bridge.bot.codex-second.service
HERE=$(cd "$(dirname "$0")/.." && pwd)

echo "1/4 stop the old bridge ($OLD)"
systemctl --user disable --now "$OLD"

echo "2/4 install the robin-hub unit"
install -m 644 "$HERE/systemd/robin-hub.service" "$HOME/.config/systemd/user/robin-hub.service"
systemctl --user daemon-reload

echo "3/4 start robin-hub"
systemctl --user enable --now robin-hub.service
i=0
until "$HERE/bin/robinctl" status >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "robin-hub did not come up. Last log lines:" >&2
    journalctl --user -u robin-hub -n 20 --no-pager >&2
    echo "Roll back with: $HERE/scripts/rollback.sh" >&2
    exit 1
  fi
  sleep 1
done

echo "4/4 post the session dashboard to the Robin chat"
"$HERE/bin/robinctl" dashboard
echo "Done. Open the Robin chat in Feishu."
