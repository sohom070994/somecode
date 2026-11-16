# Test script for the Cloudflare trigger: moves the mouse in a circle a few times, then puts it back.
# Windows only, standard library only (ctypes), so nothing needs installing.
import ctypes
import math
import time

RADIUS = 100      # pixels
LOOPS = 3         # full circles
STEPS = 60        # points per circle
STEP_DELAY = 0.01 # seconds between points


class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]


user32 = ctypes.windll.user32
start = POINT()
user32.GetCursorPos(ctypes.byref(start))

# Circle around where the mouse is now: begin at its right edge so the first move is small.
cx, cy = start.x - RADIUS, start.y
for i in range(LOOPS * STEPS + 1):
    a = 2 * math.pi * i / STEPS
    user32.SetCursorPos(int(cx + RADIUS * math.cos(a)), int(cy + RADIUS * math.sin(a)))
    time.sleep(STEP_DELAY)

user32.SetCursorPos(start.x, start.y)
print(f'Moved the mouse in {LOOPS} circles of radius {RADIUS}px')
