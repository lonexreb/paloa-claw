import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { listAgentIds } from "../agents/agent-scope.js";
import { resolveSessionKeyForRequest } from "../commands/agent/session.js";
import { loadConfig } from "../config/config.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: {
    payloads?: Array<{
      text?: string;
      mediaUrl?: string | null;
      mediaUrls?: string[];
    }>;
    meta?: unknown;
    toolCalls?: Array<{
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      status?: string;
    }>;
  };
};

type ControlSession = {
  agentId?: string;
  sessionKey: string;
  turnCount: number;
  autoApprove: boolean;
  paused: boolean;
};

const BANNER = `
${theme.heading("Paloa Control")} - Interactive Agent Controller
${theme.muted("Type a message to send to the agent. Commands:")}
  ${theme.accent("/approve")}    - Auto-approve all agent actions
  ${theme.accent("/manual")}     - Require manual approval (default)
  ${theme.accent("/pause")}      - Pause agent execution
  ${theme.accent("/resume")}     - Resume agent execution
  ${theme.accent("/status")}     - Show session status
  ${theme.accent("/history")}    - Show turn history
  ${theme.accent("/quit")}       - Exit control session
`;

function formatPayload(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}): string {
  const lines: string[] = [];
  if (payload.text) {
    lines.push(payload.text.trimEnd());
  }
  const mediaUrl =
    typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()
      ? payload.mediaUrl.trim()
      : undefined;
  const media = payload.mediaUrls ?? (mediaUrl ? [mediaUrl] : []);
  for (const url of media) {
    lines.push(`  MEDIA: ${url}`);
  }
  return lines.join("\n").trimEnd();
}

