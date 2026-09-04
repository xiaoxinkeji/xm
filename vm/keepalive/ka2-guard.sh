#!/usr/bin/env bash
# ka2-guard.sh — 保活看门狗：主循环进程死了自动拉起
# 建议同时配置 /etc/profile.d/ka2.sh 钩子，VM 真正重启后开 shell 即补拉（见 deploy 模板）
set +e
while true; do
  if ! pgrep -f "/opt/keepalive/ka2.sh" >/dev/null; then
    setsid bash /opt/keepalive/ka2.sh >> /opt/keepalive/ka2.stdout 2>&1 </dev/null &
  fi
  sleep 30
done
