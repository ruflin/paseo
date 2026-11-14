---
title: Antigravity
description: 为 Paseo 安装和配置 Antigravity。
nav: Antigravity
---

# Antigravity {#antigravity}

使用你已安装的 `agy` CLI 和登录状态，在 Paseo 中通过 ACP 运行 Antigravity。此集成未经 Google 认可。

## 开始使用 {#getting-started}

在 daemon 主机上安装 Antigravity CLI（`agy` `1.5.0` 或更高版本），然后运行一次 `agy` 登录。在 Paseo 中选择 **Antigravity**。该 Provider 随 Paseo 一起提供，无需另外安装插件。

Paseo 通过 `agy acp` 连接，支持按模型配置思考级别、斜杠命令、Paseo MCP 工具、内联图片附件、会话列表以及恢复会话时的历史重放。

如果 `agy` 不在 daemon 的 PATH 中，请在 `~/.paseo/config.json` 中覆盖它的命令。启动 ACP 模式时请保留 `"acp"` 参数，并使用 `env` 设置 Provider 专用的环境变量：

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

命令和环境变量覆盖见[自定义 Provider](/docs/custom-providers)。

## 权限 {#permissions}

Antigravity 支持 `default`、`accept-edits`、`auto` 和 `plan` 权限模式，以及交互式工具审批提示。在 `auto` 模式下，工具调用无需询问即可运行。

## 限制 {#limitations}

- 在回合进行中发送消息会先取消当前回合，再发送新的提示词。
