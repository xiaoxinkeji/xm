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
//   LLM_API_KEY    平台 LLM key（走 x-api-key）
//   LLM_API_KEYS   逗号分隔多个 key —— 额度池化：一个耗尽自动切下一个（配合 LLM_API_KEY 亦可）
//   KEYS_FILE      key 池 JSON 文件（["k1","k2"] 或 {"keys":[...]}），优先级高于环境变量
//   MODEL          默认模型全名（注意：平台会不定期更换可用模型）
//   MODEL_ALIASES  逗号分隔的模型别名（均映射到 MODEL，如 "glm-5.3-flash,qwen3.5-plus"）
//   TOKEN_FILE     网关 Bearer token 文件（默认脚本同目录 .token）
//
// 额度与降耗（平台免费额度按天重置，用完即 402）：
//   CACHE_TTL      响应缓存有效期（小时，默认 12；设 0 关闭缓存）——相同请求零额度消耗
//   CACHE_FILE     缓存落盘文件（默认脚本同目录 cache.json）
//   CACHE_MAX      缓存条数上限（默认 2000，超出淘汰最旧）
//   QUOTA_RESET    每日额度重置时刻（北京时区小时，逗号分隔，默认 "0,10"）
//   DAILY_QUOTA    单 key 每日额度 tokens（默认 30000000，仅用于 /v1/stats 展示占比）
//   THINKING       thinking 控制：off（关闭推理模型的思考过程，显著省额度）| on | auto（默认）
//   THINK_BUDGET   THINKING=on 时的思考预算（默认 2048）
//   CTX_MAX        上下文字符上限，超出时保留 system + 最近若干条（0=不裁剪）
//   MAX_TOKENS_CAP 单次请求 output token 上限（默认 16000）
//
// 管理端点（同样需要 Bearer 鉴权）：
//   GET  /v1/stats        用量、key 池状态、缓存统计、下次额度重置时间
//   POST /v1/keys/reset   手动解除所有 key 的耗尽标记（充值/买加量包后立即恢复）
//   POST /v1/cache/clear  清空响应缓存
//
// 部署：
//   echo <你的网关密钥> > .token
//   LLM_API_KEYS=<key1>,<key2> nohup node ocproxy.js >> ocproxy.log 2>&1 &

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT     = process.env.PORT || 8409;
const UP_HOST  = process.env.UP_HOST || '127.0.0.1';
const UP_PORT  = parseInt(process.env.UP_PORT || '4096', 10);
const LLM_BASE = process.env.LLM_BASE_URL || 'https://proxy.monkeycode-ai.com/v1';
const DEF_MODEL = process.env.MODEL || 'monkeycode-basic/glm-5.3-flash';
const ALIASES = {};
for (const a of (process.env.MODEL_ALIASES || 'glm-5.3-flash,qwen3.5-plus,default').split(',')) {
  if (a.trim()) ALIASES[a.trim()] = DEF_MODEL;
}
const DIR = __dirname;
const KEYS_FILE = process.env.KEYS_FILE || path.join(DIR, 'keys.json');
const CACHE_FILE = process.env.CACHE_FILE || path.join(DIR, 'cache.json');
const STATS_FILE = process.env.STATS_FILE || path.join(DIR, 'stats.json');
const CACHE_TTL_H = (process.env.CACHE_TTL !== undefined) ? parseFloat(process.env.CACHE_TTL) : 12;
const CACHE_TTL_MS = CACHE_TTL_H * 3600 * 1000;
const CACHE_ON = CACHE_TTL_MS > 0;
const CACHE_MAX = parseInt(process.env.CACHE_MAX || '2000', 10);
const DAILY_QUOTA = parseInt(process.env.DAILY_QUOTA || '30000000', 10);
const MAX_TOKENS_CAP = parseInt(process.env.MAX_TOKENS_CAP || '16000', 10);
const THINKING = process.env.THINKING || 'auto';
const THINK_BUDGET = parseInt(process.env.THINK_BUDGET || '2048', 10);
const CTX_MAX_CHARS = parseInt(process.env.CTX_MAX || '0', 10);
const CST = 8 * 3600 * 1000;   // 北京时间偏移（平台额度按北京日重置）
const RESET_HOURS = (process.env.QUOTA_RESET || '0,10').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

