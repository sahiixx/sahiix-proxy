#!/data/data/com.termux/files/usr/bin/bash
# Sahiix Proxy Sync Daemon
# Watches GitHub repo for changes and auto-deploys on Termux

set -e

PROXY_DIR="${PROXY_DIR:-$HOME/sahiix-proxy}"
REPO_URL="${REPO_URL:-https://github.com/sahiixx/sahiix-proxy.git}"
BRANCH="${BRANCH:-main}"
CHECK_INTERVAL="${CHECK_INTERVAL:-300}"
PIDFILE="$HOME/.sahiix-proxy/sync-daemon.pid"
LOGFILE="$HOME/.sahiix-proxy/sync.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOGFILE"
}

check_and_sync() {
    cd "$PROXY_DIR"
    git fetch origin "$BRANCH" --quiet
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")

    if [ "$LOCAL" != "$REMOTE" ]; then
        log "▶ Changes detected. Pulling..."
        git pull origin "$BRANCH"
        log "▶ Installing dependencies..."
        npm ci --silent
        log "▶ Building..."
        npm run build
        log "▶ Restarting proxy..."
        pm2 restart sahiix-proxy
        log "✓ Sync complete. New HEAD: $(git rev-parse --short HEAD)"

        if [ -n "$WATI_API_KEY" ] && [ -n "$ADMIN_NUMBERS" ]; then
            for admin in $(echo "$ADMIN_NUMBERS" | tr ',' ' '); do
                curl -s -X POST "${WATI_BASE_URL}/api/v1/sendSessionMessage/${admin}" \
                    -H "Authorization: Bearer ${WATI_API_KEY}" \
                    -H "Content-Type: text/plain" \
                    -d "🔄 Sahiix Proxy auto-synced on Termux. New commit: $(git rev-parse --short HEAD)" \
                    > /dev/null 2>&1 || true
            done
        fi
    fi
}

start_daemon() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Sync daemon already running (PID: $(cat "$PIDFILE"))"
        exit 0
    fi
    echo "Starting Sahiix Proxy sync daemon..."
    mkdir -p "$(dirname "$PIDFILE")"
    ( while true; do check_and_sync; sleep "$CHECK_INTERVAL"; done ) &
    echo $! > "$PIDFILE"
    log "Sync daemon started (PID: $(cat "$PIDFILE"))"
    echo "✓ Daemon started. Logs: $LOGFILE"
}

stop_daemon() {
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            rm -f "$PIDFILE"
            log "Sync daemon stopped"
            echo "✓ Daemon stopped"
        else
            rm -f "$PIDFILE"
            echo "✓ Stale PID file removed"
        fi
    else
        echo "Daemon not running"
    fi
}

status_daemon() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "● Sync daemon running (PID: $(cat "$PIDFILE"))"
        echo "  Check interval: ${CHECK_INTERVAL}s"
        echo "  Branch: $BRANCH"
        echo "  Proxy dir: $PROXY_DIR"
        echo "  Last log: $(tail -1 "$LOGFILE" 2>/dev/null || echo 'N/A')"
    else
        echo "○ Sync daemon not running"
        [ -f "$PIDFILE" ] && rm -f "$PIDFILE"
    fi
}

force_sync() {
    log "▶ Force sync triggered manually"
    check_and_sync
}

case "${1:-status}" in
    start)  start_daemon ;;
    stop)   stop_daemon ;;
    restart) stop_daemon; sleep 2; start_daemon ;;
    status) status_daemon ;;
    sync)   force_sync ;;
    *)      echo "Usage: $0 {start|stop|restart|status|sync}"; exit 1 ;;
esac
