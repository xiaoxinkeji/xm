#!/usr/bin/env node
// ocproxy — OpenAI 兼容网关（Bearer 鉴权 + OpenAI ↔ Anthropic 协议转换 + 反向代理）
//
// 运行位置：VM 内。Node >= 18（使用全局 fetch）。
//
// 职责：
//   1. Bearer token 鉴权（保护无认证的上游服务，如 opencode server）
//   2. /v1/models、/v1/chat/completions（流式+非流式）：OpenAI 格式进出，
//      内部翻译成 Anthropic Messages 协议调用平台 LLM 代理
//   3. 其余 /api/* 路径原样反向代理到上游服务
//   4. CORS 全开 + OPTIONS 预检（网页客户端可用）
//   5. 路径宽容：/models 与 /v1/models、/chat/completions 与 /v1/chat/completions、
//      重复斜杠均可（兼容各种客户端的 Base URL 填法）
//
// 环境变量：
//   PORT           监听端口（默认 8409）
//   UP_HOST        被代理上游 host（默认 127.0.0.1）
//   UP_PORT        被代理上游 port（默认 4096）
//   LLM_BASE_URL   平台 LLM 代理（Anthropic 协议，默认 MonkeyCode 代理）
//   LLM_API_KEY    平台 LLM key（必填，走 x-api-key）
//   MODEL          默认模型全名（注意：平台会不定期更换可用模型）
//   MODEL_ALIASES  逗号分隔的模型别名（均映射到 MODEL，如 "glm-5.3-flash,qwen3.5-plus"）
//   TOKEN_FILE     网关 Bearer token 文件（默认脚本同目录 .token）
//
// 部署：
//   echo <你的网关密钥> > .token
//   LLM_API_KEY=<平台key> nohup node ocproxy.js >> ocproxy.log 2>&1 &

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT     = process.env.PORT || 8409;
const UP_HOST  = process.env.UP_HOST || '127.0.0.1';
const UP_PORT  = parseInt(process.env.UP_PORT || '4096', 10);
const LLM_BASE = process.env.LLM_BASE_URL || 'https://proxy.monkeycode-ai.com/v1';
const LLM_KEY  = process.env.LLM_API_KEY || '';
const DEF_MODEL = process.env.MODEL || 'monkeycode-basic/glm-5.3-flash';
const ALIASES = {};
for (const a of (process.env.MODEL_ALIASES || 'glm-5.3-flash,qwen3.5-plus,default').split(',')) {
  if (a.trim()) ALIASES[a.trim()] = DEF_MODEL;
}
if (!LLM_KEY) { console.error('缺少 LLM_API_KEY 环境变量'); process.exit(1); }

