import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { AcpContentBlock } from "./wire.js";

export interface PromptCapabilities {
  image: boolean;
}

export function encodePrompt(
  prompt: ProviderPrompt,
  capabilities: PromptCapabilities,
): { blocks: AcpContentBlock[]; summaryText: string } {
  if (prompt.input.type === "command") {
    const suffix = prompt.input.arguments ? ` ${prompt.input.arguments}` : "";
    const text = `/${prompt.input.name}${suffix}`;
    return { blocks: [{ type: "text", text }], summaryText: text };
  }

  const blocks = prompt.input.content.map((part) => toAcpBlock(part, capabilities));
  const summaryText = blocks
    .filter((block): block is Extract<AcpContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return { blocks, summaryText };
}

function toAcpBlock(part: ProviderContent, capabilities: PromptCapabilities): AcpContentBlock {
  switch (part.type) {
    case "text": {
      if ("title" in part && part.title) {
        return { type: "text", text: `[${part.title}]\n${part.text}` };
      }
      return { type: "text", text: part.text };
    }
    case "image":
      if (capabilities.image) {
        return { type: "image", data: part.data, mimeType: part.mimeType };
      }
      return { type: "text", text: `[Image attachment: ${part.mimeType}]` };
    case "uploaded_file":
      return {
        type: "text",
        text: `Attached file (${part.fileName}, ${part.mimeType}, ${part.size} bytes): ${part.path}`,
      };
    case "forge_change_request":
    case "github_pr": {
      const header = `Pull/Change Request #${part.number}: ${part.title}\nURL: ${part.url}`;
      const branches =
        part.baseRefName || part.headRefName
          ? `\nBranch: ${part.headRefName ?? "?"} -> ${part.baseRefName ?? "?"}`
          : "";
      const body = part.body ? `\n\n${part.body}` : "";
      return { type: "text", text: `${header}${branches}${body}` };
    }
    case "forge_issue":
    case "github_issue": {
      const body = part.body ? `\n\n${part.body}` : "";
      return {
        type: "text",
        text: `Issue #${part.number}: ${part.title}\nURL: ${part.url}${body}`,
      };
    }
    case "review": {
      const lines = part.comments.map((comment) => {
        const snippet = comment.context.lines.map((line) => line.content).join("\n");
        return `${comment.filePath}:${comment.lineNumber} (${comment.side})\n${comment.context.hunkHeader}\n${snippet}\nComment: ${comment.body}`;
      });
      return { type: "text", text: lines.join("\n\n") };
    }
  }
}
