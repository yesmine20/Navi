import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { logEvidence } from "./lib/evidence";
import AuthScreen from "./screens/AuthScreen";
import FollowThePathGame, { FollowThePathResult } from "./screens/FollowThePathGame";
import ReadingChallengeGame, { ReadingChallengeResult } from "./screens/ReadingChallengeGame";
import PatternDetectiveGame, { PatternDetectiveResult } from "./screens/PatternDetectiveGame";
import BrowserScreen from "./screens/BrowserScreen";

// The system runs this sequence end to end to gather evidence — the user never picks which
// game to play (docs/ARCHITECTURE.md §3, workflow A step 2: "mobile presents the 3
// mini-games"). "browser" is the first visible slice of third-party-site adaptation
// (docs/THIRD_PARTY_ADAPTATION.md) — reachable from the summary screen once evidence exists.
type Screen = "welcome" | "followPath" | "reading" | "patternDetective" | "summary" | "browser";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>("welcome");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setScreen("welcome");
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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
          <TouchableOpacity style={styles.primaryButton} onPress={() => setScreen("browser")}>
            <Text style={styles.primaryButtonText}>Essayer sur un vrai site</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen === "browser" && <BrowserScreen />}
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
