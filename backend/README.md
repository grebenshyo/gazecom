# gazeCOM backend

FastAPI server that proxies image-generation requests to ComfyUI and language
or vision requests to Ollama.

## Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp ../.env.example ../.env           # then edit paths for your machine
```

## Run

```bash
uvicorn gengaze.main:app --reload --port 8000
# or:
gazecom-backend
```

Health check: <http://localhost:8000/api/health>

## Tests

```bash
pytest
ruff check .
```

## Layout

- `gengaze/config.py` — `Settings` loaded from `.env` via pydantic-settings
- `gengaze/workflow.py` — pure helpers (placeholder substitution)
- `gengaze/main.py` — FastAPI app factory
- `gengaze/routes/` - runtime configuration, workflow catalog, images,
  generation, and Ollama LLM/VLM endpoints. `/api/llm/models` returns the
  installed Ollama tags; model choice remains a frontend/user decision.
- `tests/` — pytest

## Status

The backend is the production API and static server used by both source and
packaged builds. Its historical Python import name remains `gengaze` for
compatibility; the distribution and command use the gazeCOM name.