async function sendAgentMessage(
  session: ControlSession,
  message: string,
  timeoutSeconds: number,
): Promise<GatewayAgentResponse | null> {
  const gatewayTimeoutMs = Math.max(10_000, (timeoutSeconds + 30) * 1000);
  const idempotencyKey = randomIdempotencyKey();

  try {
    const response = await callGateway<GatewayAgentResponse>({
      method: "agent",
      params: {
        message,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        timeout: timeoutSeconds,
        idempotencyKey,
      },
      expectFinal: true,
      timeoutMs: gatewayTimeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
    return response;
  } catch (err) {
    console.error(theme.error(`Agent error: ${String(err)}`));
    return null;
  }
}

async function promptApproval(
  rl: ReturnType<typeof createInterface>,
  action: string,
): Promise<"approve" | "deny" | "modify"> {
  console.log(`\n${theme.heading("Action proposed:")}`);
  console.log(`  ${action}`);
  const answer = await rl.question(
    `\n${theme.accent("[a]pprove")} / ${theme.error("[d]eny")} / ${theme.muted("[m]odify")} > `,
  );
  const lower = answer.trim().toLowerCase();
  if (lower === "a" || lower === "approve" || lower === "y" || lower === "yes") {
    return "approve";
  }
  if (lower === "m" || lower === "modify") {
    return "modify";
  }
  return "deny";
}

async function runControlLoop(opts: {
  agent?: string;
  to?: string;
  sessionId?: string;
  timeout?: string;
}) {
  const cfg = loadConfig();
  const agentIdRaw = opts.agent?.trim();
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;

  if (agentId) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentId)) {
      throw new Error(
        `Unknown agent id "${agentIdRaw}". Use "openclaw agents list" to see configured agents.`,
      );
    }
  }

  const timeoutSeconds =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : (cfg.agents?.defaults?.timeoutSeconds ?? 600);

  if (Number.isNaN(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error("--timeout must be a non-negative integer (seconds)");
  }

  const sessionKey = resolveSessionKeyForRequest({
    cfg,
    agentId,
    to: opts.to,
    sessionId: opts.sessionId,
  }).sessionKey;

  const session: ControlSession = {
    agentId,
    sessionKey,
    turnCount: 0,
    autoApprove: false,
    paused: false,
  };

  console.log(BANNER);
  console.log(`${theme.muted("Session:")} ${session.sessionKey}`);
  if (agentId) {
    console.log(`${theme.muted("Agent:")} ${agentId}`);
  }
  console.log(`${theme.muted("Mode:")} manual approval\n`);

  const rl = createInterface({ input: stdin, output: stdout });

  const turnHistory: Array<{ role: "user" | "agent"; text: string; turn: number }> = [];

  try {
    while (true) {
      if (session.paused) {
        const answer = await rl.question(`${theme.muted("[paused]")} > `);
        if (answer.trim() === "/resume") {
          session.paused = false;
          console.log(theme.accent("Resumed."));
        } else if (answer.trim() === "/quit") {
          break;
        } else {
          console.log(theme.muted("Agent is paused. Use /resume or /quit."));
        }
        continue;
      }

      const input = await rl.question(`${theme.accent("you")} > `);
      const trimmed = input.trim();

      if (!trimmed) {
        continue;
      }

      // Handle commands
      if (trimmed.startsWith("/")) {
        switch (trimmed) {
          case "/approve":
            session.autoApprove = true;
            console.log(
              theme.accent(
                "Auto-approve enabled. All agent actions will proceed without confirmation.",
              ),
            );
            continue;
          case "/manual":
            session.autoApprove = false;
            console.log(theme.accent("Manual approval enabled. You'll confirm each agent action."));
            continue;
          case "/pause":
            session.paused = true;
            console.log(theme.accent("Agent paused. Use /resume to continue."));
            continue;
          case "/resume":
            console.log(theme.muted("Agent is not paused."));
            continue;
          case "/status": {
            console.log(`\n${theme.heading("Session Status")}`);
            console.log(`  Session:  ${session.sessionKey}`);
            console.log(`  Agent:    ${session.agentId ?? "default"}`);
            console.log(`  Turns:    ${session.turnCount}`);
            console.log(`  Mode:     ${session.autoApprove ? "auto-approve" : "manual"}`);
            console.log(`  Paused:   ${session.paused ? "yes" : "no"}`);
            console.log("");
            continue;
          }
          case "/history": {
            if (turnHistory.length === 0) {
              console.log(theme.muted("No turns yet."));
            } else {
              console.log(`\n${theme.heading("Turn History")}`);
              for (const entry of turnHistory) {
                const prefix = entry.role === "user" ? theme.accent("you") : theme.heading("agent");
                console.log(
                  `  [${entry.turn}] ${prefix}: ${entry.text.slice(0, 120)}${entry.text.length > 120 ? "..." : ""}`,
                );
              }
              console.log("");
            }
            continue;
          }
          case "/quit":
          case "/exit":
          case "/q":
            break;
          default:
            console.log(theme.muted(`Unknown command: ${trimmed}. Type /quit to exit.`));
            continue;
        }
        // /quit breaks the switch but we need to break the while
        if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
          break;
        }
      }

      // Send message to agent
      session.turnCount++;
      turnHistory.push({ role: "user", text: trimmed, turn: session.turnCount });

      if (!session.autoApprove) {
        const decision = await promptApproval(rl, `Send to agent: "${trimmed}"`);
        if (decision === "deny") {
          console.log(theme.muted("Message cancelled."));
          session.turnCount--;
          turnHistory.pop();
          continue;
        }
        if (decision === "modify") {
          const modified = await rl.question(`${theme.accent("modified message")} > `);
          if (!modified.trim()) {
            console.log(theme.muted("Empty message, cancelled."));
            session.turnCount--;
            turnHistory.pop();
            continue;
          }
          turnHistory[turnHistory.length - 1].text = modified.trim();
        }
      }

      const messageToSend = turnHistory[turnHistory.length - 1].text;
      console.log(theme.muted(`\nSending to agent (turn ${session.turnCount})...`));

      const response = await sendAgentMessage(session, messageToSend, timeoutSeconds);

      if (!response) {
        console.log(theme.error("No response from agent.\n"));
        continue;
      }

      const payloads = response.result?.payloads ?? [];

      if (payloads.length === 0) {
        const fallback = response.summary ? String(response.summary) : "No reply from agent.";
        console.log(`\n${theme.heading("agent")} > ${fallback}\n`);
        turnHistory.push({ role: "agent", text: fallback, turn: session.turnCount });
      } else {
        for (const payload of payloads) {
          const out = formatPayload(payload);
          if (out) {
            console.log(`\n${theme.heading("agent")} >`);
            console.log(out);
            console.log("");
            turnHistory.push({ role: "agent", text: out, turn: session.turnCount });
          }
        }
      }

      // Show tool calls if any
      const toolCalls = response.result?.toolCalls;
      if (toolCalls && toolCalls.length > 0) {
        console.log(theme.heading("Tool calls executed:"));
        for (const tc of toolCalls) {
          console.log(`  ${theme.accent(tc.name ?? "unknown")} (${tc.status ?? "done"})`);
          if (tc.input) {
            const inputStr = JSON.stringify(tc.input, null, 2)
              .split("\n")
              .map((l) => `    ${l}`)
              .join("\n");
            console.log(inputStr);
          }
        }
        console.log("");
      }
    }
  } finally {
    rl.close();
  }

  console.log(theme.muted(`\nSession ended. ${session.turnCount} turns completed.`));
}

export function registerPaloaControlCli(program: Command) {
  program
    .command("control")
    .description("Interactive agent controller with action approval")
    .option("--agent <id>", "Agent id to control")
    .option("-t, --to <number>", "Recipient number in E.164 for session key")
    .option("--session-id <id>", "Use an explicit session id")
    .option(
      "--timeout <seconds>",
      "Override agent command timeout (seconds, default 600 or config value)",
    )
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  ["openclaw control --agent main", "Control the main agent interactively."],
  ["openclaw control --to +15555550123", "Start a controlled session with a recipient."],
  ["openclaw control --agent ops --timeout 300", "Control ops agent with 5min timeout."],
])}

${theme.heading("In-session commands:")}
  /approve   Auto-approve all agent actions
  /manual    Require manual approval for each action (default)
  /pause     Pause the agent
  /resume    Resume the agent
  /status    Show current session status
  /history   Show conversation turn history
  /quit      Exit the control session
`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runControlLoop({
          agent: opts.agent as string | undefined,
          to: opts.to as string | undefined,
          sessionId: opts.sessionId as string | undefined,
          timeout: opts.timeout as string | undefined,
        });
      });
    });
}
