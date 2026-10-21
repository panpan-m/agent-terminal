"""The exit marker must be shell-generic and immune to console echo."""

import re

from tio_server.mcp.tools import build_exit_marker


def _nonce(pattern: str) -> str:
    return re.search(r"__TIO_(m[0-9a-f]+):", pattern).group(1)


def test_marker_is_split_so_echo_never_matches():
    full, pattern = build_exit_marker("echo hi")
    nonce = _nonce(pattern)

    assert full.startswith("echo hi\n")
    assert "rc=$?" in full
    # The joined marker must not appear in the command text (only parts do).
    assert f"__TIO_{nonce}" not in full
    assert "__TIO_" in full and nonce in full

    # What the terminal echoes back: the command line flattened.
    echoed = "root@board:~# " + full.replace("\n", " ; ")
    assert re.search(pattern, echoed) is None

    output = f"hi\r\n__TIO_{nonce}:0\r\n"
    match = re.search(pattern, output)
    assert match is not None
    assert match.group(1) == "0"


def test_marker_captures_failure_status():
    _, pattern = build_exit_marker("false")
    nonce = _nonce(pattern)
    match = re.search(pattern, f"\r\n__TIO_{nonce}:2\r\n")
    assert match is not None
    assert match.group(1) == "2"


def test_marker_keeps_multiline_and_heredoc_commands_intact():
    command = "cat <<'EOF'\na\nb\nEOF"
    full, pattern = build_exit_marker(command)
    assert full.startswith(command + "\n")
    marker_line = full.splitlines()[-1]
    assert marker_line.startswith("rc=$?")
    assert re.search(pattern, f"a\r\nb\r\n__TIO_{_nonce(pattern)}:0\r\n") is not None


def test_marker_handles_empty_command():
    full, pattern = build_exit_marker("")
    assert full.startswith("rc=$?")
    assert re.search(pattern, f"__TIO_{_nonce(pattern)}:0") is not None


def test_marker_does_not_match_printf_output_of_its_own_parts():
    full, pattern = build_exit_marker("true")
    nonce = _nonce(pattern)
    # A device that prints both halves separately must not be mistaken for a match.
    assert re.search(pattern, f"__TIO_\n{nonce}:0") is None
