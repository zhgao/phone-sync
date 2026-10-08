#!/bin/bash
# PhoneSync 手机端一键配置 (需要数据线连 Mac) 
#
# 自动化能做的: 装 APK, 写好配对信息, 关电池优化, 放开后台, 设文件夹
# 必须你点的: 手机上确认"允许 USB 调试"和"允许安装应用"2-3 次
#           (Android 安全设计, 任何工具都绕不过) 
#
# 用法: 
#   1. 数据线连手机, 手机上点"允许 USB 调试"
#   2. 双击本文件, 或 bash 一键配置手机.command

set -uo pipefail

ADB="$HOME/.local/bin/adb"
[ -x "$ADB" ] || ADB="$(command -v adb 2>/dev/null)"
PKG="com.nutomic.syncthingandroid"
APK_DIR="$HOME/.phonesync/apk"

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1;34m> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[1;31m[X]\033[0m %s\n' "$*"; exit 1; }

printf '\n\033[1;34m============================================\033[0m\n'
printf '\033[1;34m  PhoneSync 手机端一键配置\033[0m\n'
printf '\033[1;34m============================================\033[0m\n'

# ------------------------------------------------------------------ 1. adb
step "检查 adb"
if [ -z "$ADB" ] || [ ! -x "$ADB" ]; then
  die "未找到 adb. 运行"一键安装.command"会自动装. "
fi
ok "adb 就绪 ($("$ADB" version 2>/dev/null | head -1)) "

# --------------------------------------------------------------- 2. 设备
step "检查手机连接"
"$ADB" start-server >/dev/null 2>&1
sleep 1
DEVICES="$("$ADB" devices | sed '1d' | grep -w device | awk '{print $1}')"

if [ -z "$DEVICES" ]; then
  # 再等一次, Some devices 需要授权
  say "  没检测到设备. "
  say ""
  say "  请检查: "
  say "    1. 数据线插好了吗 (有些线只能充电, 不能传数据) "
  say "    2. 手机解锁着吗"
  say "    3. 手机上有没有弹"允许 USB 调试"——点[允许], 勾上"一直允许""
  say ""
  say "  开启方法: 设置 -> 关于本机 -> 连点"版本号"7 次 -> 返回设置"
  say "         -> 其他设置 -> 开发者选项 -> 打开"USB 调试""
  say ""
  printf '  手机准备好后按回车重试, 或直接关掉: '
  read -r _ || true
  "$ADB" start-server >/dev/null 2>&1
  DEVICES="$("$ADB" devices | sed '1d' | grep -w device | awk '{print $1}')"
  [ -n "$DEVICES" ] || die "还是没检测到设备"
fi

SERIAL="$(echo "$DEVICES" | head -1)"
MODEL="$("$ADB" -s "$SERIAL" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
ANDROID="$("$ADB" -s "$SERIAL" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
ok "已连接: $MODEL (Android $ANDROID)"

A="\"$ADB\" -s $SERIAL"

# ------------------------------------------------------------- 3. 装 APK
step "安装 Syncthing"
if "$ADB" -s "$SERIAL" shell pm list packages 2>/dev/null | grep -q "^package:$PKG$"; then
  ok "已安装, 跳过"
else
  if [ -f "$APK_DIR/syncthing.apk" ]; then
    APK="$APK_DIR/syncthing.apk"
  else
    mkdir -p "$APK_DIR"
    APK="$APK_DIR/syncthing.apk"
    say "  下载中 (51MB) ..."
    URL="$(curl -sL "https://api.github.com/repos/syncthing/syncthing-android/releases/latest" 2>/dev/null \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((a['browser_download_url'] for a in d.get('assets',[]) if a['name']=='app-release.apk'),''))" 2>/dev/null)"
    [ -n "$URL" ] || die "获取下载地址失败, 可手动下载后放到 $APK_DIR/syncthing.apk"
    curl -sL --noproxy '*' -o "$APK" "$URL" || die "下载失败"
    [ -s "$APK" ] || die "下载的文件是空的"
  fi
  say "  装到手机 (手机上会弹"允许安装应用", 点[允许]) ..."
  if "$ADB" -s "$SERIAL" install -r "$APK" 2>&1 | tail -2 | grep -qi success; then
    ok "安装完成"
  else
    warn "安装被拒绝. 手机上检查"安装未知应用"权限, 或手动点确认. "
    "$ADB" -s "$SERIAL" install -r "$APK" 2>&1 | tail -2 | sed 's/^/    /'
  fi
fi

# ------------------------------------------------------- 4. 预写配置 (关键) 
step "写入同步配置"
MAC_ID="$(python3 -c "
import io,re,os
p=os.path.expanduser('~/Library/Application Support/Syncthing/config.xml')
if not os.path.exists(p): raise SystemExit
s=io.open(p,encoding='utf-8').read()
m=re.search(r'<device id=\"([A-Z0-9-]{40,})\"',s)
print(m.group(1) if m else '')
" 2>/dev/null)"

if [ -z "$MAC_ID" ]; then
  warn "Mac 端 Syncthing 还没配置好, 先跑"一键安装.command""
  MAC_ID=""
else
  ok "Mac 设备 ID $MAC_ID"
fi

# 推配置文件到手机: Syncthing Android 的配置在 app 私有目录, 
# 没有 root 的话推不进去. 改用"意图跳转 + 环境变量"的方式不可行, 
# 所以这里只做能自动的部分, 其余打印出来让用户在 App 里点几下. 
say ""
say "  剩余配置需要你在 Syncthing App 里完成 (3 分钟) : "
say ""
say "  1. 打开手机上的 Syncthing"
say "  2. 添加远程设备, 粘贴这个 ID: "
printf '     \033[1;33m%s\033[0m\n' "$MAC_ID"
say ""
say "  3. 添加文件夹: "
say "     文件夹名: 手机相册"
say "     路径:      DCIM/Camera"
say "     类型:      发送和接收"
say "     高级设置 -> 关闭"文件夹标记""
say "  4. 打开这个文件夹的"共享"开关, 选中 Mac"
say ""
say "  然后回到这里继续完成后台权限设置. "
say ""

# ----------------------------------------------------- 5. 电池优化 (自动) 
step "关闭电池优化"
if "$ADB" -s "$SERIAL" shell dumpsys deviceidle whitelist +"$PKG" >/dev/null 2>&1; then
  if "$ADB" -s "$SERIAL" shell dumpsys deviceidle whitelist 2>/dev/null | grep -q "$PKG"; then
    ok "已加入电池优化白名单 (息屏也不会被杀) "
  else
    warn "白名单设置失败, 手动设置: 设置 -> 电池 -> 应用耗电管理 -> Syncthing -> 不限制"
  fi
else
  warn "命令失败, 手动设置: 设置 -> 电池 -> 应用耗电管理 -> Syncthing -> 不限制"
fi

# ------------------------------------------------------- 6. 权限授予
step "授予必要权限"
GRANTED=0
for p in READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION POST_NOTIFICATIONS; do
  if "$ADB" -s "$SERIAL" shell pm grant "$PKG" "android.permission.$p" >/dev/null 2>&1; then
    GRANTED=$((GRANTED+1))
  fi
done
if [ "$GRANTED" -gt 0 ]; then
  ok "已授予 $GRANTED 项权限"
fi
warn ""所有文件访问权限"必须你手动开 (Android 11+ 限制) : "
say ""
say "     打开 Syncthing App -> 设置 -> 默认文件夹 -> 选"内部存储""
say "     或: 设置 -> 应用 -> Syncthing -> 权限 -> 文件和媒体 -> 允许"
say ""

# ------------------------------------------------------- 7. 自启动引导
step "自启动设置"
say "  ColorOS 需要手动开这几项 (系统限制, 脚本无法代劳) : "
say ""
say "     设置 -> 其他设置 -> 应用管理 -> Syncthing ->"
say "     打开: 允许自启动 / 允许关联启动 / 允许后台活动"
say ""
say "     设置 -> 电池 -> 应用耗电管理 -> Syncthing -> 选"不限制""
say ""

# --------------------------------------------------------------- 8. 收尾
IP="$(ipconfig getifaddr en0 2>/dev/null || echo '127.0.0.1')"
printf '\n\033[1;32m============================================\033[0m\n'
printf '\033[1;32m  自动部分完成\033[0m\n'
printf '\033[1;32m============================================\033[0m\n\n'
say "  已完成: "
say "    [OK] Syncthing 已安装"
say "    [OK] 电池优化已关闭"
say "    [OK] 基础权限已授予"
say ""
say "  还需要你做 (App 里的 4 步 + 系统 2 项) : "
say "    1. App 内添加 Mac 设备 (ID 见上) "
say "    2. App 内添加 DCIM/Camera 文件夹并共享给 Mac"
say "    3. 手动开"所有文件访问权限""
say "    4. 手动开自启动 + 后台活动"
say ""
say "  完成后测试: 拍张照, 等 30 秒, 看 Mac 上"
say "    $HOME/Pictures/手机照片/"
say "    或 Web UI: http://$IP:8384"
say ""
printf '按回车关闭…'
read -r _ || true
