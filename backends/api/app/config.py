from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str

    # Optional — only set for Supabase projects still on the legacy shared HS256 secret
    # (dashboard → Project Settings → API → JWT Settings). Newer projects sign with a
    # per-project asymmetric key instead and publish no such secret; app/auth.py falls back
    # to verifying against the project's public JWKS in that case (see its docstring).
    supabase_jwt_secret: str | None = None

    # Optional (not required at startup — the app must still boot without any of them, e.g.
    # to test the data-layer endpoints) — checked explicitly at call time in llm_gateway.py,
    # which raises a clear, actionable error rather than the app failing to start. Both can
    # be set at once — the gateway tries each configured provider in turn (docs/
    # ARCHITECTURE.md §1's "multi-provider, circuit breaker"), not just whichever is first.
    anthropic_api_key: str | None = None
    mistral_api_key: str | None = None


settings = Settings()
