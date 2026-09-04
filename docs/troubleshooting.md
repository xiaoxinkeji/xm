# 排障实录

实战中踩过的坑与根因，按"现象 → 误判 → 真因 → 修复"记录。

## 1. quick tunnel 已注册却全部 404

**现象**：quick tunnel 日志显示注册成功，但随机域名（多个）一律 404，VM 内外、甚至
`--resolve` 直连边缘 IP 都 404。

**误判过程**：先怀疑边缘传播延迟（官方文档确实说 "may take some time"），等了半小时；
又怀疑账号问题。

**真因**：**自己埋的 bug**——为了给命名隧道配固定域名，在 `/etc/cloudflared/config.yml`
里写了 ingress（含兜底 `http_status:404`）。quick tunnel 是**本地管理模式，会读这个文件**；
它的随机域名匹配不上 ingress 里的主机名，全部落入 404 兜底规则。
（佐证：cloudflared metrics 里 `request_errors=0`——404 是"合法响应"而非错误。）

**修复**：config.yml 回退为仅 `protocol: http2`，重启 quick tunnel 立即恢复。

**教训**：
- 命名隧道（token 启动）= 远程管理，ingress 必须在 Cloudflare 控制台配（Public Hostname）
- quick tunnel = 本地管理，会读 config.yml
- 两种模式共存时，config.yml 保持"空配置"

## 2. 固定域名 404（域名有证书但无路由）

**现象**：自有域名访问 404；`curl --resolve` 强制指向隧道边缘 IP 仍 404；
证书 CN 显示域名存在。

**真因**：Cloudflare 边缘没有"该主机名 → 该隧道"的路由——只建了 DNS 记录，
没在 Zero Trust 里配 Public Hostname。

**修复**：Zero Trust → Networks → Tunnels → 选中隧道 → Public Hostname：
`your-domain.com → HTTP://localhost:8409`。

## 3. 上游 LLM 突然全 403（模型热切换）

**现象**：所有 chat 请求 `upstream: Forbidden`；新旧模型名、各种请求头组合（UA/x-stainless/Bearer）全 403；
连 VM 内 opencode 自己也不产出消息（session.updated 停滞）。

**排查路径**：
1. 从沙箱直连上游 403 → 疑 key 失效 → 但 auth.json/account.json/进程环境里 key 未变
2. VM 内直连也 403 → 排除 IP 因素？不——当时用的还是旧模型名
3. 发现平台 21:04 刷新了 VM 配置：**默认模型 qwen3.5-plus → glm-5.3-flash**
4. 换新模型名（VM 出口）→ 200；同 key 外部 IP → 仍 403

**结论（双因素）**：
- 上游**按模型名**放行：旧模型已下线，请求旧名一律 403
- 上游**按出口 IP**放行：只有 VM 自身 IP 可调（所以外部拿走 key 也没用）

**修复**：网关 `MODEL` 切到新模型名，`MODEL_ALIASES` 把旧名映射过来（客户端零改动）；
加 `watch-upstream.sh` 哨兵，下次切换能从日志第一时间发现。

## 4. 外部客户端"探测不到模型"

**现象**：用户在 ChatBox 类客户端里"获取模型列表"失败，手填模型名也不通。

**真因（三合一）**：
1. `/v1/models` 只在带 `/v1` 前缀时存在——Base URL 填 `https://domain`（不带 /v1）的客户端
   请求 `/models` 落到兜底反代，返回 **HTML 页面**（opencode 前端），JSON 解析失败
2. Base URL 带尾斜杠 `https://domain/v1/` → 客户端拼出 `/v1//models` 双斜杠 → 同样落兜底
3. 模型列表里没有 `glm-5.3-flash` 短名（只有长名），客户端下拉里找不到

**修复**（网关侧全部兼容，客户端怎么填都对）：
- 路由同时接受 `/models` 与 `/v1/models`、`/chat/completions` 与 `/v1/chat/completions`
- 请求入口做路径规范化：`pathname.replace(/\/{2,}/g, '/')`
- 模型列表返回长名 + 短名 + 历史别名

## 5. 流式响应只有开头一个 chunk

**现象**：`stream:true` 客户端只收到 role chunk，无内容增量。

**真因**：忘了把 `stream:true` 透传给上游 Anthropic 请求——上游非流式返回完整 JSON，
网关的 SSE 解析循环没有事件可发。

**修复**：`if (o.stream) anth.stream = true;` 一行。

## 6. WS 投递脚本偶发不执行

**现象**：投递 `in/*.b64` 文件，daemon 心跳正常但 job 永不执行。

**真因**：队列只认 `.sh` 明文（daemon 自己做 base64），投 `.b64` 是格式错误。

**通用教训**：脚本经 WS 传送时**长度敏感**——实测 ~1.9KB 的 heredoc 脚本曾 3 秒"完成"
且无输出（疑似截断）；拆到 ≤1.2KB 稳定。长部署拆成多个小 job，或先投"写文件"再投"执行"。

## 7. `pkill -f` 自杀

**现象**：远程执行 `pkill -f cloudflared` 后，执行脚本的 shell 自己也死了，job 无输出。

**真因**：`pkill -f` 按完整命令行匹配，执行中的 shell 命令行里就含有该模式。

**修复**：用 `ps aux | grep "[c]loudflared"`（方括号技巧避免匹配 grep 自身）取 pid 再 kill。

## 8. 部署后自测全空（http=000）

**现象**：部署脚本跑完，脚本里的自测 curl 全部 000。

**真因**：`sleep 2` 太短——服务进程还没完成 listen，测试就跑了。不是部署失败。

**修复**：部署后独立跑自测，或 sleep ≥3s 并加重试。

## 9. GLM 回复正文为空

**现象**：chat 200 但 `content: ""`，`finish_reason: "length"`。

**真因**：GLM 是推理模型，max_tokens 全被 thinking 吃掉。

**修复**：客户端 `max_tokens ≥ 512`；网关侧已把 thinking 映射为 `reasoning_content` 透传。
