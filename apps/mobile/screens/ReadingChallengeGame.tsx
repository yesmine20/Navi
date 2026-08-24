import { useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { linearRegressionSlope, mean, percentile } from "../lib/stats";

type ComplexityLevel = 1 | 2 | 3;

type RoundDef = {
  sentence: string;
  question: string;
  choices: string[];
  correctIndex: number;
};

// Complexity is derived from word count (see complexityLevelFor), not manually labeled or
// based on a hand-picked "complex word list" — word count is an objective, computable proxy
// (the same kind readability formulas like Flesch use), while a curated word list would just
// be another arbitrary judgment call like the original 22px tolerance in Follow the Path.
// One sentence per level, same structure as Pattern Detective's 3-rounds-increasing-
// complexity design (docs/MINI_GAMES.md §4).
const ROUNDS: RoundDef[] = [
  {
    // 7 words -> level 1
    sentence: "Le chat gris dort sur le tapis.",
    question: "De quelle couleur est le chat ?",
    choices: ["Gris", "Noir", "Blanc"],
    correctIndex: 0,
  },
  {
    // 12 words -> level 2
    sentence: "Marie a acheté trois pommes et deux poires au marché ce matin.",
    question: "Combien de poires Marie a-t-elle achetées ?",
    choices: ["Trois", "Deux", "Cinq"],
    correctIndex: 1,
  },
  {
    // 19 words -> level 3
    sentence:
      "Avant de partir en voyage, Karim a soigneusement nourri son chien puis fermé tous les volets de la maison.",
    question: "Qu'est-ce que Karim a fait en premier ?",
    choices: ["Nourrir son chien", "Fermer les volets", "Partir en voyage"],
    correctIndex: 0,
  },
];

function wordCount(sentence: string): number {
  return sentence.trim().split(/\s+/).length;
}

function complexityLevelFor(words: number): ComplexityLevel {
  if (words <= 8) return 1;
  if (words <= 13) return 2;
  return 3;
}

export type ReadingRoundResult = {
  sentence: string;
  wordCount: number;
  charCount: number;
  complexityLevel: ComplexityLevel;
  readingTimeMs: number;
  hesitationTimeMs: number;
  correct: boolean;
  wpm: number;
  timePerCharMs: number;
  timePerWordMs: number;
};

export type ReadingChallengeResult = {
  rounds: ReadingRoundResult[];

  // "Comprehended", not "correctly pronounced" — this is silent reading + a comprehension
  // question, not read-aloud, so the classic WCPM (words correct per minute, from oral
  // reading fluency testing) doesn't apply as-is. A word counts as comprehended if its
  // sentence's question was answered correctly — an approximation, not a word-level measure.
  totalWords: number;
  comprehendedWords: number;
  readingAccuracyByWords: number; // comprehendedWords / totalWords
  roundAccuracy: number; // fraction of rounds correct — coarser, kept for continuity

  wordsPerMinute: number;
  comprehendedWordsPerMinute: number;

  avgTimePerCharMs: number;
  avgTimePerWordMs: number;
  avgTimePerCharCorrectMs: number;
  avgTimePerCharIncorrectMs: number;
  avgHesitationTimeMs: number;

  // Speed x accuracy quadrant — "fast" / "slow" is relative to this session's own median
  // time-per-char (self-relative, same reasoning as Follow the Path's relative threshold),
  // not an arbitrary fixed ms cutoff. Separates skimming/guessing (fast+wrong) from genuine
  // struggle (slow+wrong).
  fastCorrectCount: number;
  slowCorrectCount: number;
  fastWrongCount: number;
  slowWrongCount: number;

  wpmByComplexity: Record<ComplexityLevel, number>;
  accuracyByComplexity: Record<ComplexityLevel, number>;
  timePerCharByComplexity: Record<ComplexityLevel, number>;
  complexityEffectWpm: number; // level1 - level3: bigger = slows down more under complexity
  complexityEffectAccuracy: number; // level1 - level3: bigger = comprehends worse under complexity
  complexityEffectTimePerChar: number; // level3 - level1: bigger = takes longer per char under complexity

  // Trend across rounds — reading fatigue, distinct from being uniformly slow.
  wpmSlope: number;
  timePerCharSlope: number;
  accuracyTrend: number;

  totalReadingTimeMs: number;
};

type Phase = "reading" | "question";

export default function ReadingChallengeGame({
  onComplete,
}: {
  onComplete: (result: ReadingChallengeResult) => void;
}) {
  const [roundIndex, setRoundIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("reading");
  const [selected, setSelected] = useState<number | null>(null);

  const readingStartedAt = useRef(performance.now());
  const questionShownAt = useRef<number | null>(null);
  const results = useRef<ReadingRoundResult[]>([]);

  const round = ROUNDS[roundIndex];

  function finishReading() {
    questionShownAt.current = performance.now();
    setPhase("question");
  }

  function answer(index: number) {
    if (selected !== null) return; // ignore repeat taps while the choice highlight is visible
    setSelected(index);

    const readingTimeMs = (questionShownAt.current ?? performance.now()) - readingStartedAt.current;
    const hesitationTimeMs = performance.now() - (questionShownAt.current ?? performance.now());
    const words = wordCount(round.sentence);
    const chars = round.sentence.length;

    results.current.push({
      sentence: round.sentence,
      wordCount: words,
      charCount: chars,
      complexityLevel: complexityLevelFor(words),
      readingTimeMs,
      hesitationTimeMs,
      correct: index === round.correctIndex,
      wpm: words / (readingTimeMs / 60000),
      timePerCharMs: readingTimeMs / chars,
      timePerWordMs: readingTimeMs / words,
    });

    setTimeout(() => {
      if (roundIndex + 1 < ROUNDS.length) {
        setRoundIndex((i) => i + 1);
        setPhase("reading");
        setSelected(null);
        readingStartedAt.current = performance.now();
        questionShownAt.current = null;
      } else {
        onComplete(summarize(results.current));
      }
    }, 500); // brief pause so the selected choice's highlight is visible before advancing
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        Lecture — {roundIndex + 1}/{ROUNDS.length}
      </Text>

      {phase === "reading" ? (
        <>
          <Text style={styles.sentence}>{round.sentence}</Text>
          <TouchableOpacity style={styles.button} onPress={finishReading}>
            <Text style={styles.buttonText}>J'ai fini de lire</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.question}>{round.question}</Text>
          {round.choices.map((choice, i) => {
            const isSelected = selected === i;
            const isCorrect = i === round.correctIndex;
            const showResult = selected !== null;
            return (
              <TouchableOpacity
                key={choice}
                style={[
                  styles.choice,
                  showResult && isCorrect && styles.choiceCorrect,
                  showResult && isSelected && !isCorrect && styles.choiceWrong,
                ]}
                onPress={() => answer(i)}
                disabled={selected !== null}
              >
                <Text style={styles.choiceText}>{choice}</Text>
              </TouchableOpacity>
            );
          })}
        </>
      )}
    </View>
  );
}

function summarize(rounds: ReadingRoundResult[]): ReadingChallengeResult {
  const totalWords = rounds.reduce((a, r) => a + r.wordCount, 0);
  const comprehendedWords = rounds
    .filter((r) => r.correct)
    .reduce((a, r) => a + r.wordCount, 0);
  const totalReadingTimeMs = rounds.reduce((a, r) => a + r.readingTimeMs, 0);
  const totalReadingTimeMin = totalReadingTimeMs / 60000;

  const correctRounds = rounds.filter((r) => r.correct);
  const incorrectRounds = rounds.filter((r) => !r.correct);

  const medianTimePerChar = percentile(
    rounds.map((r) => r.timePerCharMs),
    50
  );
  let fastCorrectCount = 0;
  let slowCorrectCount = 0;
  let fastWrongCount = 0;
  let slowWrongCount = 0;
  for (const r of rounds) {
    const isFast = r.timePerCharMs <= medianTimePerChar;
    if (r.correct && isFast) fastCorrectCount++;
    else if (r.correct && !isFast) slowCorrectCount++;
    else if (!r.correct && isFast) fastWrongCount++;
    else slowWrongCount++;
  }

  const levels: ComplexityLevel[] = [1, 2, 3];
  const byLevel = (level: ComplexityLevel) => rounds.filter((r) => r.complexityLevel === level);
  const wpmByComplexity = Object.fromEntries(
    levels.map((l) => [l, mean(byLevel(l).map((r) => r.wpm))])
  ) as Record<ComplexityLevel, number>;
  const accuracyByComplexity = Object.fromEntries(
    levels.map((l) => {
      const rs = byLevel(l);
      return [l, rs.length === 0 ? 0 : rs.filter((r) => r.correct).length / rs.length];
    })
  ) as Record<ComplexityLevel, number>;
  const timePerCharByComplexity = Object.fromEntries(
    levels.map((l) => [l, mean(byLevel(l).map((r) => r.timePerCharMs))])
  ) as Record<ComplexityLevel, number>;

  return {
    rounds,
    totalWords,
    comprehendedWords,
    readingAccuracyByWords: comprehendedWords / Math.max(1, totalWords),
    roundAccuracy: correctRounds.length / rounds.length,

    wordsPerMinute: totalWords / Math.max(1e-6, totalReadingTimeMin),
    comprehendedWordsPerMinute: comprehendedWords / Math.max(1e-6, totalReadingTimeMin),

    avgTimePerCharMs: mean(rounds.map((r) => r.timePerCharMs)),
    avgTimePerWordMs: mean(rounds.map((r) => r.timePerWordMs)),
    avgTimePerCharCorrectMs: mean(correctRounds.map((r) => r.timePerCharMs)),
    avgTimePerCharIncorrectMs: mean(incorrectRounds.map((r) => r.timePerCharMs)),
    avgHesitationTimeMs: mean(rounds.map((r) => r.hesitationTimeMs)),

    fastCorrectCount,
    slowCorrectCount,
    fastWrongCount,
    slowWrongCount,

    wpmByComplexity,
    accuracyByComplexity,
    timePerCharByComplexity,
    complexityEffectWpm: wpmByComplexity[1] - wpmByComplexity[3],
    complexityEffectAccuracy: accuracyByComplexity[1] - accuracyByComplexity[3],
    complexityEffectTimePerChar: timePerCharByComplexity[3] - timePerCharByComplexity[1],

    wpmSlope: linearRegressionSlope(
      rounds.map((_, i) => i),
      rounds.map((r) => r.wpm)
    ),
    timePerCharSlope: linearRegressionSlope(
      rounds.map((_, i) => i),
      rounds.map((r) => r.timePerCharMs)
    ),
    accuracyTrend: linearRegressionSlope(
      rounds.map((_, i) => i),
      rounds.map((r) => (r.correct ? 1 : 0))
    ),

    totalReadingTimeMs,
  };
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#EDE7FA",
    borderRadius: 20,
    padding: 20,
    width: 300,
  },
  title: {
    fontWeight: "700",
    fontSize: 14,
    color: "#6B6280",
    marginBottom: 12,
  },
  sentence: {
    fontSize: 18,
    lineHeight: 26,
    color: "#2E2A47",
    marginBottom: 20,
  },
  button: {
    backgroundColor: "#4B32C3",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
  question: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2E2A47",
    marginBottom: 16,
  },
  choice: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  choiceCorrect: {
    backgroundColor: "#DDF3E4",
  },
  choiceWrong: {
    backgroundColor: "#FBE0DB",
  },
  choiceText: {
    fontSize: 15,
    color: "#2E2A47",
  },
});
