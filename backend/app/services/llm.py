"""
Shared Groq LLM client used by chat (RAG), learning tools and mind maps.
The model and reasoning effort come from .env (GROQ_MODEL, GROQ_REASONING_EFFORT),
so switching models is a config change, not a code change.
"""

from groq import Groq
from app.config import settings


MODEL = settings.GROQ_MODEL
REASONING_EFFORT = settings.GROQ_REASONING_EFFORT

# Reasoning models (e.g. gpt-oss) spend part of max_tokens on hidden reasoning.
# Adding headroom keeps each caller's max_tokens as the budget for the visible answer.
REASONING_HEADROOM_TOKENS = 1024

_client = Groq(api_key=settings.GROQ_API_KEY)


def chat(*, max_tokens: int, **kwargs):
    """chat.completions.create with the configured model. Supports stream=True."""
    if REASONING_EFFORT:
        max_tokens += REASONING_HEADROOM_TOKENS
        # groq SDK 0.13 has no reasoning_effort argument, so send it in the raw body
        kwargs["extra_body"] = {**(kwargs.get("extra_body") or {}), "reasoning_effort": REASONING_EFFORT}
    return _client.chat.completions.create(model=MODEL, max_tokens=max_tokens, **kwargs)


def text(response) -> str:
    """Return the answer text, or raise a clear error if the model produced none."""
    choice = response.choices[0]
    if not choice.message.content:
        raise RuntimeError(no_answer_message(choice.finish_reason))
    return choice.message.content


def no_answer_message(finish_reason) -> str:
    return (
        f"{MODEL} returned no answer text (finish_reason={finish_reason}). "
        "If it is 'length', the reasoning used up the token budget: "
        "lower GROQ_REASONING_EFFORT or raise max_tokens."
    )
