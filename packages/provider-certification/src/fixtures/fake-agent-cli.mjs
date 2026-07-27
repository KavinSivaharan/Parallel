const provider = process.argv[2];
const args = process.argv.slice(3);

if (args.includes("--version")) {
  process.stdout.write(`${provider} 99.0.0-certification\n`);
  process.exit(0);
}

if (provider === "claude-code" && args[0] === "auth" && args[1] === "status") {
  process.stdout.write('{"loggedIn":true,"authMethod":"fixture"}\n');
  process.exit(0);
}

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sessionId = `${provider}-certification-session`;

if (provider === "claude-code") {
  emit({
    type: "assistant",
    uuid: `assistant-${Date.now()}`,
    session_id: sessionId,
    message: {
      content: [{ type: "text", text: "Claude certification output" }],
      usage: { input_tokens: 4, output_tokens: 3 },
    },
  });
  emit({
    type: "result",
    uuid: `result-${Date.now()}`,
    session_id: sessionId,
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 4, output_tokens: 3 },
  });
} else if (provider === "openhands") {
  emit({
    type: "message",
    event_id: `message-${Date.now()}`,
    conversation_id: sessionId,
    content: "OpenHands certification output",
  });
} else {
  process.stderr.write(`Unknown certification provider ${String(provider)}\n`);
  process.exit(2);
}

await new Promise((resolve) => setTimeout(resolve, 75));
