#!/bin/bash
# 配置 Syncthing 用于手机照片自动同步
# 幂等：可重复执行。改前自动备份，改后校验。
set -euo pipefail

CFG="$HOME/Library/Application Support/Syncthing/config.xml"
RECV_DIR="$HOME/Pictures/手机照片"

if [ ! -f "$CFG" ]; then
  echo "找不到 Syncthing 配置：$CFG"
  echo "请先启动一次 Syncthing.app"
  exit 1
fi

mkdir -p "$RECV_DIR"
BACKUP="$CFG.bak.$(date +%Y%m%d%H%M%S)"
cp "$CFG" "$BACKUP"
echo "已备份配置到 $BACKUP"

python3 - "$CFG" <<'PYEOF'
import sys, io, re

path = sys.argv[1]
with io.open(path, encoding='utf-8') as f:
    s = f.read()

def set_global_flag(xml, tag, value):
    """设置 <options> 里的顶层 flag（不是 gui 段内的）。"""
    pat = re.compile(rf'<{tag}>\s*[^<]*\s*</{tag}>')
    if pat.search(xml):
        return pat.sub(f'<{tag}>{value}</{tag}>', xml, count=1)
    if '</options>' in xml:
        return xml.replace('</options>', f'    <{tag}>{value}</{tag}>\n</options>', 1)
    return xml

# 1) GUI 绑定到局域网 —— 默认 127.0.0.1:8384 只本机可见，手机打不开。
#    必须只改 <gui>...</gui> 段内的 address。
#    注意：<listenAddress> 和设备的 <address>dynamic</address> 不能碰，后者是发现协议用的。
m = re.search(r'(<gui\b[^>]*>)(.*?)(</gui>)', s, re.S)
if m:
    inner = m.group(2)
    if '<address>' in inner:
        inner = re.sub(r'<address>[^<]*</address>',
                       '<address>0.0.0.0:8384</address>', inner, count=1)
    else:
        inner = re.sub(r'^(\s*)', r'\1    <address>0.0.0.0:8384</address>\n', inner, count=1)
    s = s[:m.start()] + m.group(1) + inner + m.group(3) + s[m.end():]
else:
    print('警告：未找到 <gui> 段，跳过 GUI 绑定', file=sys.stderr)

# 2) 局域网发现（这些是 <options> 下的顶层 flag）
s = set_global_flag(s, 'localAnnounceEnabled', 'true')
s = set_global_flag(s, 'localAnnouncePort', '21027')
s = set_global_flag(s, 'globalAnnounceEnabled', 'true')
s = set_global_flag(s, 'relaysEnabled', 'true')

with io.open(path, 'w', encoding='utf-8') as f:
    f.write(s)
print('配置已更新')
PYEOF

# 校验：关键项必须生效，否则报错而不是假装成功
# 注意：set -e 下 grep 找不到会直接退出，所以用 || true 兜住，让 FAIL 能生效
echo
FAIL=0
GUI_ADDR="$(python3 -c "
import io,re,sys
s=io.open(sys.argv[1],encoding='utf-8').read()
m=re.search(r'<gui\b.*?</gui>', s, re.S)
if not m: print(''); raise SystemExit
a=re.findall(r'<address>([^<]*)</address>', m.group(0))
print(a[0] if len(a)==1 else 'BAD_COUNT_%d'%len(a))
" "$CFG")"

if [ "$GUI_ADDR" = "0.0.0.0:8384" ]; then
  echo "✓ GUI 已绑定 0.0.0.0:8384"
elif [ -z "$GUI_ADDR" ]; then
  echo "✗ 未找到 gui 段内的 address"; FAIL=1
else
  echo "✗ gui 段内 address 异常（$GUI_ADDR）"; FAIL=1
fi

grep -q '<localAnnounceEnabled>true</localAnnounceEnabled>' "$CFG" \
  || { echo "✗ 局域网发现未开启"; FAIL=1; }
[ "$FAIL" -eq 0 ] || true

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "配置校验失败。可手动恢复："
  echo "  cp '$BACKUP' '$CFG'"
  exit 1
fi
echo "✓ 局域网发现已开启"

DEVICE_ID="$(python3 -c "
import io, re, sys
with io.open(sys.argv[1], encoding='utf-8') as f:
    s = f.read()
m = re.search(r'<device id=\"([A-Z0-9-]{40,})\"', s)
print(m.group(1) if m else '')
" "$CFG")"

if [ -z "$DEVICE_ID" ]; then
  echo "⚠️ 没能从配置里读到设备 ID"
  echo "   请手动打开 http://127.0.0.1:8384 查看，或运行："
  echo "   grep -o 'id=\"[A-Z0-9-]*\"' \"$CFG\" | head -1"
  exit 0
fi

cat <<EOF

  ✓ GUI 已绑定 0.0.0.0:8384（手机可访问）
  ✓ 局域网发现已开启
  ✓ 接收目录 $RECV_DIR

  设备 ID（手机配对时用）：
  $DEVICE_ID

  接下来三步：
  1. 完全退出 Syncthing 再重新打开（让它读新配置）
  2. 电脑浏览器打开 http://127.0.0.1:8384，按提示设置完
  3. 手机装 Syncthing → 添加远程设备 → 粘贴上面的设备 ID
EOF
