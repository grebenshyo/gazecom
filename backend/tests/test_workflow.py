"""Tests for workflow.substitute_placeholders.

These cover the behavior the legacy main.py:39-47 had implicitly: nested
substitution in dicts/lists, repeated tokens, missing tokens (no-op), and
non-string values pass through untouched.
"""

from __future__ import annotations

from gengaze.workflow import substitute_placeholders


def test_replaces_token_in_string() -> None:
    assert substitute_placeholders("hello {name}", {"{name}": "world"}) == "hello world"


def test_replaces_repeated_tokens() -> None:
    assert (
        substitute_placeholders("{x} and {x}", {"{x}": "Q"})
        == "Q and Q"
    )


def test_missing_token_is_left_intact() -> None:
    assert substitute_placeholders("hi {nope}", {"{name}": "X"}) == "hi {nope}"


def test_recurses_into_dicts_and_lists() -> None:
    obj = {"a": "{p}", "b": [1, "{p}", {"c": "{p}!"}]}
    assert substitute_placeholders(obj, {"{p}": "Z"}) == {
        "a": "Z",
        "b": [1, "Z", {"c": "Z!"}],
    }


def test_non_strings_pass_through() -> None:
    assert substitute_placeholders(42, {"{x}": "y"}) == 42
    assert substitute_placeholders(None, {"{x}": "y"}) is None
    assert substitute_placeholders(True, {"{x}": "y"}) is True


def test_numeric_replacement_is_stringified() -> None:
    """Legacy code did str(val) when substituting; preserve that contract."""
    assert substitute_placeholders("steps: {steps}", {"{steps}": 30}) == "steps: 30"


def test_replaces_placeholder_with_declared_default() -> None:
    assert substitute_placeholders("{steps:6}", {"{steps}": 12}) == "12"


def test_returns_new_structure_does_not_mutate() -> None:
    original = {"a": "{p}", "b": ["{p}"]}
    result = substitute_placeholders(original, {"{p}": "X"})
    # Original untouched
    assert original == {"a": "{p}", "b": ["{p}"]}
    # Result has substitution
    assert result == {"a": "X", "b": ["X"]}
