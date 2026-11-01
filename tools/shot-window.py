"""截取 zxz 窗口，用于确认 release 版内嵌的前端真的渲染出来了。

为什么要枚举窗口：FindWindowW 按标题找，会命中同进程的小窗口（本机实测拿到的是
136x39 的一个附属窗口），所以改成枚举该进程所有可见的顶层窗口，取面积最大的。

为什么不用 PowerShell：本机安全策略拦掉了 Add-Type（运行时编译 .NET）。
PIL + ctypes 走的是纯解释路径，不受影响。
"""
import ctypes
import time
from ctypes import wintypes

from PIL import ImageGrab

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# 先用 tasklist 拿到 pid，避免依赖 psutil
import subprocess

out = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq zxz.exe", "/FO", "CSV", "/NH"],
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="ignore",
)
pids = set()
for line in out.stdout.splitlines():
    parts = [p.strip('"') for p in line.split('","')]
    if len(parts) >= 2 and parts[0].lower() == "zxz.exe":
        try:
            pids.add(int(parts[1]))
        except ValueError:
            pass
print("zxz 进程:", pids or "无")

if not pids:
    raise SystemExit(1)

EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
found = []


def cb(hwnd, _):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value not in pids:
        return True
    if not user32.IsWindowVisible(hwnd):
        return True
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w > 200 and h > 200:
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        found.append((w * h, hwnd, w, h, rect.left, rect.top, buf.value))
    return True


user32.EnumWindows(EnumProc(cb), 0)

if not found:
    print("没有找到尺寸合理的可见窗口")
    raise SystemExit(2)

found.sort(reverse=True)
_, hwnd, w, h, left, top, title = found[0]
print("选中窗口:", repr(title), w, "x", h, "位于", left, top)

user32.ShowWindow(hwnd, 9)
user32.SetForegroundWindow(hwnd)
time.sleep(1.5)

img = ImageGrab.grab(bbox=(left, top, left + w, top + h), all_screens=True)
path = r"F:\zhuomian\zxz\tools\shots\release-window.png"
img.save(path)
print("已保存:", path, img.size)
