#!/usr/bin/env bash
# Build + serve this Kanban fork's server, telemetry-free and detached.
#
# The `deploy` action (default) is state-aware: it rebuilds only when sources
# changed, installs deps only when missing, and (re)starts only when needed —
# so re-running it on an already-deployed, up-to-date server is a no-op.
#
# Usage:
#   scripts/serve-kanban.sh [deploy|build|start|stop|restart|status]   # default: deploy
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

action="${1:-deploy}"
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

is_running() { ss -tlnp 2>/dev/null | grep -q ":$port "; }
stop_server() { pkill -f "dist/cli.js" 2>/dev/null; pkill -f "bin/kanban" 2>/dev/null; }

# Deps missing => fresh clone, install required before building.
needs_install() { [ ! -d "$REPO_ROOT/node_modules" ] || [ ! -d "$REPO_ROOT/web-ui/node_modules" ]; }

# Rebuild needed if there is no build yet, or any build input is newer than the
# built CLI (covers edits, git pull/merge/checkout — all bump mtimes).
needs_rebuild() {
	[ -f "$CLI" ] || return 0
	local newer
	newer="$(cd "$REPO_ROOT" && find \
		src web-ui/src package.json web-ui/package.json scripts/build.mjs \
		web-ui/vite.config.ts tsconfig.json tsconfig.base.json tsconfig.build.json \
		-type f -newer "$CLI" -print -quit 2>/dev/null)"
	[ -n "$newer" ]
}

do_build() {
	load_node
	cd "$REPO_ROOT"
	if needs_install; then
		echo ">> installing dependencies (first build)..."
		npm install --no-audit --no-fund
		npm --prefix web-ui install --no-audit --no-fund
	fi
	echo ">> building (telemetry-free; no keys set)..."
	npm run build
}

do_start() {
	[ -f "$CLI" ] || { echo "Built CLI not found at $CLI — run a build first." >&2; exit 1; }
	stop_server
	sleep 1
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
}

case "$action" in
	status)
		if is_running; then
			echo "kanban running on $host:$port"
			ss -tlnp 2>/dev/null | grep ":$port "
		else
			echo "kanban not running on :$port"
		fi
		echo -n "build: "; if [ ! -f "$CLI" ]; then echo "MISSING (rebuild needed)"; \
			elif needs_rebuild; then echo "STALE (rebuild needed)"; else echo "up to date"; fi
		;;
	stop)
		stop_server; sleep 1; echo "kanban stopped" ;;
	build)
		do_build; echo ">> build complete" ;;
	start|restart)
		do_start ;;
	deploy)
		# State-aware: rebuild only if needed, (re)start only if needed.
		rebuilt=0
		if needs_rebuild; then
			echo ">> sources changed or no build present -> rebuilding"
			do_build
			rebuilt=1
		else
			echo ">> build is up to date -> skipping rebuild"
		fi
		if is_running && [ "$rebuilt" -eq 0 ]; then
			echo ">> server already deployed and up to date -> nothing to do"
			ss -tlnp 2>/dev/null | grep ":$port "
		elif is_running; then
			echo ">> redeploying to pick up the new build"
			do_start
		else
			echo ">> server not running -> deploying"
			do_start
		fi
		;;
	*)
		echo "usage: $(basename "$0") [deploy|build|start|stop|restart|status]" >&2
		exit 2 ;;
esac
