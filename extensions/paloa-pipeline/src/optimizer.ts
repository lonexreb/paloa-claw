import fs from "node:fs";
import path from "node:path";
import type { Runner } from "./runner.js";

type OptimizerConfig = {
  maxCostUsd: number;
  costPerRun: number;
  targets: { recall: number; precision: number; f1: number };
};

export type LoopState = {
  id: string;
  status: "suggesting" | "awaiting_approval" | "running" | "evaluating" | "complete" | "paused";
  iteration: number;
  maxIterations: number;
  targetF1: number;
  budget: number;
  spent: number;
  bestF1: number;
  currentSuggestion?: Record<string, unknown>;
  currentRationale?: string;
  recentF1s: number[];
  log: string[];
};

const STATE_DIR = path.join(process.env.HOME || "~", ".paloa", "optimizer");
const STATE_FILE = path.join(STATE_DIR, "loop_state.json");

function loadState(): LoopState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // corrupted state file
  }
  return null;
}

function saveState(state: LoopState) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function nextLoopId(): string {
  const existing = loadState();
  if (existing) {
    const num = parseInt(existing.id.replace("loop-", ""), 10) || 0;
    return `loop-${String(num + 1).padStart(3, "0")}`;
  }
  return "loop-001";
}

export function createOptimizer(runner: Runner, config: OptimizerConfig) {
  const segmentCount = 3;
  const costPerIteration = config.costPerRun * segmentCount;
  const maxBudgetIterations = Math.floor(config.maxCostUsd / costPerIteration);

  return {
    async start(requestedMaxIter: number, targetF1: number): Promise<string> {
      const effectiveMax = Math.min(requestedMaxIter, maxBudgetIterations);

      // Get first suggestion
      const suggestRaw = await runner.run("suggest");
      let suggestion: Record<string, unknown>;
      let rationale = "";
      try {
        suggestion = JSON.parse(suggestRaw);
        rationale = (suggestion.rationale as string) || "";
      } catch {
        return JSON.stringify({
          error: "Failed to parse initial suggestion",
          raw: suggestRaw.slice(0, 300),
        });
      }

      const state: LoopState = {
        id: nextLoopId(),
        status: "awaiting_approval",
        iteration: 1,
        maxIterations: effectiveMax,
        targetF1,
        budget: config.maxCostUsd,
        spent: 0,
        bestF1: 0,
        currentSuggestion: suggestion.suggestion as Record<string, unknown>,
        currentRationale: rationale,
        recentF1s: [],
        log: [
          `Optimization ${nextLoopId()}: max ${effectiveMax} iterations, target F1=${targetF1}`,
          `Budget: $${config.maxCostUsd} (~${maxBudgetIterations} iterations at $${costPerIteration}/iter)`,
          "",
          `[1/${effectiveMax}] Suggestion ready for approval:`,
          `  Rationale: ${rationale}`,
          `  Config: ${JSON.stringify(suggestion.suggestion)}`,
          `  Estimated cost: $${costPerIteration.toFixed(2)}`,
        ],
      };

      saveState(state);

      return JSON.stringify(
        {
          loop_id: state.id,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          suggestion: state.currentSuggestion,
          rationale: state.currentRationale,
          cost_estimate: costPerIteration,
          budget_remaining: state.budget - state.spent,
          param_gradients: (suggestion as Record<string, unknown>).param_gradients,
          plateau_strategy: (suggestion as Record<string, unknown>).plateau_strategy,
        },
        null,
        2,
      );
    },

    async step(): Promise<string> {
      const state = loadState();
      if (!state) {
        return JSON.stringify({ error: "No active loop. Call paloa_optimize_start first." });
      }

      if (state.status === "complete" || state.status === "paused") {
        return JSON.stringify({
          error: `Loop is ${state.status}. Start a new loop with paloa_optimize_start.`,
          bestF1: state.bestF1,
          spent: state.spent,
        });
      }

      // Run the current suggestion
      state.status = "running";
      state.log.push(`  Running experiment on all 3 segments...`);
      saveState(state);

      const resultRaw = await runner.run("run-experiment", [
        "--config",
        JSON.stringify(state.currentSuggestion),
      ]);

      state.spent += costPerIteration;
      state.status = "evaluating";

      // Parse results
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(resultRaw);
      } catch {
        const jsonMatch = resultRaw.match(/\{[\s\S]*"results"[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          state.log.push(`  Failed to parse results. Raw: ${resultRaw.slice(0, 300)}`);
          state.status = "awaiting_approval";
          saveState(state);
          return JSON.stringify({
            error: "Failed to parse experiment results",
            raw: resultRaw.slice(0, 500),
            loop_id: state.id,
          });
        }
      }

      // Check for error
      if (result.error_code) {
        state.log.push(`  ERROR: ${result.error_code}`);
        if (result.retryable) {
          state.log.push(`  Retryable error — suggestion unchanged, try again.`);
          state.status = "awaiting_approval";
        } else {
          state.log.push(`  Non-retryable error — loop paused.`);
          state.status = "paused";
        }
        saveState(state);
        return JSON.stringify(
          {
            loop_id: state.id,
            status: state.status,
            error_code: result.error_code,
            retryable: result.retryable,
            iteration: state.iteration,
            spent: state.spent,
          },
          null,
          2,
        );
      }

      const results = result.results as Record<string, Record<string, number>> | undefined;
      const agg = results?.aggregate ?? {};
      const f1 = agg.f1 ?? 0;
      const precision = agg.precision ?? 0;
      const recall = agg.recall ?? 0;

      state.log.push(
        `  Results: F1=${(f1 * 100).toFixed(1)}% P=${(precision * 100).toFixed(1)}% R=${(recall * 100).toFixed(1)}%`,
      );

      if (f1 > state.bestF1) {
        state.bestF1 = f1;
        state.log.push(`  ** New best F1! (${(state.bestF1 * 100).toFixed(1)}%)`);
      }

      state.log.push(`  Budget spent: $${state.spent.toFixed(2)} / $${state.budget}`);
      state.recentF1s.push(f1);
      if (state.recentF1s.length > 5) state.recentF1s.shift();

      // Check termination
      const allTargetsMet =
        f1 >= state.targetF1 &&
        precision >= config.targets.precision &&
        recall >= config.targets.recall;

      if (allTargetsMet) {
        state.status = "complete";
        state.log.push(`ALL TARGETS MET at iteration ${state.iteration}!`);
        saveState(state);
        return JSON.stringify(
          {
            loop_id: state.id,
            status: "complete",
            reason: "targets_met",
            iteration: state.iteration,
            bestF1: state.bestF1,
            spent: state.spent,
            results: { f1, precision, recall },
          },
          null,
          2,
        );
      }

      if (state.spent >= state.budget) {
        state.status = "complete";
        state.log.push(`Budget exhausted. Stopping.`);
        saveState(state);
        return JSON.stringify(
          {
            loop_id: state.id,
            status: "complete",
            reason: "budget_exhausted",
            iteration: state.iteration,
            bestF1: state.bestF1,
            spent: state.spent,
            results: { f1, precision, recall },
          },
          null,
          2,
        );
      }

      if (state.iteration >= state.maxIterations) {
        state.status = "complete";
        state.log.push(`Max iterations reached. Stopping.`);
        saveState(state);
        return JSON.stringify(
          {
            loop_id: state.id,
            status: "complete",
            reason: "max_iterations",
            iteration: state.iteration,
            bestF1: state.bestF1,
            spent: state.spent,
            results: { f1, precision, recall },
          },
          null,
          2,
        );
      }

      // Get next suggestion
      state.iteration++;
      const nextSuggestRaw = await runner.run("suggest");
      let nextSuggestion: Record<string, unknown> = {};
      let nextRationale = "";
      try {
        nextSuggestion = JSON.parse(nextSuggestRaw);
        nextRationale = (nextSuggestion.rationale as string) || "";
      } catch {
        state.log.push(`  Warning: failed to parse next suggestion`);
      }

      state.currentSuggestion = nextSuggestion.suggestion as Record<string, unknown>;
      state.currentRationale = nextRationale;
      state.status = "awaiting_approval";

      state.log.push("");
      state.log.push(`[${state.iteration}/${state.maxIterations}] Next suggestion:`);
      state.log.push(`  Rationale: ${nextRationale}`);
      state.log.push(`  Config: ${JSON.stringify(state.currentSuggestion)}`);

      saveState(state);

      return JSON.stringify(
        {
          loop_id: state.id,
          status: "awaiting_approval",
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          lastResults: { f1, precision, recall },
          bestF1: state.bestF1,
          spent: state.spent,
          budget_remaining: state.budget - state.spent,
          nextSuggestion: state.currentSuggestion,
          nextRationale,
          plateau_strategy: (nextSuggestion as Record<string, unknown>).plateau_strategy,
        },
        null,
        2,
      );
    },

    async getStatus(): Promise<string> {
      const state = loadState();
      if (!state) {
        return JSON.stringify({
          status: "no_active_loop",
          message: "No optimization loop running. Use paloa_optimize_start to begin.",
        });
      }

      return JSON.stringify(
        {
          loop_id: state.id,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          targetF1: state.targetF1,
          bestF1: state.bestF1,
          spent: state.spent,
          budget: state.budget,
          budget_remaining: state.budget - state.spent,
          recentF1s: state.recentF1s,
          currentSuggestion:
            state.status === "awaiting_approval" ? state.currentSuggestion : undefined,
          log_tail: state.log.slice(-10),
        },
        null,
        2,
      );
    },

    // Keep the old monolithic loop for backwards compatibility
    async runLoop(requestedMaxIter: number, targetF1: number): Promise<string> {
      const effectiveMax = Math.min(requestedMaxIter, maxBudgetIterations);
      const log: string[] = [];
      let totalCost = 0;
      let bestF1 = 0;
      let plateauCount = 0;
      const recentF1s: number[] = [];

      log.push(`Optimization loop: max ${effectiveMax} iterations, target F1=${targetF1}`);
      log.push(
        `Budget: $${config.maxCostUsd} (~${maxBudgetIterations} iterations at $${costPerIteration}/iter)`,
      );
      log.push("");

      for (let i = 1; i <= effectiveMax; i++) {
        const suggestRaw = await runner.run("suggest");
        let suggestion: Record<string, unknown>;
        try {
          suggestion = JSON.parse(suggestRaw);
        } catch {
          log.push(`[${i}] Failed to parse suggestion: ${suggestRaw.slice(0, 200)}`);
          continue;
        }

        const configOverride = suggestion.suggestion as Record<string, unknown>;
        const rationale = suggestion.rationale as string;

        log.push(`[${i}/${effectiveMax}] Suggested config:`);
        log.push(`  Rationale: ${rationale}`);
        log.push(`  Config: ${JSON.stringify(configOverride)}`);
        log.push(`  Estimated cost: $${costPerIteration.toFixed(2)}`);
        log.push("");

        log.push(`  Running experiment on all 3 segments...`);
        const resultRaw = await runner.run("run-experiment", [
          "--config",
          JSON.stringify(configOverride),
        ]);

        totalCost += costPerIteration;

        let result: Record<string, unknown>;
        try {
          result = JSON.parse(resultRaw);
        } catch {
          const jsonMatch = resultRaw.match(/\{[\s\S]*"results"[\s\S]*\}/);
          if (jsonMatch) {
            result = JSON.parse(jsonMatch[0]);
          } else {
            log.push(`  Failed to parse results. Raw output: ${resultRaw.slice(0, 300)}`);
            continue;
          }
        }

        const results = result.results as Record<string, Record<string, number>> | undefined;
        const agg = results?.aggregate ?? {};
        const f1 = agg.f1 ?? 0;
        const precision = agg.precision ?? 0;
        const recall = agg.recall ?? 0;

        log.push(
          `  Results: F1=${(f1 * 100).toFixed(1)}% P=${(precision * 100).toFixed(1)}% R=${(recall * 100).toFixed(1)}%`,
        );

        if (f1 > bestF1) {
          bestF1 = f1;
          log.push(`  ** New best F1! (${(bestF1 * 100).toFixed(1)}%)`);
        }

        log.push(`  Budget spent: $${totalCost.toFixed(2)} / $${config.maxCostUsd}`);
        log.push("");

        if (
          f1 >= targetF1 &&
          precision >= config.targets.precision &&
          recall >= config.targets.recall
        ) {
          log.push(`ALL TARGETS MET at iteration ${i}!`);
          break;
        }

        if (totalCost >= config.maxCostUsd) {
          log.push(`Budget exhausted. Stopping.`);
          break;
        }

        recentF1s.push(f1);
        if (recentF1s.length > 5) {
          recentF1s.shift();
          const range = Math.max(...recentF1s) - Math.min(...recentF1s);
          if (range < 0.02) {
            plateauCount++;
            if (plateauCount >= 2) {
              log.push(`Plateau detected (last 5 F1 range < 2%). Consider trying EXP-021..026.`);
            }
          } else {
            plateauCount = 0;
          }
        }
      }

      return JSON.stringify(
        {
          iterations: recentF1s.length,
          bestF1,
          totalCost,
          targetMet: bestF1 >= targetF1,
          log,
        },
        null,
        2,
      );
    },
  };
}
