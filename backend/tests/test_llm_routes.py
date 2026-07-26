from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pytest_httpx import HTTPXMock

from gengaze.config import Settings, get_settings
from gengaze.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("APPDATA", str(tmp_path))
    workflows = tmp_path / "workflows"
    images = tmp_path / "images"
    workflows.mkdir()
    images.mkdir()
    settings = Settings(
        workflows_dir=workflows,
        images_dir=images,
        ollama_host="ollama.local:11434",
    )
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


def test_llm_models_lists_ollama_tags(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="GET",
        url="http://ollama.local:11434/api/tags",
        json={
            "models": [
                {
                    "name": "zeta:latest",
                    "capabilities": ["thinking", "completion"],
                    "details": {"family": "qwen3"},
                },
                {
                    "name": "gemma4:latest",
                    "capabilities": ["thinking", "completion"],
                    "details": {"family": "gemma4"},
                },
                {
                    "name": "gpt-oss:20b",
                    "capabilities": ["thinking", "completion"],
                    "details": {"family": "gptoss"},
                },
                {"name": "mistral:latest"},
                {"not_name": "ignored"},
            ]
        },
    )
    resp = client.get("/api/llm/models")

    assert resp.status_code == 200
    assert resp.json() == {
        "models": [
            {
                "name": "gemma4:latest",
                "capabilities": ["completion", "thinking"],
                "thinking_modes": ["off", "low", "medium", "high", "max"],
            },
            {
                "name": "gpt-oss:20b",
                "capabilities": ["completion", "thinking"],
                "thinking_modes": ["low", "medium", "high"],
            },
            {"name": "mistral:latest", "capabilities": [], "thinking_modes": []},
            {
                "name": "zeta:latest",
                "capabilities": ["completion", "thinking"],
                "thinking_modes": ["off", "on"],
            },
        ]
    }


def test_llm_describe_calls_ollama_chat_with_image(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={
            "message": {
                "content": "weathered copper greenhouse, foggy morning light",
            }
        },
    )

    resp = client.post(
        "/api/llm/describe",
        data={
            "model": "llava:latest",
            "prompt": "Describe this as a prompt.",
            "think": "false",
        },
        files={"image": ("frame.png", b"png-bytes", "image/png")},
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "weathered copper greenhouse, foggy morning light"}
    request = httpx_mock.get_request()
    assert request is not None
    body = json.loads(request.read())
    assert body["model"] == "llava:latest"
    assert "system" not in body
    assert body["messages"] == [
        {
            "role": "user",
            "content": "Describe this as a prompt.",
            "images": ["cG5nLWJ5dGVz"],
        }
    ]
    assert body["think"] is False
    assert body["stream"] is False
    assert body["keep_alive"] == 0
    assert body["options"]["num_predict"] == 2048


