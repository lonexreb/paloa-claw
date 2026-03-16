# Paloa Claw

**Your personal AI assistant that lives where you already are.**

Paloa Claw is a self-hosted, multi-channel AI gateway built on top of [OpenClaw](https://github.com/openclaw/openclaw). It connects to 40+ messaging platforms, runs agents with tool access and memory, and gives you direct interactive control over every action the AI takes. Built by Paloa Labs for production use in sports analytics and beyond.

**Version:** 2026.3.3 | **Runtime:** Node 22+ | **License:** MIT

---

## Table of Contents

- [What Is Paloa Claw](#what-is-paloa-claw)
- [Why Paloa Claw](#why-paloa-claw)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [The Gateway](#the-gateway)
- [The Control Command](#the-control-command)
- [Channels](#channels)
- [Agents](#agents)
- [Skills](#skills)
- [Memory](#memory)
- [Sandbox & Security](#sandbox--security)
- [Hooks](#hooks)
- [Cron & Scheduling](#cron--scheduling)
- [Companion Apps](#companion-apps)
- [Docker Deployment](#docker-deployment)
- [Configuration Reference](#configuration-reference)
- [Use Cases & Examples](#use-cases--examples)
- [CLI Command Reference](#cli-command-reference)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## What Is Paloa Claw

Paloa Claw is a **personal AI assistant runtime**. Unlike cloud-hosted assistants, it runs on your own hardware and connects to the messaging apps you already use. The assistant is the product -- the gateway is just the control plane.

```
You (WhatsApp, Telegram, Slack, Discord, ...)
  --> Paloa Claw Gateway (your machine / your server)
    --> LLM (Claude, GPT, Gemini, local models, ...)
      --> Tools, Skills, Memory, Sandbox
        --> Response delivered back to your channel
```

It is a single binary (`openclaw`) that:

- Runs a WebSocket gateway on your machine
- Connects to any supported messaging channel
- Routes messages to AI agents with configurable models
- Executes tools in sandboxed environments
- Remembers context across conversations via vector memory
- Schedules recurring agent jobs via cron
- Gives you interactive control over every agent action

---

## Why Paloa Claw

| Problem                          | Paloa Claw Solution                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| AI assistants trapped in one app | Talk to the same AI on WhatsApp, Telegram, Slack, Discord, iMessage, and 35+ more  |
| No control over what the AI does | `openclaw control` -- approve, deny, or modify every action before it runs         |
| Cloud-only, no privacy           | Runs on your machine. Your data stays local.                                       |
| Can't use your own tools         | Plugin SDK + 54 bundled skills + MCP support                                       |
| Stateless conversations          | Vector memory with semantic search and temporal decay                              |
| Expensive API costs              | Bring your own keys. Use any model. Local models via Ollama/vLLM.                  |
| Can't schedule AI work           | Built-in cron: `every 5 minutes`, `daily at 9:00 AM`, `every Monday`               |
| Unsafe code execution            | Docker/Podman sandbox with resource limits, network policies, filesystem isolation |

---

## Architecture

```
                        +------------------+
                        |  Companion Apps  |
                        |  macOS/iOS/Droid |
                        +--------+---------+
                                 |
+----------+  +----------+  +---+----+  +----------+  +----------+
| WhatsApp |  | Telegram |  |  Slack |  | Discord  |  | 36 more  |
+----+-----+  +----+-----+  +---+----+  +----+-----+  +----+-----+
     |             |             |            |             |
     +------+------+------+-----+------+-----+------+------+
            |                          |
     +------+------+           +-------+-------+
     |   Gateway   |           |  Control CLI  |
     |  :18789 WS  |           | (you approve) |
     +------+------+           +-------+-------+
            |                          |
     +------+------+           +-------+-------+
     |    Agent    |<----------+   Session &   |
     |   Runtime   |           |    Memory     |
     +------+------+           +---------------+
            |
     +------+------+------+------+
     |      |      |      |      |
  +--+--+ +-+--+ +-+--+ +-+--+ +-+--+
  |Tools| |Sand| |Hook| |Cron| |ACP |
  |     | |box | |s   | |    | |    |
  +-----+ +----+ +----+ +----+ +----+
```

**Core Components:**

| Component         | Role                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| **Gateway**       | WebSocket server. Routes messages, manages sessions, authenticates clients. |
| **Agent Runtime** | Executes LLM calls. Manages tool use, model fallback, context compaction.   |
| **Control CLI**   | Interactive REPL. You approve/deny/modify every agent action in real time.  |
| **Channels**      | 44 messaging integrations (7 core + 37 extensions).                         |
| **Skills**        | 54 bundled capabilities (GitHub, Notion, Spotify, email, camera, ...).      |
| **Memory**        | Vector database (LanceDB/SQLite) with semantic search.                      |
| **Sandbox**       | Docker/Podman containers for isolated code execution.                       |
| **Hooks**         | Injection points for custom logic (message pre/post-processing).            |
| **Cron**          | Scheduled agent jobs with delivery to any channel.                          |
| **ACP**           | Agent Control Protocol for inter-process agent isolation.                   |

---

## Quick Start

```bash
# Install
npm install -g openclaw@latest    # or: pnpm add -g openclaw@latest

# Onboard (guided wizard: auth, channels, skills)
openclaw onboard --install-daemon

# Start the gateway
openclaw gateway --port 18789

# Send a message
openclaw agent --message "What can you do?" --local

# Interactive control mode
openclaw control --agent main
```

**From source (this repo):**

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run CLI
node openclaw.mjs --help

# Run gateway in dev mode
node openclaw.mjs --dev gateway --port 19001 --verbose

# Interactive control
node openclaw.mjs control --agent main
```

---

## Installation

### Prerequisites

- **Node.js 22+** (required)
- **pnpm** (recommended) or npm/bun
- An API key for at least one LLM provider (Anthropic, OpenAI, Google, etc.)

### From npm

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### From source

```bash
git clone <this-repo>
cd paloa-claw
pnpm install
pnpm build
```

### Via Docker

```bash
docker build -t paloa-claw:local .
docker-compose up -d
```

### Verify installation

```bash
openclaw --version          # 2026.3.3
openclaw doctor             # Health check
openclaw channels status    # Channel connectivity
```

---

## The Gateway

The gateway is the **central nervous system**. It is a WebSocket server that all channels, apps, and CLI commands connect to.

### Starting the gateway

```bash
# Default (localhost:18789)
openclaw gateway

# Custom port
openclaw gateway --port 9000

# Dev mode (isolated state, port 19001)
openclaw --dev gateway

# Force kill anything on the port, then start
openclaw gateway --force

# Bind to LAN (not just localhost)
openclaw gateway --bind lan --port 18789

# Verbose logging
openclaw gateway --verbose
```

### Gateway as a daemon (auto-start on boot)

```bash
# macOS (launchd)
openclaw onboard --install-daemon

# Linux (systemd)
openclaw onboard --install-daemon
```

### Gateway modes

| Mode    | Bind                 | Use                                 |
| ------- | -------------------- | ----------------------------------- |
| `local` | `127.0.0.1` only     | Development, single machine         |
| `lan`   | All local interfaces | Home network, LAN access            |
| `all`   | `0.0.0.0`            | Public access (requires auth token) |

### Health check

```bash
openclaw health              # Quick check
openclaw status              # Full channel + session status
openclaw doctor              # Diagnose and fix issues
```

---

## The Control Command

The `control` command is Paloa Claw's signature feature: an **interactive REPL that puts you in the driver's seat** of every agent action.

### Why

Standard agent commands fire-and-forget. You send a message, the agent does whatever it wants, and you get a result. With `control`, you see every proposed action and decide: approve, deny, or modify.

This is critical for:

- **Production safety** -- prevent the agent from running destructive commands
- **Debugging** -- see exactly what the agent tries to do and why
- **Training** -- guide the agent's behavior by approving/denying patterns
- **Compliance** -- audit trail of every approved action
- **Demo scenarios** -- show stakeholders the agent's decision-making in real time

### Usage

```bash
# Control the default agent
openclaw control

# Control a specific agent
openclaw control --agent main

# Control with a session target
openclaw control --to +15555550123

# Control with a custom timeout
openclaw control --agent ops --timeout 300
```

### Session flow

```
Paloa Control - Interactive Agent Controller
Type a message to send to the agent. Commands:
  /approve    - Auto-approve all agent actions
  /manual     - Require manual approval (default)
  /pause      - Pause agent execution
  /resume     - Resume agent execution
  /status     - Show session status
  /history    - Show turn history
  /quit       - Exit control session

Session: cli:main:default
Agent: main
Mode: manual approval

you > Summarize the last 3 git commits

Action proposed:
  Send to agent: "Summarize the last 3 git commits"

[a]pprove / [d]eny / [m]odify > a

Sending to agent (turn 1)...

agent >
Here are the last 3 commits:
1. feat: add new workers...
2. Add trained X3D classifier...
3. Merge remote-tracking branch...

Tool calls executed:
  bash (done)
    {
      "command": "git log --oneline -3"
    }

you > /status

Session Status
  Session:  cli:main:default
  Agent:    main
  Turns:    1
  Mode:     manual
  Paused:   no

you > /approve
Auto-approve enabled. All agent actions will proceed without confirmation.

you > Now write a changelog from those commits
Sending to agent (turn 2)...
...
```

### In-session commands

| Command    | Effect                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| `/approve` | Switch to auto-approve mode. All messages sent without confirmation.     |
| `/manual`  | Switch to manual approval mode (default). Each message requires confirm. |
| `/pause`   | Freeze the session. Only `/resume` and `/quit` accepted.                 |
| `/resume`  | Unfreeze after `/pause`.                                                 |
| `/status`  | Display session key, agent ID, turn count, mode, and pause state.        |
| `/history` | Show all turns with role labels and truncated content.                   |
| `/quit`    | End the session and exit. Also: `/exit`, `/q`.                           |

### Approval workflow

When manual mode is active, every outbound message shows:

```
Action proposed:
  Send to agent: "your message here"

[a]pprove / [d]eny / [m]odify >
```

- **Approve (a/y):** Send the message as-is.
- **Deny (d/n):** Cancel the message. Turn counter rolls back.
- **Modify (m):** Re-type the message before sending.

---

## Channels

Paloa Claw supports **44 messaging channels** out of the box. The assistant runs once and speaks everywhere.

### Core channels (built-in)

| Channel      | Setup                                   |
| ------------ | --------------------------------------- |
| **WhatsApp** | `openclaw channels login` (QR scan)     |
| **Telegram** | `openclaw configure` (bot token)        |
| **Discord**  | `openclaw configure` (bot token)        |
| **Slack**    | `openclaw configure` (app token)        |
| **Signal**   | `openclaw configure` (signal-cli)       |
| **iMessage** | macOS only, requires BlueBubbles bridge |
| **LINE**     | `openclaw configure` (channel token)    |

### Extension channels

| Channel                | Extension                   |
| ---------------------- | --------------------------- |
| Google Chat            | `extensions/googlechat`     |
| Microsoft Teams        | `extensions/msteams`        |
| Matrix / Element       | `extensions/matrix`         |
| Mattermost             | `extensions/mattermost`     |
| IRC                    | `extensions/irc`            |
| Feishu / Lark          | `extensions/feishu`         |
| Nostr                  | `extensions/nostr`          |
| BlueBubbles (iMessage) | `extensions/bluebubbles`    |
| Nextcloud Talk         | `extensions/nextcloud-talk` |
| Synology Chat          | `extensions/synology-chat`  |
| Tlon / Urbit           | `extensions/tlon`           |
| Twitch                 | `extensions/twitch`         |
| Zalo                   | `extensions/zalo`           |
| Voice Call (VoIP)      | `extensions/voice-call`     |

### Channel commands

```bash
# List all channels and their status
openclaw channels status

# Probe channels (live connectivity test)
openclaw channels status --probe

# Login to WhatsApp (QR code)
openclaw channels login

# Configure a channel interactively
openclaw configure

# Look up contacts
openclaw directory peers --channel telegram
openclaw directory groups --channel discord
```

### Multi-channel routing

Messages can be received on one channel and delivered on another:

```bash
# Agent replies on Slack
openclaw agent --message "status report" --deliver --reply-channel slack --reply-to "#reports"

# Agent replies on Telegram
openclaw agent --message "daily summary" --deliver --reply-channel telegram --reply-to @mychat
```

---

## Agents

Agents are isolated AI instances with their own model, workspace, tools, and identity.

### Managing agents

```bash
# List configured agents
openclaw agents list

# Add a new agent
openclaw agents add coding --workspace ~/projects --model claude-opus-4-6

# Delete an agent
openclaw agents delete coding

# Set agent identity (name, emoji, avatar)
openclaw agents set-identity --agent main --name "Paloa" --emoji "P"

# Bind an agent to a channel (auto-route incoming messages)
openclaw agents bind --agent coding --bind discord:123456789

# Show bindings
openclaw agents bindings
```

### Running agents

```bash
# One-shot via gateway
openclaw agent --message "What time is it?" --agent main

# One-shot local (no gateway needed, uses local API keys)
openclaw agent --message "Hello" --local

# With thinking level
openclaw agent --message "Complex problem" --thinking high

# With delivery
openclaw agent --message "Morning report" --deliver --channel telegram

# Interactive control
openclaw control --agent main
```

### Agent configuration

In `~/.openclaw/config.json`:

```json5
{
  agents: {
    main: {
      defaultModel: "claude-opus-4-6",
      timeoutSeconds: 600,
    },
    coding: {
      defaultModel: "claude-sonnet-4-6",
      workspace: "~/projects",
    },
    defaults: {
      timeoutSeconds: 600,
      sandbox: { enabled: true },
    },
  },
}
```

### Supported model providers

| Provider  | Models                                 |
| --------- | -------------------------------------- |
| Anthropic | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| OpenAI    | GPT-4.1, o3, o4-mini                   |
| Google    | Gemini 2.5 Pro, Flash                  |
| Meta      | Llama 4 (via Ollama, vLLM)             |
| Mistral   | Mistral Large, Medium                  |
| DeepSeek  | DeepSeek V3, R1                        |
| Local     | Ollama, vLLM, LM Studio                |
| Proxy     | OpenRouter, LiteLLM, GitHub Copilot    |

---

## Skills

Skills are self-contained capabilities that extend what the agent can do. Paloa Claw ships with **54 bundled skills**.

### Browsing & installing skills

```bash
# List installed skills
openclaw skills list

# Inspect a skill
openclaw skills inspect github

# Install from ClawHub
openclaw skills install clawhub:weather

# Install from local path
openclaw skills install ./my-skill
```

### Notable bundled skills

| Skill              | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `github`           | Create issues, PRs, read repos, manage releases  |
| `notion`           | Query databases, create pages, manage workspaces |
| `slack`            | Send messages, manage channels, search history   |
| `discord`          | Server management, message sending               |
| `spotify-player`   | Control playback, search music, manage playlists |
| `canvas`           | Draw and whiteboard in real time                 |
| `coding-agent`     | AI programming assistant with file access        |
| `obsidian`         | Read/write Obsidian vault notes                  |
| `apple-notes`      | Read/write macOS Notes                           |
| `apple-reminders`  | Manage macOS Reminders                           |
| `things-mac`       | Things 3 task management                         |
| `trello`           | Board and card management                        |
| `1password`        | Vault access (read-only)                         |
| `openai-image-gen` | DALL-E image generation                          |
| `openai-whisper`   | Speech-to-text transcription                     |
| `sherpa-onnx-tts`  | Text-to-speech                                   |
| `weather`          | Current weather and forecasts                    |
| `gifgrep`          | Search and send GIFs                             |
| `camsnap`          | Camera snapshot capture                          |
| `video-frames`     | Extract frames from video                        |
| `nano-pdf`         | PDF processing and extraction                    |
| `sonoscli`         | Sonos speaker control                            |
| `eightctl`         | Eight Sleep device control                       |
| `tmux`             | Terminal multiplexer management                  |
| `himalaya`         | Email client (IMAP/SMTP)                         |

### MCP (Model Context Protocol) support

Paloa Claw supports MCP through [mcporter](https://github.com/steipete/mcporter):

```bash
# Add an MCP server without restarting the gateway
openclaw plugins install mcporter
```

MCP servers can be added/removed dynamically, keeping the core tool surface lean.

---

## Memory

Agents remember past conversations and knowledge through a **vector memory system** with semantic search.

### How it works

1. Conversations and documents are embedded into vectors
2. Stored in LanceDB (default) or SQLite
3. On each new message, relevant memories are retrieved via similarity search
4. Temporal decay ensures recent memories are weighted higher
5. MMR (Maximal Marginal Relevance) ensures diversity in retrieved results

### Memory commands

```bash
# Search memory
openclaw memory search "basketball shot detection accuracy"

# Reindex memory files
openclaw memory reindex

# Check memory health
openclaw doctor
```

### Supported embedding backends

| Backend   | Model                    | Notes               |
| --------- | ------------------------ | ------------------- |
| OpenAI    | `text-embedding-3-large` | Best quality        |
| Voyage AI | `voyage-3-lite`          | Good balance        |
| Google    | Gemini embeddings        | Free tier available |
| Mistral   | Mistral embeddings       | European hosting    |
| Ollama    | Local models             | Fully offline       |

### Configuration

```json5
{
  memory: {
    backend: "lancedb", // or "sqlite"
    embeddingModel: "openai",
    temporalDecay: true,
    searchLimit: 10,
  },
}
```

---

## Sandbox & Security

Agent code execution happens inside **isolated containers** to prevent untrusted code from affecting your system.

### Sandbox modes

| Mode          | Isolation             | Use case                  |
| ------------- | --------------------- | ------------------------- |
| **Docker**    | Full containerization | Production (recommended)  |
| **Podman**    | Rootless containers   | Security-conscious setups |
| **Localhost** | No isolation          | Development only          |

### Configuration

```json5
{
  agents: {
    defaults: {
      sandbox: {
        enabled: true,
        docker: {
          image: "openclaw:sandbox",
          pull: "on-missing",
        },
        resources: {
          cpus: 2,
          memoryMb: 512,
          diskMb: 1024,
          timeoutSeconds: 300,
        },
      },
    },
  },
}
```

### Exec approvals

Beyond sandboxing, the **exec approvals** system gates every shell command the agent tries to run:

```bash
# View current approvals
openclaw approvals get

# Set approval mode
openclaw approvals set --security allowlist --ask on-miss

# Edit the allowlist
openclaw approvals allowlist
```

**Security levels:**

| Level       | Behavior                      |
| ----------- | ----------------------------- |
| `deny`      | Block all shell commands      |
| `allowlist` | Only allow matched patterns   |
| `full`      | Allow all (with optional ask) |

**Ask modes:**

| Mode      | Behavior                                |
| --------- | --------------------------------------- |
| `off`     | No prompting                            |
| `on-miss` | Prompt when command is not in allowlist |
| `always`  | Prompt for every command                |

### Browser sandbox

The agent can browse the web in an isolated Chromium instance:

```bash
openclaw browser launch         # Start sandboxed browser
openclaw browser status         # Check browser state
```

---

## Hooks

Hooks are **injection points** for custom logic that runs at specific points in the agent lifecycle.

### Bundled hooks

| Hook                    | Purpose                               |
| ----------------------- | ------------------------------------- |
| `session-memory`        | Persist session state across restarts |
| `command-logger`        | Log all agent commands                |
| `boot-md`               | Run markdown files on gateway startup |
| `bootstrap-extra-files` | Load additional context files         |

### Managing hooks

```bash
# List installed hooks
openclaw hooks list

# Install a hook from URL or file path
openclaw hooks install ./my-hook.ts --save

# Remove a hook
openclaw hooks remove my-hook
```

### Hook types

- **Message hooks** -- Transform messages before/after agent processing
- **Lifecycle hooks** -- Run on startup, shutdown, session create/destroy
- **Gmail hooks** -- Trigger on email events

---

## Cron & Scheduling

Schedule agent jobs with natural-language-like syntax.

### Schedule syntax

```
every 5 minutes
every hour
daily at 9:00 AM
every Monday at 10:00
at 2026-03-15 14:30          (one-shot)
```

### Managing cron jobs

```bash
# List scheduled jobs
openclaw cron list

# Add a job
openclaw cron add --schedule "daily at 9:00 AM" --agent main --message "Morning briefing" --channel slack

# Remove a job
openclaw cron remove <job-id>

# View run history
openclaw cron logs
```

### Configuration

```json5
{
  cron: [
    {
      id: "morning-report",
      schedule: "daily at 9:00 AM",
      agent: "main",
      message: "Generate morning report and post to #general",
      channel: "slack",
    },
    {
      id: "git-summary",
      schedule: "every Friday at 5:00 PM",
      agent: "coding",
      message: "Summarize this week's commits",
    },
  ],
}
```

---

## Companion Apps

### macOS

Native SwiftUI menubar app. Gateway management, system tray, Sparkle auto-updates.

```
apps/macos/
```

### iOS

Swift app with Share extensions and Siri integration.

```
apps/ios/
```

### Android

Kotlin app with push notifications and device-to-gateway bridging.

```
apps/android/
```

### Building apps

```bash
# macOS (current arch)
scripts/package-mac-app.sh

# See release checklist
docs/platforms/mac/release.md
```

---

## Docker Deployment

### Quick deploy

```bash
docker build -t paloa-claw:local .
docker-compose up -d
```

### docker-compose.yml services

| Service            | Port  | Role                           |
| ------------------ | ----- | ------------------------------ |
| `openclaw-gateway` | 18789 | Main daemon                    |
| `openclaw-cli`     | --    | CLI container (shares network) |

### Build arguments

| Arg                            | Default | Effect                     |
| ------------------------------ | ------- | -------------------------- |
| `OPENCLAW_INSTALL_BROWSER`     | `0`     | Include Chromium (~300MB)  |
| `OPENCLAW_INSTALL_DOCKER_CLI`  | `0`     | Include Docker CLI (~50MB) |
| `OPENCLAW_DOCKER_APT_PACKAGES` | `""`    | Additional apt packages    |

### Volumes

```yaml
volumes:
  - ~/.openclaw:/home/node/.openclaw # Config + state
  - ~/.openclaw/workspace:/workspace # Agent workspace
```

### Health check

HTTP GET to `http://127.0.0.1:18789/healthz` every 30 seconds.

---

## Configuration Reference

Config file: `~/.openclaw/config.json` (JSON5 format)

### Top-level sections

| Section    | Purpose                                      |
| ---------- | -------------------------------------------- |
| `agents`   | Agent definitions, defaults, model overrides |
| `gateway`  | Bind address, port, mode, auth tokens        |
| `channels` | Per-channel settings (tokens, allowlists)    |
| `models`   | Model provider configs, fallback chains      |
| `memory`   | Vector database backend, embedding model     |
| `sandbox`  | Docker/Podman settings, resource limits      |
| `cron`     | Scheduled job definitions                    |
| `hooks`    | Hook installation and config                 |
| `skills`   | Skill installation and config                |
| `tools`    | Tool definitions and policies                |
| `browser`  | Headless browser config                      |

### Config commands

```bash
# Get a value
openclaw config get agents.main.defaultModel

# Set a value
openclaw config set agents.main.defaultModel claude-opus-4-6

# Unset a value
openclaw config unset agents.coding

# View full config file path
openclaw config file

# Validate config
openclaw config validate

# Interactive wizard
openclaw configure
```

---

## Use Cases & Examples

### 1. Sports Film Analytics (Paloa Labs production use)

Run the AI pipeline and get results posted to Slack:

```bash
# Schedule daily game analysis
openclaw cron add \
  --schedule "daily at 6:00 AM" \
  --agent main \
  --message "Run the quad pipeline on yesterday's game and post results" \
  --channel slack

# Interactive control during pipeline testing
openclaw control --agent main
you > Run YOLO shot detection on the 10:00-15:00 segment
[a]pprove > a
agent > Running YOLO detection with ball_conf=0.28, min_traj=4...
```

### 2. Team Communication Hub

Single assistant across all your team's channels:

```bash
# Set up channels
openclaw configure   # Telegram, Discord, Slack

# Bind agents to channels
openclaw agents bind --agent main --bind telegram
openclaw agents bind --agent main --bind discord
openclaw agents bind --agent main --bind slack

# Message from any channel, get a reply on any channel
openclaw agent --message "Summarize today's standup" --deliver --reply-channel slack --reply-to "#engineering"
```

### 3. Automated DevOps Assistant

```bash
# Create a dedicated ops agent
openclaw agents add ops --model claude-sonnet-4-6

# Schedule monitoring
openclaw cron add --schedule "every 30 minutes" --agent ops --message "Check server health and alert if any issues"

# Interactive incident response
openclaw control --agent ops
you > Investigate the 502 errors on api.example.com
[a]pprove > a
agent > Checking server logs...
Tool calls executed:
  bash (done)
    { "command": "ssh api.example.com 'tail -50 /var/log/nginx/error.log'" }
```

### 4. Research & Knowledge Management

```bash
# Agent with Obsidian + GitHub skills
openclaw agent --message "Read my research notes on YOLO v11 and create a GitHub issue for the fine-tuning task" --local

# Memory-powered recall
openclaw agent --message "What did we decide about the Kimi temperature setting last week?"
# Agent searches vector memory, finds the conversation, returns: "Temperature must be >= 0.4"
```

### 5. Personal Home Automation

```bash
# Control smart devices via skills
openclaw agent --message "Set bedroom temperature to 68F" --local
# Uses eightctl skill for Eight Sleep, sonoscli for speakers

# Schedule routines
openclaw cron add --schedule "daily at 7:00 AM" --agent main --message "Good morning routine: lights on, coffee, weather briefing"
```

### 6. Content & Social Media Pipeline

```bash
# Agent generates content and delivers to multiple channels
openclaw agent \
  --message "Write a tweet thread about our latest accuracy improvements" \
  --deliver \
  --reply-channel discord \
  --reply-to "#content-review"
```

### 7. Controlled Code Review

```bash
openclaw control --agent coding
you > Review the changes in workers/bring_it_home.py and suggest improvements
[a]pprove > a
agent > Reading the file...
Tool calls executed:
  bash (done)
    { "command": "git diff HEAD~1 workers/bring_it_home.py" }
agent > I found 3 issues:
1. The confidence gate at 0.5 may be too aggressive...
you > /approve
you > Apply fix #1 only
agent > Applying fix...
```

### 8. Multi-Agent Pipeline

```bash
# Research agent gathers data
openclaw agents add researcher --model claude-sonnet-4-6
# Writer agent drafts content
openclaw agents add writer --model claude-opus-4-6

# Chain them
openclaw agent --agent researcher --message "Find the latest papers on basketball action recognition"
openclaw agent --agent writer --message "Draft a blog post using the research agent's findings"
```

---

## CLI Command Reference

### Core commands

| Command                    | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `openclaw gateway`         | Run the WebSocket gateway                         |
| `openclaw agent -m <text>` | Run one agent turn                                |
| `openclaw control`         | Interactive agent controller with action approval |
| `openclaw channels status` | Show channel connectivity                         |
| `openclaw configure`       | Interactive setup wizard                          |
| `openclaw onboard`         | Full onboarding wizard                            |
| `openclaw doctor`          | Health checks and auto-fixes                      |
| `openclaw tui`             | Terminal UI for real-time chat                    |
| `openclaw status`          | Show channel health + recent sessions             |
| `openclaw health`          | Quick gateway health check                        |

### Agent management

| Command                        | Description                 |
| ------------------------------ | --------------------------- |
| `openclaw agents list`         | List all agents             |
| `openclaw agents add <name>`   | Add a new agent             |
| `openclaw agents delete <id>`  | Delete an agent             |
| `openclaw agents bind`         | Route a channel to an agent |
| `openclaw agents unbind`       | Remove a routing binding    |
| `openclaw agents set-identity` | Set agent name/emoji/avatar |

### Configuration & state

| Command                           | Description           |
| --------------------------------- | --------------------- |
| `openclaw config get <key>`       | Read a config value   |
| `openclaw config set <key> <val>` | Write a config value  |
| `openclaw sessions list`          | List stored sessions  |
| `openclaw memory search <query>`  | Search vector memory  |
| `openclaw models list`            | List available models |
| `openclaw approvals get`          | View exec approvals   |

### Infrastructure

| Command                   | Description             |
| ------------------------- | ----------------------- |
| `openclaw cron list`      | List scheduled jobs     |
| `openclaw hooks list`     | List installed hooks    |
| `openclaw skills list`    | List installed skills   |
| `openclaw plugins list`   | List installed plugins  |
| `openclaw sandbox status` | Show sandbox state      |
| `openclaw browser launch` | Start sandboxed browser |
| `openclaw logs`           | Tail gateway logs       |

### Utility

| Command                 | Description                |
| ----------------------- | -------------------------- |
| `openclaw dashboard`    | Open Control UI in browser |
| `openclaw docs`         | Search the docs            |
| `openclaw qr`           | Generate pairing QR code   |
| `openclaw devices list` | List paired devices        |
| `openclaw reset`        | Reset config/state         |
| `openclaw update`       | Update to latest version   |
| `openclaw completion`   | Generate shell completions |

---

## Development

### Setup

```bash
pnpm install                    # Install dependencies
pnpm build                     # Type-check + build to dist/
pnpm dev                       # Run CLI in dev mode
```

### Testing

```bash
pnpm test                      # Run all tests (vitest)
pnpm test:coverage             # Run with coverage (70% threshold)
```

### Code quality

```bash
pnpm check                     # Lint + format check (Oxlint + Oxfmt)
pnpm format:fix                # Auto-fix formatting
pnpm tsgo                      # TypeScript type-check only
```

### Project structure

```
paloa-claw/
  src/
    cli/                       # CLI commands and program setup
      paloa-control-cli.ts     # The control command (Paloa addition)
      program/                 # Command registry, lazy loading
    commands/                  # Command implementations
      agent.ts                 # Agent execution logic
      agent-via-gateway.ts     # Gateway-routed agent calls
    agents/                    # Agent runtime, model selection, tools
      pi-embedded-runner/      # Embedded LLM agent runner
      sandbox/                 # Docker/Podman sandbox
    gateway/                   # WebSocket gateway server
    acp/                       # Agent Control Protocol
    config/                    # Config types, loading, validation
    channels/                  # Core channel implementations
    cron/                      # Job scheduler
    hooks/                     # Hook system
    memory/                    # Vector memory (LanceDB, SQLite)
    tui/                       # Terminal UI
    routing/                   # Message routing, session keys
  extensions/                  # Channel plugins (37 extensions)
  skills/                      # Bundled skills (54 skills)
  apps/                        # Companion apps (macOS, iOS, Android)
  docs/                        # Documentation
  ui/                          # Web Control UI
  test/                        # Integration tests
```

### Key conventions

- **TypeScript ESM** -- Strict typing, no `any`, no `@ts-nocheck`
- **Oxlint + Oxfmt** -- Linting and formatting (run `pnpm check`)
- **Colocated tests** -- `*.test.ts` next to source files
- **Lazy command loading** -- Commands are only imported when invoked
- **Plugin SDK** -- `openclaw/plugin-sdk` for extension development

---

## Troubleshooting

### Gateway won't start

```bash
# Check if port is in use
lsof -i :18789

# Force kill and restart
openclaw gateway --force

# Check logs
openclaw logs
```

### Channel not connecting

```bash
# Probe all channels
openclaw channels status --probe

# Re-authenticate
openclaw configure

# Run diagnostics
openclaw doctor
```

### Agent not responding

```bash
# Check model configuration
openclaw models list

# Test with local execution (no gateway)
openclaw agent --message "test" --local

# Check approvals (might be blocking)
openclaw approvals get
```

### Build fails

```bash
# Clean and rebuild
rm -rf dist/ node_modules/
pnpm install
pnpm build

# Check Node version (need 22+)
node --version
```

### Memory search returns nothing

```bash
# Reindex
openclaw memory reindex

# Check memory config
openclaw config get memory

# Run doctor
openclaw doctor
```

---

**Built by Paloa Labs. Forked from [OpenClaw](https://github.com/openclaw/openclaw).**
