#!/usr/bin/env node
// mc-daemon — 共享终端常驻守护进程
//
// 把平台的"浏览器共享终端"变成一条可编程的远程执行通道：
//   - 通过 WS 长连到共享终端（密码从文件热读取，失效自动重连）
//   - 文件队列：把 .sh 脚本放进 in/，自动 base64 投递到 VM 执行，结果回写 out/
//   - PTY 保活：周期性制造真实终端交互，防止空闲回收
//
// 用法（操作机需 Node >= 22，用到全局 WebSocket）：
//   export TERMINAL_ID=<终端ID>            # 必填
//   echo <连接密码> > mcq/password         # 密码文件（热读取，失效后换新即可）
//   setsid nohup node mc-daemon.js > /dev/null 2>&1 &
//
// 远程执行：
//   cp your-script.sh mcq/in/              # 排队（按文件名顺序）
//   cat mcq/out/your-script.out            # 出现即执行完成
//
// 状态：
//   cat mcq/status                         # 连接状态 JSON
//   tail mcq/daemon.log                    # 运行日志
//
// 目录布局（MCQ_DIR 可用环境变量覆盖，默认 ./mcq）：
//   mcq/password   连接密码（一行）
//   mcq/in/*.sh    待执行脚本队列
//   mcq/out/*.out  执行结果
//   mcq/status     状态 JSON
//   mcq/daemon.log 日志

const fs = require('fs');
const path = require('path');
const { WebSocket } = globalThis;

const TERMINAL_ID = process.env.TERMINAL_ID || '';
if (!TERMINAL_ID) { console.error('缺少 TERMINAL_ID 环境变量（共享终端 URL 里 id= 参数）'); process.exit(1); }
const WS_ORIGIN = process.env.WS_ORIGIN || 'wss://monkeycode-ai.com';

