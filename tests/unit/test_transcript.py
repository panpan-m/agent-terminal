import json

from tio_server.transcript import Redactor, TranscriptWriter


def test_transcript_writes_and_tails(tmp_path):
    w = TranscriptWriter(tmp_path, "board-a", max_file_mb=1, max_files=2)
    w.event("open", port="COM5")
    w.data("rx", 0, b"hello", "device")
    w.close()
    events = w.tail(10)
    assert events[0]["event"] == "open"
    assert events[1]["dir"] == "rx"
    assert events[1]["offset"] == 0
    assert events[1]["len"] == 5


def test_transcript_rotates(tmp_path):
    w = TranscriptWriter(tmp_path, "s", max_file_mb=1, max_files=3)
    w.max_bytes = 800  # ~5 records per file
    for i in range(50):
        w.data("rx", i, b"x" * 10, "device")
    w.close()
    files = w.files()
    assert len(files) >= 3
    # the newest files are always readable through tail()
    events = w.tail(5)
    assert len(events) == 5
    assert events[-1]["offset"] == 49


def test_redaction(tmp_path):
    red = Redactor([r"(?i)password\s*[:=]\s*\S+"])
    w = TranscriptWriter(tmp_path, "s", redactor=red)
    w.event("note", text="password=hunter2")
    w.close()
    line = w.path.read_text(encoding="utf-8").strip()
    record = json.loads(line)
    assert "hunter2" not in record["text"]
    assert "***" in record["text"]
