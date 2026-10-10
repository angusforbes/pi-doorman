#!/usr/bin/env python3
"""The window's "a <answer>" through a real PTY and bracketed paste (the actual runView, a fake review provider; all state in a
temp dir). A pasted answer with control or formatting characters is refused; a clean one decides.
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
    env = {**os.environ, "PI_DOORMAN_STATE": tmp + "/state", "PI_DOORMAN_REVIEW_MODULE": str(provider), "REVIEW_CAPTURE": str(capture)}
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
        for text in ["a yes\u202edoc.exe", "a hi\u200bthere", "a ok\x07", "a good\x1b[31mred", "a x\u2060y"]:
            before = len(decisions())
            send("\x1b[200~" + text + "\x1b[201~\r")
            assert len(decisions()) == before, "dirty paste was decided: " + repr(text)
            print("PASS dirty paste refused:", repr(text))
        assert b"(pasted)" in screen, "paste refusal feedback missing"
        send("\x1b[200~a yes\x1b[201~\r")
        assert decisions() == [{"id": "door--abc123", "k": "a", "note": "yes"}]
        print("PASS clean paste a yes still decides")
        send("\x1b[200~a x\u200b\x1b[201~")
        send("\x7f" * 3)
        send("a retyped\r")
        assert len(decisions()) == 2 and decisions()[-1]["note"] == "retyped"
        print("PASS separately emptied box clears dirty flag")
        send("\x1b[200~a x\u200b\x1b[201~")
        before = len(decisions())
        send("\x7f" * 3 + "a same-chunk-retyped\r")
        assert len(decisions()) == before + 1 and decisions()[-1]["note"] == "same-chunk-retyped", "an emptied box must forget the paste at once"
        print("PASS emptied and retyped in the same chunk still decides")
    finally:
        child.terminate()
        child.wait(timeout=5)
        os.close(master)
