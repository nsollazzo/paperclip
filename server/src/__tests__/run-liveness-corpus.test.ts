import { describe, expect, it } from "vitest";
import { RUN_LIVENESS_STATES, type RunLivenessState } from "@paperclipai/shared";
import {
  classifyRunLiveness,
  type RunLivenessClassificationInput,
} from "../services/run-liveness.ts";
import {
  PRECISION_FLOOR,
  RECALL_FLOOR,
  RUN_LIVENESS_CORPUS,
  RUN_LIVENESS_GAMING_HOLES,
  type RunLivenessCorpusCase,
} from "./fixtures/run-liveness-corpus.ts";

type Classifier = (input: RunLivenessClassificationInput) => RunLivenessState;

interface StateMetrics {
  support: number; // ground-truth count for this state
  predicted: number; // predicted count for this state
  truePositives: number;
  precision: number; // TP / predicted (1 when nothing predicted)
  recall: number; // TP / support (1 when no support)
}

function evaluate(
  classify: Classifier,
  corpus: RunLivenessCorpusCase[],
): Record<RunLivenessState, StateMetrics> {
  const support = {} as Record<RunLivenessState, number>;
  const predicted = {} as Record<RunLivenessState, number>;
  const tp = {} as Record<RunLivenessState, number>;
  for (const state of RUN_LIVENESS_STATES) {
    support[state] = 0;
    predicted[state] = 0;
    tp[state] = 0;
  }

  for (const item of corpus) {
    const actual = classify(item.input);
    support[item.expected] += 1;
    predicted[actual] += 1;
    if (actual === item.expected) tp[item.expected] += 1;
  }

  const metrics = {} as Record<RunLivenessState, StateMetrics>;
  for (const state of RUN_LIVENESS_STATES) {
    metrics[state] = {
      support: support[state],
      predicted: predicted[state],
      truePositives: tp[state],
      precision: predicted[state] === 0 ? 1 : tp[state] / predicted[state],
      recall: support[state] === 0 ? 1 : tp[state] / support[state],
    };
  }
  return metrics;
}

function floorViolations(metrics: Record<RunLivenessState, StateMetrics>): string[] {
  const violations: string[] = [];
  for (const state of RUN_LIVENESS_STATES) {
    const m = metrics[state];
    if (m.support > 0 && m.precision < PRECISION_FLOOR[state]) {
      violations.push(`${state}: precision ${m.precision.toFixed(2)} < ${PRECISION_FLOOR[state]}`);
    }
    if (m.support > 0 && m.recall < RECALL_FLOOR[state]) {
      violations.push(`${state}: recall ${m.recall.toFixed(2)} < ${RECALL_FLOOR[state]}`);
    }
  }
  return violations;
}

const realClassifier: Classifier = (input) => classifyRunLiveness(input).livenessState;

describe("run-liveness golden corpus", () => {
  it("has a representative, multi-state corpus", () => {
    // Guard against the corpus silently shrinking or collapsing to a few states.
    expect(RUN_LIVENESS_CORPUS.length).toBeGreaterThanOrEqual(48);
    const covered = new Set(RUN_LIVENESS_CORPUS.map((c) => c.expected));
    for (const state of RUN_LIVENESS_STATES) {
      expect(covered.has(state), `no corpus coverage for state ${state}`).toBe(true);
    }
    const ids = RUN_LIVENESS_CORPUS.map((c) => c.id);
    expect(new Set(ids).size, "duplicate corpus ids").toBe(ids.length);
  });

  it.each(RUN_LIVENESS_CORPUS)("labels $id as $expected", (item) => {
    const classification = classifyRunLiveness(item.input);
    expect(classification.livenessState, item.note).toBe(item.expected);
    if (item.expectedActionability) {
      expect(classification.actionability, item.note).toBe(item.expectedActionability);
    }
  });

  it("meets per-state precision and recall floors", () => {
    const metrics = evaluate(realClassifier, RUN_LIVENESS_CORPUS);
    expect(floorViolations(metrics)).toEqual([]);
  });

  it("floors fail on a deliberate classifier loosening", () => {
    // Simulate the classic gaming regression: any run with non-empty output is
    // rubber-stamped as `advanced` progress. This must trip the floors — proving
    // the thresholds have teeth rather than passing vacuously.
    const loosened: Classifier = (input) => {
      const state = classifyRunLiveness(input).livenessState;
      if (state === "plan_only" || state === "needs_followup" || state === "empty_response") {
        return "advanced";
      }
      return state;
    };
    const violations = floorViolations(evaluate(loosened, RUN_LIVENESS_CORPUS));
    expect(violations.length, "loosened classifier unexpectedly met all floors").toBeGreaterThan(0);
  });
});

// Known gaming holes. These assert the DESIRED (non-gameable) classification,
// which the current classifier does NOT produce — so each is pinned as an
// expected failure. If the classifier is tightened to close a hole, its pin
// flips to passing and vitest fails the (now-incorrect) `.fails` expectation,
// forcing the pin to be updated/removed alongside the fix.
describe("run-liveness gaming holes (pinned expected-fail)", () => {
  for (const hole of RUN_LIVENESS_GAMING_HOLES) {
    it.fails(`${hole.id}: should classify as ${hole.desired} (${hole.note})`, () => {
      expect(classifyRunLiveness(hole.input).livenessState).toBe(hole.desired);
    });

    it(`${hole.id}: currently returns ${hole.currentlyReturns}`, () => {
      // Documents today's gameable behavior so a change is visible in the diff.
      expect(classifyRunLiveness(hole.input).livenessState).toBe(hole.currentlyReturns);
    });
  }
});
