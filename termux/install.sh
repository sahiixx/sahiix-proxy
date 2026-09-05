#!/data/data/com.termux/files/usr/bin/bash
# Sahiix Edge Proxy - Termux Deployment
# Auto-installer for Android/Termux primary build machine

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROXY_DIR="$HOME/sahiix-proxy"
NODE_VERSION="20.12.2"

echo -e "${GREEN}▶ Sahiix Edge Proxy - Termux Installer${NC}"
echo "  Target: $PROXY_DIR"
echo ""

# ─── Dependencies ───
echo -e "${YELLOW}→ Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}  Installing Node.js...${NC}"
    pkg update -y
    pkg install -y nodejs-lts
fi

if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}  Installing git...${NC}"
    pkg install -y git
fi

if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}  Installing PM2...${NC}"
    npm install -g pm2
fi

# ─── Clone or update ───
if [ -d "$PROXY_DIR/.git" ]; then
    echo -e "${YELLOW}→ Updating existing repo...${NC}"
    cd "$PROXY_DIR"
    git pull origin main
else
    echo -e "${YELLOW}→ Cloning repository...${NC}"
    if [ -n "$GH_TOKEN" ]; then
        git clone "https://${GH_TOKEN}@github.com/sahiixx/sahiix-proxy.git" "$PROXY_DIR" || \
        git clone https://github.com/sahiixx/sahiix-proxy.git "$PROXY_DIR"
    else
        git clone https://github.com/sahiixx/sahiix-proxy.git "$PROXY_DIR"
    fi
fi

cd "$PROXY_DIR"

# ─── Install & build ───
echo -e "${YELLOW}→ Installing npm dependencies...${NC}"
npm --prefix "$PROXY_DIR" ci

echo -e "${YELLOW}→ Running TypeScript build...${NC}"
npm --prefix "$PROXY_DIR" run build

# ─── Environment setup ───
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}→ Creating .env template...${NC}"
    cat > .env << 'EOF'
# Sahiix Edge Proxy - Termux Environment
SAHIIX_API_BASE=https://api.sahiix.com
AUTH_SECRET=change-me-32-char-minimum!!!
WATI_API_KEY=your-wati-api-key
WATI_BASE_URL=https://live-server-115912.wati.io
ADMIN_NUMBERS=+971585476077
RATE_LIMIT_KV_PATH=/data/data/com.termux/files/home/.sahiix-proxy/kv/ratelimit
GOVERNANCE_KV_PATH=/data/data/com.termux/files/home/.sahiix-proxy/kv/governance
PORT=8787
EOF
    echo -e "${RED}⚠ Edit .env with real values before starting!${NC}"
fi

# ─── KV directories ───
mkdir -p "$HOME/.sahiix-proxy/kv/ratelimit"
mkdir -p "$HOME/.sahiix-proxy/kv/governance"

# ─── PM2 ecosystem ───
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'sahiix-proxy',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    env_file: './.env',
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_memory_restart: '256M',
    restart_delay: 3000,
    max_restarts: 5,
    min_uptime: '10s',
    watch: false,
    kill_timeout: 5000,
    listen_timeout: 8000,
  }],
};
EOF

mkdir -p logs

# ─── Termux:Boot setup ───
BOOT_DIR="$HOME/.termux/boot"
if [ -d "$BOOT_DIR" ]; then
    echo -e "${YELLOW}→ Installing Termux:Boot auto-start...${NC}"
    cat > "$BOOT_DIR/start-sahiix-proxy.sh" << EOF
#!/data/data/com.termux/files/usr/bin/bash
source $HOME/.bashrc 2>/dev/null
sleep 10
pm2 start $PROXY_DIR/ecosystem.config.js
EOF
    chmod +x "$BOOT_DIR/start-sahiix-proxy.sh"
    echo -e "${GREEN}  ✓ Termux:Boot script installed${NC}"
fi

# ─── Sync daemon ───
echo -e "${YELLOW}→ Installing sync daemon...${NC}"
cp termux/sync-daemon.sh "$HOME/.sahiix-proxy/"
chmod +x "$HOME/.sahiix-proxy/sync-daemon.sh"

# ─── Bionic Bypass check ───
if [ -f "$PREFIX/lib/libbionic_compat.so" ] || [ -n "$LD_PRELOAD" ]; then
    echo -e "${GREEN}  ✓ Bionic Bypass (LD_PRELOAD) detected${NC}"
else
    echo -e "${YELLOW}  ℹ If Node.js crashes with 'cannot locate symbol', install bionic-bypass:${NC}"
    echo "    pkg install bionic-bypass || npm install -g termux-bionic-bypass"
fi

# ─── Completion ───
echo ""
echo -e "${GREEN}✓ Installation complete!${NC}"
echo ""
echo "  Next steps:"
echo "    1. Edit $PROXY_DIR/.env with your secrets"
echo "    2. pm2 start ecosystem.config.js"
echo "    3. pm2 save"
echo "    4. pm2 startup"
echo ""
echo "  Sync daemon:"
echo "    $HOME/.sahiix-proxy/sync-daemon.sh start"
echo ""