def test_llm_describe_keeps_ollama_model_loaded_when_configured(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    config_resp = client.put(
        "/api/config",
        json={"ollama_keep_model_loaded": True},
    )
    assert config_resp.status_code == 200
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"response": "blue porcelain bird shrine, soft window light"},
    )

    resp = client.post(
        "/api/llm/describe",
        data={"model": "moondream:latest", "prompt": "describe"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    request = httpx_mock.get_request()
    assert request is not None
    body = json.loads(request.read())
    assert body["keep_alive"] == -1
    assert body["messages"][0]["content"] == "describe"


def test_llm_describe_omits_think_when_not_requested(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": "small brass owl, dusty window light"}},
    )

    resp = client.post(
        "/api/llm/describe",
        data={"model": "llava:latest", "prompt": "describe"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "small brass owl, dusty window light"}
    requests = httpx_mock.get_requests()
    assert len(requests) == 1
    first_body = json.loads(requests[0].read())
    assert "think" not in first_body
    assert first_body["messages"][0]["images"] == ["aW1hZ2U="]


def test_llm_describe_falls_back_to_generate_when_chat_empty(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": ""}},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": "red lacquer bridge, river mist, miniature scale"},
    )

    resp = client.post(
        "/api/llm/describe",
        data={"model": "llava:latest", "prompt": "describe", "think": "low"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "text": "red lacquer bridge, river mist, miniature scale",
    }
    requests = httpx_mock.get_requests()
    assert len(requests) == 2
    fallback_body = json.loads(requests[1].read())
    assert fallback_body["prompt"] == "describe"
    assert fallback_body["images"] == ["aW1hZ2U="]
    assert fallback_body["think"] == "low"


def test_llm_describe_rejects_empty_prompt(
    client: TestClient,
) -> None:
    resp = client.post(
        "/api/llm/describe",
        data={"model": "moondream:latest", "prompt": ""},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 400
    assert "Vision prompt is empty" in resp.text


def test_llm_describe_reports_empty_response(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": ""}},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": ""},
    )

    resp = client.post(
        "/api/llm/describe",
        data={"model": "llava:latest", "prompt": "describe"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 502
    assert "empty image description" in resp.text
    assert "chat+default: empty image description" in resp.text
    assert "generate+default: empty image description" in resp.text


def test_llm_point_parses_grid_json(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": '{"x": 512, "y": 380}'}},
    )

    resp = client.post(
        "/api/llm/point",
        data={"model": "qwen2.5vl:latest"},
        files={"image": ("frame.png", b"png-bytes", "image/png")},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["x"] == pytest.approx(0.512)
    assert body["y"] == pytest.approx(0.380)
    # Default POINT_SYSTEM_PROMPT is used when the client sends no prompt.
    request = httpx_mock.get_request()
    assert request is not None
    sent = json.loads(request.read())
    assert "0-1000 grid" in sent["messages"][0]["content"]
    assert sent["messages"][0]["images"] == ["cG5nLWJ5dGVz"]
    assert sent["options"]["temperature"] == 0.1


def test_llm_point_extracts_coords_from_prose(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": "The salient point is at (512, 380)."}},
    )

    resp = client.post(
        "/api/llm/point",
        data={"model": "llava:latest"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["x"] == pytest.approx(0.512)
    assert body["y"] == pytest.approx(0.380)


def test_llm_point_accepts_normalized_floats(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": '{"x": 0.5, "y": 0.3}'}},
    )

    resp = client.post(
        "/api/llm/point",
        data={"model": "moondream:latest"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["x"] == pytest.approx(0.5)
    assert body["y"] == pytest.approx(0.3)


def test_llm_point_honors_prompt_override(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": "x=100 y=900"}},
    )

    resp = client.post(
        "/api/llm/point",
        data={"model": "qwen2.5vl:latest", "prompt": "Point at the darkest spot."},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    request = httpx_mock.get_request()
    assert request is not None
    sent = json.loads(request.read())
    assert sent["messages"][0]["content"] == "Point at the darkest spot."


def test_llm_point_returns_422_when_no_coordinates(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": "I cannot find a clear point."}},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": "I cannot find a clear point."},
    )

    resp = client.post(
        "/api/llm/point",
        data={"model": "llava:latest"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 422
    assert "no coordinates in response" in resp.text


def test_llm_point_returns_502_on_transport_failure(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        status_code=404,
        text="model not found",
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        status_code=404,
        text="model not found",
    )

    resp = client.post(
        "/api/llm/point",
        data={"model": "missing"},
        files={"image": ("frame.png", b"image", "image/png")},
    )

    assert resp.status_code == 502
    assert "model not found" in resp.text


def test_llm_agent_decision_uses_structured_output(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={
            "message": {
                "content": (
                    '{"x": 742, "y": 381, '
                    '"instruction": "Erase the red figure and extend the wall."}'
                )
            }
        },
    )

    resp = client.post(
        "/api/llm/decision",
        data={
            "model": "gemma3:latest",
            "prompt": "Choose the next edit and return JSON.",
        },
        files={"image": ("canvas.png", b"canvas-bytes", "image/png")},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "x": pytest.approx(0.742),
        "y": pytest.approx(0.381),
        "instruction": "Erase the red figure and extend the wall.",
    }
    request = httpx_mock.get_request()
    assert request is not None
    sent = json.loads(request.read())
    assert sent["messages"][0]["content"] == ("Choose the next edit and return JSON.")
    assert sent["messages"][0]["images"] == ["Y2FudmFzLWJ5dGVz"]
    assert set(sent["format"]["properties"]) == {"x", "y", "instruction"}
    assert sent["format"]["properties"]["instruction"]["minLength"] == 1
    assert sent["options"]["temperature"] == 0.1


def test_llm_agent_decision_accepts_normalized_coordinates(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={
            "message": {
                "content": '{"x":0.25,"y":0.75,"instruction":"Add a doorway."}'
            }
        },
    )

    resp = client.post(
        "/api/llm/decision",
        data={"model": "gemma3:latest", "prompt": "Choose an edit."},
        files={"image": ("canvas.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "x": pytest.approx(0.25),
        "y": pytest.approx(0.75),
        "instruction": "Add a doorway.",
    }


def test_llm_agent_decision_accepts_qwen_json_in_thinking_field(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={
            "message": {
                "content": "",
                "thinking": (
                    '{"x":640,"y":210,'
                    '"instruction":"Extend the architecture into the upper right."}'
                ),
            }
        },
    )

    resp = client.post(
        "/api/llm/decision",
        data={
            "model": "qwen3-vl:8b",
            "prompt": "Choose an edit.",
            "think": "false",
        },
        files={"image": ("canvas.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "x": pytest.approx(0.64),
        "y": pytest.approx(0.21),
        "instruction": "Extend the architecture into the upper right.",
    }


def test_llm_agent_decision_resends_applied_action_history(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={
            "message": {
                "content": (
                    '{"x":200,"y":800,'
                    '"instruction":"Extend the landscape into the lower left."}'
                )
            }
        },
    )

    prompt = "Continue building the composition and return JSON."
    resp = client.post(
        "/api/llm/decision",
        data={
            "model": "gemma4:latest",
            "prompt": prompt,
            "think": "low",
            "history": json.dumps(
                [
                    {
                        "x": 0.5,
                        "y": 0.5,
                        "instruction": "Establish the central portrait.",
                    }
                ]
            ),
        },
        files={"image": ("canvas.png", b"latest-canvas", "image/png")},
    )

    assert resp.status_code == 200
    request = httpx_mock.get_request()
    assert request is not None
    sent = json.loads(request.read())
    assert sent["think"] == "low"
    assert sent["messages"] == [
        {"role": "user", "content": prompt},
        {
            "role": "assistant",
            "content": (
                '{"x":500.0,"y":500.0,'
                '"instruction":"Establish the central portrait."}'
            ),
        },
        {
            "role": "user",
            "content": (
                "The crop centered at that coordinate was generated and composited."
            ),
        },
        {
            "role": "user",
            "content": prompt,
            "images": ["bGF0ZXN0LWNhbnZhcw=="],
        },
    ]


def test_llm_agent_decision_rejects_invalid_output(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": '{"x":500,"y":500,"instruction":""}'}},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": "I would change the center."},
    )

    resp = client.post(
        "/api/llm/decision",
        data={"model": "gemma3:latest", "prompt": "Choose an edit."},
        files={"image": ("canvas.png", b"image", "image/png")},
    )

    assert resp.status_code == 422
    assert "invalid agent decision" in resp.text


def test_llm_guide_decision_uses_coordinate_only_schema(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={
            "message": {
                "content": (
                    '{"x":640,"y":210,'
                    '"instruction":"A legacy field that Guide ignores."}'
                )
            }
        },
    )

    resp = client.post(
        "/api/llm/decision",
        data={
            "model": "qwen3-vl:8b",
            "prompt": "Choose the next crop location.",
            "behavior": "guide",
        },
        files={"image": ("canvas.png", b"image", "image/png")},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "x": pytest.approx(0.64),
        "y": pytest.approx(0.21),
    }
    request = httpx_mock.get_request()
    assert request is not None
    sent = json.loads(request.read())
    assert set(sent["format"]["properties"]) == {"x", "y"}


def test_llm_guide_decision_resends_coordinate_history(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": '{"x":200,"y":800}'}},
    )

    prompt = "Choose another useful location."
    resp = client.post(
        "/api/llm/decision",
        data={
            "model": "gemma4:latest",
            "prompt": prompt,
            "behavior": "guide",
            "history": json.dumps([{"x": 0.5, "y": 0.5}]),
        },
        files={"image": ("canvas.png", b"latest-canvas", "image/png")},
    )

    assert resp.status_code == 200
    request = httpx_mock.get_request()
    assert request is not None
    sent = json.loads(request.read())
    assert sent["messages"][1]["content"] == '{"x":500.0,"y":500.0}'


def test_llm_enhance_calls_ollama_chat(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"response": "  luminous ceramic frog, macro studio photograph  "},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={
            "model": "mistral",
            "prompt": "frog",
            "template": "Make this into a concise ceramic image prompt: {prompt}",
            "think": False,
        },
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "luminous ceramic frog, macro studio photograph"}
    request = httpx_mock.get_request()
    assert request is not None
    body = json.loads(request.read())
    assert body["model"] == "mistral"
    assert body["messages"] == [
        {
            "role": "user",
            "content": "Make this into a concise ceramic image prompt: frog",
        }
    ]
    assert body["think"] is False
    assert body["stream"] is False
    assert body["keep_alive"] == 0
    assert body["options"]["num_predict"] == 2048
    assert "system" not in body


def test_llm_enhance_keeps_ollama_model_loaded_when_configured(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    config_resp = client.put(
        "/api/config",
        json={"ollama_keep_model_loaded": True},
    )
    assert config_resp.status_code == 200
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"response": "warm brass fox automaton, candlelit workshop"},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "qwen3:4b", "prompt": "fox"},
    )

    assert resp.status_code == 200
    request = httpx_mock.get_request()
    assert request is not None
    body = json.loads(request.read())
    assert body["keep_alive"] == -1


def test_llm_enhance_strips_thinking_blocks(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"response": '<think>reasoning</think>\n"misty forest shrine"'},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "deepseek-r1:8b", "prompt": "forest"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "misty forest shrine"}


def test_llm_enhance_accepts_chat_shaped_response(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": "glowing moss altar, cinematic dusk"}},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "gemma3:latest", "prompt": "altar"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "glowing moss altar, cinematic dusk"}


def test_llm_enhance_omits_think_when_not_requested(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": "pearl dolphin shrine, neon surf, vapor"}},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "dolphin3:latest", "prompt": "dolphin shrine"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "pearl dolphin shrine, neon surf, vapor"}
    requests = httpx_mock.get_requests()
    assert len(requests) == 1
    first_body = json.loads(requests[0].read())
    assert "think" not in first_body
    assert first_body["keep_alive"] == 0


def test_llm_enhance_falls_back_to_generate_when_chat_empty(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"message": {"content": ""}},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": "silver moth temple, rainlit glass, macro detail"},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "gemma3:latest", "prompt": "moth", "think": "low"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "silver moth temple, rainlit glass, macro detail"}
    requests = httpx_mock.get_requests()
    assert len(requests) == 2
    fallback_body = json.loads(requests[1].read())
    assert fallback_body["think"] == "low"
    assert fallback_body["keep_alive"] == 0
    assert fallback_body["prompt"].endswith("Keep it concise.")
    assert "system" not in fallback_body


def test_llm_enhance_reports_empty_response(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"response": ""},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": ""},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "mistral", "prompt": "keep me"},
    )

    assert resp.status_code == 502
    assert "empty prompt enhancement" in resp.text
    assert "chat+default: empty prompt enhancement" in resp.text
    assert "generate+default: empty prompt enhancement" in resp.text


def test_llm_enhance_reports_hidden_thinking_without_content(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={
            "message": {
                "thinking": "I should rewrite this with more visual detail.",
                "content": "",
            },
            "done_reason": "length",
        },
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": ""},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "gemma3:latest", "prompt": "keep me"},
    )

    assert resp.status_code == 502
    assert "message_keys=content, thinking" in resp.text
    assert "content_len=0" in resp.text
    assert "thinking_len=" in resp.text


def test_llm_enhance_reports_unchanged_response(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        json={"response": "  Keep   Me  "},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        json={"response": "keep me"},
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "mistral", "prompt": "keep me"},
    )

    assert resp.status_code == 502
    assert "chat+default: prompt unchanged" in resp.text
    assert "generate+default: prompt unchanged" in resp.text


def test_llm_enhance_reports_ollama_errors(
    client: TestClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/chat",
        status_code=404,
        text="model not found",
    )
    httpx_mock.add_response(
        method="POST",
        url="http://ollama.local:11434/api/generate",
        status_code=404,
        text="model not found",
    )

    resp = client.post(
        "/api/llm/enhance",
        json={"model": "missing", "prompt": "frog"},
    )

    assert resp.status_code == 502
    assert "model not found" in resp.text
