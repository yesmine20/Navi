from supabase import Client, create_client

from app.config import settings


def rls_client(user_token: str) -> Client:
    """Client scoped to the caller's own token — RLS enforces access, per §0 principle #4.

    Use this for every read and for user-initiated writes. Every table's RLS policy is
    keyed on auth.uid(), so a token for user A can never see or write user B's rows.
    """
    client = create_client(settings.supabase_url, settings.supabase_anon_key)
    client.postgrest.auth(user_token)
    return client


def service_client() -> Client:
    """Service-role client — bypasses RLS. Only for server-initiated writes (e.g. background
    rollups), never for reads and never scoped to a single request's caller. See §0.4.
    """
    return create_client(settings.supabase_url, settings.supabase_service_role_key)
