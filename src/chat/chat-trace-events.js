// Only observable tool activity is shared; model reasoning, prompts and images are excluded.
function toolContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.filter((part) => part?.type === "text").slice(0, 8).map((part) => String(part.text || "").slice(0, 12000)).join("\n");
}

function traceEvents(provider, event) {
  if (!event || typeof event !== "object") return [];
  if (provider === "claude" || provider === "grok") {
    const content = event.message?.content;
    if ((event.type === "assistant" || event.type === "user") && Array.isArray(content)) {
      return content.slice(0, 32).flatMap((block) => {
        if (block?.type === "tool_use") return [{ kind: "tool-call", id: block.id, tool: block.name, input: block.input }];
        if (block?.type === "tool_result") return [{ kind: "tool-result", id: block.tool_use_id, error: Boolean(block.is_error), output: toolContent(block.content) }];
        return [];
      });
    }
    if (event.type === "result" && event.is_error) return [{ kind: "error", message: event.result || event.errors || event.subtype }];
  }
  if (provider === "codex") {
    const item = event.item;
    if (item && event.type === "item.completed") {
      if (item.type === "command_execution") return [{ kind: "tool-result", tool: "shell", command: item.command, output: item.aggregated_output, exitCode: item.exit_code }];
      if (item.type === "file_change") return [{ kind: "file-change", status: item.status, changes: item.changes?.slice(0, 8).map(({ path, kind }) => ({ path, kind })) }];
      if (item.type === "mcp_tool_call") return [{ kind: "tool-result", tool: `${item.server}/${item.tool}`, input: item.arguments, output: toolContent(item.result?.content), error: item.error }];
      if (item.type === "web_search") return [{ kind: "tool-result", tool: "web_search", query: item.query }];
    }
    if (item?.type === "command_execution" && event.type === "item.started") return [{ kind: "tool-call", tool: "shell", command: item.command }];
    if (item?.type === "error" && !/skill descriptions were shortened/i.test(item.message || "")) return [{ kind: "error", message: item.message }];
    if (event.type === "turn.failed" || event.type === "error") return [{ kind: "error", message: event.error?.message || event.message }];
    const msg = event.msg;
    if (msg?.type === "exec_command_begin") return [{ kind: "tool-call", tool: "shell", id: msg.call_id, command: msg.command }];
    if (msg?.type === "exec_command_end") return [{ kind: "tool-result", tool: "shell", id: msg.call_id, output: msg.aggregated_output || msg.stdout, stderr: msg.stderr, exitCode: msg.exit_code }];
  }
  if (provider === "agy" && event.event === "step_update") {
    const step = event.step_update || {};
    const info = step.tool_info || {};
    const tool = step.tool_name || info.name;
    if (tool) return [{ kind: "tool-result", id: step.id, tool, state: step.state, input: info.arguments || info.input, output: toolContent(info.output || info.result), error: info.error?.message || step.error?.message }];
  }
  return [];
}

module.exports = { traceEvents };
