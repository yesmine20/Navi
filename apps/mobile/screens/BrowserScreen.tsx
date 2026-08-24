import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { buildApplierScript } from "../lib/adaptationApplier";
import { AdaptationProposal, refreshProfile } from "../lib/api";

const DEFAULT_URL = "https://fr.wikipedia.org/wiki/Accessibilit%C3%A9_du_web";

function summarizeProposal(p: AdaptationProposal): string {
  const bits: string[] = [];
  if (p.font_scale > 1) bits.push(`police ×${p.font_scale.toFixed(1)}`);
  if (p.line_spacing !== "normal") bits.push(`espacement ${p.line_spacing}`);
  if (p.contrast_mode !== "none") bits.push(`contraste ${p.contrast_mode}`);
  if (p.reduce_motion) bits.push("mouvement réduit");
  if (p.touch_target_boost) bits.push("cibles tactiles agrandies");
  return bits.length > 0 ? bits.join(" · ") : "aucune adaptation (profil neutre)";
}

export default function BrowserScreen() {
  const [urlInput, setUrlInput] = useState(DEFAULT_URL);
  const [loadedUrl, setLoadedUrl] = useState(DEFAULT_URL);
  const [proposal, setProposal] = useState<AdaptationProposal | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const webviewRef = useRef<WebView>(null);

  useEffect(() => {
    // Layer A only needs the profile once — it's the same values regardless of which site
    // is loaded (docs/THIRD_PARTY_ADAPTATION.md §1: no per-site logic needed for this layer).
    refreshProfile()
      .then((result) => {
        setProposal(result);
        setStatus("ready");
      })
      .catch((err: Error) => {
        setErrorMessage(err.message);
        setStatus("error");
      });
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.urlBar}>
        <TextInput
          style={styles.urlInput}
          value={urlInput}
          onChangeText={setUrlInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={() => setLoadedUrl(urlInput)}
        />
        <TouchableOpacity style={styles.goButton} onPress={() => setLoadedUrl(urlInput)}>
          <Text style={styles.goButtonText}>Aller</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statusBar}>
        {status === "loading" && (
          <>
            <ActivityIndicator size="small" color="#4B32C3" />
            <Text style={styles.statusText}>Chargement du profil…</Text>
          </>
        )}
        {status === "error" && (
          <Text style={[styles.statusText, styles.statusError]}>
            Profil indisponible ({errorMessage}) — site affiché sans adaptation.
          </Text>
        )}
        {status === "ready" && (
          <Text style={styles.statusText}>
            {proposal ? `Adaptation appliquée : ${summarizeProposal(proposal)}` : "Aucune preuve encore — joue aux mini-jeux d'abord."}
          </Text>
        )}
      </View>

      {status !== "loading" && (
        <WebView
          ref={webviewRef}
          source={{ uri: loadedUrl }}
          style={styles.webview}
          injectedJavaScript={proposal ? buildApplierScript(proposal) : undefined}
          // injectedJavaScript's own re-injection behavior across in-WebView navigations
          // (user taps a link to another page on the same site) isn't reliably documented,
          // so onLoadEnd explicitly re-applies via the ref on every single page load —
          // the "run on demand" mechanism from react-native-webview's own guide — rather
          // than depending on undocumented behavior for something safety/UX-relevant.
          onLoadEnd={() => {
            if (proposal) webviewRef.current?.injectJavaScript(buildApplierScript(proposal));
          }}
          onMessage={() => {}}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F3F0FB" },
  urlBar: { flexDirection: "row", padding: 8, gap: 8, backgroundColor: "#EDE7FA" },
  urlInput: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  goButton: {
    backgroundColor: "#4B32C3",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  goButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#DDD6F5",
  },
  statusText: { fontSize: 12, color: "#2E2A47", flexShrink: 1 },
  statusError: { color: "#B4482F" },
  webview: { flex: 1 },
});
