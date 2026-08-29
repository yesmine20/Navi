import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { buildApplierScript } from "../lib/adaptationApplier";
import { AdaptationProposal, getLatestAdaptation, refreshProfile } from "../lib/api";
import { addSavedSite, listSavedSites, removeSavedSite, SavedSite } from "../lib/savedSites";
import { isDirectUrl, resolveUrlOrSearch } from "../lib/urlBar";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function summarizeProposal(p: AdaptationProposal): string {
  const bits: string[] = [];
  if (p.font_scale > 1) bits.push(`police ×${p.font_scale.toFixed(1)}`);
  if (p.line_spacing !== "normal") bits.push(`espacement ${p.line_spacing}`);
  if (p.contrast_mode !== "none") bits.push(`contraste ${p.contrast_mode}`);
  if (p.reduce_motion) bits.push("mouvement réduit");
  if (p.touch_target_boost) bits.push("cibles tactiles agrandies");
  return bits.length > 0 ? bits.join(" · ") : "aucune adaptation (profil neutre)";
}

function SiteIcon({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <View style={styles.siteIconWrap}>
      <Text style={styles.siteIconLetter}>{label.trim().charAt(0).toUpperCase() || "?"}</Text>
      {!failed && (
        <Image
          style={StyleSheet.absoluteFill}
          source={{ uri: `https://www.google.com/s2/favicons?domain=${hostnameOf(url)}&sz=64` }}
          onError={() => setFailed(true)}
        />
      )}
    </View>
  );
}

export default function BrowserScreen({
  session,
  justFinishedOnboarding,
}: {
  session: Session;
  // True only right after this session's own mini-games just finished — the one case where
  // computing a fresh (LLM-backed) adaptation is worth it. Every other open just rereads
  // whatever was already accepted (App.tsx's routing already guarantees something exists).
  justFinishedOnboarding: boolean;
}) {
  const [mode, setMode] = useState<"home" | "site">("home");
  const [sites, setSites] = useState<SavedSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");

  const [proposal, setProposal] = useState<AdaptationProposal | null>(null);
  const [profileStatus, setProfileStatus] = useState<"loading" | "ready" | "error">("loading");
  const [profileError, setProfileError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const webviewRef = useRef<WebView>(null);
  const firstName = (session.user.user_metadata?.first_name as string | undefined)?.trim();

  useEffect(() => {
    // Layer A only needs the profile once — same values regardless of which site is opened
    // (docs/THIRD_PARTY_ADAPTATION.md §1), so this runs once for the whole browsing session,
    // not per site. Only right after onboarding is there new evidence worth reasoning over
    // with the LLM (refreshProfile) — every other open just rereads what was already decided
    // (getLatestAdaptation), no LLM round trip.
    (justFinishedOnboarding ? refreshProfile() : getLatestAdaptation())
      .then((result) => {
        setProposal(result);
        setProfileStatus("ready");
      })
      .catch((err: Error) => {
        setProfileError(err.message);
        setProfileStatus("error");
      });

    listSavedSites(session.user.id)
      .then(setSites)
      .catch((err: Error) => Alert.alert("Impossible de charger vos sites", err.message))
      .finally(() => setSitesLoading(false));
  }, [session.user.id]);

  useEffect(() => {
    // Covers the race `injectedJavaScript`/`onLoadEnd` alone can't: `refreshProfile()` is an
    // async network+LLM round trip, so it's entirely possible the WebView finishes its first
    // page load (firing onLoadEnd with `proposal` still null in that closure) before the
    // profile call resolves. onLoadEnd only fires once per navigation — it never re-fires
    // just because `proposal` state changes afterward — so without this effect, a page opened
    // "too early" would silently never get adapted, even though the status bar (a normal React
    // re-render) correctly shows the adaptation as available.
    if (mode === "site" && proposal) {
      webviewRef.current?.injectJavaScript(buildApplierScript(proposal));
    }
  }, [mode, proposal, currentUrl]);

  function openUrl(url: string) {
    setCurrentUrl(url);
    setMode("site");
  }

  async function handleSearchSubmit() {
    if (!searchInput.trim()) return;
    const url = resolveUrlOrSearch(searchInput);

    // Only auto-save real destinations, not text queries — a Google search-results page
    // isn't a "site" worth a permanent shortcut in VOS SITES.
    if (isDirectUrl(searchInput)) {
      const alreadySaved = sites.some((s) => hostnameOf(s.url) === hostnameOf(url));
      if (!alreadySaved) {
        try {
          await addSavedSite(session.user.id, url, hostnameOf(url));
          setSites(await listSavedSites(session.user.id));
        } catch (err) {
          // Non-blocking — failing to save the shortcut shouldn't stop the user from browsing.
          console.warn("Auto-add saved site failed", err);
        }
      }
    }
    openUrl(url);
  }

  async function handleAddSite() {
    if (!newUrl.trim() || !newLabel.trim()) return;
    const url = resolveUrlOrSearch(newUrl); // reused: turns a bare domain into a full https URL
    try {
      await addSavedSite(session.user.id, url, newLabel.trim());
      setSites(await listSavedSites(session.user.id));
      setAdding(false);
      setNewLabel("");
      setNewUrl("");
    } catch (err) {
      Alert.alert("Impossible d'ajouter ce site", (err as Error).message);
    }
  }

  function confirmRemoveSite(site: SavedSite) {
    Alert.alert(site.label, "Retirer ce site de vos raccourcis ?", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Retirer",
        style: "destructive",
        onPress: async () => {
          try {
            await removeSavedSite(site.id);
            setSites((prev) => prev.filter((s) => s.id !== site.id));
          } catch (err) {
            Alert.alert("Impossible de retirer ce site", (err as Error).message);
          }
        },
      },
    ]);
  }

  if (mode === "site") {
    return (
      <View style={styles.container}>
        <View style={styles.siteHeader}>
          <TouchableOpacity onPress={() => setMode("home")} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Accueil</Text>
          </TouchableOpacity>
          <Text style={styles.siteHeaderUrl} numberOfLines={1}>
            {hostnameOf(currentUrl)}
          </Text>
        </View>

        <View style={styles.statusBar}>
          {profileStatus === "error" ? (
            <Text style={[styles.statusText, styles.statusError]}>
              Profil indisponible ({profileError}) — site affiché sans adaptation.
            </Text>
          ) : (
            <Text style={styles.statusText}>
              {proposal ? `Adaptation appliquée : ${summarizeProposal(proposal)}` : "Aucune preuve encore — joue aux mini-jeux d'abord."}
            </Text>
          )}
        </View>

        <WebView
          ref={webviewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          injectedJavaScript={proposal ? buildApplierScript(proposal) : undefined}
          onLoadEnd={() => {
            if (proposal) webviewRef.current?.injectJavaScript(buildApplierScript(proposal));
          }}
          onNavigationStateChange={(navState) => {
            // Clicking a link (e.g. a Google result) navigates the WebView internally —
            // `currentUrl` never changes and `onLoadEnd` isn't reliable for that kind of
            // in-WebView navigation, so the header URL goes stale and the adaptation silently
            // stops being re-applied past the first page. onNavigationStateChange fires for
            // every real navigation (including these), so it's the reliable place to both
            // track the real URL and re-inject.
            if (!navState.loading) {
              setCurrentUrl(navState.url);
              if (proposal) webviewRef.current?.injectJavaScript(buildApplierScript(proposal));
            }
          }}
          onMessage={() => {}}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.homeHeader}>
        <View style={styles.orb} />
        <Text style={styles.greeting}>
          {firstName ? `${firstName}, c'est Navi !` : "C'est Navi !"}
        </Text>
      </View>

      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Rechercher ou saisir une URL"
          placeholderTextColor="#9A93AE"
          value={searchInput}
          onChangeText={setSearchInput}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={handleSearchSubmit}
          returnKeyType="go"
        />
      </View>

      <Text style={styles.sectionLabel}>VOS SITES</Text>

      {sitesLoading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color="#4B32C3" />
      ) : (
        <FlatList
          data={sites}
          numColumns={4}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.siteTile}
              onPress={() => openUrl(item.url)}
              onLongPress={() => confirmRemoveSite(item)}
            >
              <SiteIcon url={item.url} label={item.label} />
              <Text style={styles.siteLabel} numberOfLines={1}>
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
          ListFooterComponent={
            adding ? (
              <View style={styles.addForm}>
                <TextInput
                  style={styles.addInput}
                  placeholder="Nom du site"
                  value={newLabel}
                  onChangeText={setNewLabel}
                />
                <TextInput
                  style={styles.addInput}
                  placeholder="URL (ex: exemple.com)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={newUrl}
                  onChangeText={setNewUrl}
                />
                <View style={styles.addFormButtons}>
                  <TouchableOpacity onPress={() => setAdding(false)}>
                    <Text style={styles.addCancel}>Annuler</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.addSaveButton} onPress={handleAddSite}>
                    <Text style={styles.addSaveButtonText}>Enregistrer</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.siteTile} onPress={() => setAdding(true)}>
                <View style={[styles.siteIconWrap, styles.addTileIcon]}>
                  <Text style={styles.addTileIconText}>+</Text>
                </View>
                <Text style={styles.siteLabel}>Ajouter</Text>
              </TouchableOpacity>
            )
          }
        />
      )}
    </View>
  );
}

