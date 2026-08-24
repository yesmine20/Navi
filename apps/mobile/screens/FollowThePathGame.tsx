import { useMemo, useRef, useState } from "react";
import {
  GestureResponderEvent,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import Svg, { Circle, Polyline } from "react-native-svg";
import { coefficientOfVariation, linearRegressionSlope, mean, percentile } from "../lib/stats";

const WIDTH = 300;
const HEIGHT = 180;
const POINT_COUNT = 60;
const PATH_WIDTH_PX = WIDTH - 40; // horizontal span used in buildPath — deviation's reference scale
const ON_PATH_TOLERANCE = 22;
// Deviation threshold expressed relative to this round's own median deviation, instead of
// only the fixed pixel tolerance above — less dependent on screen size/DPI. k in the 1.5–2.0
// range is a reasonable starting point; the agent can compare which correlates better later.
const RELATIVE_THRESHOLD_K = 1.75;
// An excursion peaking above (threshold × this) counts as a "large" correction rather than a
// small oscillation — a rough way to separate dysmetria-scale corrections from fine tremor.
const LARGE_CORRECTION_MULTIPLIER = 2;
// Intermediate checkpoints along the path (as a fraction of progress), used to measure
// movement rhythm — how regular the time between checkpoints is, not just the endpoint.
const WAYPOINT_FRACTIONS = [0.25, 0.5, 0.75];
// "Beginning" / "end" of the movement, for detecting progressive slowing (bradykinesia-style
// signal) — the first/last slice of the speed series, by sample count so it works regardless
// of how long the round took.
const SPEED_EDGE_FRACTION = 0.25;
// How long the success feedback (checkmark + haptic) stays visible before onComplete fires
// and the app navigates away — long enough to register, short enough not to feel like a wait.
const SUCCESS_FEEDBACK_MS = 700;

type Point = { x: number; y: number };

export type TrajectorySample = {
  tMs: number;
  x: number;
  y: number;
  deviation: number;
};

export type FollowThePathResult = {
  // Spatial accuracy — raw px and normalized to path width, so thresholds are interpretable
  // as "multiples of the path's own scale" rather than a device-specific pixel count.
  pathDeviationAvg: number;
  pathDeviationMedian: number;
  pathDeviationP95: number;
  pathDeviationMax: number;
  pathDeviationAvgNorm: number;
  pathDeviationMedianNorm: number;
  pathDeviationP95Norm: number;
  pathDeviationMaxNorm: number;

  // Off-path time + corrections, computed twice: once against the fixed pixel tolerance,
  // once against a threshold relative to this round's own median deviation.
  timeOffPathMs: number;
  timeOffPathRatio: number;
  corrections: number;
  correctionsLarge: number;
  correctionsSmall: number;
  timeOffPathMsRelative: number;
  timeOffPathRatioRelative: number;
  correctionsRelative: number;
  correctionsRelativeLarge: number;
  correctionsRelativeSmall: number;

  // Speed / rhythm — slopes are the "sequence effect" signal (progressive slowing within
  // the round), distinct from just being slow overall.
  avgSpeed: number;
  speedStart: number;
  speedEnd: number;
  speedEndToStartRatio: number;
  speedCV: number;
  speedSlope: number;
  smoothness: number;
  waypointIntervalsMs: number[];
  waypointIntervalCV: number;
  intervalTrend: number;

  completed: boolean;
  durationMs: number;
  // Raw samples, not a score — tremor amplitude/frequency (FFT on the perpendicular-to-path
  // component) needs the full time series, not just aggregates. Left for the Profiling &
  // Adaptation Agent (docs/ARCHITECTURE.md §0 principle #5: decision content, including any
  // derived score, is never computed/hardcoded on-device).
  trajectory: TrajectorySample[];
};

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Single pass over timestamped deviation samples: total time spent past `threshold`, and
// excursions past it classified as "large" (peaked past threshold × largeMultiplier) or
// "small". Reused for both the fixed-pixel and the relative-to-median thresholds.
function analyzeExcursions(
  samples: { tMs: number; deviation: number }[],
  threshold: number,
  largeMultiplier: number
) {
  let timeOffPathMs = 0;
  let corrections = 0;
  let correctionsLarge = 0;
  let correctionsSmall = 0;
  let off = false;
  let excursionMax = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dt = cur.tMs - prev.tMs;
    const isOff = cur.deviation > threshold;

    if (isOff) {
      if (dt > 0) timeOffPathMs += dt;
      excursionMax = Math.max(excursionMax, cur.deviation);
      off = true;
    } else if (off) {
      corrections += 1;
      if (excursionMax > threshold * largeMultiplier) correctionsLarge += 1;
      else correctionsSmall += 1;
      off = false;
      excursionMax = 0;
    }
  }

  return { timeOffPathMs, corrections, correctionsLarge, correctionsSmall };
}

