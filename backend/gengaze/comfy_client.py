"""Async client for ComfyUI.

Replaces the legacy filesystem-polling pattern in legacy main.py:252-259 with a
websocket subscription that ComfyUI itself drives. We:

1. POST the workflow JSON to ``/prompt`` → ComfyUI returns a ``prompt_id``.
2. Open a websocket to ``/ws?clientId=<uuid>`` and listen for messages.
3. When ComfyUI broadcasts ``{"type": "executed", "data": {"prompt_id":
   <ours>, "node": <output_node>, "output": {...}}}`` we have the result.
4. For image outputs: fetch raw bytes via ``/view?filename=&subfolder=&type=``.
The whole exchange is request-scoped — one ws connection per generation —
which is simpler than a long-lived pooled connection and adequate for
single-user latency profiles.
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
import websockets

log = logging.getLogger(__name__)


# Node class types that emit a final image we want to return to the caller.
# Excludes mask/debug preview nodes like ``MaskPreview+`` even though those
# *also* fire ``executed`` events with images attached. Listed in priority
# order — the first class found in the workflow wins.
_IMAGE_OUTPUT_CLASS_TYPES = ("SaveImage", "PreviewImage")


def pick_image_output_node(prompt: dict[str, Any]) -> str | None:
    """Identify the workflow's terminal image-output node.

    Workflows can have multiple ``OUTPUT_NODE``-marked nodes (e.g. a
    ``SaveImage`` plus a ``MaskPreview+`` for debugging). ComfyUI fires an
    ``executed`` websocket event for each of them, in execution order — and
    if we just take the first event we get the mask, not the generated
    image (the bug this function fixes).

    Strategy: scan the workflow dict for the highest-priority output class
    we recognize, and return the last node of that class (in dict order —
    typical ComfyUI convention puts the final save node late). Returns
    ``None`` if no candidate is found, in which case the caller falls back
    to the generic "first executed event" behaviour.
    """
    found: dict[str, list[str]] = {c: [] for c in _IMAGE_OUTPUT_CLASS_TYPES}
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        cls = node.get("class_type")
        if cls in found:
            found[cls].append(str(node_id))
    for cls in _IMAGE_OUTPUT_CLASS_TYPES:
        if found[cls]:
            return found[cls][-1]
    return None


class ComfyError(RuntimeError):
    """Raised when ComfyUI returns an error or times out."""


class ComfyExecutionError(ComfyError):
    """Raised when ComfyUI broadcasts an ``execution_error`` event.

    Distinct from generic ``ComfyError`` so callers can branch on
    workflow-execution failures (e.g. a cloud-provider node like
    ``GeminiStudio`` refusing on policy grounds) vs. transport-level
    issues (timeouts, no-image-output, ws closure).

    Carries ``node_id`` and ``node_type`` so the route layer can decide
    whether to surface or silently swallow the error based on which node
    failed and what the client's tolerance settings are.
    """

    def __init__(
        self, message: str, *, node_id: str | None, node_type: str | None
    ) -> None:
        super().__init__(message)
        self.node_id = node_id
        self.node_type = node_type


@dataclass
class ImageRef:
    """A pointer to an image produced by ComfyUI, fetchable via /view."""

    filename: str
    subfolder: str
    type: str  # "output" | "temp" | "input"


class ComfyClient:
    """Stateless wrapper around the ComfyUI HTTP + websocket APIs."""

    def __init__(self, host: str) -> None:
        self.host = host
        self.http_url = f"http://{host}"
        self.ws_url = f"ws://{host}/ws"

    # ── Submit ──────────────────────────────────────────────────────────

    async def submit(self, prompt: dict[str, Any], client_id: str) -> str:
        """POST a workflow to ComfyUI and return its ``prompt_id``."""
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self.http_url}/prompt",
                json={"prompt": prompt, "client_id": client_id},
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code != 200:
                raise ComfyError(
                    f"ComfyUI rejected workflow ({resp.status_code}): {resp.text}"
                )
            data = resp.json()
            prompt_id = data.get("prompt_id")
            if not prompt_id:
                raise ComfyError(f"ComfyUI returned no prompt_id: {data}")
            return prompt_id

    # ── Upload input image ──────────────────────────────────────────────

    async def upload_image(
        self,
        data: bytes,
        filename: str,
        *,
        overwrite: bool = True,
        image_type: str = "input",
    ) -> str:
        """Upload image bytes to ComfyUI via ``POST /upload/image``.

        Returns the stored name (prefixed with its subfolder if ComfyUI
        placed it in one) — that's what a ``LoadImage`` node's ``image``
        widget expects. ComfyUI may rename on collision, so callers must
        use the returned name rather than ``filename``.

        This is the API-based replacement for the old filesystem staging:
        because it goes over HTTP, gazeCOM needs no write access to
        ComfyUI's input folder and can drive a ComfyUI on any host.
        """
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self.http_url}/upload/image",
                files={"image": (filename, data, "application/octet-stream")},
                data={
                    "type": image_type,
                    "overwrite": "true" if overwrite else "false",
                },
            )
            if resp.status_code != 200:
                raise ComfyError(
                    f"ComfyUI rejected image upload ({resp.status_code}): {resp.text}"
                )
            info = resp.json()
            name = info.get("name")
            if not name:
                raise ComfyError(f"ComfyUI upload returned no name: {info}")
            subfolder = info.get("subfolder") or ""
            return f"{subfolder}/{name}" if subfolder else name

    # ── Submit + wait for output (websocket) ────────────────────────────

    async def _connect_ws(
        self, client_id: str, *, attempts: int = 3, backoff: float = 0.5
    ) -> Any:
        """Open the result websocket, retrying transient cold-start failures.

        Force IPv4 (``family=AF_INET``): ``websockets`` resolves the host via
        ``getaddrinfo``, which for an mDNS ``.local`` name can return an IPv6
        (link-local) address it then hangs on during the opening handshake —
        even when plain HTTP to the same host works (httpx prefers IPv4 /
        Happy-Eyeballs). Pinning IPv4 makes the ws resolve exactly like our
        HTTP calls do.

        The retry loop absorbs the *first-generation* flake: a cold mDNS
        cache or a transient reset makes the very first connect throw
        (``OSError`` / a websockets error) while the second succeeds — the
        "first gen fails, second lands" symptom. Retrying here turns that
        into a silent internal retry. Raises ``ComfyError`` (never a raw
        exception) when every attempt fails.
        """
        url = f"{self.ws_url}?clientId={client_id}"
        last: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                return await websockets.connect(
                    url, family=socket.AF_INET, open_timeout=10
                )
            except (OSError, websockets.WebSocketException, TimeoutError) as e:
                last = e
                log.warning(
                    "ws connect attempt %d/%d to %s failed: %r",
                    attempt,
                    attempts,
                    url,
                    e,
                )
                if attempt < attempts:
                    await asyncio.sleep(backoff * attempt)
        raise ComfyError(
            f"Could not open websocket to ComfyUI after {attempts} attempts: {last!r}"
        )

    async def _submit_and_wait(
        self,
        prompt: dict[str, Any],
        client_id: str,
        node_id: str | None,
        timeout: float,
    ) -> dict[str, Any]:
        """Open the ws, THEN submit, THEN wait for the target node's output.

        Ordering matters: ComfyUI sends the ``executed`` event to the
        *submitting client's* socket and drops it if that socket isn't
        registered yet (server.py: ``elif sid in self.sockets``). If we
        submitted first and connected second, a fast generation could
        finish — and its event fire — before our ws is registered, and
        we'd wait forever. Over a LAN the ws handshake latency rivals a
        fast (nunchaku) generation, so that race is lost intermittently.
        Connecting before submitting guarantees the socket exists.

        If ``node_id`` is None, returns the first ``executed`` event for
        our prompt (covers single-output workflows).
        """
        captured: dict[str, str] = {}

        async def _run() -> dict[str, Any]:
            async with await self._connect_ws(client_id) as ws:
                # Socket now registered — safe to submit.
                prompt_id = await self.submit(prompt, client_id)
                captured["prompt_id"] = prompt_id
                log.info(
                    "ComfyUI prompt submitted: %s (target output node: %s)",
                    prompt_id,
                    node_id or "<first event>",
                )
                async for raw in ws:
                    if isinstance(raw, bytes):
                        # ComfyUI sends preview image binaries as bytes — ignore.
                        continue
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    msg_type = msg.get("type")
                    data = msg.get("data", {})
                    if data.get("prompt_id") != prompt_id:
                        continue

                    # `execution_error` events fire when a node throws during
                    # execution (cloud provider rejected, model load failed,
                    # etc.). Without this branch we'd wait until the full
                    # timeout for something already known to have failed.
                    if msg_type == "execution_error":
                        raise ComfyExecutionError(
                            f"ComfyUI execution error on node "
                            f"{data.get('node_id')} "
                            f"({data.get('node_type')}): "
                            f"{data.get('exception_message') or data.get('exception_type')}",
                            node_id=data.get("node_id"),
                            node_type=data.get("node_type"),
                        )

                    if msg_type != "executed":
                        continue
                    if node_id is not None and data.get("node") != node_id:
                        continue

                    output = data.get("output") or {}
                    return output  # type: ignore[no-any-return]
            raise ComfyError("Websocket closed before executed event arrived.")

        try:
            return await asyncio.wait_for(_run(), timeout=timeout)
        except TimeoutError as e:
            pid = captured.get("prompt_id", "<unsubmitted>")
            raise ComfyError(
                f"Timed out after {timeout}s waiting for prompt {pid}"
            ) from e
        except ComfyError:
            # Already a clean, typed error (submit rejection, connect
            # exhaustion, execution error) — let the route surface it as a
            # 500 with a proper `detail`.
            raise
        except Exception as e:
            # Any other transport-level failure (a ws error mid-stream, an
            # unexpected disconnect) must NOT escape as a bare Starlette 500
            # ("Internal Server Error" with no detail). Wrap it so the route's
            # `except ComfyError` catches it and the client gets a message.
            pid = captured.get("prompt_id", "<unsubmitted>")
            raise ComfyError(
                f"Websocket exchange failed for prompt {pid}: {e!r}"
            ) from e

    # ── Fetch image bytes ───────────────────────────────────────────────

    async def fetch_image(self, ref: ImageRef) -> bytes:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{self.http_url}/view",
                params={
                    "filename": ref.filename,
                    "subfolder": ref.subfolder,
                    "type": ref.type,
                },
            )
            if resp.status_code != 200:
                raise ComfyError(
                    f"Failed to fetch image {ref}: {resp.status_code} {resp.text}"
                )
            return resp.content

    # ── High-level helpers ──────────────────────────────────────────────

    async def run_for_image(
        self,
        prompt: dict[str, Any],
        timeout: float,
    ) -> bytes:
        """Submit a workflow, wait for its terminal image output, return PNG bytes.

        We resolve the target output node from the workflow JSON before
        submitting so we don't get fooled by intermediate ``executed`` events
        (e.g. a ``MaskPreview+`` debug node firing before the real
        ``SaveImage``). If the workflow has only one output node — or one we
        don't recognize — we fall back to "first executed event" behaviour.
        """
        client_id = str(uuid.uuid4())
        target_node = pick_image_output_node(prompt)
        output = await self._submit_and_wait(prompt, client_id, target_node, timeout)
        images = output.get("images") or []
        if not images:
            raise ComfyError(f"Workflow produced no images: {output}")

        first = images[0]
        ref = ImageRef(
            filename=first["filename"],
            subfolder=first.get("subfolder", ""),
            type=first.get("type", "output"),
        )
        return await self.fetch_image(ref)
