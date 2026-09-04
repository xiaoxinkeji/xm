# 平台协议细节

## 1. 共享终端 WS 协议

**接入**：
```
wss://monkeycode-ai.com/api/v1/users/hosts/vms/terminals/join?terminal_id=<uuid>&password=<pw>
```

**密码生命周期**：与发起共享的浏览器会话绑定——浏览器不关可长期复用；关闭即作废，
服务端返回错误消息 `验证密码失败` 并断连。

**消息格式**（JSON，双向）：

| 方向 | type | data | 说明 |
|------|------|------|------|
| C→S | `data` | base64(终端字节) | 键盘输入（含 `\r`、`\x03` 等控制字符） |
| S→C | `data` | base64(终端字节) | PTY 输出（含 ANSI 转义序列，需 stripAnsi 清洗） |
| C→S | `ping` | - | 保 WS 活（**不产生 PTY 流量，防不了空闲回收**） |
| S→C | `error` | 文本 | 服务端错误（如密码验证失败） |

**可靠性结论**：
- 直接发送长命令文本会被 PTY 吞字符（行编辑缓冲限制）
- 唯一可靠投递方式：**base64 后分片限速发送**，见 architecture.md 的队列协议
- 输出侧无流控问题，单 job 输出 18KB+ 实测正常

## 2. opencode API（VM 内 127.0.0.1:4096）

coding agent 的本地 HTTP API，**无认证**（所以绝不能直接暴露公网）。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/session` | GET | 会话列表（含 tokens 统计、时间戳） |
| `/api/session/{id}/message` | GET | 消息历史 |
| `/api/session/{id}/prompt` | POST | 投递 prompt，body: `{"id":"msg_x","prompt":{"text":"..."}}` |
| `/api/model` | GET | 模型目录（含 disabled_providers） |

- prompt 被接受返回 `{"data":{"admittedSeq":N,...}}`——**这只代表 API 接受**，
  LLM 是否成功要看 session 的消息产出（上游故障时 prompt 照样 200）
- 平台对配置做的热变更（如换默认模型）会在 `/root/.config/opencode/opencode.json`
  和 `/root/.local/share/opencode/auth.json` 上体现，opencode 进程随之重启

## 3. 平台 LLM 代理（Anthropic 协议）

```
POST https://proxy.monkeycode-ai.com/v1/messages
x-api-key: <key>                  # 也接受 Authorization: Bearer
anthropic-version: 2023-06-01
content-type: application/json

{"model":"<provider/model>","max_tokens":N,"messages":[...],"system":"..."}
```

- key 位置：VM 上 `/root/.local/share/opencode/auth.json`（或 opencode 进程环境变量 `OPENAI_API_KEY`）
- **出口 IP 绑定**：只接受 VM 自身 IP 的请求，外部 IP 直连一律 403（key 泄漏也无用）
- **`/v1/chat/completions` 不存在**（404）——平台只有 Anthropic 协议，OpenAI 格式需自行转换（本项目 ocproxy 的由来）
- **模型名单会热切换**：曾从 `monkeycode-basic/qwen3.5-plus` 一夜切到 `monkeycode-basic/glm-5.3-flash`，
  旧模型名立即 403。可用模型以 VM 上 opencode.json 里声明的为准

## 4. 响应内容块类型（Anthropic 风格）

```
content: [
  { "type": "thinking", "thinking": "..." },   // 推理过程 → OpenAI 侧映射为 reasoning_content
  { "type": "text",     "text":     "..." }    // 正文     → OpenAI 侧映射为 content
]
```

流式事件流：

```
event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}

data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}

event: message_stop
```

## 5. 环境特征（Firecracker 微 VM）

- 无 systemd / crontab / 常规 init——**所有常驻进程用 setsid + nohup 挂**，开机自启用 `/etc/profile.d/` 钩子
- 快照冻结/恢复不保留进程内存状态，组件必须能被看门狗/profile 钩子重拉
- `pgrep -f` 会匹配到执行中 shell 自身的命令行（`pkill -f xxx` 等于自杀），
  匹配用 `ps aux | grep "[x]xx"` 的方括号技巧