// ---- 多 key 池：额度池化，一个耗尽自动切下一个 ----
// 优先级：KEYS_FILE > LLM_API_KEYS > LLM_API_KEY
let pool = [];
function loadKeys() {
  let list = null;
  try {
    const raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.keys) ? raw.keys : null);
  } catch (e) { list = null; }
  if (!list || !list.length) {
    const envKeys = (process.env.LLM_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
    list = envKeys.length ? envKeys : [(process.env.LLM_API_KEY || '').trim()].filter(Boolean);
  }
  const seen = {}; const out = [];
  for (const k of list) {
    const key = String(k || '').trim();
    if (!key || seen[key]) continue;
    seen[key] = 1;
    const old = pool.find(p => p.key === key);
    out.push(old || { key: key, until: 0, fails: 0, ok: 0, used: 0 });
  }
  pool = out;
  return pool;
}
if (!loadKeys().length) { console.error('缺少 key：请设置 LLM_API_KEY(S) 或提供 keys.json'); process.exit(1); }
// 下一个额度重置时刻（北京时间，取最近的下一个候选小时）
function nextResetTs(now) {
  const c = new Date(now + CST);
  const Y = c.getUTCFullYear(), M = c.getUTCMonth(), D = c.getUTCDate();
  const hours = (RESET_HOURS.length ? RESET_HOURS : [0]).slice().sort((a, b) => a - b);
  for (const h of hours) {
    const t = Date.UTC(Y, M, D, h) - CST;
    if (t > now + 60000) return t;
  }
  return Date.UTC(Y, M, D + 1, hours[0]) - CST;
}
function aliveKeys() { const now = Date.now(); return pool.filter(k => k.until <= now); }
function pickKey() {   // 优先可用池中用量最少者（均匀分摊额度）
  const alive = aliveKeys();
  if (!alive.length) return null;
  alive.sort((a, b) => a.used - b.used);
  return alive[0];
}
function markExhausted(k) { k.until = nextResetTs(Date.now()); k.fails++; }
function isQuotaErr(status, text) {
  return status === 402 || status === 429 || /耗尽|已用尽|额度不足|exhausted|quota|insufficient/i.test(text || '');
}
function maskKey(k) { return k ? (k.slice(0, 8) + '...' + k.slice(-4)) : ''; }
function cstStr(ts) { return new Date(ts + CST).toISOString().slice(0, 19).replace('T', ' ') + ' CST'; }

const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, '.token');
function token() { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; } }
function authed(req, url) {
  const t = token(); if (!t) return false;
  const h = req.headers['authorization'] || '';
  return h === 'Bearer ' + t || url.searchParams.get('token') === t;
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

// ---- 响应缓存：相同请求零额度消耗（额度耗尽时命中缓存仍可服务）----
let cache = {};
let cacheDirty = false, cacheTimer = null;
function loadCache() { try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (e) { cache = {}; } }
function saveCache() { cacheDirty = false; try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) { } }
function touchCache() { if (cacheDirty) return; cacheDirty = true; clearTimeout(cacheTimer); cacheTimer = setTimeout(saveCache, 5000); }
function cacheKeyOf(o) {
  const sig = {
    m: ALIASES[o.model] || DEF_MODEL,
    msgs: (o.messages || []).map(m => ({
      r: m.role, c: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || null),
      t: m.tool_calls || null, i: m.tool_call_id || null
    })),
    tools: o.tools ? JSON.stringify(o.tools) : '',
    tc: o.tool_choice ? JSON.stringify(o.tool_choice) : '',
    temp: o.temperature == null ? '' : o.temperature,
    top: o.top_p == null ? '' : o.top_p
  };
  return crypto.createHash('sha256').update(JSON.stringify(sig)).digest('hex');
}
function cacheGet(k) {
  const e = cache[k];
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { delete cache[k]; touchCache(); return null; }
  return e;
}
function cacheSet(k, v) {
  const keys = Object.keys(cache);
  if (keys.length >= CACHE_MAX) {   // 淘汰最旧的 10%
    keys.sort((a, b) => cache[a].ts - cache[b].ts);
    for (let i = 0; i < Math.ceil(CACHE_MAX * 0.1); i++) delete cache[keys[i]];
  }
  cache[k] = { ts: Date.now(), v: v }; touchCache();
}

