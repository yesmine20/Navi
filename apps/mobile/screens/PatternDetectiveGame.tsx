import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Polygon, Rect } from "react-native-svg";
import { linearRegressionSlope, mean } from "../lib/stats";

const CANVAS_WIDTH = 260;
const CANVAS_HEIGHT = 210;
const REF_SIZE = 90;
// Brief pause after a hit so the green highlight registers before the next round loads —
// same reasoning as the choice-highlight pause in ReadingChallengeGame.
const FOUND_PAUSE_MS = 600;
const MISS_PULSE_MS = 180;

type ComplexityLevel = 1 | 2 | 3;
type ShapeKind = "circle" | "triangle" | "square";

type Shape = {
  id: string;
  kind: ShapeKind;
  cx: number;
  cy: number;
  size: number;
  rotation: number;
};

type RoundDef = {
  complexityLevel: ComplexityLevel;
  targetKind: ShapeKind;
  targetSize: number;
  targetRotation: number;
  // Exactly one entry has id "target" — same kind/size/rotation as the reference shape shown
  // above the canvas. The rest are distractors; more of them (and more overlap with the
  // target) is what "increasing visual complexity" means round to round.
  shapes: Shape[];
};

// Hand-placed, not randomly generated — same reasoning as ReadingChallengeGame's fixed
// sentences: deterministic layouts keep the signal comparable session to session instead of
// varying with a random draw's incidental difficulty. Complexity increases via shape count
// (4 -> 7 -> 10) and overlap with the target, mirroring the word-count thresholds used for
// reading complexity.
const ROUNDS: RoundDef[] = [
  {
    complexityLevel: 1,
    targetKind: "triangle",
    targetSize: 54,
    targetRotation: 0,
    shapes: [
      { id: "target", kind: "triangle", cx: 70, cy: 75, size: 54, rotation: 0 },
      { id: "d1", kind: "circle", cx: 175, cy: 60, size: 50, rotation: 0 },
      { id: "d2", kind: "square", cx: 135, cy: 150, size: 46, rotation: 20 },
      { id: "d3", kind: "triangle", cx: 215, cy: 155, size: 48, rotation: 70 },
    ],
  },
  {
    complexityLevel: 2,
    targetKind: "square",
    targetSize: 50,
    targetRotation: 25,
    shapes: [
      { id: "target", kind: "square", cx: 130, cy: 100, size: 50, rotation: 25 },
      // Kept close enough to overlap the target visually, but far enough that its own touch
      // zone (hitRadius) doesn't swallow the target's — see the hit-zone note on round 3 below.
      { id: "d1", kind: "circle", cx: 160, cy: 82, size: 44, rotation: 0 },
      { id: "d2", kind: "triangle", cx: 108, cy: 125, size: 42, rotation: 200 },
      { id: "d3", kind: "square", cx: 55, cy: 55, size: 40, rotation: 60 },
      { id: "d4", kind: "circle", cx: 215, cy: 55, size: 38, rotation: 0 },
      { id: "d5", kind: "triangle", cx: 205, cy: 155, size: 44, rotation: 10 },
      { id: "d6", kind: "square", cx: 65, cy: 165, size: 36, rotation: 80 },
    ],
  },
  {
    complexityLevel: 3,
    targetKind: "triangle",
    targetSize: 46,
    targetRotation: 45,
    shapes: [
      { id: "target", kind: "triangle", cx: 140, cy: 105, size: 46, rotation: 45 },
      // d1/d3 deliberately share one property with the target (rotation or kind) so it can't
      // be spotted by silhouette or angle alone — the point of an embedded-figures task. Their
      // centers stay far enough from the target's that each shape's own touch zone (see
      // hitRadius) never fully covers the target's — otherwise tapping the target's own visual
      // center would register as a miss, since whichever overlay renders on top wins the tap.
      { id: "d1", kind: "triangle", cx: 172, cy: 95, size: 46, rotation: 20 },
      { id: "d2", kind: "circle", cx: 118, cy: 130, size: 42, rotation: 0 },
      { id: "d3", kind: "square", cx: 168, cy: 132, size: 40, rotation: 45 },
      { id: "d4", kind: "triangle", cx: 95, cy: 65, size: 38, rotation: 80 },
      { id: "d5", kind: "circle", cx: 195, cy: 65, size: 36, rotation: 0 },
      { id: "d6", kind: "square", cx: 65, cy: 135, size: 38, rotation: 15 },
      { id: "d7", kind: "triangle", cx: 210, cy: 145, size: 40, rotation: 200 },
      { id: "d8", kind: "circle", cx: 55, cy: 55, size: 34, rotation: 0 },
      { id: "d9", kind: "square", cx: 200, cy: 175, size: 32, rotation: 65 },
    ],
  },
];