function buildPath(): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    const t = i / (POINT_COUNT - 1);
    const x = 20 + t * (WIDTH - 40);
    const y = HEIGHT / 2 + 50 * Math.sin(t * Math.PI * 1.5);
    points.push({ x, y });
  }
  return points;
}

export default function FollowThePathGame({
  onComplete,
}: {
  onComplete: (result: FollowThePathResult) => void;
}) {
  const path = useMemo(buildPath, []);
  const waypointIndices = useMemo(
    () => WAYPOINT_FRACTIONS.map((f) => Math.round(f * (path.length - 1))),
    [path]
  );
  const [puck, setPuck] = useState<Point>(path[0]);
  const [onPathStatus, setOnPathStatus] = useState(true);
  const [isTouching, setIsTouching] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const containerOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<View>(null);
  const lastIndex = useRef(0);
  const startedAt = useRef<number | null>(null);
  // Ref, not state: handleMove/onPanResponderRelease are captured once inside the
  // PanResponder built via useRef below, so a state read here would stay frozen at its
  // initial value forever (the same stale-closure trap the timer hit earlier).
  const startedRef = useRef(false);
  const finished = useRef(false);
  const trajectory = useRef<TrajectorySample[]>([]);
  const waypointTimestamps = useRef<(number | null)[]>(
    WAYPOINT_FRACTIONS.map(() => null)
  );

  function finish(completed: boolean) {
    if (finished.current) return;
    finished.current = true;

    if (completed) {
      setIsSuccess(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }

    const durationMs = performance.now() - (startedAt.current ?? performance.now());
    const samples = trajectory.current;
    const deviations = samples.map((s) => s.deviation);

    const avg = mean(deviations);
    const median = percentile(deviations, 50);
    const p95 = percentile(deviations, 95);
    const max = Math.max(0, ...deviations);

    const speedSeries: { tMs: number; speed: number }[] = [];
    for (let i = 1; i < samples.length; i++) {
      const dtMs = samples[i].tMs - samples[i - 1].tMs;
      if (dtMs > 0) {
        speedSeries.push({
          tMs: samples[i].tMs,
          speed: distance(samples[i - 1], samples[i]) / (dtMs / 1000),
        });
      }
    }
    const speeds = speedSeries.map((s) => s.speed);
    const avgSpeed = mean(speeds);
    const edgeCount = Math.max(1, Math.round(speeds.length * SPEED_EDGE_FRACTION));
    const speedStart = mean(speeds.slice(0, edgeCount));
    const speedEnd = mean(speeds.slice(-edgeCount));
    const speedCV = coefficientOfVariation(speeds);
    const smoothness = Math.max(0, Math.min(1, 1 - speedCV));
    const speedSlope = linearRegressionSlope(
      speedSeries.map((s) => s.tMs),
      speeds
    );

    const absolute = analyzeExcursions(samples, ON_PATH_TOLERANCE, LARGE_CORRECTION_MULTIPLIER);
    const relativeThreshold = RELATIVE_THRESHOLD_K * (median || ON_PATH_TOLERANCE);
    const relative = analyzeExcursions(samples, relativeThreshold, LARGE_CORRECTION_MULTIPLIER);

    const reachedWaypoints = waypointTimestamps.current.filter(
      (t): t is number => t !== null
    );
    const checkpoints = [...reachedWaypoints, durationMs];
    const waypointIntervalsMs = checkpoints.map((t, i) =>
      i === 0 ? t : t - checkpoints[i - 1]
    );
    const waypointIntervalCV = coefficientOfVariation(waypointIntervalsMs);
    const intervalTrend = linearRegressionSlope(
      waypointIntervalsMs.map((_, i) => i),
      waypointIntervalsMs
    );

    const result: FollowThePathResult = {
      pathDeviationAvg: avg,
      pathDeviationMedian: median,
      pathDeviationP95: p95,
      pathDeviationMax: max,
      pathDeviationAvgNorm: avg / PATH_WIDTH_PX,
      pathDeviationMedianNorm: median / PATH_WIDTH_PX,
      pathDeviationP95Norm: p95 / PATH_WIDTH_PX,
      pathDeviationMaxNorm: max / PATH_WIDTH_PX,

      timeOffPathMs: absolute.timeOffPathMs,
      timeOffPathRatio: absolute.timeOffPathMs / Math.max(1, durationMs),
      corrections: absolute.corrections,
      correctionsLarge: absolute.correctionsLarge,
      correctionsSmall: absolute.correctionsSmall,
      timeOffPathMsRelative: relative.timeOffPathMs,
      timeOffPathRatioRelative: relative.timeOffPathMs / Math.max(1, durationMs),
      correctionsRelative: relative.corrections,
      correctionsRelativeLarge: relative.correctionsLarge,
      correctionsRelativeSmall: relative.correctionsSmall,

      avgSpeed,
      speedStart,
      speedEnd,
      speedEndToStartRatio: speedEnd / (speedStart + 1e-6),
      speedCV,
      speedSlope,
      smoothness,
      waypointIntervalsMs,
      waypointIntervalCV,
      intervalTrend,

      completed,
      durationMs,
      trajectory: samples,
    };

    if (completed) {
      // Let the success feedback (checkmark + haptic) register before the app
      // navigates away and unmounts this screen.
      setTimeout(() => onComplete(result), SUCCESS_FEEDBACK_MS);
    } else {
      onComplete(result);
    }
  }

  function handleMove(evt: GestureResponderEvent) {
    const x = evt.nativeEvent.pageX - containerOffset.current.x;
    const y = evt.nativeEvent.pageY - containerOffset.current.y;
    const touchPoint = { x, y };
    const now = performance.now();
    setPuck(touchPoint);

    if (!startedRef.current) {
      startedRef.current = true;
      startedAt.current = now;
    }

    // Nearest path point at or ahead of the last matched index — progression
    // is monotonic, small backtrack window allowed for natural finger wobble.
    const searchStart = Math.max(0, lastIndex.current - 2);
    const searchEnd = Math.min(path.length - 1, lastIndex.current + 6);
    let bestIndex = lastIndex.current;
    let bestDist = Infinity;
    for (let i = searchStart; i <= searchEnd; i++) {
      const d = distance(touchPoint, path[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    lastIndex.current = Math.max(lastIndex.current, bestIndex);

    waypointIndices.forEach((idx, i) => {
      if (lastIndex.current >= idx && waypointTimestamps.current[i] === null) {
        waypointTimestamps.current[i] = now - (startedAt.current ?? now);
      }
    });

    setOnPathStatus(bestDist <= ON_PATH_TOLERANCE);

    trajectory.current.push({
      tMs: now - (startedAt.current ?? now),
      x: touchPoint.x,
      y: touchPoint.y,
      deviation: bestDist,
    });

    if (lastIndex.current >= path.length - 2) finish(true);
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setIsTouching(true),
      onPanResponderMove: handleMove,
      // Releasing early no longer ends the round — progress (lastIndex, trajectory) is kept
      // in refs, so the user can put their finger back down and resume from where they left off.
      onPanResponderRelease: () => setIsTouching(false),
      onPanResponderTerminate: () => setIsTouching(false),
    })
  ).current;

  const statusDisplay = isSuccess
    ? { label: "Bravo, tu as atteint le but !", color: "#3FAE6A" }
    : !isTouching && startedRef.current
    ? { label: "En pause — repose ton doigt sur le point", color: "#9A93AE" }
    : { label: onPathStatus ? "Sur le chemin" : "Hors du chemin", color: onPathStatus ? "#4B32C3" : "#E0664B" };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Suis le chemin</Text>
      </View>
      <Text style={styles.instructions}>
        {isSuccess
          ? "Parcours terminé."
          : "Fais glisser le point le long de la ligne. Tu peux relâcher et reprendre à tout moment."}
      </Text>

      <View
        ref={containerRef}
        style={styles.board}
        onLayout={() => {
          containerRef.current?.measure((_x, _y, _w, _h, pageX, pageY) => {
            containerOffset.current = { x: pageX, y: pageY };
          });
        }}
        {...panResponder.panHandlers}
      >
        <Svg width={WIDTH} height={HEIGHT}>
          <Polyline
            points={path.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#C9BEEC"
            strokeWidth={4}
            strokeDasharray="2,10"
            strokeLinecap="round"
          />
          <Circle cx={path[0].x} cy={path[0].y} r={8} fill="#4B32C3" />
          <Circle
            cx={path[path.length - 1].x}
            cy={path[path.length - 1].y}
            r={isSuccess ? 12 : 8}
            fill={isSuccess ? "#3FAE6A" : "#4B32C3"}
            opacity={isSuccess ? 1 : 0.4}
          />
          <Circle
            cx={puck.x}
            cy={puck.y}
            r={14}
            fill={isSuccess ? "#3FAE6A" : onPathStatus ? "#4B32C3" : "#E0664B"}
            opacity={isTouching || isSuccess ? 0.85 : 0.4}
          />
        </Svg>
      </View>

      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>STATUT</Text>
        <Text style={[styles.statusValue, { color: statusDisplay.color }]}>
          {statusDisplay.label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#EDE7FA",
    borderRadius: 20,
    padding: 16,
    width: WIDTH + 32,
  },
  header: {
    marginBottom: 8,
  },
  title: {
    fontWeight: "700",
    fontSize: 16,
    color: "#2E2A47",
  },
  instructions: {
    color: "#6B6280",
    marginBottom: 12,
  },
  board: {
    backgroundColor: "#fff",
    borderRadius: 16,
    alignSelf: "center",
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
