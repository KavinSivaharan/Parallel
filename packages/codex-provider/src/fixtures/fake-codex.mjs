import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 99.0.0-test\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using test credentials\n");
  process.exit(0);
}

const isResume = args.includes("resume");
const instruction = args.at(-1) ?? "";
const threadId = "019fa202-0f67-76e0-8acb-aa69bad8b8ac";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
if (instruction.includes("malformed")) {
  process.stdout.write("{this-is-not-json}\n");
}
if (instruction.includes("stderr")) {
  process.stderr.write("Authorization: Bearer fake-secret-token provider warning\n");
}
if (instruction.includes("crash")) {
  process.stderr.write("provider crashed intentionally\n");
  process.exit(7);
}
emit({
  type: "item.started",
  item: {
    id: `command-${isResume ? "resume" : "initial"}`,
    type: "command_execution",
    command: "update fixture.txt",
    status: "in_progress",
  },
});
if (instruction.includes("duplicate")) {
  emit({
    type: "item.started",
    item: {
      id: `command-${isResume ? "resume" : "initial"}`,
      type: "command_execution",
      command: "update fixture.txt",
      status: "in_progress",
    },
  });
}
if (instruction.includes("slow")) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
await appendFile(join(process.cwd(), "fixture.txt"), `${instruction}\n`, "utf8");
emit({
  type: "item.completed",
  item: {
    id: `command-${isResume ? "resume" : "initial"}`,
    type: "command_execution",
    command: "update fixture.txt",
    aggregated_output: "updated fixture.txt",
    exit_code: 0,
    status: "completed",
  },
});
emit({
  type: "item.completed",
  item: {
    id: `message-${isResume ? "resume" : "initial"}`,
    type: "agent_message",
    text: isResume ? "Continuation complete." : "Initial turn complete.",
  },
});
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
  },
});
