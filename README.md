# monkeycode-vm-kit

> 把 MonkeyCode（及类似平台）的"浏览器共享终端"变成 **7×24 在线、可编程、带公网 OpenAI API 的服务器**。
>
> 一套经过实战验证（连续多天稳定运行）的完整方案：远程控制通道 + 防休眠 + 公网隧道 + OpenAI 兼容网关。

## 它解决什么问题

MonkeyCode 共享终端是一个 Firecracker 微 VM（浏览器里用），原生限制很多：

| 限制 | 本方案的对策 |
|------|------------|
| VM 按 **coding agent 活跃度**判定休眠（阈值约 11 分钟），人不在就冻结 | `ka2.sh` 每 60s 发一次最小 agent prompt，实测彻底阻止休眠 |
| 浏览器一关就失联，密码作废 | `mc-daemon.js` 在操作机上常驻 WS，密码热读取、失效自动重连 |
| 无法从外部访问任何端口（新端口不被平台 frp 转发） | cloudflared 双隧道：命名隧道（固定域名）+ quick tunnel（随机域名备用） |
| 内置 LLM 是 Anthropic 协议、且只接受 VM 出口 IP | `ocproxy.js` 网关：OpenAI 协议进出 + Bearer 鉴权，外部可当标准 OpenAI API 用 |
| coding agent API（opencode）完全无认证，不敢暴露 | 网关统一 Bearer 鉴权，未带 token 一律 401 |

## 架构

```
┌────────────── 你的操作机（任意 Node≥22 主机）──────────────┐
│                                                             │
│  mc-daemon.js ◄── 文件队列: mcq/in/*.sh → mcq/out/*.out     │
│      │  (wss 长连 + 密码热读取 + 自动重连 + PTY 保活)        │
└──────┼──────────────────────────────────────────────────────┘
       │ wss://monkeycode-ai.com/api/v1/.../terminals/join
       ▼
┌────────────── 共享终端 VM（Firecracker 微 VM）──────────────┐
│                                                             │
│  ka2.sh ──60s──► opencode(:4096) ──► 平台 LLM 代理           │
│   (防休眠)         (coding agent, 无认证)                    │
│                        ▲                                    │
│  ocproxy.js(:8409) ────┤ 反向代理 /api/*                     │
│   ├─ Bearer 鉴权                                           │
│   ├─ /v1/models, /v1/chat/completions (OpenAI↔Anthropic)    │
│   └─ watch-upstream.sh (上游哨兵, 5min/次)                   │
│                        ▲                                    │
│  cloudflared ─────────┘                                     │
│   ├─ 命名隧道: token 启动, 固定域名(控制台配 Public Hostname) │
│   └─ quick tunnel: 随机域名备用(本地管理模式)                 │
└──────┬──────────────────────────────────────────────────────┘
       │ https
       ▼
   任何 OpenAI 客户端 / curl / 你的程序
   Base URL: https://your-domain.com/v1
   API Key:  <网关token>          Model: glm-5.3-flash
```

## 快速开始

### 第 0 步：准备

- 平台侧开一个共享终端，记下 URL 里的 `terminal_id` 和连接密码
- 操作机装有 Node.js ≥ 22（需要全局 `WebSocket`）

### 第 1 步：启动控制通道（操作机）

```bash
git clone https://github.com/<you>/monkeycode-vm-kit && cd monkeycode-vm-kit/client

export TERMINAL_ID=<终端ID>            # 共享终端 URL 里 id= 参数
echo <连接密码> > mcq/password
setsid nohup node mc-daemon.js > /dev/null 2>&1 &

./mcq status                            # 看到 "connected": true 即成功
./mcq run "uname -a"                    # 远程执行第一条命令
```

> 密码与"发起共享的浏览器会话"绑定：**浏览器不关可长期复用**；关掉后密码作废，
> 新密码写进 `mcq/password` 即自动重连（daemon 持续重试，无需重启）。

### 第 2 步：部署 VM 内组件（网关 + 保活 + 哨兵）

先把源码推到 VM（利用第 1 步的通道）：

```bash
# 源码本体（放 /opt/ocproxy/ocproxy.js）
{ echo '#!/bin/bash'; echo 'mkdir -p /opt/ocproxy'; echo "cat > /opt/ocproxy/ocproxy.js <<'XEOF'"; cat ../vm/gateway/ocproxy.js; echo XEOF; } > mcq/in/put-ocproxy.sh

# 再跑部署模板（替换占位符后投递）
LLM_API_KEY=<平台LLM的key>   # 在 VM 上: cat /root/.local/share/opencode/auth.json
GW_TOKEN=$(openssl rand -base64 24)
sed -e "s|__LLM_KEY__|$LLM_API_KEY|" -e "s|__GW_TOKEN__|$GW_TOKEN|" \
    ../deploy/deploy-vm.template.sh > mcq/in/deploy-vm.sh
./mcq cat deploy-vm
```

