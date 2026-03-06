import { execFile } from "node:child_process";
import path from "node:path";

export type Runner = {
  run: (subcommand: string, args?: string[]) => Promise<string>;
};

export function createRunner(pythonPath: string, workspaceDir: string): Runner {
  const scriptPath = path.join(workspaceDir, "workers", "pipeline_optimizer.py");

  return {
    async run(subcommand: string, args: string[] = []): Promise<string> {
      const fullArgs = [scriptPath, subcommand, ...args];

      return new Promise((resolve, reject) => {
        const proc = execFile(
          pythonPath,
          fullArgs,
          {
            cwd: workspaceDir,
            timeout: 600_000, // 10 min max
            maxBuffer: 10 * 1024 * 1024, // 10MB
            env: { ...process.env },
          },
          (error, stdout, stderr) => {
            if (error) {
              const msg = stderr?.trim() || error.message;
              reject(new Error(`pipeline_optimizer.py ${subcommand} failed: ${msg}`));
              return;
            }
            resolve(stdout);
          },
        );

        // Forward stderr to console for visibility during long runs
        proc.stderr?.on("data", (chunk: Buffer) => {
          process.stderr.write(chunk);
        });
      });
    },
  };
}