const TILE_SIZE = 64;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F3F0FB" },
  homeHeader: { alignItems: "center", paddingTop: 32, paddingBottom: 16 },
  orb: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#7A5FE0",
    marginBottom: 12,
  },
  greeting: { fontSize: 20, fontWeight: "700", color: "#2E2A47" },
  searchBar: { paddingHorizontal: 20, marginBottom: 20 },
  searchInput: {
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
  },
  sectionLabel: {
    fontSize: 11,
    color: "#9A93AE",
    letterSpacing: 1,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  grid: { paddingHorizontal: 12, paddingBottom: 32 },
  siteTile: { width: "25%", alignItems: "center", paddingVertical: 10 },
  siteIconWrap: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: 16,
    backgroundColor: "#DDD6F5",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  siteIconLetter: { fontSize: 22, fontWeight: "700", color: "#4B32C3" },
  siteLabel: { fontSize: 11, color: "#2E2A47", marginTop: 6, maxWidth: TILE_SIZE + 8, textAlign: "center" },
  addTileIcon: { backgroundColor: "#EDE7FA" },
  addTileIconText: { fontSize: 28, color: "#4B32C3", fontWeight: "300" },
  addForm: { paddingHorizontal: 20, paddingTop: 12 },
  addInput: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 8,
  },
  addFormButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 16, marginTop: 4 },
  addCancel: { color: "#6B6280", paddingVertical: 10 },
  addSaveButton: { backgroundColor: "#4B32C3", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  addSaveButtonText: { color: "#fff", fontWeight: "600" },

  siteHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    gap: 10,
    backgroundColor: "#EDE7FA",
  },
  backButton: { paddingVertical: 4, paddingHorizontal: 8 },
  backButtonText: { color: "#4B32C3", fontWeight: "600", fontSize: 14 },
  siteHeaderUrl: { flex: 1, fontSize: 13, color: "#2E2A47" },
  statusBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#DDD6F5",
  },
  statusText: { fontSize: 12, color: "#2E2A47" },
  statusError: { color: "#B4482F" },
  webview: { flex: 1 },
});
