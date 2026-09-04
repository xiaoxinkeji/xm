#!/usr/bin/env bash
# watch-upstream.sh — 平台 LLM 上游哨兵
# 每 5 分钟向平台 LLM 代理发一个最小请求，状态码变化时记录到日志。
# 用途：平台更换模型/密钥/故障时能第一时间从日志发现（403/5xx 突变）。
#
# 环境变量：
#   LLM_API_KEY   平台 LLM key（必填）
#   LLM_BASE_URL  平台代理地址（默认 MonkeyCode）
#   MODEL         探测用的模型名
set +e
LLM_BASE_URL="${LLM_BASE_URL:-https://proxy.monkeycode-ai.com/v1}"
MODEL="${MODEL:-monkeycode-basic/glm-5.3-flash}"
LOG="${LOG:-/opt/ocproxy/upstream-watch.log}"

if [ -z "$LLM_API_KEY" ]; then echo "缺少 LLM_API_KEY" >&2; exit 1; fi

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