// ---- 用量统计 ----
let stats = {};
function loadStats() { try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) || {}; } catch (e) { stats = {}; } }
function saveStats() { try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch (e) { } }
function dayId(now) { return new Date(now + CST).toISOString().slice(0, 10); }
function statAdd(mask, inTok, outTok) {
  const d = dayId(Date.now());
  if (!stats[d]) stats[d] = {};
  const s = stats[d][mask] || (stats[d][mask] = { in: 0, out: 0, reqs: 0, cacheHits: 0 });
  s.in += inTok || 0; s.out += outTok || 0; s.reqs++;
  saveStats();
}
function statHit(mask) {
  const d = dayId(Date.now());
  if (!stats[d]) stats[d] = {};
  const s = stats[d][mask] || (stats[d][mask] = { in: 0, out: 0, reqs: 0, cacheHits: 0 });
  s.cacheHits++; saveStats();
}

// ---- 上下文裁剪：长对话 agent 场景省输入 token ----
function msgLen(m) {
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
  return c.length + JSON.stringify(m.tool_calls || '').length + (m.tool_call_id || '').length;
}
function trimContext(o) {
  const msgs = o.messages || [];
  if (!CTX_MAX_CHARS) return msgs;
  let total = 0;
  for (const m of msgs) total += msgLen(m);
  if (total <= CTX_MAX_CHARS) return msgs;
  const isSys = m => m.role === 'system' || m.role === 'developer';
  const sys = msgs.filter(isSys);
  const rest = msgs.filter(m => !isSys(m));
  const keep = []; let acc = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const L = msgLen(rest[i]);
    if (acc + L > CTX_MAX_CHARS && keep.length) break;
    acc += L; keep.unshift(rest[i]);
  }
  while (keep.length && keep[0].role === 'tool') keep.shift();   // 去掉孤儿 tool_result
  return sys.concat(keep);
}

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
  for (const m of trimContext(o)) {
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
  const b = { model: model, messages: msgs, max_tokens: Math.min(o.max_tokens || 4096, MAX_TOKENS_CAP) };
  if (sys.length) b.system = sys.join('\n');
  if (typeof o.temperature === 'number') b.temperature = o.temperature;
  if (typeof o.top_p === 'number') b.top_p = o.top_p;
  if (o.stop) b.stop_sequences = Array.isArray(o.stop) ? o.stop : [o.stop];
  // thinking 控制：off 可显著降低推理模型的额度消耗
  if (THINKING === 'off') b.thinking = { type: 'disabled' };
  else if (THINKING === 'on') b.thinking = { type: 'enabled', budget_tokens: THINK_BUDGET };
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
function llmHeaders(key) {
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
}

function handleModels(res) {
  const now = Math.floor(Date.now() / 1000);
  const ids = [DEF_MODEL, ...Object.keys(ALIASES).filter(a => a !== 'default')];
  const out = { object: 'list', data: ids.map(id => ({ id: id, object: 'model', created: now, owned_by: 'gateway' })) };
  res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
  res.end(JSON.stringify(out));
}

function oaiErr(res, code, msg, extra) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, CORS));
  res.end(JSON.stringify(Object.assign({ error: { message: msg, type: 'proxy_error', code: code } }, extra || {})));
}

