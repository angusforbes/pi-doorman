#!/usr/bin/env python3
"""J412 keys on a plain message through a real PTY and bracketed paste (the actual runView, a fake review provider; all state in a
temp dir). J412: "1 <answer>" on a host agent's question (a pasted answer with control or formatting
characters is refused; a clean one decides); then, on a plain message, 1+ with a time and 2 with text.
Usage: python3 test/pty/answer-paste.py [REPO]
"""
import json
import os
import pathlib
import pty
import select
import subprocess
import sys
import tempfile
import time

repo = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2]).resolve()
provider = pathlib.Path(__file__).with_name("answer-provider.mjs").resolve()
with tempfile.TemporaryDirectory(prefix="pi-doorman-pty-") as tmp:
    capture = pathlib.Path(tmp) / "decisions.jsonl"
    env = {**os.environ, "PI_DOORMAN_STATE": tmp + "/state", "PI_DOORMAN_REVIEW_MODULE": str(provider), "REVIEW_CAPTURE": str(capture), "REVIEW_CHOICES": "1,1+,2", "REVIEW_ANSWER": "0"}
    master, slave = pty.openpty()
    code = "import {runView} from " + json.dumps(str(repo / "src/view.mjs")) + ";runView('view','test','--write')"
    child = subprocess.Popen(["node", "--input-type=module", "-e", code], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    screen = bytearray()

    def drain(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], max(0, end - time.monotonic()))[0]:
                try:
                    screen.extend(os.read(master, 65536))
                except OSError:
                    break

    def send(text):
        os.write(master, text.encode())
        drain(0.25)

    def decisions():
        return [json.loads(row) for row in capture.read_text().splitlines()] if capture.exists() else []

    try:
        drain(2.5)
        steps = [("1+ 2h keep it short\r", {"k": "1+", "note": "keep it short", "minutes": 120}),
                 ("1+\r", {"k": "1+", "note": "", "minutes": 60}),
                 ("1+ 12h\r", {"k": "1+", "note": "", "minutes": 480}),
                 ("1 thanks\r", {"k": "1", "note": "thanks"}),
                 ("2 not on task\r", {"k": "2", "note": "not on task"}),
                 ("2\r", {"k": "2", "note": ""})]
        for keys, want in steps:
            n = len(decisions()); send(keys); drain(0.5)
            got = decisions()[n:]
            assert len(got) == 1, f"{keys!r}: {got}"
            g = {k: v for k, v in got[0].items() if k != "id"}; g.setdefault("note", "")
            assert g == want, f"{keys!r}: {g} != {want}"
            print("PASS", repr(keys), "->", g)
        for keys in ["1+ 3m\r", "e\r", "r note\r", "a yes\r", "3\r"]:
            n = len(decisions()); send(keys); drain(0.5)
            assert len(decisions()) == n, f"{keys!r} decided"
            print("PASS refused/ignored", repr(keys))
    finally:
        child.terminate()
        child.wait(timeout=5)
        os.close(master)
