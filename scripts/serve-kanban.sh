#!/usr/bin/env bash
# Serve this Kanban fork's already-built server, detached and telemetry-free.
#
# This does NOT build — run `npm run build` first (see the deploy-server skill,
# .claude/skills/deploy-server/SKILL.md). It starts dist/cli.js in its own
# session (setsid + nohup) so it survives the launching shell, binds to the LAN,
# and disables the remote passcode by default.
#
# Usage:
#   scripts/serve-kanban.sh [start|stop|restart|status]   # default: restart
#
# Env overrides:
#   KANBAN_PROJECT         git repo the board opens on   (default: $HOME/hello-kanban)
#   KANBAN_HOST            bind interface                (default: 0.0.0.0)
#   KANBAN_PORT            port                          (default: 3484)
#   KANBAN_ALLOWED_HOSTS   extra Host header allowlist   (default: tyamini-dev,10.10.73.144)
#   KANBAN_LOG             server log path               (default: /tmp/kanban-server.log)
#   KANBAN_PASSCODE_FLAG   set to "" to ENABLE the auto-generated remote passcode
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/dist/cli.js"

action="${1:-restart}"
project="${KANBAN_PROJECT:-$HOME/hello-kanban}"
host="${KANBAN_HOST:-0.0.0.0}"
port="${KANBAN_PORT:-3484}"
allowed="${KANBAN_ALLOWED_HOSTS:-tyamini-dev,10.10.73.144}"
log="${KANBAN_LOG:-/tmp/kanban-server.log}"
# `-` (not `:-`): default only when unset, so KANBAN_PASSCODE_FLAG="" enables the passcode.
passcode_flag="${KANBAN_PASSCODE_FLAG---no-passcode}"

load_node() {
	export NVM_DIR="$HOME/.nvm"
	# shellcheck disable=SC1091
	[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
	nvm use 22 >/dev/null 2>&1 || true
}

stop_server() { pkill -f "dist/cli.js" 2>/dev/null; pkill -f "bin/kanban" 2>/dev/null; }

case "$action" in
	stop)
		stop_server; sleep 1; echo "kanban stopped"; exit 0 ;;
	status)
		if ss -tlnp 2>/dev/null | grep -q ":$port "; then
			echo "kanban running on $host:$port"
			ss -tlnp 2>/dev/null | grep ":$port "
		else
			echo "kanban not running on :$port"
		fi
		exit 0 ;;
	start|restart) ;;
	*)
		echo "usage: $(basename "$0") [start|stop|restart|status]" >&2; exit 2 ;;
esac

[ -f "$CLI" ] || { echo "Built CLI not found at $CLI — run 'npm run build' first." >&2; exit 1; }

stop_server; sleep 1
load_node
cd "$project" 2>/dev/null || { echo "project dir not found: $project" >&2; exit 1; }

# setsid + nohup => own session, detached from this shell, survives logout.
# shellcheck disable=SC2086
setsid nohup env KANBAN_NO_AUTO_UPDATE=1 KANBAN_ALLOWED_HOSTS="$allowed" \
	node "$CLI" --no-open $passcode_flag --host "$host" --port "$port" \
	>"$log" 2>&1 </dev/null &
disown

sleep 6
echo "--- kanban ($host:$port) | log: $log ---"
tail -n 12 "$log"