验证：

```bash
./mcq run 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8409/v1/models -H "Authorization: Bearer '"$GW_TOKEN"'"'
# 200 = 网关 OK；401 = token 不对
tail -3 /opt/keepalive/ka2.log        # 应看到 agent_touch ... http=200
```

### 第 3 步：公网入口（VM 内装 cloudflared）

```bash
# 方式 A：命名隧道（固定域名，推荐）
#   Cloudflare Zero Trust → Networks → Tunnels → 创建隧道 → 复制 token
./mcq run 'echo <TUNNEL_TOKEN> > /etc/cloudflared/token'   # token 写入 VM
./mcq put ../vm/tunnel/start.sh
#   然后在 Cloudflare 控制台配 Public Hostname:
#   your-domain.com → HTTP://localhost:8409   （必须控制台配，token 模式忽略本地 ingress！）

# 方式 B：quick tunnel（免费随机域名，零配置备用）
./mcq put ../vm/tunnel/quick.sh
./mcq run 'grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /opt/cloudflared/quick.log | tail -1'
```

### 第 4 步：当 OpenAI API 用

```bash
curl https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer $GW_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

ChatBox / NextChat / Cherry Studio / openai SDK 填 `Base URL + API Key + Model` 三项即可，
网关对路径和模型名都做了宽容兼容（详见 [docs/troubleshooting.md](docs/troubleshooting.md)）。

## 组件一览

| 文件 | 运行位置 | 作用 |
|------|---------|------|
| `client/mc-daemon.js` | 操作机 | WS 常驻守护：文件队列远程执行、密码热读取重连、PTY 保活 |
| `client/mcq` | 操作机 | 队列命令行封装（status / run / put / cat） |
| `vm/gateway/ocproxy.js` | VM | OpenAI 兼容网关：Bearer 鉴权 + OpenAI↔Anthropic 转换（流式+非流式）+ 反代 |
| `vm/gateway/watch-upstream.sh` | VM | 上游哨兵：5 分钟探测一次平台 LLM，状态突变记日志 |
| `vm/keepalive/ka2.sh` | VM | 60s agent 保活主循环（防休眠核心） |
| `vm/keepalive/ka2-guard.sh` | VM | 保活看门狗 |
| `vm/tunnel/start.sh` | VM | 命名隧道（固定域名） |
| `vm/tunnel/quick.sh` | VM | quick tunnel（随机域名备用） |
| `deploy/deploy-vm.template.sh` | 投递执行 | VM 组件一键部署模板（占位符替换） |

## 文档

- [docs/architecture.md](docs/architecture.md) — 架构与数据流详解
- [docs/hibernate.md](docs/hibernate.md) — VM 休眠机制研究（为什么是 60s agent prompt）
- [docs/protocol.md](docs/protocol.md) — 平台协议细节：WS 消息格式、文件队列协议、opencode API、LLM 代理
- [docs/troubleshooting.md](docs/troubleshooting.md) — 排障实录：quick tunnel 404、模型热切换、路径兼容、PTY 吞字等

## 已知限制与注意

- **平台模型会热切换**：上游曾从 `qwen3.5-plus` 一夜切到 `glm-5.3-flash`（旧模型名 403）。
  网关用 `MODEL` + `MODEL_ALIASES` 环境变量收敛模型名，客户端无感知；哨兵日志能看到切换时间点。
- **LLM key 与 VM 出口 IP 绑定**：平台代理只接受 VM 自身 IP 的请求，key 泄漏到外部也用不了——
  但网关 token 才是真正的门禁，务必保管好 `.token`。
- **推理模型**：GLM 系列先思考后回答，`max_tokens` 建议 ≥ 512，否则正文为空（`finish_reason: length`）。
- 60s 保活 ≈ 1440 次/天 LLM 调用（每次仅数 token）；介意可调 `OC_INTERVAL`（120/300s 仍安全，
  15min 不行——阈值约 11 分钟）。
- 本项目用于学习研究自动化运维与协议网关技术，请遵守平台服务条款，敏感信息（token/key/密码）均已参数化，**切勿硬编码提交**。

## License

[MIT](LICENSE)
