"""Run every test file in this folder, one after the other, and say which ones failed.

    python3 algorithms/run_all_tests.py
"""
import pathlib
import subprocess
import sys

here = pathlib.Path(__file__).resolve().parent
tests = sorted(here.glob("*/test_*.py"))
failed = []
for t in tests:
    result = subprocess.run([sys.executable, str(t)], capture_output=True, text=True)
    status = "ok" if result.returncode == 0 else "FAILED"
    print(f"{status:7s} {t.relative_to(here)}")
    if result.returncode != 0:
        failed.append(t)
        print(result.stdout[-1500:], result.stderr[-1500:])
print(f"\n{len(tests) - len(failed)} of {len(tests)} test files passed")
sys.exit(1 if failed else 0)
