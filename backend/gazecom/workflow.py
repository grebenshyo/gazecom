"""Pure helpers for ComfyUI workflow JSON manipulation.

Kept free of FastAPI/httpx dependencies so it can be unit-tested directly.
"""

from __future__ import annotations

import re
from typing import Any


def substitute_placeholders(obj: Any, replacements: dict[str, Any]) -> Any:
    """Recursively replace ``{placeholder}`` tokens in any nested string.

    Mirrors the original implementation in legacy main.py:39-47 but returns a
    new structure rather than mutating in place.

    Parameters
    ----------
    obj : Any
        Workflow JSON (dict / list / str / number / bool).
    replacements : dict[str, Any]
        Map of token -> replacement value. Tokens are expected to include
        their braces, e.g. ``{"{prompt}": "a cat"}``.
    """
    if isinstance(obj, dict):
        return {k: substitute_placeholders(v, replacements) for k, v in obj.items()}
    if isinstance(obj, list):
        return [substitute_placeholders(item, replacements) for item in obj]
    if isinstance(obj, str):
        out = obj
        for token, value in replacements.items():
            # A declared default keeps workflow-specific configuration inside
            # the JSON while still letting the UI override it at run time:
            # {steps:6} is substituted by the same value as {steps}.
            if token.startswith("{") and token.endswith("}"):
                name = re.escape(token[1:-1])
                out = re.sub(rf"\{{{name}:[^{{}}]+\}}", str(value), out)
            out = out.replace(token, str(value))
        return out
    return obj