// Generous relative to shape size (mirrors ON_PATH_TOLERANCE's role in Follow the Path) so a
// touch registers as a "find" without needing pixel-perfect precision, while staying tight
// enough that adjacent overlapping shapes aren't ambiguous.
function hitRadius(size: number) {
  return Math.max(18, size * 0.45);
}

function trianglePoints(cx: number, cy: number, size: number) {
  const r = size / 2;
  return [-90, 30, 150]
    .map((deg) => (deg * Math.PI) / 180)
    .map((rad) => `${cx + r * Math.cos(rad)},${cy + r * Math.sin(rad)}`)
    .join(" ");
}

function renderShape(shape: Shape, color: string, strokeWidth: number) {
  const origin: [number, number] = [shape.cx, shape.cy];
  if (shape.kind === "circle") {
    return (
      <Circle
        key={shape.id}
        cx={shape.cx}
        cy={shape.cy}
        r={shape.size / 2}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
    );
  }
  if (shape.kind === "square") {
    return (
      <Rect
        key={shape.id}
        x={shape.cx - shape.size / 2}
        y={shape.cy - shape.size / 2}
        width={shape.size}
        height={shape.size}
        rotation={shape.rotation}
        origin={origin}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
    );
  }
  return (
    <Polygon
      key={shape.id}
      points={trianglePoints(shape.cx, shape.cy, shape.size)}
      rotation={shape.rotation}
      origin={origin}
      stroke={color}
      strokeWidth={strokeWidth}
      fill="none"
    />
  );
}

type Tap = { tMs: number; shapeId: string; hit: boolean };

export type PatternRoundResult = {
  complexityLevel: ComplexityLevel;
  shapeCount: number;
  timeToFindMs: number;
  missCount: number;
  taps: Tap[];
};

export type PatternDetectiveResult = {
  rounds: PatternRoundResult[];

  totalTimeMs: number;
  avgTimeToFindMs: number;
  totalMisses: number;
  avgMissesPerRound: number;

  timeToFindByComplexity: Record<ComplexityLevel, number>;
  missesByComplexity: Record<ComplexityLevel, number>;
  // level3 - level1: the researched "enhanced perceptual functioning" signal (docs/MINI_GAMES.md
  // §4) is fast, accurate detection that HOLDS UP as clutter increases — a small (or negative)
  // effect here means complexity barely slows this user down, unlike the other two games where
  // a *large* complexity effect is the signal of difficulty.
  complexityEffectTime: number;
  complexityEffectMisses: number;

  // Trend across rounds — practice getting faster vs. fatigue, distinct from a uniform pace.
  timeSlope: number;
  missSlope: number;
};

function summarize(rounds: PatternRoundResult[]): PatternDetectiveResult {
  const levels: ComplexityLevel[] = [1, 2, 3];
  const byLevel = (l: ComplexityLevel) => rounds.filter((r) => r.complexityLevel === l);
  const timeToFindByComplexity = Object.fromEntries(
    levels.map((l) => [l, mean(byLevel(l).map((r) => r.timeToFindMs))])
  ) as Record<ComplexityLevel, number>;
  const missesByComplexity = Object.fromEntries(
    levels.map((l) => [l, mean(byLevel(l).map((r) => r.missCount))])
  ) as Record<ComplexityLevel, number>;

  return {
    rounds,
    totalTimeMs: rounds.reduce((a, r) => a + r.timeToFindMs, 0),
    avgTimeToFindMs: mean(rounds.map((r) => r.timeToFindMs)),
    totalMisses: rounds.reduce((a, r) => a + r.missCount, 0),
    avgMissesPerRound: mean(rounds.map((r) => r.missCount)),

    timeToFindByComplexity,
    missesByComplexity,
    complexityEffectTime: timeToFindByComplexity[3] - timeToFindByComplexity[1],
    complexityEffectMisses: missesByComplexity[3] - missesByComplexity[1],

    timeSlope: linearRegressionSlope(
      rounds.map((_, i) => i),
      rounds.map((r) => r.timeToFindMs)
    ),
    missSlope: linearRegressionSlope(
      rounds.map((_, i) => i),
      rounds.map((r) => r.missCount)
    ),
  };
}

