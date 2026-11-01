#!/usr/bin/env python3
"""只用 adb 驱动模拟器，给 Agent 做探索性测试和看截图。自动化回归请写 Maestro 流程。

用法（可以连写多个动作，按顺序执行）：
  scripts/adb-ui.py tap=welcome-create type=hello hide shot=today wait=2 texts ids
"""
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK = os.environ.get('ANDROID_HOME', os.path.expanduser('~/Android/Sdk'))
ADB = os.path.join(SDK, 'platform-tools', 'adb')


def adb(*args: str) -> bytes:
    return subprocess.run([ADB, *args], check=True, capture_output=True, timeout=60).stdout


def nodes():
    for _ in range(5):
        out = adb('exec-out', 'uiautomator', 'dump', '/dev/tty').decode('utf8', 'replace')
        start = out.find('<?xml')
        end = out.rfind('</hierarchy>')
        if start >= 0 and end >= 0:
            return list(ET.fromstring(out[start : end + len('</hierarchy>')]).iter('node'))
        time.sleep(1)
    raise SystemExit('读不到界面结构')


def center(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    return (x1 + x2) // 2, (y1 + y2) // 2


def find(key, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for node in nodes():
            rid = node.get('resource-id', '').split('/')[-1]
            if key in (rid, node.get('text'), node.get('content-desc')):
                return node
        time.sleep(0.5)
    raise SystemExit(f'找不到元素：{key}')


def run(action: str):
    name, _, value = action.partition('=')
    if name == 'tap':
        x, y = center(find(value))
        adb('shell', 'input', 'tap', str(x), str(y))
    elif name == 'type':
        # 批量注入会和输入法的组字冲突、丢字符，真实键盘和 Maestro 都是逐字的。
        for ch in value:
            adb('shell', 'input', 'text', '%s' if ch == ' ' else ch)
        time.sleep(0.5)
    elif name == 'hide':
        # 键盘没开时按返回键会退出页面。
        if b'mInputShown=true' in adb('shell', 'dumpsys', 'input_method'):
            adb('shell', 'input', 'keyevent', '4')
            time.sleep(1)
    elif name == 'back':
        adb('shell', 'input', 'keyevent', '4')
    elif name == 'wait':
        time.sleep(float(value))
    elif name == 'scroll':
        # 正数向下翻，负数向上翻。
        distance = int(value or 800)
        start = 1700 if distance > 0 else 500
        adb('shell', 'input', 'swipe', '540', str(start), '540', str(start - distance), '400')
    elif name == 'shot':
        os.makedirs(f'{ROOT}/.artifacts', exist_ok=True)
        path = f'{ROOT}/.artifacts/{value}.png'
        with open(path, 'wb') as f:
            f.write(adb('exec-out', 'screencap', '-p'))
        print(path)
    elif name == 'texts':
        print([n.get('text') for n in nodes() if n.get('text')])
    elif name == 'ids':
        print([n.get('resource-id').split('/')[-1] for n in nodes() if n.get('resource-id')])
    elif name == 'launch':
        adb('shell', 'monkey', '-p', 'com.gchust.xiaodouya', '-c', 'android.intent.category.LAUNCHER', '1')
    elif name == 'stop':
        adb('shell', 'am', 'force-stop', 'com.gchust.xiaodouya')
    elif name == 'clear':
        adb('shell', 'pm', 'clear', 'com.gchust.xiaodouya')
    else:
        raise SystemExit(f'未知动作：{action}')


for item in sys.argv[1:]:
    run(item)
