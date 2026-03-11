import fs from "node:fs";
import path from "node:path";
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

  // Tool: paloa_sweep (chunked — runs one config at a time to avoid timeouts)
  api.registerTool(
    {
      name: "paloa_sweep",
      label: "Config Sweep",
      description:
        "Run parameter sweep across configs on all 3 test segments. Runs ONE config at a time (timeout-safe). Costs ~$0.40 per config. Requires approval.",
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
        const spec = JSON.parse(params.spec as string);
        // Build all combinations client-side
        const paramNames = Object.keys(spec);
        const paramValues = paramNames.map((k) => (Array.isArray(spec[k]) ? spec[k] : [spec[k]]));

        // Cartesian product
        const combos: Record<string, unknown>[] = [];
        function cartesian(idx: number, current: Record<string, unknown>) {
          if (idx === paramNames.length) {
            combos.push({ ...current });
            return;
          }
          for (const val of paramValues[idx]) {
            current[paramNames[idx]] = val;
            cartesian(idx + 1, current);
          }
        }
        cartesian(0, {});

        const results: Record<string, unknown>[] = [];
        const lines: string[] = [`Sweep: ${combos.length} configs x 3 segments`];

        for (let i = 0; i < combos.length; i++) {
          const config = combos[i];
          lines.push(`[${i + 1}/${combos.length}] ${JSON.stringify(config)}`);
          const raw = await runner.run("sweep-single", ["--config", JSON.stringify(config)]);
          try {
            const parsed = JSON.parse(raw);
            results.push(parsed);
            const agg = parsed.results?.aggregate ?? {};
            lines.push(
              `  -> F1=${((agg.f1 ?? 0) * 100).toFixed(1)}% P=${((agg.precision ?? 0) * 100).toFixed(1)}% R=${((agg.recall ?? 0) * 100).toFixed(1)}%`,
            );
          } catch {
            lines.push(`  -> Failed to parse result`);
            results.push({ config, error: "parse_failed", raw: raw.slice(0, 300) });
          }
        }

        // Rank by aggregate F1
        results.sort(
          (a, b) =>
            ((b as Record<string, Record<string, Record<string, number>>>).results?.aggregate?.f1 ??
              0) -
            ((a as Record<string, Record<string, Record<string, number>>>).results?.aggregate?.f1 ??
              0),
        );

        const output = {
          ranked_results: results,
          summary: lines.join("\n"),
        };
        return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
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

  // Tool: paloa_optimize_start — initialize a new optimization loop
  api.registerTool(
    {
      name: "paloa_optimize_start",
      label: "Start Optimization",
      description:
        "Initialize a new optimization loop with target F1 and budget. Returns the first config suggestion for approval. The agent controls the loop by calling paloa_optimize_step for each iteration.",
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
        const result = await optimizer.start(maxIter, targetF1);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_optimize_step — execute one iteration (calling = approval)
  api.registerTool(
    {
      name: "paloa_optimize_step",
      label: "Optimization Step",
      description:
        "Execute one optimization iteration: runs the current suggestion on all segments, evaluates results, and returns the next suggestion. Calling this tool is the approval gate. Costs ~$1.20 per step.",
      parameters: {},
      async execute() {
        const result = await optimizer.step();
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_optimize_status — check current loop state
  api.registerTool(
    {
      name: "paloa_optimize_status",
      label: "Optimization Status",
      description:
        "Check current optimization loop state: iteration, budget, best F1, recent progress, and pending suggestion.",
      parameters: {},
      async execute() {
        const result = await optimizer.getStatus();
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_optimize (legacy — monolithic loop, kept for backwards compat)
  api.registerTool(
    {
      name: "paloa_optimize",
      label: "Optimize Pipeline (Legacy)",
      description:
        "LEGACY: Monolithic optimization loop. Prefer paloa_optimize_start + paloa_optimize_step for step-by-step control with approval gates.",
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

  // --- Paloa CLI Bridge Tools ---

  // Tool: paloa_run_v8 (requires approval — API cost)
  api.registerTool(
    {
      name: "paloa_run_v8",
      label: "Run V8 Pipeline",
      description:
        "Run the V8 3-pass shot detection pipeline (narration + confirmation + skeptical review) on a game segment. Costs ~$0.15/min of video. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          game: { type: "string", description: "Game identifier (e.g. 'nd_vs_sc')" },
          start: { type: "string", description: "Start time in seconds or M:SS format" },
          end: { type: "string", description: "End time in seconds or M:SS format" },
        },
        required: ["game", "start", "end"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const game = params.game as string;
        const start = params.start as string;
        const end = params.end as string;
        const result = await runner.runBridge("run-v8", [
          "--game",
          game,
          "--start",
          start,
          "--end",
          end,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_cli_evaluate
  api.registerTool(
    {
      name: "paloa_cli_evaluate",
      label: "CLI Evaluate",
      description:
        "Evaluate last pipeline run against ground truth for a game. Returns F1, precision, recall, and make/miss accuracy.",
      parameters: {
        type: "object",
        properties: {
          game: { type: "string", description: "Game identifier" },
          start: { type: "string", description: "Start time filter (optional)" },
          end: { type: "string", description: "End time filter (optional)" },
        },
        required: ["game"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--game", params.game as string];
        if (params.start) args.push("--start", params.start as string);
        if (params.end) args.push("--end", params.end as string);
        const result = await runner.runBridge("evaluate", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_show_results
  api.registerTool(
    {
      name: "paloa_show_results",
      label: "Show Results",
      description: "Display results from the most recent pipeline run for a game.",
      parameters: {
        type: "object",
        properties: {
          game: { type: "string", description: "Game identifier" },
        },
        required: ["game"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("show-results", ["--game", params.game as string]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_list_games
  api.registerTool(
    {
      name: "paloa_list_games",
      label: "List Games",
      description: "List all registered games with their video paths and configuration.",
      parameters: {},
      async execute() {
        const result = await runner.runBridge("list-games");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_export_csv
  api.registerTool(
    {
      name: "paloa_export_csv",
      label: "Export CSV",
      description: "Export detected shots from the last pipeline run as a CSV file.",
      parameters: {
        type: "object",
        properties: {
          game: { type: "string", description: "Game identifier" },
        },
        required: ["game"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("export-csv", ["--game", params.game as string]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // Tool: paloa_compare_runs
  api.registerTool(
    {
      name: "paloa_compare_runs",
      label: "Compare Runs",
      description: "Compare recent pipeline runs for a game, showing shot counts and deltas.",
      parameters: {
        type: "object",
        properties: {
          game: { type: "string", description: "Game identifier" },
          limit: { type: "number", description: "Number of recent runs to compare (default: 5)" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.game) args.push("--game", params.game as string);
        if (params.limit) args.push("--limit", String(params.limit));
        const result = await runner.runBridge("compare-runs", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Phase 1: Video/Clip CRUD + Analytics
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_list_videos",
      label: "List Videos",
      description: "List all videos in the database with status, clip count, and dates.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status (uploading, processing, ready, failed)",
          },
          limit: { type: "number", description: "Max results (default: 50)" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.status) args.push("--status", params.status as string);
        if (params.limit) args.push("--limit", String(params.limit));
        const result = await runner.runBridge("list-videos", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_video",
      label: "Get Video",
      description: "Get full details of a video by its UUID.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
        },
        required: ["videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("get-video", [
          "--video-id",
          params.videoId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_update_video",
      label: "Update Video",
      description: "Update video metadata (title, description, game_date, opponent, venue).",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
          title: { type: "string" },
          description: { type: "string" },
          gameDate: { type: "string", description: "YYYY-MM-DD" },
          opponent: { type: "string" },
          venue: { type: "string" },
        },
        required: ["videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--video-id", params.videoId as string];
        if (params.title) args.push("--title", params.title as string);
        if (params.description) args.push("--description", params.description as string);
        if (params.gameDate) args.push("--game-date", params.gameDate as string);
        if (params.opponent) args.push("--opponent", params.opponent as string);
        if (params.venue) args.push("--venue", params.venue as string);
        const result = await runner.runBridge("update-video", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_delete_video",
      label: "Delete Video",
      description: "Delete a video and all its clips.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
        },
        required: ["videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("delete-video", [
          "--video-id",
          params.videoId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_list_clips",
      label: "List Clips",
      description: "List clips for a video, filterable by shot result or type.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
          shotResult: { type: "string", description: "'make' or 'miss'" },
          shotType: { type: "string", description: "e.g. 'three_pointer'" },
          limit: { type: "number", description: "Max results (default: 100)" },
        },
        required: ["videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--video-id", params.videoId as string];
        if (params.shotResult) args.push("--shot-result", params.shotResult as string);
        if (params.shotType) args.push("--shot-type", params.shotType as string);
        if (params.limit) args.push("--limit", String(params.limit));
        const result = await runner.runBridge("list-clips", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_update_clip",
      label: "Update Clip",
      description: "Update a clip's shot_result, shot_type, or play_type.",
      parameters: {
        type: "object",
        properties: {
          clipId: { type: "string", description: "Clip UUID" },
          shotResult: { type: "string", description: "'make' or 'miss'" },
          shotType: { type: "string" },
          playType: { type: "string" },
        },
        required: ["clipId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--clip-id", params.clipId as string];
        if (params.shotResult) args.push("--shot-result", params.shotResult as string);
        if (params.shotType) args.push("--shot-type", params.shotType as string);
        if (params.playType) args.push("--play-type", params.playType as string);
        const result = await runner.runBridge("update-clip", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_delete_clip",
      label: "Delete Clip",
      description: "Delete a single clip.",
      parameters: {
        type: "object",
        properties: {
          clipId: { type: "string", description: "Clip UUID" },
        },
        required: ["clipId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("delete-clip", [
          "--clip-id",
          params.clipId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_shooting_stats",
      label: "Shooting Stats",
      description:
        "Get comprehensive shooting statistics (FG%, 3P%, zone/play breakdowns) for a video, session, player, or team.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
          sessionId: { type: "string", description: "Session UUID" },
          playerId: { type: "string", description: "Player UUID" },
          teamId: { type: "string", description: "Team UUID" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.videoId) args.push("--video-id", params.videoId as string);
        if (params.sessionId) args.push("--session-id", params.sessionId as string);
        if (params.playerId) args.push("--player-id", params.playerId as string);
        if (params.teamId) args.push("--team-id", params.teamId as string);
        const result = await runner.runBridge("get-shooting-stats", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Phase 2: Teams, Players, Sessions
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_list_teams",
      label: "List Teams",
      description: "List all teams belonging to the current user.",
      parameters: {},
      async execute() {
        const result = await runner.runBridge("list-teams");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_create_team",
      label: "Create Team",
      description: "Create a new team.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Team name" },
          abbreviation: { type: "string" },
          level: { type: "string", description: "nba, d1, d2, high_school, aau, etc." },
          season: { type: "string" },
          isMyTeam: { type: "boolean" },
        },
        required: ["name"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--name", params.name as string];
        if (params.abbreviation) args.push("--abbreviation", params.abbreviation as string);
        if (params.level) args.push("--level", params.level as string);
        if (params.season) args.push("--season", params.season as string);
        if (params.isMyTeam) args.push("--is-my-team");
        const result = await runner.runBridge("create-team", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_delete_team",
      label: "Delete Team",
      description: "Delete a team and all its players.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team UUID" },
        },
        required: ["teamId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("delete-team", [
          "--team-id",
          params.teamId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_list_players",
      label: "List Players",
      description: "List players on a team with their stats.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team UUID" },
          activeOnly: { type: "boolean" },
        },
        required: ["teamId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--team-id", params.teamId as string];
        if (params.activeOnly) args.push("--active-only");
        const result = await runner.runBridge("list-players", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_create_player",
      label: "Create Player",
      description: "Add a player to a team.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team UUID" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          jerseyNumber: { type: "string" },
          position: { type: "string" },
        },
        required: ["teamId", "firstName", "lastName", "jerseyNumber"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = [
          "--team-id",
          params.teamId as string,
          "--first-name",
          params.firstName as string,
          "--last-name",
          params.lastName as string,
          "--jersey-number",
          params.jerseyNumber as string,
        ];
        if (params.position) args.push("--position", params.position as string);
        const result = await runner.runBridge("create-player", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_search_players",
      label: "Search Players",
      description: "Search players by name or jersey number across all teams.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name or jersey number" },
        },
        required: ["query"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("search-players", [
          "--query",
          params.query as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_list_sessions",
      label: "List Sessions",
      description: "List all sessions (games, practices, drills) with stats.",
      parameters: {},
      async execute() {
        const result = await runner.runBridge("list-sessions");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_create_session",
      label: "Create Session",
      description: "Create a new session to group videos.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Session name" },
          sessionType: {
            type: "string",
            description: "full_game, scrimmage, practice, drill, shootaround",
          },
          sessionDate: { type: "string", description: "YYYY-MM-DD" },
          notes: { type: "string" },
        },
        required: ["name"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--name", params.name as string];
        if (params.sessionType) args.push("--type", params.sessionType as string);
        if (params.sessionDate) args.push("--session-date", params.sessionDate as string);
        if (params.notes) args.push("--notes", params.notes as string);
        const result = await runner.runBridge("create-session", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_delete_session",
      label: "Delete Session",
      description: "Delete a session.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session UUID" },
        },
        required: ["sessionId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("delete-session", [
          "--session-id",
          params.sessionId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Phase 3: Reports, Annotations, Pipeline, Zone Stats
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_get_game_report",
      label: "Game Report",
      description: "Get the AI-generated game report for a video.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
        },
        required: ["videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("get-game-report", [
          "--video-id",
          params.videoId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_list_annotations",
      label: "List Annotations",
      description: "List annotation events (ground truth shots) for a video.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Annotation video UUID" },
          filename: { type: "string", description: "Annotation video filename" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.videoId) args.push("--video-id", params.videoId as string);
        if (params.filename) args.push("--filename", params.filename as string);
        const result = await runner.runBridge("list-annotations", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_pipeline_logs",
      label: "Pipeline Logs",
      description: "Get pipeline processing logs for a video.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
          stage: {
            type: "string",
            description: "Filter by stage: yolo, rfdetr, kimi, scoreboard, merge, pipeline",
          },
          limit: { type: "number", description: "Max results (default: 50)" },
        },
        required: ["videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--video-id", params.videoId as string];
        if (params.stage) args.push("--stage", params.stage as string);
        if (params.limit) args.push("--limit", String(params.limit));
        const result = await runner.runBridge("get-pipeline-logs", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_processing_status",
      label: "Processing Status",
      description: "Get video processing status with recent pipeline logs.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
        },
        required: ["videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("get-processing-status", [
          "--video-id",
          params.videoId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_zone_stats",
      label: "Zone Stats",
      description: "Get zone-based shooting statistics for a video, session, or player.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Video UUID" },
          sessionId: { type: "string", description: "Session UUID" },
          playerId: { type: "string", description: "Player UUID" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.videoId) args.push("--video-id", params.videoId as string);
        if (params.sessionId) args.push("--session-id", params.sessionId as string);
        if (params.playerId) args.push("--player-id", params.playerId as string);
        const result = await runner.runBridge("get-zone-stats", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Phase 4: Organization
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_get_organization",
      label: "Get Organization",
      description: "Get the user's organization details.",
      parameters: {},
      async execute() {
        const result = await runner.runBridge("get-organization");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_list_org_members",
      label: "Org Members",
      description: "List members of an organization.",
      parameters: {
        type: "object",
        properties: {
          orgId: { type: "string", description: "Organization UUID" },
        },
        required: ["orgId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("list-org-members", [
          "--org-id",
          params.orgId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_list_org_videos",
      label: "Org Videos",
      description: "List videos shared with an organization.",
      parameters: {
        type: "object",
        properties: {
          orgId: { type: "string", description: "Organization UUID" },
        },
        required: ["orgId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("list-org-videos", [
          "--org-id",
          params.orgId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_share_video",
      label: "Share Video",
      description: "Share a video with an organization.",
      parameters: {
        type: "object",
        properties: {
          orgId: { type: "string", description: "Organization UUID" },
          videoId: { type: "string", description: "Video UUID" },
        },
        required: ["orgId", "videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("share-video", [
          "--org-id",
          params.orgId as string,
          "--video-id",
          params.videoId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_unshare_video",
      label: "Unshare Video",
      description: "Remove a shared video from an organization.",
      parameters: {
        type: "object",
        properties: {
          orgId: { type: "string", description: "Organization UUID" },
          videoId: { type: "string", description: "Video UUID" },
        },
        required: ["orgId", "videoId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("unshare-video", [
          "--org-id",
          params.orgId as string,
          "--video-id",
          params.videoId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Missing Tool Registrations (bridge commands that existed but had no tool)
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_export_clip",
      label: "Export Clip",
      description: "Export a video clip centered on a specific shot timestamp.",
      parameters: {
        type: "object",
        properties: {
          game: { type: "string", description: "Game identifier" },
          timestamp: { type: "string", description: "Shot timestamp in seconds or M:SS" },
          duration: { type: "number", description: "Clip duration in seconds (default: 8)" },
        },
        required: ["game", "timestamp"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--game", params.game as string, "--timestamp", params.timestamp as string];
        if (params.duration) args.push("--duration", String(params.duration));
        const result = await runner.runBridge("export-clip", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_update_team",
      label: "Update Team",
      description: "Update team details (name, abbreviation, level, season).",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team UUID" },
          name: { type: "string" },
          abbreviation: { type: "string" },
          level: { type: "string" },
          season: { type: "string" },
        },
        required: ["teamId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--team-id", params.teamId as string];
        if (params.name) args.push("--name", params.name as string);
        if (params.abbreviation) args.push("--abbreviation", params.abbreviation as string);
        if (params.level) args.push("--level", params.level as string);
        if (params.season) args.push("--season", params.season as string);
        const result = await runner.runBridge("update-team", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_update_player",
      label: "Update Player",
      description: "Update player details (name, jersey, position, active/starter status).",
      parameters: {
        type: "object",
        properties: {
          playerId: { type: "string", description: "Player UUID" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          jerseyNumber: { type: "string" },
          position: { type: "string" },
          isActive: { type: "boolean" },
          isStarter: { type: "boolean" },
        },
        required: ["playerId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--player-id", params.playerId as string];
        if (params.firstName) args.push("--first-name", params.firstName as string);
        if (params.lastName) args.push("--last-name", params.lastName as string);
        if (params.jerseyNumber) args.push("--jersey-number", params.jerseyNumber as string);
        if (params.position) args.push("--position", params.position as string);
        if (params.isActive !== undefined) args.push("--is-active", String(params.isActive));
        if (params.isStarter !== undefined) args.push("--is-starter", String(params.isStarter));
        const result = await runner.runBridge("update-player", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_update_session",
      label: "Update Session",
      description: "Update session details (name, type, notes).",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session UUID" },
          name: { type: "string" },
          sessionType: { type: "string" },
          notes: { type: "string" },
        },
        required: ["sessionId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = ["--session-id", params.sessionId as string];
        if (params.name) args.push("--name", params.name as string);
        if (params.sessionType) args.push("--session-type", params.sessionType as string);
        if (params.notes) args.push("--notes", params.notes as string);
        const result = await runner.runBridge("update-session", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_create_annotation",
      label: "Create Annotation",
      description: "Create a new annotation event (shot/play) for a video.",
      parameters: {
        type: "object",
        properties: {
          videoId: { type: "string", description: "Annotation video UUID" },
          timestampSecs: { type: "number", description: "Timestamp in seconds" },
          eventType: { type: "string", description: "Event type (default: 'shot')" },
          result: { type: "string", description: "'make' or 'miss'" },
          shotType: { type: "string" },
          team: { type: "string" },
          jersey: { type: "string" },
          notes: { type: "string" },
        },
        required: ["videoId", "timestampSecs"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args = [
          "--video-id",
          params.videoId as string,
          "--timestamp-secs",
          String(params.timestampSecs),
        ];
        if (params.eventType) args.push("--event-type", params.eventType as string);
        if (params.result) args.push("--result", params.result as string);
        if (params.shotType) args.push("--shot-type", params.shotType as string);
        if (params.team) args.push("--team", params.team as string);
        if (params.jersey) args.push("--jersey", params.jersey as string);
        if (params.notes) args.push("--notes", params.notes as string);
        const result = await runner.runBridge("create-annotation", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_delete_annotation",
      label: "Delete Annotation",
      description: "Delete an annotation event.",
      parameters: {
        type: "object",
        properties: {
          annotationId: { type: "string", description: "Annotation event UUID" },
        },
        required: ["annotationId"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await runner.runBridge("delete-annotation", [
          "--annotation-id",
          params.annotationId as string,
        ]);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // User Analytics Tools
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_get_user_events",
      label: "User Events",
      description:
        "Query raw user behavior events from the web app (page views, tab switches, feature usage, errors).",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to look back (default: 7)" },
          eventType: {
            type: "string",
            description: "Filter: page_view, tab_switch, feature_use, video_action, error",
          },
          page: { type: "string", description: "Filter by page path" },
          limit: { type: "number", description: "Max results (default: 100)" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.days) args.push("--days", String(params.days));
        if (params.eventType) args.push("--event-type", params.eventType as string);
        if (params.page) args.push("--page", params.page as string);
        if (params.limit) args.push("--limit", String(params.limit));
        const result = await runner.runBridge("get-user-events", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_feature_usage",
      label: "Feature Usage",
      description:
        "Get aggregated feature usage summary: event name, count, unique users, avg duration.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to look back (default: 7)" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.days) args.push("--days", String(params.days));
        const result = await runner.runBridge("get-feature-usage", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_page_analytics",
      label: "Page Analytics",
      description: "Get page view statistics: views, unique users, avg duration, bounce rate.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to look back (default: 7)" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.days) args.push("--days", String(params.days));
        const result = await runner.runBridge("get-page-analytics", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  api.registerTool(
    {
      name: "paloa_get_engagement_funnel",
      label: "Engagement Funnel",
      description:
        "Get user conversion funnel: Upload -> View Video -> Analytics -> AI Coach -> Export.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to look back (default: 7)" },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const args: string[] = [];
        if (params.days) args.push("--days", String(params.days));
        const result = await runner.runBridge("get-engagement-funnel", args);
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Composite: Daily Briefing
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_daily_briefing",
      label: "Daily Briefing",
      description:
        "Composite tool: pipeline KPI gap + yesterday's feature usage + page analytics + failed videos + experiment history summary. Use this for daily status checks.",
      parameters: {},
      async execute() {
        const sections: string[] = [];

        try {
          const status = await runner.run("status");
          sections.push("## Pipeline Status\n" + status);
        } catch (e) {
          sections.push("## Pipeline Status\nUnavailable: " + (e as Error).message);
        }

        try {
          const features = await runner.runBridge("get-feature-usage", ["--days", "1"]);
          sections.push("## Feature Usage (24h)\n" + features);
        } catch (e) {
          sections.push("## Feature Usage (24h)\nUnavailable: " + (e as Error).message);
        }

        try {
          const pages = await runner.runBridge("get-page-analytics", ["--days", "1"]);
          sections.push("## Page Analytics (24h)\n" + pages);
        } catch (e) {
          sections.push("## Page Analytics (24h)\nUnavailable: " + (e as Error).message);
        }

        try {
          const failed = await runner.runBridge("list-videos", [
            "--status",
            "failed",
            "--limit",
            "5",
          ]);
          sections.push("## Failed Videos\n" + failed);
        } catch (e) {
          sections.push("## Failed Videos\nUnavailable: " + (e as Error).message);
        }

        try {
          const funnel = await runner.runBridge("get-engagement-funnel", ["--days", "7"]);
          sections.push("## Engagement Funnel (7d)\n" + funnel);
        } catch (e) {
          sections.push("## Engagement Funnel (7d)\nUnavailable: " + (e as Error).message);
        }

        return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Agent Memory: Session Context Loading
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_load_context",
      label: "Load Session Context",
      description:
        "Load session context at the start of a conversation: last 5 experiments, top learnings, best config, KPI gap, and untried dimensions. Always call this first before making optimization decisions.",
      parameters: {},
      async execute() {
        const result = await runner.run("load-context");
        return { content: [{ type: "text", text: result }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // =========================================================================
  // Observability: Trace Viewer
  // =========================================================================

  api.registerTool(
    {
      name: "paloa_trace",
      label: "View Traces",
      description:
        "View recent tool call traces: total calls, durations, errors, retries, and F1 progression. Useful for debugging and auditing optimization runs.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date to view (YYYY-MM-DD format, default: today)",
          },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const traceDir = path.join(process.env.HOME || "~", ".paloa", "optimizer", "traces");
        const date = (params.date as string) || new Date().toISOString().slice(0, 10);
        const traceFile = path.join(traceDir, `${date}.jsonl`);

        if (!fs.existsSync(traceFile)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ message: `No traces for ${date}`, available: [] }),
              },
            ],
          };
        }

        const lines = fs.readFileSync(traceFile, "utf-8").trim().split("\n");
        const entries = lines.filter((l) => l.trim()).map((l) => JSON.parse(l));

        let totalDuration = 0;
        let errorCount = 0;
        let retryCount = 0;
        const toolCounts: Record<string, number> = {};
        const f1Progression: { timestamp: string; f1: number }[] = [];

        for (const entry of entries) {
          totalDuration += entry.duration_ms || 0;
          if (entry.error) errorCount++;
          if (entry.retrying) retryCount++;
          const key = `${entry.tool}:${entry.subcommand}`;
          toolCounts[key] = (toolCounts[key] || 0) + 1;
          if (entry.result_summary?.f1 != null) {
            f1Progression.push({ timestamp: entry.timestamp, f1: entry.result_summary.f1 });
          }
        }

        const summary = {
          date,
          total_calls: entries.length,
          total_duration_min: Math.round((totalDuration / 60000) * 10) / 10,
          errors: errorCount,
          retries: retryCount,
          tool_counts: toolCounts,
          f1_progression: f1Progression,
          recent_entries: entries.slice(-5),
        };

        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );
}
