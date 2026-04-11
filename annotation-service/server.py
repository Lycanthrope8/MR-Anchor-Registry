"""
Mock Annotation Generator Service v0.1

Returns deterministic template text for testing the governed annotation pipeline.
No LLM calls — just templates. This isolates governance testing from AI quality.

Runs on the gateway host at port 5001 (Decision 3).
Will be replaced by real LLM in Phase 1 (Week 5).

Usage:
    pip install fastapi uvicorn
    python server.py

    Or: uvicorn server:app --host 0.0.0.0 --port 5001
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import hashlib
import uuid
import time

app = FastAPI(title="Annotation Generator", version="0.1.0-mock")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnnotateRequest(BaseModel):
    asset_id: str
    tier: str = "ADVISORY"
    class_name: str = "unknown"
    confidence: float = 0.0


class AnnotateResponse(BaseModel):
    annotation_text: str
    content_hash: str
    content_ptr: str
    tier: str
    generator_id: str
    prompt_hash: str
    inference_time_ms: int


# Mock templates — deterministic, short, under 280 chars
MOCK_TEMPLATES = {
    "ADVISORY": "This is a {class_name} (confidence: {confidence:.0%}). Common workspace object identified by detection system.",
    "GOVERNED": "Operational note for {class_name}: verify status before interaction. Object detected with {confidence:.0%} confidence. Organizational review required.",
}


@app.post("/annotate", response_model=AnnotateResponse)
async def annotate(req: AnnotateRequest):
    start = time.time()

    template = MOCK_TEMPLATES.get(req.tier, MOCK_TEMPLATES["ADVISORY"])
    text = template.format(class_name=req.class_name, confidence=req.confidence)

    # Enforce 280 char limit
    if len(text) > 280:
        text = text[:277] + "..."

    content_hash = hashlib.sha256(text.encode()).hexdigest()
    prompt_hash = hashlib.sha256(template.encode()).hexdigest()

    inference_ms = int((time.time() - start) * 1000)

    return AnnotateResponse(
        annotation_text=text,
        content_hash=content_hash,
        content_ptr=str(uuid.uuid4()),
        tier=req.tier,
        generator_id="mock-v1",
        prompt_hash=prompt_hash,
        inference_time_ms=max(inference_ms, 1),
    )


@app.get("/health")
async def health():
    return {"status": "healthy", "generator": "mock-v1", "version": "0.1.0"}


if __name__ == "__main__":
    import uvicorn

    print("=" * 50)
    print("  Mock Annotation Generator v0.1")
    print("  Listening on http://0.0.0.0:5001")
    print("  Tiers: ADVISORY (auto-approve), GOVERNED")
    print("  Generator: mock-v1 (template text)")
    print("=" * 50)
    uvicorn.run("server:app", host="0.0.0.0", port=5001, reload=False, log_level="info")