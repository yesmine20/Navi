# Navi mobile (Expo / React Native)

First slice: auth screen + one mini-game ("Follow the Path" — motor precision axis),
writing telemetry straight to `evidence_log` via the RLS-scoped Supabase client (no backend
round trip needed for this table, see `docs/ARCHITECTURE.md` §2).

## Setup

Copy `.env.example` to `.env` and fill in your Supabase project's URL + anon key
(Project Settings → API). Safe to expose client-side — RLS is what actually protects the
data, not secrecy of the anon key.

```
npm install
npm run web    # fastest loop for iterating on the game's touch/drag logic
npm start      # Expo Go on a physical device, for real touch input
```

## What's next

- More mini-games (Reading Challenge, Pattern Detective) — mapping locked in
  `docs/MINI_GAMES.md`.
- Onboarding flow (welcome screen → 3 games → summary), currently jumps straight into the
  one game after sign-in.
- 4-tab shell + WebView browser (docs/ARCHITECTURE.md §1) — comes later, once the
  orchestrator exists server-side.
