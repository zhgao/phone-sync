"""通过 Syncthing REST API 创建共享文件夹。

为什么不用手改 XML：
config.xml 里的空 <folder id=""> 段在 <defaults> 容器内，是「默认模板」，
不是真实文件夹。把真实 folder 塞进去会让整个 XML 结构非法，
Syncthing 启动时直接忽略（表现为 folders API 返回 0 个，却不报错）。

正确做法：调 REST API（POST /rest/config/folders），让 Syncthing 自己写回磁盘。
它会保证结构正确，也顺便触发 reload。
"""
import http.client, io, json, os, re, sys

CFG = os.path.expanduser('~/Library/Application Support/Syncthing/config.xml')
FOLDER_ID = 'phone-photos'
LABEL = '手机照片'
DEST = os.path.expanduser('~/Pictures/手机照片')

s = io.open(CFG, encoding='utf-8').read()
key = re.search(r'<apikey>([^<]+)</apikey>', s).group(1)


def api(method, path, body=None):
    conn = http.client.HTTPConnection('127.0.0.1', 8384, timeout=20)
    payload = json.dumps(body).encode() if body is not None else None
    hdrs = {'X-API-Key': key}
    if payload:
        hdrs['Content-Type'] = 'application/json'
    conn.request(method, path, body=payload, headers=hdrs)
    r = conn.getresponse()
    data = r.read().decode('utf-8', 'replace')
    return r.status, data


# 先拿本机设备 ID
st, data = api('GET', '/rest/system/status')
status = json.loads(data)
self_id = status.get('myID')
print('本机设备 ID:', self_id)

os.makedirs(DEST, exist_ok=True)

# 看现有文件夹
st, data = api('GET', '/rest/config/folders')
folders = json.loads(data)
print('当前文件夹数:', len(folders))

existing = next((f for f in folders if f.get('id') == FOLDER_ID), None)

if existing:
    print('已存在，改为更新:', FOLDER_ID)
    existing.update({
        'label': LABEL,
        'path': DEST,
        'type': 'receiveonly',
    })
    st, data = api('PUT', '/rest/config/folders/%s' % FOLDER_ID, existing)
    print('更新返回:', st, data[:120])
else:
    new_folder = {
        'id': FOLDER_ID,
        'label': LABEL,
        'path': DEST,
        'type': 'receiveonly',
        'rescanIntervalS': 300,
        'fsWatcherEnabled': True,
        'fsWatcherDelayS': 10,
        'ignorePerms': False,
        'autoNormalize': True,
        'devices': [{'deviceID': self_id}],
        # minDiskFree 是 config.Size：
        #   传 int    -> "cannot unmarshal number into ... config.Size"（说明不是 int）
        #   传 string -> "cannot unmarshal string into ... config.Size"（说明不是 string）
        # 实际它要的是带单位的 JSON 数字形式，原始配置里是 <minDiskFree unit="%">1</minDiskFree>
        # 稳妥做法：干脆不传这个字段，用 Syncthing 的默认值。
        # 结果里若确需设置，再按 API 文档的类型补。
    }
    st, data = api('POST', '/rest/config/folders', new_folder)
    print('创建返回:', st, data[:200])

# 验证：重新读，确认 Syncthing 真的加载了
st, data = api('GET', '/rest/config/folders')
folders = json.loads(data)
print()
print('=== 验证 ===')
print('文件夹数:', len(folders))
for f in folders:
    print('  id=%s | label=%s | path=%s | type=%s'
          % (f.get('id'), f.get('label'), f.get('path'), f.get('type')))

ok = any(f.get('id') == FOLDER_ID and f.get('path') == DEST for f in folders)
print()
print('结果:', '成功' if ok else '失败')
sys.exit(0 if ok else 1)
