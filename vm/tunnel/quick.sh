#!/usr/bin/env bash
# quick.sh — cloudflared 临时隧道（免费随机域名，无需账号，备用通道）
#
# 用途：命名隧道/域名故障时的备用入口；或不想绑域名时快速获得公网地址。
# 输出的随机域名在 quick.log 里：grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com'
#
# 注意：
#   1. quick tunnel 是"本地管理模式"，会读取 /etc/cloudflared/config.yml——
#      该文件里不要写 ingress（否则随机域名落入兜底规则全部 404，见 docs/troubleshooting.md）
#   2. pkill -f 会匹配到执行中的 shell 自身命令行，务必用 [x] 技巧或精确 pid
set +e
OLD=$(ps aux | grep "[c]loudflared.*--url" | awk '{print $2}')
[ -n "$OLD" ] && kill $OLD 2>/dev/null
sleep 1
cd /opt/cloudflared
nohup /opt/cloudflared/cloudflared tunnel --url http://127.0.0.1:8409 \
  >> /opt/cloudflared/quick.log 2>&1 &
echo "quick tunnel started pid=$!"
sleep 6
grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /opt/cloudflared/quick.log | tail -1
