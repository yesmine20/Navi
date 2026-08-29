import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../lib/supabase";

export default function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setInfo(null);
    setLoading(true);

    if (mode === "signIn") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) setError(error.message);
      return;
    }

    // Stored in auth.users.raw_user_meta_data (Supabase's built-in per-user metadata) rather
    // than a new profile table — one field, no join needed to greet the user by name.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { first_name: firstName.trim() } },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    // With "Confirm email" enabled (Supabase default), signUp succeeds but returns no
    // session until the confirmation link is clicked — nothing to navigate to yet.
    if (!data.session) {
      setInfo(
        "Compte créé. Vérifie ta boîte mail et clique sur le lien de confirmation, puis reviens te connecter ici."
      );
      setMode("signIn");
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Navi</Text>
      <Text style={styles.subtitle}>
        {mode === "signIn" ? "Connexion" : "Créer un compte"}
      </Text>

      {mode === "signUp" && (
        <TextInput
          style={styles.input}
          placeholder="Prénom"
          value={firstName}
          onChangeText={setFirstName}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Mot de passe"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}
      {info && <Text style={styles.info}>{info}</Text>}

      <TouchableOpacity
        style={styles.button}
        onPress={submit}
        disabled={loading || !email || !password || (mode === "signUp" && !firstName.trim())}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>
            {mode === "signIn" ? "Se connecter" : "S'inscrire"}
          </Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
      >
        <Text style={styles.switchText}>
          {mode === "signIn"
            ? "Pas de compte ? S'inscrire"
            : "Déjà un compte ? Se connecter"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#F3F0FB",
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#4B32C3",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: "#6B6280",
    textAlign: "center",
    marginBottom: 24,
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#4B32C3",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  switchText: {
    color: "#4B32C3",
    textAlign: "center",
    marginTop: 16,
  },
  error: {
    color: "#C0392B",
    marginBottom: 12,
    textAlign: "center",
  },
  info: {
    color: "#4B32C3",
    marginBottom: 12,
    textAlign: "center",
  },
});
