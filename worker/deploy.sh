#!/bin/bash
# Run this on the DigitalOcean droplet after SSH in
# Usage: bash deploy.sh

set -e

echo "=== MineralFlow TRRC Worker — Deploy ==="

# 1. Install Node.js 22
if ! command -v node &> /dev/null || [[ "$(node -v)" < "v22" ]]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "Node: $(node -v) | npm: $(npm -v)"

# 2. Install dependencies
npm install

# 3. Install Playwright + Chromium
npx playwright install chromium
npx playwright install-deps chromium

# 4. Build TypeScript
npm run build

# 5. Install pm2 for process management
npm install -g pm2

# 6. Create .env file (fill these in)
if [ ! -f .env ]; then
  cat > .env << 'EOF'
SUPABASE_URL=https://mevttpgjaeqxccmqitax.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY_HERE
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_KEY_HERE
MAX_CONCURRENT=3
POLL_INTERVAL_MS=5000
EOF
  echo ""
  echo "!!! Edit .env with your actual keys before starting the worker !!!"
  echo ""
fi

# 7. Start with pm2
# --env production does NOT load .env — that flag only applies to an
# ecosystem.config.js env_production block, which we don't have. Node
# doesn't read .env files automatically either. Without --node-args here,
# the process starts with none of the secrets in .env and crash-loops on
# "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required".
pm2 delete mineralflow-worker 2>/dev/null || true
pm2 start dist/index.js --name mineralflow-worker \
  --node-args="--env-file=.env" \
  --log ./logs/worker.log \
  --time \
  --restart-delay 5000 \
  --max-restarts 10

pm2 save
pm2 startup

echo ""
echo "=== Worker deployed ==="
echo "Monitor: pm2 logs mineralflow-worker"
echo "Status:  pm2 status"
echo "Restart: pm2 restart mineralflow-worker"
