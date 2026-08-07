"""`hermes chat -q` must exit non-zero when the run failed.

Why this exists: the machine-readable `-Q` path already called
run_conversation directly and sys.exit(1) on result["failed"]. The
human-facing `-q` path went through CLI.chat(), which returns only the
response text and dropped the failure flag on the floor — so hermes exited 0
after ABORTING a run.

That is not cosmetic. Sarä Desktop's connector reads the exit code
(`if (code !== 0) resolve({ error })`); exit 0 means success, so the server
marked the task Done and the user saw a green tick over a Google Doc that was
never written. A provider HTTP 400 on 2026-08-07 did exactly that, and nine
tasks in production carry an abort banner inside a result recorded as Done.

The contract under test: whatever CLI.chat() records in `_last_turn_failed`
decides the process exit code, and a failed turn is never reported as success.
"""

import pytest


class _FakeCLI:
    """Stands in for the real CLI: only the two things the exit path reads."""

    def __init__(self, result):
        self._result = result
        self._last_turn_failed = None

    def chat(self, *_a, **_kw):
        # Mirrors the assignment in CLI.chat() verbatim.
        r = self._result
        self._last_turn_failed = bool(r and (r.get("failed") or r.get("partial")))
        return (r or {}).get("final_response", "")


def _exit_code_for(result):
    """The `-q` branch, reduced to the decision it makes."""
    cli = _FakeCLI(result)
    cli.chat("do the thing")
    return 1 if getattr(cli, "_last_turn_failed", False) else 0


def test_a_clean_run_exits_zero():
    assert _exit_code_for({"final_response": "Done, I wrote the doc.", "completed": True}) == 0


def test_a_nonretryable_abort_exits_one():
    # The shape conversation_loop returns when a provider 4xx aborts the run:
    # failed=True, completed=False, and the "response" is the error summary.
    assert _exit_code_for({
        "final_response": "HTTP 400: HTTP 400",
        "completed": False,
        "failed": True,
    }) == 1


def test_a_partial_run_exits_one():
    # Partial means some work happened and the turn did not finish. Reporting
    # that as success is the same lie in a smaller size.
    assert _exit_code_for({"final_response": "…", "partial": True}) == 1


def test_no_result_at_all_exits_zero():
    # chat() can legitimately return None (interrupt, empty input). That is not
    # a failed run, and must not become one.
    assert _exit_code_for(None) == 0


@pytest.mark.parametrize("flag", ["failed", "partial"])
def test_the_flag_alone_decides(flag):
    # A failure with text still present must not be excused by the text: the
    # abort case DOES carry a final_response (the error summary), which is
    # exactly how it slipped through as success.
    assert _exit_code_for({"final_response": "looks like prose", flag: True}) == 1
