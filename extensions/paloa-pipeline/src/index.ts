import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import { createOptimizer } from "./optimizer.js";
import { createRunner } from "./runner.js";

type PluginCfg = {
  workspaceDir?: string;
  pythonPath?: string;
  maxCostUsd?: number;
  costPerRun?: number;
  targets?: { recall?: number; precision?: number; f1?: number };
};

export default function register(api: OpenClawPluginApi) {
  const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;
  const workspaceDir = pluginCfg.workspaceDir ?? process.env.PALOA_WORKSPACE ?? process.cwd();
  const pythonPath = pluginCfg.pythonPath ?? "python3";
  const maxCostUsd = pluginCfg.maxCostUsd ?? 20;
  const costPerRun = pluginCfg.costPerRun ?? 0.4;
  const targets = {
    recall: pluginCfg.targets?.recall ?? 0.85,
    precision: pluginCfg.targets?.precision ?? 0.9,
    f1: pluginCfg.targets?.f1 ?? 0.85,
  };

  const runner = createRunner(pythonPath, workspaceDir);
  const optimizer = createOptimizer(runner, { maxCostUsd, costPerRun, targets });

  // Tool: paloa_status
  api.registerTool(
    {
      name: "paloa_status",
      label: "Pipeline Status",
      description:
        "Show current pipeline config, best experimental config, and KPI gap vs targets.",
      parameters: {},
      async execute() {
        const result = await runner.run("status");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_evaluate
  api.registerTool(
    {
      name: "paloa_evaluate",
      label: "Evaluate Results",
      description: "Evaluate pipeline results against ground truth for a segment.",
      parameters: {
        type: "object",
        properties: {
          resultsFile: { type: "string", description: "Path to results JSON file" },
          segment: {
            type: "string",
            enum: ["segment_1", "segment_2", "segment_3"],
            description: "Test segment to evaluate against",
          },
        },
        required: ["resultsFile"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const file = params.resultsFile as string;
        const segment = (params.segment as string) ?? "segment_1";
        const result = await runner.run("evaluate", ["--results-file", file, "--segment", segment]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_run_experiment (requires approval — GPU cost)
  api.registerTool(
    {
      name: "paloa_run_experiment",
      label: "Run Experiment",
      description:
        "Run a single pipeline experiment with config overrides on Modal GPU. Costs ~$0.40 per segment. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          config: {
            type: "string",
            description: 'JSON config overrides, e.g. \'{"ball_conf": 0.25, "dedup_window": 5.0}\'',
          },
          segment: {
            type: "string",
            enum: ["segment_1", "segment_2", "segment_3"],
            description: "Run on a single segment (default: all 3)",
          },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const configStr = (params.config as string) ?? "{}";
        const args = ["--config", configStr];
        if (params.segment) {
          args.push("--segment", params.segment as string);
        }
        const result = await runner.run("run-experiment", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_sweep (requires approval — multiple GPU runs)
  api.registerTool(
    {
      name: "paloa_sweep",
      label: "Config Sweep",
      description:
        "Run parameter sweep across configs on all 3 test segments. Costs ~$0.40 per config. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          spec: {
            type: "string",
            description:
              'JSON sweep spec, e.g. \'{"ball_conf": [0.25, 0.28], "dedup_window": [5.0, 6.0]}\'',
          },
        },
        required: ["spec"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const spec = params.spec as string;
        const result = await runner.run("sweep", ["--spec", spec]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_suggest
  api.registerTool(
    {
      name: "paloa_suggest",
      label: "Suggest Config",
      description: "Suggest next config to try based on experiment history analysis.",
      parameters: {},
      async execute() {
        const result = await runner.run("suggest");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_history
  api.registerTool(
    {
      name: "paloa_history",
      label: "Experiment History",
      description: "Show experiment history including best configs, Pareto front, and trends.",
      parameters: {},
      async execute() {
        const result = await runner.run("status");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_optimize (semi-autonomous — requires per-iteration approval)
  api.registerTool(
    {
      name: "paloa_optimize",
      label: "Optimize Pipeline",
      description:
        "Semi-autonomous optimization loop: suggest config → approve → run → evaluate → repeat. Pauses for human approval before each GPU run. Stops when targets met or budget exceeded.",
      parameters: {
        type: "object",
        properties: {
          maxIterations: {
            type: "number",
            description: "Maximum optimization iterations (default: 10)",
          },
          targetF1: {
            type: "number",
            description: "Stop when aggregate F1 exceeds this (default: 0.85)",
          },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const maxIter = (params.maxIterations as number) ?? 10;
        const targetF1 = (params.targetF1 as number) ?? targets.f1;
        const result = await optimizer.runLoop(maxIter, targetF1);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );
}
