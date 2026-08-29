import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { logEvidence } from "./lib/evidence";
import { getLatestAdaptation } from "./lib/api";
import AuthScreen from "./screens/AuthScreen";
import FollowThePathGame, { FollowThePathResult } from "./screens/FollowThePathGame";
import ReadingChallengeGame, { ReadingChallengeResult } from "./screens/ReadingChallengeGame";
import PatternDetectiveGame, { PatternDetectiveResult } from "./screens/PatternDetectiveGame";
import BrowserScreen from "./screens/BrowserScreen";

// The system runs this sequence end to end to gather evidence — the user never picks which
// game to play (docs/ARCHITECTURE.md §3, workflow A step 2: "mobile presents the 3
// mini-games"). "browser" is the first visible slice of third-party-site adaptation
// (docs/THIRD_PARTY_ADAPTATION.md) — reachable from the summary screen once evidence exists.
// "loading" covers the brief window after a session exists but before we know whether this
// user already has an accepted adaptation — that lookup decides welcome vs. browser below.
type Screen = "loading" | "welcome" | "followPath" | "reading" | "patternDetective" | "summary" | "browser";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>("loading");
  // True only right after this session's own mini-games just finished — the one case where
  // BrowserScreen should call the LLM-backed refreshProfile() instead of just rereading
  // whatever was already accepted (see BrowserScreen's `justFinishedOnboarding` prop).
  const [justFinishedOnboarding, setJustFinishedOnboarding] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Supabase also fires this on background token refreshes — only a genuine sign-in/
      // sign-out should re-decide navigation, otherwise a routine refresh mid-use would
      // silently kick the user back through onboarding.
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
        setJustFinishedOnboarding(false);
        setScreen("loading");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session || screen !== "loading") return;
    // Returning user who already has an accepted adaptation skips straight past onboarding;
    // a brand-new account (no adaptation yet) goes through the usual welcome -> games -> summary
    // flow. Fails open into onboarding on a lookup error rather than stranding a new user.
    getLatestAdaptation()
      .then((adaptation) => setScreen(adaptation ? "browser" : "welcome"))
      .catch((err) => {
        console.warn("Adaptation lookup failed, defaulting to onboarding", err);
        setScreen("welcome");
      });
  }, [session, screen]);

  async function handleFollowPathComplete(result: FollowThePathResult) {
    console.log("Follow the Path result", result);
    if (session?.user) {
      try {
        await logEvidence(session.user.id, "motor_precision", result);
      } catch (e) {
        console.warn("Failed to write evidence_log", e);
      }
    }
    setScreen("reading");
  }

  async function handleReadingComplete(result: ReadingChallengeResult) {
    console.log("Reading Challenge result", result);
    if (session?.user) {
      try {
        await logEvidence(session.user.id, "reading_comfort", result);
      } catch (e) {
        console.warn("Failed to write evidence_log", e);
      }
    }
    setScreen("patternDetective");
  }

  async function handlePatternDetectiveComplete(result: PatternDetectiveResult) {
    console.log("Pattern Detective result", result);
    if (session?.user) {
      try {
        await logEvidence(session.user.id, "visual_processing_style", result);
      } catch (e) {
        console.warn("Failed to write evidence_log", e);
      }
    }
    setScreen("summary");
  }

  if (session === undefined) {
    return (
      <View style={styles.container}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  if (screen === "loading") {
    return (
      <View style={styles.container}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={screen === "browser" ? styles.fullContainer : styles.container}>
      <StatusBar style="auto" />

      {screen === "welcome" && (
        <View style={styles.card}>
          <Text style={styles.title}>Bienvenue dans l'univers Navi</Text>
          <Text style={styles.subtitle}>
            Trois courtes expériences pour adapter Navi à vos besoins, en quelques minutes.
          </Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => setScreen("followPath")}
          >
            <Text style={styles.primaryButtonText}>Commencer l'aventure</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen === "followPath" && (
        <FollowThePathGame onComplete={handleFollowPathComplete} />
      )}
      {screen === "reading" && (
        <ReadingChallengeGame onComplete={handleReadingComplete} />
      )}
      {screen === "patternDetective" && (
        <PatternDetectiveGame onComplete={handlePatternDetectiveComplete} />
      )}

      {screen === "summary" && (
        <View style={styles.card}>
          <Text style={styles.title}>Félicitations !</Text>
          <Text style={styles.subtitle}>
            Navi est désormais mieux configuré pour s'adapter à vos besoins.
          </Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => {
              // This is the one moment a fresh (LLM-backed) adaptation is worth computing —
              // real evidence from this session's 3 mini-games exists now and hasn't been
              // reasoned over yet. Every later app open just reapplies whatever gets decided
              // here (see BrowserScreen's `justFinishedOnboarding` prop).
              setJustFinishedOnboarding(true);
              setScreen("browser");
            }}
          >
            <Text style={styles.primaryButtonText}>Essayer sur un vrai site</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen === "browser" && (
        <BrowserScreen session={session} justFinishedOnboarding={justFinishedOnboarding} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F3F0FB",
    alignItems: "center",
    justifyContent: "center",
  },
  fullContainer: {
    flex: 1,
    backgroundColor: "#F3F0FB",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    width: 280,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#4B32C3",
    marginBottom: 12,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 15,
    color: "#6B6280",
    textAlign: "center",
    marginBottom: 20,
  },
  primaryButton: {
    backgroundColor: "#4B32C3",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
});