export default function PatternDetectiveGame({
  onComplete,
}: {
  onComplete: (result: PatternDetectiveResult) => void;
}) {
  const [roundIndex, setRoundIndex] = useState(0);
  const [found, setFound] = useState(false);
  const [missPulse, setMissPulse] = useState(false);
  // Only used to force a re-render so the live miss count (read from the ref below) reflects
  // the tap that was just recorded — the count itself always lives in tapLog.current.
  const [, forceRender] = useState(0);

  const roundStartedAt = useRef(performance.now());
  const tapLog = useRef<Tap[]>([]);
  const roundResults = useRef<PatternRoundResult[]>([]);
  // Guards taps landing during the found-transition pause, when the round is already decided
  // but the component hasn't advanced yet.
  const advancing = useRef(false);

  const round = ROUNDS[roundIndex];

  function advanceRound() {
    if (roundIndex + 1 < ROUNDS.length) {
      setRoundIndex((i) => i + 1);
      setFound(false);
      advancing.current = false;
      tapLog.current = [];
      roundStartedAt.current = performance.now();
    } else {
      onComplete(summarize(roundResults.current));
    }
  }

  // Each shape carries its own touch target (see the overlay below) sized by hitRadius, so
  // this only ever needs to know WHICH shape was tapped — no page/screen coordinate math
  // (locationX/locationY and Pressable.measure() are unreliable across native vs. web, which
  // made every tap register as a miss regardless of where the user touched).
  function handleShapeTap(shapeId: string) {
    if (advancing.current) return;
    const now = performance.now();
    const hit = shapeId === "target";

    tapLog.current.push({ tMs: now - roundStartedAt.current, shapeId, hit });

    if (hit) {
      advancing.current = true;
      setFound(true);
      roundResults.current.push({
        complexityLevel: round.complexityLevel,
        shapeCount: round.shapes.length,
        timeToFindMs: now - roundStartedAt.current,
        missCount: tapLog.current.filter((t) => !t.hit).length,
        taps: tapLog.current,
      });
      setTimeout(advanceRound, FOUND_PAUSE_MS);
    } else {
      setMissPulse(true);
      forceRender((n) => n + 1);
      setTimeout(() => setMissPulse(false), MISS_PULSE_MS);
    }
  }

  const missCount = tapLog.current.filter((t) => !t.hit).length;
  const statusDisplay = found
    ? { label: "Trouvé !", color: "#3FAE6A" }
    : { label: missCount === 0 ? "Cherche la forme repère" : `${missCount} essai${missCount > 1 ? "s" : ""}`, color: "#6B6280" };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        Détective de motifs — {roundIndex + 1}/{ROUNDS.length}
      </Text>
      <Text style={styles.instructions}>
        Repère cette forme cachée dans le dessin ci-dessous, puis touche-la.
      </Text>

      <View style={styles.referenceBox}>
        <Svg width={REF_SIZE} height={REF_SIZE}>
          {renderShape(
            {
              id: "reference",
              kind: round.targetKind,
              cx: REF_SIZE / 2,
              cy: REF_SIZE / 2,
              size: round.targetSize,
              rotation: round.targetRotation,
            },
            "#4B32C3",
            3
          )}
        </Svg>
      </View>

      <View style={[styles.board, missPulse && styles.boardMiss]}>
        <Svg width={CANVAS_WIDTH} height={CANVAS_HEIGHT} pointerEvents="none">
          {round.shapes.map((shape) =>
            renderShape(shape, shape.id === "target" && found ? "#3FAE6A" : "#2E2A47", shape.id === "target" && found ? 4 : 3)
          )}
        </Svg>
        {round.shapes.map((shape) => {
          const r = hitRadius(shape.size);
          return (
            <Pressable
              key={shape.id}
              onPress={() => handleShapeTap(shape.id)}
              style={{
                position: "absolute",
                left: shape.cx - r,
                top: shape.cy - r,
                width: r * 2,
                height: r * 2,
                borderRadius: r,
              }}
            />
          );
        })}
      </View>

      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>STATUT</Text>
        <Text style={[styles.statusValue, { color: statusDisplay.color }]}>{statusDisplay.label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#EDE7FA",
    borderRadius: 20,
    padding: 16,
    width: CANVAS_WIDTH + 32,
  },
  title: {
    fontWeight: "700",
    fontSize: 16,
    color: "#2E2A47",
    marginBottom: 8,
  },
  instructions: {
    color: "#6B6280",
    marginBottom: 12,
  },
  referenceBox: {
    backgroundColor: "#fff",
    borderRadius: 12,
    alignSelf: "center",
    marginBottom: 12,
  },
  board: {
    backgroundColor: "#fff",
    borderRadius: 16,
    alignSelf: "center",
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    position: "relative",
  },
  boardMiss: {
    backgroundColor: "#FBE0DB",
  },
  statusRow: {
    marginTop: 12,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
  },
  statusLabel: {
    fontSize: 11,
    color: "#9A93AE",
    letterSpacing: 1,
  },
  statusValue: {
    fontWeight: "600",
    marginTop: 2,
  },
});
