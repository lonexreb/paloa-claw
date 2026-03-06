# Paloa Pipeline Optimizer — OpenClaw Extension

This extension adds basketball shot detection pipeline optimization tools to OpenClaw.

## Setup

1. Ensure `paloa-film-analytics` repo is cloned with the `paloa-claw` submodule
2. Python 3.11+ with venv: `source venv/bin/activate`
3. Modal CLI authenticated: `modal token new`
4. Modal secrets configured: `supabase-credentials`, `gemini-api-key`

## Configuration

In your OpenClaw config, add the paloa-pipeline extension:
```json
{
  "extensions": {
    "paloa-pipeline": {
      "workspaceDir": "/path/to/paloa-film-analytics",
      "pythonPath": "python3",
      "maxCostUsd": 20,
      "targets": { "recall": 0.85, "precision": 0.90, "f1": 0.85 }
    }
  }
}
```

## Tools Provided

| Tool | Description | GPU Cost |
|------|-------------|----------|
| `paloa_status` | Current config, best config, KPI gap | Free |
| `paloa_evaluate` | Evaluate results vs ground truth | Free |
| `paloa_run_experiment` | Run pipeline with config overrides | ~$0.40/seg |
| `paloa_sweep` | Parameter sweep across configs | ~$0.40/config/seg |
| `paloa_suggest` | Suggest next config from history | Free |
| `paloa_history` | Experiment history and trends | Free |
| `paloa_optimize` | Semi-autonomous optimization loop | ~$0.40/iter/seg |

## Domain Rules

See `paloa-claw-cli.md` in the repo root for full domain knowledge, parameter ranges, key learnings, and workflow recipes.

## Architecture

```
OpenClaw Agent
  └── paloa-pipeline extension (src/index.ts)
        ├── runner.ts      → spawns: python workers/pipeline_optimizer.py <subcommand>
        ├── optimizer.ts   → semi-autonomous loop with budget + plateau detection
        └── pipeline_optimizer.py
              ├── run-experiment  → modal run workers/bring_it_home.py (with PALOA_* env vars)
              ├── evaluate       → workers/evaluation/shot_detection_eval.py
              ├── sweep          → iterates configs × 3 segments
              ├── suggest        → guided random search from top-3 history
              └── status         → reads ~/.paloa/optimizer/history.jsonl
```

## Key Constraints

- VLM temperature must be >= 0.4 (0.0 breaks JSON extraction)
- Always validate on all 3 test segments (anti-overfitting)
- RF-DETR is noisy — never require it for agreement
- Budget default $20 = ~16 full experiments
- Approval required before every GPU run
