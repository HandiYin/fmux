#!/bin/sh
# Put Robin back on lark-channel-bridge (one chat = one Codex thread).
set -eu
systemctl --user disable --now robin-hub.service || true
systemctl --user enable --now lark-channel-bridge.bot.codex-second.service
systemctl --user --no-pager status lark-channel-bridge.bot.codex-second.service | head -5
