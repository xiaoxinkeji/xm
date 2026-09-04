#!/usr/bin/env bash
# examples/openai-curl.sh — OpenAI 兼容接口 curl 示例
# 任何 OpenAI 客户端（ChatBox/NextChat/Cherry Studio/openai SDK）同样填这三项即可
BASE="${BASE:-https://your-domain.com/v1}"       # 换成你的域名
KEY="${KEY:-your-gateway-token}"                 # 换成网关 .token 里的值
MODEL="${MODEL:-glm-5.3-flash}"

echo "== 模型列表 =="
curl -s "$BASE/models" -H "Authorization: Bearer $KEY"
echo; echo "== 对话（非流式）=="
curl -s "$BASE/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":1024,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
echo; echo "== 对话（流式）=="
curl -sN "$BASE/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"max_tokens\":1024,\"messages\":[{\"role\":\"user\",\"content\":\"数到5\"}]}"