// ---- Anthropic 响应 → OpenAI 格式 ----
async function handleChat(req, res, bodyBuf) {
  let o; try { o = JSON.parse(bodyBuf.toString('utf8')); } catch (e) { return oaiErr(res, 400, 'invalid JSON body'); }
  const stream = !!o.stream;
  const cid = 'chatcmpl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const model = ALIASES[o.model] || DEF_MODEL;
  const now = () => Math.floor(Date.now() / 1000);

  // 1) 缓存命中 → 直接返回（零额度消耗；额度耗尽时命中缓存仍可服务）
  const ck = cacheKeyOf(o);
  if (CACHE_ON && req.headers['cache-control'] !== 'no-cache' && req.headers['x-no-cache'] !== '1') {
    const hit = cacheGet(ck);
    if (hit) {
      const v = hit.v;
      statHit('cache');
      if (!stream) {
        const out = Object.assign({}, v, { id: cid, created: now() });
        res.writeHead(200, Object.assign({ 'content-type': 'application/json', 'x-cache': 'HIT' }, CORS));
        return res.end(JSON.stringify(out));
      }
      // 流式：把缓存内容切成块重放
      res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-cache': 'HIT' }, CORS));
      const chunk = (delta, fin) => res.write('data: ' + JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: now(), model: model, choices: [{ index: 0, delta: delta, finish_reason: fin || null }] }) + '\n\n');
      chunk({ role: 'assistant', content: '' }, null);
      const m = v.choices[0].message;
      if (m.reasoning_content) chunk({ reasoning_content: m.reasoning_content }, null);
      if (m.content) { const parts = m.content.match(/[\s\S]{1,24}/g) || []; for (const p of parts) chunk({ content: p }, null); }
      if (m.tool_calls) for (let i = 0; i < m.tool_calls.length; i++) {
        const tc = m.tool_calls[i];
        chunk({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, null);
        const parts = (tc.function.arguments || '').match(/[\s\S]{1,24}/g) || [];
        for (const p of parts) chunk({ tool_calls: [{ index: i, function: { arguments: p } }] }, null);
      }
      chunk({}, v.choices[0].finish_reason || 'stop');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  }

  // 2) 未命中 → 遍历 key 池（一个额度耗尽自动切下一个）
  const anth = toAnthropic(o);
  if (stream) anth.stream = true;   // 必须透传，否则上游非流式返回、无 SSE 可转发
  const body = JSON.stringify(anth);
  const tried = [];
  for (let attempt = 0; attempt < Math.max(pool.length, 1); attempt++) {
    const k = pickKey();
    if (!k) break;
    let up;
    try {
      up = await fetch(LLM_BASE + '/messages', { method: 'POST', headers: llmHeaders(k.key), body: body });
    } catch (e) {
      tried.push(maskKey(k.key) + ': connect fail');
      continue;
    }
    if (!up.ok) {
      const t = await up.text();
      if (isQuotaErr(up.status, t)) { markExhausted(k); tried.push(maskKey(k.key) + ': 额度耗尽'); continue; }
      return oaiErr(res, up.status || 502, 'upstream: ' + t.slice(0, 500));
    }
    k.ok++;
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
      const pT = (d.usage && d.usage.input_tokens) || 0, cT = (d.usage && d.usage.output_tokens) || 0;
      const out = { id: cid, object: 'chat.completion', created: now(), model: model,
        choices: [{ index: 0, message: msg, finish_reason: fin }],
        usage: { prompt_tokens: pT, completion_tokens: cT, total_tokens: pT + cT } };
      k.used += pT + cT; statAdd(maskKey(k.key), pT, cT);
      if (CACHE_ON) cacheSet(ck, { choices: out.choices, usage: out.usage });   // 不含 id/created，便于复用
      res.writeHead(200, Object.assign({ 'content-type': 'application/json', 'x-cache': 'MISS', 'x-key': maskKey(k.key) }, CORS));
      return res.end(JSON.stringify(out));
    }
    // 流式：Anthropic SSE → OpenAI chat.completion.chunk
    res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-cache': 'MISS', 'x-key': maskKey(k.key) }, CORS));
    const chunk = (delta, fin) => res.write('data: ' + JSON.stringify({ id: cid, object: 'chat.completion.chunk',
      created: now(), model: model, choices: [{ index: 0, delta: delta, finish_reason: fin || null }] }) + '\n\n');
    chunk({ role: 'assistant', content: '' }, null);
    let buf = '', fin = 'stop', pT = 0, cT = 0, accText = '', accThink = '';
    const accTools = {};
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
        if (ev.type === 'message_start') { const u = ev.message && ev.message.usage; if (u) pT = u.input_tokens || 0; }
        else if (ev.type === 'content_block_start') {   // tool_use 块开始 → tool_calls 起始增量
          const cb = ev.content_block || {};
          if (cb.type === 'tool_use') { accTools[ev.index] = { id: cb.id, name: cb.name, args: '' }; chunk({ tool_calls: [{ index: ev.index, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] }, null); }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) { accText += ev.delta.text; chunk({ content: ev.delta.text }, null); }
          else if (ev.delta && ev.delta.type === 'thinking_delta' && ev.delta.thinking) { accThink += ev.delta.thinking; chunk({ reasoning_content: ev.delta.thinking }, null); }
          else if (ev.delta && ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
            if (accTools[ev.index]) accTools[ev.index].args += ev.delta.partial_json;
            chunk({ tool_calls: [{ index: ev.index, function: { arguments: ev.delta.partial_json } }] }, null);
          }
        } else if (ev.type === 'message_delta') {  // 记录真实 stop_reason
          if (ev.delta && ev.delta.stop_reason === 'tool_use') fin = 'tool_calls';
          else if (ev.delta && ev.delta.stop_reason === 'max_tokens') fin = 'length';
          if (ev.usage) cT = ev.usage.output_tokens || cT;
        } else if (ev.type === 'message_stop') {
          chunk({}, fin);
          res.write('data: [DONE]\n\n');
        }
      }
    }
    k.used += pT + cT; statAdd(maskKey(k.key), pT, cT);
    if (CACHE_ON) {   // 流结束后落缓存，后续同请求零消耗
      const tcList = Object.keys(accTools).map(i => accTools[i]).filter(t => t && t.name)
        .map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } }));
      const msg = { role: 'assistant', content: tcList.length ? (accText === '' ? null : accText) : accText };
      if (accThink) msg.reasoning_content = accThink;
      if (tcList.length) msg.tool_calls = tcList;
      cacheSet(ck, { choices: [{ index: 0, message: msg, finish_reason: fin }], usage: { prompt_tokens: pT, completion_tokens: cT, total_tokens: pT + cT } });
    }
    return res.end();
  }

  // 3) 池中 key 全部不可用 → 402 + 明确的恢复时间
  const soonest = pool.length ? Math.min.apply(null, pool.map(k => k.until)) : nextResetTs(Date.now());
  return oaiErr(res, 402,
    '上游额度已耗尽：池中 ' + pool.length + ' 个 key 全部不可用（' + (tried.join('; ') || 'none') + '）' +
    '，预计 ' + cstStr(soonest) + ' 额度重置后自动恢复',
    { reset_at: cstStr(soonest), reset_ts: soonest, keys_total: pool.length, keys_alive: aliveKeys().length });
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

