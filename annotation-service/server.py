"""
Annotation Generator Service v1.0 (LLM + Mock)

Supports two modes:
  - mode=llm:  Calls LLM via Parley (OpenAI-compatible API, model set in .env)
  - mode=mock: Returns deterministic template text (fallback)

Default mode is 'llm'. If the LLM call fails for any reason, automatically
falls back to mock and marks the response with generator_id='mock-v2-fallback'.

Environment variables (in .env or exported):
  PARLEY_API_KEY      — required for LLM mode
  PARLEY_BASE_URL     — default: https://keys.theparley.org/v1
  PARLEY_MODEL        — default: gpt-4o (override to gpt-5.2 etc. in .env)
  DEFAULT_MODE        — default: llm

Runs on the gateway host at port 5001 (Decision 3).

Usage:
    pip install fastapi uvicorn httpx python-dotenv
    python server.py
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import hashlib
import uuid
import time
import os
import re
import logging
import httpx
from dotenv import load_dotenv

# Load .env from project root or annotation-service directory
load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

# ─── Configuration ───────────────────────────────────────────────────────────

PARLEY_API_KEY = os.getenv("PARLEY_API_KEY", "")
PARLEY_BASE_URL = os.getenv("PARLEY_BASE_URL", "https://keys.theparley.org/v1")
PARLEY_MODEL = os.getenv("PARLEY_MODEL", "gpt-4o")
DEFAULT_MODE = os.getenv("DEFAULT_MODE", "llm")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("annotation-service")

app = FastAPI(title="Annotation Generator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Prompt Templates ────────────────────────────────────────────────────────
# These are the raw templates BEFORE variable substitution.
# promptHash = sha256(template_text)[:16]  — changes when we edit the template.

PROMPT_TEMPLATES = {
    "ASK_ANCHOR": (
        "You are a concise object identification assistant in a mixed reality workspace.\n"
        "\n"
        "Detected object: {class_name} (confidence: {confidence:.0%})\n"
        "Tag ID: {asset_id}\n"
        "\n"
        "Provide a 1-2 sentence factual description of this object and its typical function "
        "in a workspace setting. Be specific and useful.\n"
        "\n"
        "Rules:\n"
        "- Maximum 280 characters\n"
        "- No safety warnings or operational instructions\n"
        "- No questions or markdown\n"
        "- Plain text only\n"
        "\n"
        "Respond with ONLY the description text."
    ),
    "ACTION_SUGGEST": (
        "You are a concise operational assistant in a governed mixed reality workspace.\n"
        "\n"
        "Detected object: {class_name} (confidence: {confidence:.0%})\n"
        "Tag ID: {asset_id}\n"
        "\n"
        "Suggest 2-3 short practical next actions for this specific object in a workspace. "
        "Each action should be 3-8 words. Focus on physical handling, status checks, or "
        "workspace safety.\n"
        "\n"
        "Rules:\n"
        "- Maximum 280 characters total\n"
        '- Format as: "1. action  2. action  3. action"\n'
        "- Actions must be specific to this object type\n"
        "- Recommendations only, not commands\n"
        "- Plain text only\n"
        "\n"
        "Respond with ONLY the numbered actions."
    ),
}

# Precompute prompt hashes (from template before substitution)
PROMPT_HASHES = {
    intent: hashlib.sha256(template.encode()).hexdigest()[:16]
    for intent, template in PROMPT_TEMPLATES.items()
}

# ─── Mock Templates ──────────────────────────────────────────────────────────

MOCK_TEMPLATES = {
    ("ADVISORY", "ASK_ANCHOR"): "This is a {class_name} (confidence: {confidence:.0%}). Common workspace object identified by detection system.",
    ("ADVISORY", "ACTION_SUGGEST"): "Suggested actions for {class_name}: inspect condition, verify placement, log status. Detected at {confidence:.0%} confidence.",
    ("GOVERNED", "ASK_ANCHOR"): "Operational note for {class_name}: verify status before interaction. Object detected with {confidence:.0%} confidence. Organizational review required.",
    ("GOVERNED", "ACTION_SUGGEST"): "Action plan for {class_name}: 1) Confirm identity, 2) Check safety status, 3) Log interaction. Confidence: {confidence:.0%}. Dual-org approval required.",
}

DEFAULT_TEMPLATE = "Object {class_name} detected with {confidence:.0%} confidence. Intent: {intent_type}."

VALID_INTENT_TYPES = ["ASK_ANCHOR", "ACTION_SUGGEST"]

# ─── Request / Response Models ───────────────────────────────────────────────


class AnnotateRequest(BaseModel):
    asset_id: str
    tier: str = "ADVISORY"
    intent_type: str = "ASK_ANCHOR"
    class_name: str = "unknown"
    confidence: float = 0.0
    mode: Optional[str] = None  # "llm" or "mock" — defaults to DEFAULT_MODE


class AnnotateResponse(BaseModel):
    annotation_text: str
    content_hash: str
    content_ptr: str
    tier: str
    intent_type: str
    generator_id: str
    prompt_hash: str
    inference_time_ms: int
    mode_used: str  # "llm" or "mock" or "mock-fallback"


# ─── LLM Call ────────────────────────────────────────────────────────────────

async def call_llm(prompt: str) -> str:
    """Call Parley LLM via OpenAI-compatible chat completions endpoint."""
    if not PARLEY_API_KEY:
        raise ValueError("PARLEY_API_KEY not set — cannot call LLM")

    url = f"{PARLEY_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {PARLEY_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": PARLEY_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_completion_tokens": 200,
        "temperature": 0.4,
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    # Extract text from OpenAI-compatible response
    text = data["choices"][0]["message"]["content"]
    return text


def sanitize_llm_output(raw: str) -> str:
    """Strip markdown, whitespace, and enforce 280 char limit."""
    text = raw.strip()
    # Remove markdown formatting
    text = re.sub(r'```[\s\S]*?```', '', text)  # code blocks
    text = re.sub(r'[`*_#>]', '', text)          # inline markdown chars
    text = re.sub(r'\n{3,}', '\n\n', text)       # excessive newlines
    text = text.strip()
    # Enforce 280 char limit
    if len(text) > 280:
        text = text[:277] + "..."
    return text


# ─── Mock Generator ──────────────────────────────────────────────────────────

def generate_mock(req: AnnotateRequest, intent_type: str) -> str:
    """Generate deterministic mock text from templates."""
    template_key = (req.tier, intent_type)
    template = MOCK_TEMPLATES.get(template_key, DEFAULT_TEMPLATE)
    text = template.format(
        class_name=req.class_name,
        confidence=req.confidence,
        intent_type=intent_type,
    )
    if len(text) > 280:
        text = text[:277] + "..."
    return text


# ─── Main Endpoint ───────────────────────────────────────────────────────────

@app.post("/annotate", response_model=AnnotateResponse)
async def annotate(req: AnnotateRequest):
    start = time.time()

    # Validate intent_type
    intent_type = req.intent_type if req.intent_type in VALID_INTENT_TYPES else "ASK_ANCHOR"

    # Determine mode
    mode = req.mode or DEFAULT_MODE
    if mode not in ("llm", "mock"):
        mode = DEFAULT_MODE

    mode_used = mode
    generator_id = ""
    text = ""
    prompt_hash = ""

    if mode == "llm":
        # ── LLM path ──
        template = PROMPT_TEMPLATES.get(intent_type)
        if not template:
            logger.warning(f"No prompt template for {intent_type}, falling back to mock")
            mode_used = "mock-fallback"
        else:
            prompt_hash = PROMPT_HASHES[intent_type]
            filled_prompt = template.format(
                class_name=req.class_name,
                confidence=req.confidence,
                asset_id=req.asset_id,
            )

            try:
                logger.info(f"[LLM] Calling {PARLEY_MODEL} for {req.asset_id}:{intent_type} (class={req.class_name})")
                raw = await call_llm(filled_prompt)
                logger.info(f"[LLM] Raw response ({len(raw)} chars): {raw[:120]}...")
                text = sanitize_llm_output(raw)
                logger.info(f"[LLM] Sanitized ({len(text)} chars): {text[:120]}...")
                generator_id = f"{PARLEY_MODEL}-parley"
                mode_used = "llm"

                # Guard: if LLM returned empty after sanitization
                if not text.strip():
                    logger.warning("[LLM] Empty after sanitization, falling back to mock")
                    mode_used = "mock-fallback"

            except Exception as e:
                logger.error(f"[LLM] Error: {e} — falling back to mock")
                mode_used = "mock-fallback"

    # ── Mock path (explicit or fallback) ──
    if mode_used in ("mock", "mock-fallback"):
        text = generate_mock(req, intent_type)
        if mode_used == "mock-fallback":
            generator_id = "mock-v2-fallback"
            logger.warning(f"[MOCK-FALLBACK] Using mock for {req.asset_id}:{intent_type}")
        else:
            generator_id = "mock-v2"
            logger.info(f"[MOCK] Generating for {req.asset_id}:{intent_type}")
        # Mock prompt hash: hash of the mock template
        template_key = (req.tier, intent_type)
        mock_template = MOCK_TEMPLATES.get(template_key, DEFAULT_TEMPLATE)
        prompt_hash = hashlib.sha256(mock_template.encode()).hexdigest()[:16]

    content_hash = hashlib.sha256(text.encode()).hexdigest()
    inference_ms = int((time.time() - start) * 1000)

    return AnnotateResponse(
        annotation_text=text,
        content_hash=content_hash,
        content_ptr=str(uuid.uuid4()),
        tier=req.tier,
        intent_type=intent_type,
        generator_id=generator_id,
        prompt_hash=prompt_hash,
        inference_time_ms=max(inference_ms, 1),
        mode_used=mode_used,
    )


@app.get("/health")
async def health():
    has_key = bool(PARLEY_API_KEY)
    return {
        "status": "healthy",
        "version": "1.0.0",
        "default_mode": DEFAULT_MODE,
        "llm_available": has_key,
        "llm_model": PARLEY_MODEL if has_key else "not configured",
        "llm_base_url": PARLEY_BASE_URL if has_key else "not configured",
        "intent_types": VALID_INTENT_TYPES,
        "prompt_hashes": PROMPT_HASHES,
    }


if __name__ == "__main__":
    import uvicorn

    has_key = bool(PARLEY_API_KEY)
    print("=" * 60)
    print("  Annotation Generator v1.0 (LLM + Mock)")
    print("=" * 60)
    print(f"  Listening on http://0.0.0.0:5001")
    print(f"  Default mode:  {DEFAULT_MODE}")
    print(f"  LLM available: {has_key}")
    if has_key:
        print(f"  LLM model:     {PARLEY_MODEL}")
        print(f"  LLM base URL:  {PARLEY_BASE_URL}")
    else:
        print(f"  ⚠ PARLEY_API_KEY not set — LLM calls will fall back to mock")
    print(f"  Intent types:  {', '.join(VALID_INTENT_TYPES)}")
    print(f"  Prompt hashes: ASK_ANCHOR={PROMPT_HASHES['ASK_ANCHOR']}")
    print(f"                 ACTION_SUGGEST={PROMPT_HASHES['ACTION_SUGGEST']}")
    print("=" * 60)
    uvicorn.run("server:app", host="0.0.0.0", port=5001, reload=False, log_level="info")