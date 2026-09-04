#!/usr/bin/env bash
# deploy-vm.template.sh — VM 内组件一键部署模板
#
# 使用方式：本文件不直接执行。在操作机上先替换占位符再经 mc-daemon 队列投递：
#   sed -e "s|__LLM_KEY__|$LLM_API_KEY|" \
#       -e "s|__GW_TOKEN__|$GW_TOKEN|" \
#       deploy/deploy-vm.template.sh > mcq/in/deploy-vm.sh
#
# 幂等：重复执行安全（先清旧进程再部署）。
set +e

LLM_KEY="__LLM_KEY__"          # 平台 LLM key（部署时替换）
GW_TOKEN="__GW_TOKEN__"        # 网关 Bearer token（部署时替换）
GW_PORT="${GW_PORT:-8409}"
OC_PORT="${OC_PORT:-4096}"

ts(){ date '+%m-%d %H:%M:%S'; }
log(){ echo "[$(ts)] $*"; }

log "===== 部署开始 ====="

# ---------- 1. OpenAI 兼容网关 ----------
mkdir -p /opt/ocproxy
if [ ! -f /opt/ocproxy/ocproxy.js ]; then
  log "缺少 /opt/ocproxy/ocproxy.js —— 请先经队列投递源码"
else
  echo "$GW_TOKEN" > /opt/ocproxy/.token
  chmod 600 /opt/ocproxy/.token
  PID=$(ps aux | grep "[o]cproxy.js" | awk '{print $2}')
  [ -n "$PID" ] && kill $PID
  sleep 1
  LLM_API_KEY="$LLM_KEY" nohup node /opt/ocproxy/ocproxy.js >> /opt/ocproxy/ocproxy.log 2>&1 &
  sleep 2
  log "ocproxy: $(ps aux | grep "[o]cproxy.js" | awk '{print "pid="$2}' | head -1)"
fi

# ---------- 2. 上游哨兵 ----------
cat > /opt/ocproxy/watch-upstream.sh <<'W'
#!/usr/bin/env bash
set +e
LLM_BASE_URL="${LLM_BASE_URL:-https://proxy.monkeycode-ai.com/v1}"
MODEL="${MODEL:-monkeycode-basic/glm-5.3-flash}"
LOG="${LOG:-/opt/ocproxy/upstream-watch.log}"
[ -z "$LLM_API_KEY" ] && exit 1
LAST="init"
while true; do
  code=$(curl -s -m 15 -o /dev/null -w "%{http_code}" "$LLM_BASE_URL/messages" \
    -H "x-api-key: $LLM_API_KEY" \
    -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}")
  if [ "$code" != "$LAST" ]; then
    echo "[$(date '+%m-%d %H:%M:%S')] upstream status: $LAST -> $code" >> "$LOG"
    LAST=$code
  fi
  sleep 300
done
W
chmod +x /opt/ocproxy/watch-upstream.sh
OLD=$(ps aux | grep "[w]atch-upstream" | awk '{print $2}')
[ -n "$OLD" ] && kill $OLD
LLM_API_KEY="$LLM_KEY" setsid nohup /opt/ocproxy/watch-upstream.sh >/dev/null 2>&1 &
log "watch-upstream: started"

# ---------- 3. 60s 保活（含看门狗 + profile.d 钩子）----------
mkdir -p /opt/keepalive
cat > /opt/keepalive/ka2.sh <<'KA'
#!/usr/bin/env bash
set +e
LOG="${LOG:-/opt/keepalive/ka2.log}"
OC="${OC:-http://127.0.0.1:4096}"
INTERVAL=60; OC_INTERVAL=60; TERM_INTERVAL=60
ts(){ date '+%m-%d %H:%M:%S'; }
log(){ echo "[$(ts)] $*" >> "$LOG"; }
get_sid(){ curl -s -m 5 "$OC/api/session" 2>/dev/null | grep -oE 'ses_[A-Za-z0-9]+' | head -1; }
agent_touch(){
  local sid; sid=$(get_sid)
  if [ -z "$sid" ]; then log "agent_touch: NO SESSION"; return 1; fi
  local body="{\"id\":\"msg_ka_$(date +%s%N)\",\"prompt\":{\"text\":\"echo keepalive\"}}"
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
  [ $((now-last_term)) -ge $TERM_INTERVAL ] && { term_touch; last_term=$now; }
  [ $((now-last_oc))   -ge $OC_INTERVAL ]  && { agent_touch; last_oc=$now; }
  sleep "$INTERVAL"
done
KA
chmod +x /opt/keepalive/ka2.sh

cat > /opt/keepalive/ka2-guard.sh <<'G'
#!/usr/bin/env bash
while true; do
  if ! pgrep -f "/opt/keepalive/ka2.sh" >/dev/null; then
    setsid bash /opt/keepalive/ka2.sh >> /opt/keepalive/ka2.stdout 2>&1 </dev/null &
  fi
  sleep 30
done
G
chmod +x /opt/keepalive/ka2-guard.sh

cat > /etc/profile.d/ka2.sh <<'P'
#!/usr/bin/env bash
pgrep -f "/opt/keepalive/ka2-guard.sh" >/dev/null || \
  setsid bash /opt/keepalive/ka2-guard.sh >/dev/null 2>&1 </dev/null &
P
chmod +x /etc/profile.d/ka2.sh

OLD=$(pgrep -f "/opt/keepalive/ka2.sh"; pgrep -f "/opt/keepalive/ka2-guard.sh")
[ -n "$OLD" ] && kill $OLD 2>/dev/null
setsid bash /opt/keepalive/ka2-guard.sh >/dev/null 2>&1 &
sleep 2
log "keepalive: $(pgrep -f /opt/keepalive/ka2.sh | tr '\n' ' ')"

# ---------- 4. 校验 ----------
log "gateway:  $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$GW_PORT/v1/models -H "Authorization: Bearer $GW_TOKEN") (200=OK, 401=token错)"
log "keepalive: $(tail -1 /opt/keepalive/ka2.log 2>/dev/null)"
log "===== 部署完成 ====="