// ---- 用量/额度可视化 ----
function handleStats(res) {
  const d = dayId(Date.now());
  const day = stats[d] || {};
  let inT = 0, outT = 0, reqs = 0, hits = 0;
  for (const k of Object.keys(day)) { inT += day[k].in; outT += day[k].out; reqs += day[k].reqs; hits += day[k].cacheHits || 0; }
  const out = {
    date: d + ' (CST)',
    today: { requests: reqs, prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT, cache_hits: hits },
    quota_per_key: DAILY_QUOTA,
    keys: pool.map(k => ({ key: maskKey(k.key), alive: k.until <= Date.now(), used_today: k.used, ok: k.ok, fails: k.fails,
      blocked_until: k.until > Date.now() ? cstStr(k.until) : null })),
    cache: { enabled: CACHE_ON, entries: Object.keys(cache).length, ttl_hours: CACHE_TTL_H },
    config: { thinking: THINKING, ctx_max_chars: CTX_MAX_CHARS, max_tokens_cap: MAX_TOKENS_CAP },
    next_reset: cstStr(nextResetTs(Date.now()))
  };
  res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
  res.end(JSON.stringify(out, null, 2));
}

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');   // 尾斜杠客户端兼容
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (!authed(req, url)) return oaiErr(res, 401, 'missing or invalid token');
  if ((url.pathname === '/models' || url.pathname === '/v1/models') && req.method === 'GET') return handleModels(res);
  if (url.pathname === '/v1/stats' && req.method === 'GET') return handleStats(res);
  if (url.pathname === '/v1/cache/clear' && req.method === 'POST') {
    cache = {}; saveCache();
    res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
    return res.end('{"ok":true}');
  }
  // 手动解除耗尽标记（充值 / 买加量包 / 额度提前重置后调用，免等自动恢复）
  if (url.pathname === '/v1/keys/reset' && req.method === 'POST') {
    loadKeys(); for (const k of pool) k.until = 0;
    res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
    return res.end(JSON.stringify({ ok: true, keys_alive: pool.length, next_reset: cstStr(nextResetTs(Date.now())) }));
  }
  if ((url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions') && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handleChat(req, res, Buffer.concat(chunks)));
    return;
  }
  proxyToUpstream(req, res, url);
});

loadCache(); loadStats();
srv.listen(PORT, '0.0.0.0', () => console.log(`ocproxy on ${PORT} -> upstream ${UP_HOST}:${UP_PORT}, model ${DEF_MODEL}, keys ${pool.length}, cache ${CACHE_ON ? CACHE_TTL_H + 'h' : 'off'}`));
