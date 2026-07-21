"""Discovery and validation for bundled and user ComfyUI workflows."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from gengaze.comfy_client import pick_image_output_node

WORKFLOW_CATEGORIES = ("img", "edit", "inpainting")
WORKFLOW_TYPES = {
    "img": "standard",
    "edit": "edit",
    "inpainting": "inpainting",
}

_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)(?::([^{}]+))?\}")


def _walk_strings(value: Any):
    if isinstance(value, dict):
        for item in value.values():
            yield from _walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_strings(item)
    elif isinstance(value, str):
        yield value


def _workflow_key(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _workflow_files(root: Path) -> dict[str, Path]:
    if not root.is_dir():
        return {}
    return {
        _workflow_key(path, root): path
        for path in root.rglob("*.json")
        if path.is_file()
    }


def workflow_roots(
    bundled_root: Path,
    user_root: Path | None,
) -> tuple[Path, ...]:
    """Return roots in resolution order; user files override bundled files."""
    roots: list[Path] = []
    if user_root is not None:
        roots.append(user_root)
    roots.append(bundled_root)
    return tuple(roots)


def resolve_workflow_path(
    workflow: str,
    bundled_root: Path,
    user_root: Path | None = None,
) -> Path | None:
    """Resolve a catalog key without allowing traversal or unknown categories."""
    pure = PurePosixPath(workflow)
    if pure.is_absolute() or len(pure.parts) != 2:
        return None
    category, filename = pure.parts
    if category not in WORKFLOW_CATEGORIES or filename in {"", ".", ".."}:
        return None

    for root in workflow_roots(bundled_root, user_root):
        candidate = (root / category / filename).resolve()
        root_resolved = root.resolve()
        if root_resolved not in candidate.parents:
            continue
        if candidate.is_file():
            return candidate
    return None


def inspect_workflow(path: Path, key: str) -> dict[str, Any]:
    """Build the frontend descriptor for one API-format workflow JSON file."""
    parts = PurePosixPath(key).parts
    category = parts[0] if len(parts) == 2 and parts[0] in WORKFLOW_CATEGORIES else None
    errors: list[str] = []
    warnings: list[str] = []
    workflow: Any = None

    if category is None:
        errors.append("Place the workflow directly inside img/, edit/, or inpainting/.")

    try:
        with path.open(encoding="utf-8") as fh:
            workflow = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"Invalid JSON: {exc}")

    if workflow is not None and not isinstance(workflow, dict):
        errors.append("Workflow must be a ComfyUI API-format JSON object.")

    strings = list(_walk_strings(workflow)) if isinstance(workflow, dict) else []
    matches = [match for value in strings for match in _PLACEHOLDER_RE.finditer(value)]
    placeholders = sorted({match.group(1) for match in matches})

    if isinstance(workflow, dict):
        nodes = [
            node
            for node in workflow.values()
            if isinstance(node, dict) and isinstance(node.get("class_type"), str)
        ]
        if not nodes:
            errors.append("Workflow contains no ComfyUI API nodes.")
        if "input_image" not in placeholders:
            errors.append("Missing required {input_image} placeholder.")

    step_matches = [match for match in matches if match.group(1) == "steps"]
    default_steps: int | None = None
    if any(match.group(2) is None for match in step_matches):
        errors.append("Use {steps:N} so the workflow declares its default step count.")
    declared_steps = {match.group(2) for match in step_matches if match.group(2) is not None}
    if len(declared_steps) > 1:
        errors.append("Workflow declares conflicting {steps:N} defaults.")
    elif declared_steps:
        raw_steps = next(iter(declared_steps))
        try:
            parsed_steps = int(raw_steps)
            if parsed_steps < 1:
                raise ValueError
            default_steps = parsed_steps
        except (TypeError, ValueError):
            errors.append("The {steps:N} default must be a positive integer.")

    output_node = pick_image_output_node(workflow) if isinstance(workflow, dict) else None
    if isinstance(workflow, dict) and output_node is None:
        errors.append("Missing a terminal SaveImage or PreviewImage node.")

    if "prompt" not in placeholders:
        warnings.append("No {prompt} placeholder; the prompt pool will not affect this workflow.")

    return {
        "path": key,
        "label": path.stem,
        "category": category,
        "type": WORKFLOW_TYPES.get(category) if category is not None else None,
        "default_steps": default_steps,
        "placeholders": placeholders,
        "output_node": output_node,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def scan_workflows(
    bundled_root: Path,
    user_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Merge workflow roots and return stable descriptors sorted by category/name."""
    merged = _workflow_files(bundled_root)
    if user_root is not None:
        merged.update(_workflow_files(user_root))

    category_order = {name: index for index, name in enumerate(WORKFLOW_CATEGORIES)}
    descriptors = [inspect_workflow(path, key) for key, path in merged.items()]
    return sorted(
        descriptors,
        key=lambda item: (
            category_order.get(item["category"], len(category_order)),
            item["label"].casefold(),
            item["path"].casefold(),
        ),
    )
