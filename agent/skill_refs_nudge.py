"""Deterministic reminder: a loaded skill's references must actually be read.

skill_view(name) returns the full SKILL.md plus a linked_files manifest, and
both the system prompt and the result's usage_hint tell the model to read the
matching references/*.md before acting. Small models routinely ignore that
soft guidance (observed on the Sarä Desktop MiniMax path: skill loaded, zero
references read, straight to the browser). This module is the hard backstop:

- after every skill_view(name) whose result lists reference files, the skill
  is recorded as "pending references";
- a skill_view(name, file_path=...) read clears the pending state for that
  skill;
- the first NON-skill tool executed while any skill is pending gets a one-line
  reminder appended to its tool result, listing the exact skill_view calls to
  make. Each skill is nudged at most once per run so a deliberate skip never
  turns into a nag loop.

State lives on the agent object via getattr/setattr so no __init__ wiring is
needed and background/curator agents (which build bare agents) stay unaffected.
"""

import json
import logging

logger = logging.getLogger(__name__)

# Tools that are part of "loading context" rather than "acting" — never
# trigger the reminder. skill_view itself is handled separately.
_CONTEXT_TOOLS = frozenset({"skills_list", "skill_view", "skill_manage", "todo"})

_PENDING_ATTR = "_skill_refs_pending"   # dict: skill name -> list of reference paths
_NUDGED_ATTR = "_skill_refs_nudged"     # set: skill names already reminded once


def note_skill_view(agent, args, result) -> None:
    """Record pending/satisfied reference state after a skill_view call."""
    try:
        if not isinstance(result, str):
            return
        name = (args or {}).get("name") or ""
        file_path = (args or {}).get("file_path")
        pending = getattr(agent, _PENDING_ATTR, None)
        if pending is None:
            pending = {}
            setattr(agent, _PENDING_ATTR, pending)

        if file_path:
            # Reading any file inside the pack counts as following the router.
            parsed = _safe_parse(result)
            resolved = (parsed.get("name") if parsed else None) or name
            pending.pop(str(resolved), None)
            pending.pop(str(name), None)
            return

        parsed = _safe_parse(result)
        if not parsed or not parsed.get("success"):
            return
        linked = parsed.get("linked_files") or {}
        refs = linked.get("references") or []
        if not refs:
            return
        resolved = str(parsed.get("name") or name)
        nudged = getattr(agent, _NUDGED_ATTR, None) or set()
        if resolved in nudged:
            return
        pending[resolved] = [str(r) for r in refs[:12]]
    except Exception:
        logger.debug("skill_refs_nudge: note_skill_view failed", exc_info=True)


def reminder_for(agent, tool_name: str) -> str:
    """Return a reminder string to append to this tool's result, or ''.

    Fires when a non-context tool runs while skills are pending, then marks
    those skills as nudged (once per run each) and clears the pending state.
    """
    try:
        if tool_name in _CONTEXT_TOOLS:
            return ""
        pending = getattr(agent, _PENDING_ATTR, None)
        if not pending:
            return ""
        nudged = getattr(agent, _NUDGED_ATTR, None)
        if nudged is None:
            nudged = set()
            setattr(agent, _NUDGED_ATTR, nudged)

        lines = []
        for skill_name, refs in pending.items():
            nudged.add(skill_name)
            shown = ", ".join(refs[:6]) + (", …" if len(refs) > 6 else "")
            lines.append(
                f"- '{skill_name}' routes its mechanics to reference files ({shown}) "
                f"and you have read none of them. Read the one(s) matching this task "
                f"IN FULL with skill_view('{skill_name}', file_path='references/…')."
            )
        pending.clear()
        if not lines:
            return ""
        return (
            "\n\n[SKILL REFERENCES — REQUIRED] You started acting without reading "
            "the references of the skill(s) you loaded:\n" + "\n".join(lines) +
            "\nDo those reads before continuing with the task."
        )
    except Exception:
        logger.debug("skill_refs_nudge: reminder_for failed", exc_info=True)
        return ""


def _safe_parse(result: str):
    try:
        parsed = json.loads(result)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None