const QDIR    = process.env.MCQ_DIR || path.join(process.cwd(), 'mcq');
const IN      = path.join(QDIR, 'in');
const OUT     = path.join(QDIR, 'out');
const LOG     = path.join(QDIR, 'daemon.log');
const STATUS  = path.join(QDIR, 'status');
const PWFILE  = path.join(QDIR, 'password');
fs.mkdirSync(IN,  { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const enc = s => Buffer.from(s, 'utf-8').toString('base64');

function log(s) { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {} }
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')
          .replace(/\x1b[=>]/g, '')
          .replace(/\r/g, '');
}

// 密码热读取：文件优先，环境变量兜底。
// 平台侧密码通常与"发起共享的浏览器会话"绑定：浏览器不关可长期复用，
// 关闭后密码作废——守护进程持续重试，新密码写进文件即自动重连。
function readPassword() {
  try {
    const s = fs.readFileSync(PWFILE, 'utf-8').trim();
    if (s) return s;
  } catch {}
  return process.env.TERMINAL_PASSWORD || '';
}
function wsUrl(pw) {
  return `${WS_ORIGIN}/api/v1/users/hosts/vms/terminals/join?terminal_id=${TERMINAL_ID}&password=${pw}`;
}

let ws = null;
let ready = false;
let busy = false;
let buf = '';
let marker = null;
let job = null;
let pingTimer = null;
let reconnectTimer = null;
let connectedSince = null;
let lastActivity = null;
let currentPassword = '';
let failCount = 0;
let lastFailReason = null;

// 持续重试策略：服务端可能因"终端会话未激活"暂时拒绝同一密码，
// 用户重新打开共享页面后同一密码即生效，因此不设放弃上限。
function shouldTry(pw) { return !!pw; }

function writeStatus(extra) {
  const st = {
    connected: ready,
    since: connectedSince ? new Date(connectedSince).toISOString() : null,
    uptimeMin: connectedSince ? Math.round((Date.now() - connectedSince) / 60000) : 0,
    lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
    busy,
    passwordOnFile: !!readPassword(),
    failCount,
    lastFailReason,
    ...extra,
  };
  try { fs.writeFileSync(STATUS, JSON.stringify(st, null, 2)); } catch {}
}

// 分片限速发送：长命令一次发会被 PTY 吞字符，必须切块慢发
function sendThrottled(text, chunk, delay, done) {
  let i = 0;
  (function step() {
    if (!ws || ws.readyState !== 1) { if (done) done(); return; }
    if (i >= text.length) { if (done) done(); return; }
    const piece = text.slice(i, i + chunk);
    i += chunk;
    try { ws.send(JSON.stringify({ type: 'data', data: enc(piece) })); } catch {}
    setTimeout(step, delay);
  })();
}

function finishJob(out) {
  if (job) {
    clearTimeout(job.timer);
    const name = job.name;
    try { fs.writeFileSync(path.join(OUT, name + '.out'), stripAnsi(out).trim() + '\n'); } catch {}
    log('job done: ' + name);
    job = null;
  }
  busy = false; marker = null; buf = '';
  writeStatus();
}

function runJob(name, body) {
  busy = true; buf = '';
  marker = `__MCQ_DONE_${name}_${Date.now()}__`;
  const script = body.replace(/\s*$/, '') + `\necho ${marker}\n`;
  const b64 = Buffer.from(script, 'utf-8').toString('base64');
  job = { name, timer: setTimeout(() => { log('job TIMEOUT: ' + name); finishJob(buf + '\n[JOB TIMEOUT]'); }, 150000) };
  log('job start: ' + name);
  // 投递方式：base64 写文件再执行（规避 PTY 对特殊字符/长命令的吞字问题）
  sendThrottled(`echo '${b64}' | base64 -d > /tmp/mcq.sh\r`, 180, 25, () => {
    setTimeout(() => { sendThrottled('bash /tmp/mcq.sh 2>&1\r', 16, 30); }, 700);
  });
  writeStatus();
}

function pump() {
  if (!ready || busy) return;
  let files;
  try { files = fs.readdirSync(IN).filter(f => f.endsWith('.sh')).sort(); } catch { return; }
  if (!files.length) return;
  const f = files[0];
  const name = f.replace(/\.sh$/, '');
  let body;
  try { body = fs.readFileSync(path.join(IN, f), 'utf-8'); fs.unlinkSync(path.join(IN, f)); }
  catch (e) { return; }
  runJob(name, body);
}

// 制造真实 PTY 交互流（Ctrl-C 清行 + 回车出提示符）。
// 只发 WS ping 不产生终端数据，平台可能据此判定空闲并回收会话。
function ptyTouch() {
  if (!ready || busy) return;
  try {
    ws.send(JSON.stringify({ type: 'data', data: enc('\x03') }));
    setTimeout(() => { try { ws.send(JSON.stringify({ type: 'data', data: enc('\r') })); } catch {} }, 150);
    setTimeout(() => { if (!busy) buf = ''; }, 2500);
    lastActivity = Date.now();
    writeStatus();
  } catch {}
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  log(`will reconnect in 8s (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const pw = readPassword();
    if (!shouldTry(pw)) { writeStatus(); return; }
    connect(pw);
  }, 8000);
}

function connect(pw) {
  const password = pw || readPassword();
  if (!password) { log('connect aborted: no password'); writeStatus(); return; }
  currentPassword = password;
  log('connecting...');
  try { ws = new WebSocket(wsUrl(password)); } catch (e) { log('ws ctor error: ' + e); scheduleReconnect('ctor'); return; }

  ws.addEventListener('open', () => {
    ready = true;
    connectedSince = Date.now();
    lastActivity = Date.now();
    log('WS OPEN — session alive');
    writeStatus();
    sendThrottled('\x03', 1, 10);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ready) { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }
    }, 5000);
  });

  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data.toString()); } catch { return; }
    if (m.type === 'error') {
      log('server error: ' + m.data);
      if (String(m.data).includes('验证密码失败') || String(m.data).includes('password')) {
        lastFailReason = String(m.data);
        failCount++;
        log(`password rejected (count=${failCount}) — 新密码写入 ${PWFILE} 即自动重连`);
        writeStatus();
      }
      return;
    }
    if (m.type !== 'data') return;
    lastActivity = Date.now();
    const t = Buffer.from(m.data, 'base64').toString('utf-8');
    buf += t;
    if (busy && marker && buf.indexOf(marker) >= 0) {
      finishJob(buf.slice(0, buf.indexOf(marker)));
    }
  });

  ws.addEventListener('error', (e) => log('ws error: ' + (e.message || e)));

  ws.addEventListener('close', (c, r) => {
    const wasReady = ready;
    ready = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    connectedSince = null;
    log(`WS CLOSED code=${c} reason=${r} — 会话结束，密码可能作废`);
    writeStatus({ lastClose: new Date().toISOString(), lastCloseCode: String(c) });
    if (wasReady) scheduleReconnect('server closed');
  });
}

// 启动
connect();
setInterval(pump, 800);
setInterval(ptyTouch, 75000);
setInterval(() => {
  if (ready) {
    if (connectedSince && Date.now() - connectedSince > 60000) { failCount = 0; lastFailReason = null; }
    log(`heartbeat: alive, busy=${busy}, up=${connectedSince ? Math.round((Date.now()-connectedSince)/60000) : 0}min`);
    writeStatus();
  }
}, 60000);
// 断线时定期检查密码文件是否更新（热插新密码后自动重连）
setInterval(() => {
  if (!ready && !reconnectTimer && readPassword()) scheduleReconnect('password file present');
}, 5000);
