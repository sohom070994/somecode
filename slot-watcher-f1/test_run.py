# Run by test.bat: runs test_final.move_to_target_and_click() unchanged, and prints every cursor
# position it went through (start, each stop, the click, where it ended) for test-logs.
import sys

sys.path.insert(0, r"C:\Users\tck07\OneDrive\Documents\GitHub\Test")
import test_final as t  # noqa: E402

stops = []
clicks = []
orig_move, orig_click = t.curvy_move, t.click


def curvy_move(start, end, duration):
    orig_move(start, end, duration)
    stops.append((tuple(end), t.get_cursor_pos()))


def click():
    clicks.append(t.get_cursor_pos())
    orig_click()


t.curvy_move, t.click = curvy_move, click

start = t.get_cursor_pos()
t.move_to_target_and_click()
end = t.get_cursor_pos()

print(f"screen:  {t.user32.GetSystemMetrics(0)} x {t.user32.GetSystemMetrics(1)}")
print(f"target:  {t.TARGET_POS}")
print(f"start:   {start}")
for i, (aim, at) in enumerate(stops, 1):
    print(f"move {i}:  aimed {aim}, cursor at {at}")
for c in clicks:
    print(f"clicked: {c}{'' if c == tuple(t.TARGET_POS) else '  <-- NOT on target'}")
print(f"end:     {end}")
