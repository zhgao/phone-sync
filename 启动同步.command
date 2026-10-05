#!/bin/bash
# 双击启动 PhoneSync（.command 文件在 Finder 里双击即可运行）
cd "$(dirname "$0")" || exit 1

# Node 路径：优先用 PATH 里的，找不到再退回 WorkBuddy 托管的版本
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$candidate" ] && NODE_BIN="$candidate" && break
  done
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node。装一个 Node.js 18+ 再试。"
  read -r -p "按回车关闭…"
  exit 1
fi

# 端口已被占用说明服务已在跑，直接打开页面
if lsof -ti tcp:8848 >/dev/null 2>&1; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || echo '127.0.0.1')"
  echo "服务已经在运行了。"
  echo "手机打开： http://$IP:8848"
  open "http://localhost:8848" 2>/dev/null
  read -r -p "按回车关闭…"
  exit 0
fi

echo "PhoneSync 启动中… 手机上打开下面这个地址："
echo
"$NODE_BIN" server.js
echo
echo "服务已停止。"
read -r -p "按回车关闭…"