const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, '.token');
function token() { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; } }
function authed(req, url) {
  const t = token(); if (!t) return false;
  const h = req.headers['authorization'] || '';
  return h === 'Bearer ' + t || url.searchParams.get('token') === t;
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

// ---- OpenAI → Anthropic 请求翻译（含 function calling 双向转换）----
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p && (p.type === 'text' || typeof p === 'string')).map(p => typeof p === 'string' ? p : (p.text || '')).join('\n');
  return '';
}
function toAnthropic(o) {
  const model = ALIASES[o.model] || DEF_MODEL;
  const msgs = []; const sys = [];
  const push = (role, block) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(block);
    else msgs.push({ role: role, content: [block] });
  };
  for (const m of (o.messages || [])) {
    if (m.role === 'system' || m.role === 'developer') { const t = textOf(m.content); if (t) sys.push(t); continue; }
    if (m.role === 'tool') { // OpenAI 工具结果 → Anthropic user/tool_result（连续 tool 消息自动合并进同一 user turn）
      const blk = { type: 'tool_result', tool_use_id: m.tool_call_id || m.tool_use_id || '' };
      const c = m.content;
      if (typeof c === 'string') blk.content = c;
      else if (Array.isArray(c)) blk.content = c.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
      else if (c != null && typeof c === 'object') blk.content = JSON.stringify(c);
      else blk.content = '';
      push('user', blk);
      continue;
    }
    if (m.role === 'assistant') { // OpenAI tool_calls → Anthropic tool_use blocks
      const t = textOf(m.content);
      if (t) push('assistant', { type: 'text', text: t });
      for (const tc of (m.tool_calls || [])) {
        if (!tc || !tc.function) continue;
        let input = {}; try { input = JSON.parse(tc.function.arguments || '{}'); if (input == null || typeof input !== 'object') input = {}; } catch (e) { input = {}; }
        push('assistant', { type: 'tool_use', id: tc.id || ('call_' + Date.now() + Math.random().toString(36).slice(2, 8)), name: tc.function.name, input: input });
      }
      continue;
    }
    const t = textOf(m.content);
    if (t) push('user', { type: 'text', text: t });
  }
  for (const m of msgs) { // 全 text 块的消息压回字符串
    if (m.content.every(b => b.type === 'text')) m.content = m.content.map(b => b.text).join('\n');
  }
  if (!msgs.length) msgs.push({ role: 'user', content: ' ' });
  const b = { model: model, messages: msgs, max_tokens: Math.min(o.max_tokens || 4096, 32000) };
  if (sys.length) b.system = sys.join('\n');
  if (typeof o.temperature === 'number') b.temperature = o.temperature;
  if (typeof o.top_p === 'number') b.top_p = o.top_p;
  if (o.stop) b.stop_sequences = Array.isArray(o.stop) ? o.stop : [o.stop];
  // tools：OpenAI function 定义 → Anthropic tool 定义
  const tools = (o.tools || []).map(t => {
    if (t && t.type === 'function' && t.function) return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } };
    if (t && t.name) return { name: t.name, description: t.description || '', input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} } };
    return null;
  }).filter(Boolean);
  if (tools.length && o.tool_choice !== 'none') {
    b.tools = tools;
    const tc = o.tool_choice;
    // 部分平台代理会忽略 tool_choice 强制(any/tool)，除原生字段外再用 system 指令兜底实现 OpenAI 语义
    let force = '';
    if (tc === 'required') { force = '[SYSTEM RULE] tool_choice=required: this response MUST call at least one of the available tools. Do not answer with text only.'; b.tool_choice = { type: 'any' }; }
    else if (tc && typeof tc === 'object' && tc.type === 'function' && tc.function && tc.function.name) { force = '[SYSTEM RULE] tool_choice is forced: this response MUST call the tool "' + tc.function.name + '". Do not answer with text only.'; b.tool_choice = { type: 'tool', name: tc.function.name }; }
    else if (tc && typeof tc === 'object' && (tc.type === 'any' || tc.type === 'auto' || tc.type === 'tool')) { b.tool_choice = { type: tc.type, name: tc.name }; }
    if (force) b.system = (b.system ? b.system + '\n\n' : '') + force;
  }
  return b;
}
function llmHeaders() {
  return { 'x-api-key': LLM_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
}

function handleModels(res) {
  const now = Math.floor(Date.now() / 1000);
  const ids = [DEF_MODEL, ...Object.keys(ALIASES).filter(a => a !== 'default')];
  const out = { object: 'list', data: ids.map(id => ({ id: id, object: 'model', created: now, owned_by: 'gateway' })) };
  res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
  res.end(JSON.stringify(out));
}

function oaiErr(res, code, msg) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, CORS));
  res.end(JSON.stringify({ error: { message: msg, type: 'proxy_error', code: code } }));
}

