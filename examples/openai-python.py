# examples/openai-python.py — openai SDK 接入示例
# pip install openai
from openai import OpenAI

client = OpenAI(
    base_url="https://your-domain.com/v1",   # 换成你的域名
    api_key="your-gateway-token",            # 换成网关 .token 里的值
)

# 非流式
r = client.chat.completions.create(
    model="glm-5.3-flash",
    max_tokens=1024,          # 推理模型，建议 >=512，太小会被思考过程占满
    messages=[{"role": "user", "content": "用一句话介绍你自己"}],
)
print(r.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="glm-5.3-flash",
    max_tokens=1024,
    stream=True,
    messages=[{"role": "user", "content": "数到5"}],
)
for chunk in stream:
    delta = chunk.choices[0].delta
    if delta.content:
        print(delta.content, end="", flush=True)
print()
