#!/usr/bin/env bash
# ka2.sh — 60s coding-agent 保活主循环（防 VM 休眠的主防线）
#
# 背景：平台按 coding agent 活跃度判定 VM 是否休眠（阈值约 11 分钟），
# 15 分钟一次的保活留有空窗仍会被冻结，60s 一次实测可彻底阻止休眠。
#
# 机制：
#   - 每 OC_INTERVAL 秒向 coding agent（opencode）当前 session 发最小 prompt
#     （真实 LLM 调用 = 平台级活跃信号，已验证有效）
#   - 每 TERM_INTERVAL 秒在本地 shell 产生 PTY 活动（终端级保险）
set +e
LOG="${LOG:-/opt/keepalive/ka2.log}"
OC="${OC:-http://127.0.0.1:4096}"
INTERVAL="${INTERVAL:-60}"
OC_INTERVAL="${OC_INTERVAL:-60}"
TERM_INTERVAL="${TERM_INTERVAL:-60}"

ts(){ date '+%m-%d %H:%M:%S'; }
log(){ echo "[$(ts)] $*" >> "$LOG"; }

get_sid(){
  curl -s -m 5 "$OC/api/session" 2>/dev/null | grep -oE 'ses_[A-Za-z0-9]+' | head -1
}

agent_touch(){
  local sid; sid=$(get_sid)
  if [ -z "$sid" ]; then log "agent_touch: NO SESSION"; return 1; fi
  local id="msg_ka_$(date +%s%N)"
  local body="{\"id\":\"$id\",\"prompt\":{\"text\":\"echo keepalive\"}}"
  local code
  code=$(curl -s -m 25 -o /tmp/kar.$$ -w '%{http_code}' -X POST \
    "$OC/api/session/$sid/prompt" -H 'Content-Type: application/json' -d "$body" 2>/dev/null)
  rm -f /tmp/kar.$$
  log "agent_touch sid=${sid:0:14} http=$code"
}

term_touch(){ uptime >/dev/null 2>&1; : ; }

last_term=0; last_oc=0
while true; do
  now=$(date +%s)
  if [ $((now - last_term)) -ge "$TERM_INTERVAL" ]; then term_touch; last_term=$now; fi
  if [ $((now - last_oc))   -ge "$OC_INTERVAL" ];  then agent_touch; last_oc=$now; fi
  sleep "$INTERVAL"
done
