import time
from dataclasses import dataclass, field
from typing import Callable, TypeVar

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage
from pydantic import BaseModel

from app.config import settings

T = TypeVar("T", bound=BaseModel)

FAILURE_THRESHOLD = 3
COOLDOWN_SECONDS = 45.0


class AllProvidersDownError(Exception):
    """Raised when every configured provider's circuit is open or every call failed.

    Callers must not invent a fallback response here — per docs/ARCHITECTURE.md §6, the
    correct behavior on this path is "no new response generated, existing state untouched",
    decided by the caller (e.g. the orchestrator returns 503 rather than a guessed reply).
    """


@dataclass
class _CircuitState:
    consecutive_failures: int = 0
    opened_at: float | None = None

    def is_open(self) -> bool:
        if self.opened_at is None:
            return False
        if time.monotonic() - self.opened_at >= COOLDOWN_SECONDS:
            # Cooldown elapsed — half-open: let the next call through and judge by its result.
            self.opened_at = None
            self.consecutive_failures = 0
            return False
        return True

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.opened_at = None

    def record_failure(self) -> None:
        self.consecutive_failures += 1
        if self.consecutive_failures >= FAILURE_THRESHOLD:
            self.opened_at = time.monotonic()


@dataclass
class _Provider:
    name: str
    model: BaseChatModel
    circuit: _CircuitState = field(default_factory=_CircuitState)


def _build_providers() -> list[_Provider]:
    providers: list[_Provider] = []
    if settings.anthropic_api_key:
        # Imported lazily so the package is only required when this provider is actually
        # configured — keeps the gateway provider-agnostic per docs/ARCHITECTURE.md §1
        # ("LLM Gateway (multi-provider, circuit breaker)").
        from langchain_anthropic import ChatAnthropic

        providers.append(
            _Provider(
                name="anthropic",
                model=ChatAnthropic(
                    model="claude-sonnet-4-5",
                    api_key=settings.anthropic_api_key,
                    timeout=30,
                    max_retries=0,  # retries are the gateway's job, not the SDK's
                ),
            )
        )
    return providers


class LLMGateway:
    """Multi-provider chat completion with a per-provider circuit breaker.

    Providers are tried in priority order; a provider whose circuit is open is skipped
    without being called. A provider call that raises counts as a failure. If every
    provider is unavailable, raises AllProvidersDownError — the caller decides the
    user-facing fallback, this class never invents one (docs/ARCHITECTURE.md §0 principle #8).
    """

    def __init__(self) -> None:
        self._providers = _build_providers()

    def _call_with_fallback(self, call: Callable[[BaseChatModel], T]) -> T:
        """Shared provider-iteration + circuit-breaker loop. `call` is whatever this
        particular request needs to do with a provider's model (plain invoke, structured
        output, ...) — the fallback/circuit-breaker behavior is identical either way.
        """
        if not self._providers:
            raise AllProvidersDownError(
                "No LLM provider configured — set ANTHROPIC_API_KEY (see .env.example)."
            )

        last_error: Exception | None = None
        for provider in self._providers:
            if provider.circuit.is_open():
                continue
            try:
                result = call(provider.model)
            except Exception as exc:  # noqa: BLE001 — any provider failure must not crash the request
                provider.circuit.record_failure()
                last_error = exc
                continue
            provider.circuit.record_success()
            return result

        raise AllProvidersDownError(
            "All configured LLM providers are unavailable."
        ) from last_error

    def complete(self, messages: list[BaseMessage]) -> str:
        response = self._call_with_fallback(lambda model: model.invoke(messages))
        return str(response.content)

    def complete_structured(self, messages: list[BaseMessage], schema: type[T]) -> T:
        """Same fallback/circuit-breaker behavior as `complete`, but the response is parsed
        into `schema` (a Pydantic model) via the provider's native structured-output/tool-
        calling support, instead of returned as raw text.
        """
        return self._call_with_fallback(
            lambda model: model.with_structured_output(schema).invoke(messages)
        )


# Module-level singleton — circuit-breaker state must persist across requests within one
# process, not reset per call.
gateway = LLMGateway()
