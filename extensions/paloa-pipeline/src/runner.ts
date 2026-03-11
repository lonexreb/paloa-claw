import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type RunResult = {
  stdout: string;
  progress: string[];
};

export type Runner = {
  run: (subcommand: string, args?: string[]) => Promise<string>;
  runBridge: (subcommand: string, args?: string[]) => Promise<string>;
};

// Subcommands that involve GPU operations and are eligible for retry + longer timeout
const GPU_SUBCOMMANDS = new Set(["run-experiment", "sweep", "sweep-single"]);

// Trace directory
const TRACE_DIR = path.join(process.env.HOME || "~", ".paloa", "optimizer", "traces");

function ensureTraceDir() {
  fs.mkdirSync(TRACE_DIR, { recursive: true });
}

function appendTrace(entry: Record<string, unknown>) {
  ensureTraceDir();
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(TRACE_DIR, `${date}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRunner(pythonPath: string, workspaceDir: string): Runner {
  const scriptPath = path.join(workspaceDir, "workers", "pipeline_optimizer.py");
  const bridgePath = path.join(workspaceDir, "workers", "paloa_cli_bridge.py");

  function execPython(
    script: string,
    label: string,
    subcommand: string,
    args: string[],
  ): Promise<RunResult> {
    const fullArgs = [script, subcommand, ...args];
    const isGpu = GPU_SUBCOMMANDS.has(subcommand);
    const timeout = isGpu ? 1_800_000 : 600_000; // 30 min for GPU ops, 10 min otherwise

    return new Promise((resolve, reject) => {
      const stderrLines: string[] = [];

      const proc = execFile(
        pythonPath,
        fullArgs,
        {
          cwd: workspaceDir,
          timeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          // Collect any remaining stderr
          if (stderr) {
            for (const line of stderr.split("\n")) {
              if (line.trim()) stderrLines.push(line.trim());
            }
          }

          if (error) {
            const msg = stderr?.trim() || error.message;
            reject(new Error(`${label} ${subcommand} failed: ${msg}`));
            return;
          }
          resolve({ stdout, progress: stderrLines });
        },
      );

      // Collect stderr progress lines in real-time
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          if (line.trim()) stderrLines.push(line.trim());
        }
        // Also forward to console for visibility
        process.stderr.write(chunk);
      });
    });
  }

  async function execPythonWithRetry(
    script: string,
    label: string,
    subcommand: string,
    args: string[],
    maxRetries: number = 2,
  ): Promise<string> {
    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { stdout, progress: progressLines } = await execPython(
          script,
          label,
          subcommand,
          args,
        );

        // Try to parse result and check for retryable errors
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error_code && parsed.retryable && attempt < maxRetries) {
            const wait = (parsed.retry_after_sec || 30) * 1000;
            process.stderr.write(
              `[retry] ${parsed.error_code}: retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})\n`,
            );

            // Log failed attempt
            appendTrace({
              timestamp: new Date().toISOString(),
              tool: label,
              subcommand,
              args,
              attempt,
              duration_ms: Date.now() - startTime,
              error: parsed.error_code,
              retrying: true,
            });

            await sleep(wait);
            continue;
          }

          // Attach progress lines to result
          if (progressLines.length > 0) {
            parsed._progress = progressLines;
          }

          // Log success
          appendTrace({
            timestamp: new Date().toISOString(),
            tool: label,
            subcommand,
            args,
            attempt,
            duration_ms: Date.now() - startTime,
            result_summary: {
              f1: parsed.results?.aggregate?.f1 ?? parsed.f1,
              precision: parsed.results?.aggregate?.precision ?? parsed.precision,
              recall: parsed.results?.aggregate?.recall ?? parsed.recall,
            },
            error: parsed.error_code || null,
          });

          return JSON.stringify(parsed, null, 2);
        } catch {
          // stdout wasn't JSON — return as-is (e.g., status output)
          appendTrace({
            timestamp: new Date().toISOString(),
            tool: label,
            subcommand,
            args,
            attempt,
            duration_ms: Date.now() - startTime,
            result_summary: "non-json",
            error: null,
          });
          return stdout;
        }
      } catch (e) {
        appendTrace({
          timestamp: new Date().toISOString(),
          tool: label,
          subcommand,
          args,
          attempt,
          duration_ms: Date.now() - startTime,
          error: (e as Error).message.slice(0, 200),
          retrying: attempt < maxRetries,
        });

        if (attempt === maxRetries) throw e;
        process.stderr.write(`[retry] Error: ${(e as Error).message.slice(0, 100)}. Retrying...\n`);
        await sleep(30_000);
      }
    }

    throw new Error("unreachable");
  }

  return {
    async run(subcommand: string, args: string[] = []): Promise<string> {
      const shouldRetry = GPU_SUBCOMMANDS.has(subcommand);
      if (shouldRetry) {
        return execPythonWithRetry(scriptPath, "pipeline_optimizer.py", subcommand, args);
      }
      const { stdout } = await execPython(scriptPath, "pipeline_optimizer.py", subcommand, args);
      return stdout;
    },
    async runBridge(subcommand: string, args: string[] = []): Promise<string> {
      const { stdout } = await execPython(bridgePath, "paloa_cli_bridge.py", subcommand, args);
      return stdout;
    },
  };
}
