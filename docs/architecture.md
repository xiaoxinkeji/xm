# 架构与数据流

## 总体分层

```
[外部客户端] ──https──► [Cloudflare 边缘] ──tunnel──► [VM: ocproxy:8409] ──► [opencode:4096 / 平台LLM]
[操作机 daemon] ──wss──► [平台终端网关] ──► [VM PTY]
```

整个系统有**两条进入 VM 的通道**，职责不同：

| 通道 | 协议 | 用途 | 谁在用 |
|------|------|------|--------|
| 控制通道 | WSS（终端 join 协议） | 运维：投递脚本、看状态、部署组件 | mc-daemon（操作机） |
| 数据通道 | HTTPS（cloudflared 隧道） | 业务：OpenAI API、opencode API | 外部客户端 |

## 控制通道：文件队列协议

mc-daemon 与 VM 的交互完全走"共享终端"的 PTY，但**不直接发命令文本**——PTY 对长命令/特殊字符不可靠（会吞字）。协议设计：

```
操作机                                VM (PTY)
  │                                     │
  │ 1. 投递: mcq/in/<job>.sh            │
  │    (daemon 800ms 轮询, 按名排序)     │
  │                                     │
  │ 2. daemon 读脚本 → base64 →         │
  │    分片限速发送:                     │
  │    echo '<b64>' | base64 -d \r      │  ← 每片 180 字符, 25ms 间隔
  │    bash /tmp/mcq.sh 2>&1 \r         │  ← 每片 16 字符, 30ms 间隔
  │                                     │
  │ 3. 脚本末尾自动追加:                  │
  │    echo __MCQ_DONE_<job>_<ts>__     │
  │                                     │
  │ 4. daemon 在输出流里找 marker →      │
  │    回写 mcq/out/<job>.out           │
  │    (150s 超时保护)                   │
```

设计要点：

- **base64 投递**：规避 PTY 吞字/转义/行编辑问题，是唯一可靠的方式
- **分片限速**：`sendThrottled()` 每次发一小块、间隔几十 ms，模拟人工输入速度
- **marker 完成检测**：不猜超时，脚本自己报告完成
- **幂等**：投递文件被消费即删除，daemon 重启不重复执行

## 保活子系统

平台按 **coding agent 活跃度**（不是终端流量）判定 VM 休眠，研究结论见 [hibernate.md](hibernate.md)。三层防线：

1. **ka2.sh（主防线，VM 内）**：每 60s 向 opencode 当前 session POST 一个最小 prompt。
   这是"平台级"活跃信号——平台统计的是 agent→LLM 的调用，不是浏览器 WS。
2. **ka2-guard.sh（看门狗）**：30s 检查一次主循环进程，死了拉起。
3. **profile.d 钩子**：VM 真正重启（非冻结恢复）后，任何 shell 登录都会补拉看门狗。

另有两道**恢复机制**兜底（冻结发生后）：

- sleepwatch：检测到 RESUMED 事件时自动重拉组件（快照恢复后进程会丢）
- 操作机 vm-monitor：外部探测失联时，等用户打开共享会话后由 daemon 自动补部署队列

## 数据通道：网关与隧道

### ocproxy.js（VM 内，:8409）

单进程四职责，请求分流：

```
请求 → 路径规范化(去重复斜杠) → OPTIONS? → 204+CORS
                              → 鉴权(Bearer/query token)? → 401
                              → /models | /v1/models (GET)  → 模型列表(静态生成)
                              → /chat/completions | /v1/... (POST)
                                   → OpenAI 请求体 ─翻译→ Anthropic /v1/messages
                                   ← Anthropic 响应 ─翻译→ OpenAI 格式
                              → 其余 → http 反代到 127.0.0.1:4096 (opencode)
```

协议翻译要点：

- **请求向**：system/developer 消息抽出合并为顶层 `system`；连续同角色消息合并（Anthropic 要求严格交替）；`max_tokens` 上限 32000；`stop` → `stop_sequences`
- **响应向（非流式）**：content 块按类型拼接（text→content、thinking→reasoning_content）；`stop_reason: max_tokens` → `finish_reason: length`；usage 字段名映射
- **响应向（流式）**：逐行解析上游 SSE 的 `data:` 行，`content_block_delta` 按 delta 类型分流（text_delta→delta.content、thinking_delta→delta.reasoning_content），`message_stop` 补 `data: [DONE]`
- **易错点**：`stream: true` 必须透传给上游，否则上游非流式返回、没有 SSE 事件可转发（客户端只收到一个空 chunk）

### 隧道

| | 命名隧道 | quick tunnel |
|--|---------|--------------|
| 启动 | `tunnel run --token-file <token>` | `tunnel --url http://...` |
| 域名 | 自己的固定域名 | 随机 *.trycloudflare.com |
| 管理模式 | **远程管理**（Cloudflare 控制台） | **本地管理**（读 config.yml） |
| ingress 配置位置 | 控制台 Public Hostname | 本地 config.yml（**别写**，见 troubleshooting） |
| 定位 | 生产主入口 | 零配置备用 |

关键认知：**token 启动的隧道忽略本地 config.yml**；反之 quick tunnel 会读它。
两者混用时，config.yml 里只放 `protocol: http2`，什么都不加。

## 状态观测

- `mcq/status`：daemon 连接状态 JSON（connected/busy/failCount）
- `mcq/daemon.log`：心跳 + job 流水（每分钟一条 heartbeat）
- `/opt/keepalive/ka2.log`：保活心跳（每分钟 agent_touch http=200）
- `/opt/ocproxy/upstream-watch.log`：上游哨兵（状态码突变记录）
- `/opt/cloudflared/*.log`：隧道注册与请求日志
