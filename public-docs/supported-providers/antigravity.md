---
title: Antigravity
description: Install and configure Antigravity for Paseo.
nav: Antigravity
order: 23
category: Providers
---

# Antigravity

Run Antigravity in Paseo over ACP with your installed `agy` CLI and sign-in. This integration is not endorsed by Google.

## Getting started

Install the Antigravity CLI (`agy` `1.5.0` or newer) on your daemon host, then run `agy` once to sign in. In Paseo, select **Antigravity**. The provider ships with Paseo, so you do not install a plugin.

Paseo connects over `agy acp` and supports per-model thinking levels, slash commands, mid-turn steering, interactive question prompts, Paseo MCP tools, inline image attachments, session listing, history replay on resume, and quota reporting in the Usage panel.

If `agy` is outside your daemon's PATH, override its command in `~/.paseo/config.json`. Keep `"acp"` as the argument when launching ACP mode, and use `env` for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "command": ["/absolute/path/to/agy", "acp"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

See [Custom providers](/docs/custom-providers) for command and environment overrides.

## Permissions

Antigravity supports `default`, `accept-edits`, `auto`, and `plan` permission modes, along with interactive tool approval prompts. In `auto` mode, tool calls run without asking.

## Limitations

- When Paseo MCP tools are enabled, Antigravity is instructed to spawn subagents through Paseo's `create_agent` tool so subagents stay visible and controllable in Paseo.