// ---- Anthropic 响应 → OpenAI 格式 ----
async function handleChat(req, res, bodyBuf) {
  let o; try { o = JSON.parse(bodyBuf.toString('utf8')); } catch (e) { return oaiErr(res, 400, 'invalid JSON body'); }
  const anth = toAnthropic(o);
  const stream = !!o.stream;
  if (stream) anth.stream = true;   // 必须透传，否则上游非流式返回、无 SSE 可转发
  let up;
  try {
    up = await fetch(LLM_BASE + '/messages', { method: 'POST', headers: llmHeaders(), body: JSON.stringify(anth) });
  } catch (e) { return oaiErr(res, 502, 'upstream connect failed: ' + e.message); }
  if (!up.ok) {
    const t = await up.text();
    return oaiErr(res, up.status, 'upstream: ' + t.slice(0, 500));
  }
  const cid = 'chatcmpl-' + Date.now();
  const model = anth.model;
  if (!stream) {
    const d = await up.json();
    const blocks = d.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const think = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('');
    const toolCalls = blocks.filter(b => b.type === 'tool_use').map((b, i) => ({  // tool_use → OpenAI tool_calls
      id: b.id || ('call_' + i), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
    }));
    const fin = d.stop_reason === 'max_tokens' ? 'length' : (d.stop_reason === 'tool_use' ? 'tool_calls' : 'stop');
    const msg = { role: 'assistant', content: toolCalls.length ? (text === '' ? null : text) : text };
    if (think) msg.reasoning_content = think;   // 思考过程 → DeepSeek 风格字段
    if (toolCalls.length) msg.tool_calls = toolCalls;
    const out = { id: cid, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model,
      choices: [{ index: 0, message: msg, finish_reason: fin }],
      usage: { prompt_tokens: (d.usage && d.usage.input_tokens) || 0, completion_tokens: (d.usage && d.usage.output_tokens) || 0,
        total_tokens: ((d.usage && d.usage.input_tokens) || 0) + ((d.usage && d.usage.output_tokens) || 0) } };
    res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
    return res.end(JSON.stringify(out));
  }
  // 流式：Anthropic SSE → OpenAI chat.completion.chunk
  res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' }, CORS));
  const chunk = (delta, fin) => res.write('data: ' + JSON.stringify({ id: cid, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: model, choices: [{ index: 0, delta: delta, finish_reason: fin || null }] }) + '\n\n');
  chunk({ role: 'assistant', content: '' }, null);
  let buf = '';
  let fin = 'stop';
  const dec = new TextDecoder();
  for await (const raw of up.body) {
    buf += dec.decode(raw, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
      if (ev.type === 'content_block_start') {   // tool_use 块开始 → tool_calls 起始增量
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') chunk({ tool_calls: [{ index: ev.index, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] }, null);
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) chunk({ content: ev.delta.text }, null);
        else if (ev.delta && ev.delta.type === 'thinking_delta' && ev.delta.thinking) chunk({ reasoning_content: ev.delta.thinking }, null);
        else if (ev.delta && ev.delta.type === 'input_json_delta' && ev.delta.partial_json) chunk({ tool_calls: [{ index: ev.index, function: { arguments: ev.delta.partial_json } }] }, null);
      } else if (ev.type === 'message_delta') {  // 记录真实 stop_reason
        if (ev.delta && ev.delta.stop_reason === 'tool_use') fin = 'tool_calls';
        else if (ev.delta && ev.delta.stop_reason === 'max_tokens') fin = 'length';
      } else if (ev.type === 'message_stop') {
        chunk({}, fin);
        res.write('data: [DONE]\n\n');
      }
    }
  }
  res.end();
}

// ---- 其余路径反向代理到上游（opencode server 等）----
function proxyToUpstream(req, res, url) {
  const opts = { host: UP_HOST, port: UP_PORT, method: req.method, path: url.pathname + url.search,
    headers: Object.assign({}, req.headers, { host: UP_HOST + ':' + UP_PORT }) };
  const up = http.request(opts, ur => {
    const h = Object.assign({}, ur.headers, CORS);
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
  });
  up.on('error', e => oaiErr(res, 502, 'upstream proxy error: ' + e.message));
  req.pipe(up);
}

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');   // 尾斜杠客户端兼容
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (!authed(req, url)) return oaiErr(res, 401, 'missing or invalid token');
  if ((url.pathname === '/models' || url.pathname === '/v1/models') && req.method === 'GET') return handleModels(res);
  if ((url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions') && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handleChat(req, res, Buffer.concat(chunks)));
    return;
  }
  proxyToUpstream(req, res, url);
});
srv.listen(PORT, '0.0.0.0', () => console.log(`ocproxy (OpenAI-compat) on ${PORT} -> upstream ${UP_HOST}:${UP_PORT}, model ${DEF_MODEL}`));
