import type { Runner } from "./runner.js";

type OptimizerConfig = {
  maxCostUsd: number;
  costPerRun: number;
  targets: { recall: number; precision: number; f1: number };
};

type OptimizeResult = {
  iterations: number;
  bestF1: number;
  totalCost: number;
  targetMet: boolean;
  log: string[];
};

export function createOptimizer(runner: Runner, config: OptimizerConfig) {
  const segmentCount = 3;
  const costPerIteration = config.costPerRun * segmentCount;
  const maxIterations = Math.floor(config.maxCostUsd / costPerIteration);

  return {
    async runLoop(requestedMaxIter: number, targetF1: number): Promise<string> {
      const effectiveMax = Math.min(requestedMaxIter, maxIterations);
      const log: string[] = [];
      let totalCost = 0;
      let bestF1 = 0;
      let plateauCount = 0;
      const recentF1s: number[] = [];

      log.push(`Optimization loop: max ${effectiveMax} iterations, target F1=${targetF1}`);
      log.push(
        `Budget: $${config.maxCostUsd} (~${maxIterations} iterations at $${costPerIteration}/iter)`,
      );
      log.push("");

      for (let i = 1; i <= effectiveMax; i++) {
        // Step 1: Get suggestion
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

        // Step 2: Run experiment (this is where approval gate happens in the agent)
        log.push(`  Running experiment on all 3 segments...`);
        const resultRaw = await runner.run("run-experiment", [
          "--config",
          JSON.stringify(configOverride),
        ]);

        totalCost += costPerIteration;

        // Step 3: Parse results
        let result: Record<string, unknown>;
        try {
          result = JSON.parse(resultRaw);
        } catch {
          // Try to find JSON in output
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

        // Step 4: Check termination conditions
        if (
          f1 >= targetF1 &&
          precision >= config.targets.precision &&
          recall >= config.targets.recall
        ) {
          log.push(`ALL TARGETS MET at iteration ${i}!`);
          log.push(`  F1=${(f1 * 100).toFixed(1)}% >= ${(targetF1 * 100).toFixed(1)}%`);
          log.push(
            `  P=${(precision * 100).toFixed(1)}% >= ${(config.targets.precision * 100).toFixed(1)}%`,
          );
          log.push(
            `  R=${(recall * 100).toFixed(1)}% >= ${(config.targets.recall * 100).toFixed(1)}%`,
          );
          break;
        }

        if (totalCost >= config.maxCostUsd) {
          log.push(
            `Budget exhausted ($${totalCost.toFixed(2)} >= $${config.maxCostUsd}). Stopping.`,
          );
          break;
        }

        // Plateau detection
        recentF1s.push(f1);
        if (recentF1s.length > 5) {
          recentF1s.shift();
          const range = Math.max(...recentF1s) - Math.min(...recentF1s);
          if (range < 0.02) {
            plateauCount++;
            if (plateauCount >= 2) {
              log.push(
                `Plateau detected (last 5 F1 range < 2%). Consider trying EXP-021..026 for a different approach.`,
              );
            }
          } else {
            plateauCount = 0;
          }
        }
      }

      const summary: OptimizeResult = {
        iterations: recentF1s.length,
        bestF1,
        totalCost,
        targetMet: bestF1 >= targetF1,
        log,
      };

      return JSON.stringify(summary, null, 2);
    },
  };
}
