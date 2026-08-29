// "Rechercher ou saisir une URL" — the search bar accepts either. A dot with no spaces and
// no obvious query wording is treated as a domain; everything else goes to search. Not meant
// to be a bulletproof URL detector, just enough to match the common cases without forcing the
// user to type "https://" for a bare domain.
const LOOKS_LIKE_URL = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

// Exported so callers can decide whether a search-bar submission was a real destination
// (worth remembering as a shortcut) vs. a text query (a Google results page isn't a
// "site" the user meant to bookmark).
export function isDirectUrl(input: string): boolean {
  return LOOKS_LIKE_URL.test(input.trim());
}

export function resolveUrlOrSearch(input: string): string {
  const trimmed = input.trim();
  if (isDirectUrl(trimmed)) {
    return trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}
