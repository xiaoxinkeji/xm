#!/usr/bin/env bash
# start.sh — cloudflared 命名隧道（固定域名，远程管理模式）
#
# 前置：
#   1. /opt/cloudflared/cloudflared   二进制
#   2. /etc/cloudflared/token         Cloudflare Zero Trust 下发的 tunnel run token
#      （Cloudflare 控制台 → Zero Trust → Networks → Tunnels → 创建后复制）
#   3. 域名路由（Public Hostname）必须在 Cloudflare 控制台配置：
#      your-domain.com → HTTP://localhost:8409
#      注意：token 启动的隧道是"远程管理模式"，本地 config.yml 的 ingress 会被忽略！
set +e
if [ -x /etc/init.d/cloudflared ]; then
  /etc/init.d/cloudflared start >/dev/null 2>&1
  sleep 3
fi
if ! pgrep -f "cloudflared.*tunnel run" >/dev/null 2>&1; then
  cd /opt/cloudflared
  nohup /opt/cloudflared/cloudflared --pidfile /var/run/cloudflared.pid \
    --autoupdate-freq 24h0m0s tunnel run --token-file /etc/cloudflared/token \
    --url http://127.0.0.1:8409 \
    >> /opt/cloudflared/cloudflared.log 2>&1 &
  echo "fallback started pid=$!"
else
  echo "already running"
fi
