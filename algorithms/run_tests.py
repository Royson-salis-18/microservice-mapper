"""Run the tests of the five core files:  python3 algorithms/run_tests.py
(The longer versions in detailed/ have their own: python3 algorithms/detailed/run_all_tests.py)"""
import pathlib
import subprocess
import sys

here = pathlib.Path(__file__).resolve().parent
bad = 0
for t in sorted(here.glob("test_*.py")):
    ok = subprocess.run([sys.executable, str(t)], capture_output=True, text=True).returncode == 0
    print("ok     " if ok else "FAILED", t.name)
    bad += not ok
sys.exit(1 if bad else 0)
