#!/usr/bin/env bash
# examples/remote-exec.sh — 经 mc-daemon 远程执行命令示例（操作机上运行）
#
# 演示把命令投递进文件队列，等待结果回写。
# 前置：mc-daemon.js 已运行且 status 显示 connected: true
set +e
QDIR="${MCQ_DIR:-$PWD/mcq}"

cat > "$QDIR/in/demo.sh" <<'EOF'
#!/bin/bash
echo "hostname: $(hostname)"
echo "uptime:   $(uptime)"
echo "disk:     $(df -h / | tail -1)"
echo "gateway:  $(curl -s -m5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8409/v1/models -H "Authorization: Bearer dummy" )"
echo "keepalive 最近3条:"
tail -3 /opt/keepalive/ka2.log 2>/dev/null
EOF

echo ">> 已投递 demo.sh，等待结果…"
for i in $(seq 1 60); do
  [ -f "$QDIR/out/demo.out" ] && { echo "---- 结果 ----"; cat "$QDIR/out/demo.out"; exit 0; }
  sleep 2
done
echo "超时，稍后查看: $QDIR/out/demo.out"
