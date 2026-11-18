import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderPermissionResponse } from "../provider.js";

interface NormalizedOption {
  id: string;
  label: string;
  description?: string;
}

export interface NormalizedElicitationQuestion {
  id: string;
  header: string;
  question: string;
  options: NormalizedOption[];
  multiSelect: boolean;
  allowOther: boolean;
  valueType: "string" | "number" | "integer" | "boolean" | "array";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseChoices(raw: unknown): NormalizedOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    const item = asRecord(entry);
    const id = item.const === undefined || item.const === null ? String(index) : String(item.const);
    const label = nonEmptyString(item.title) ?? nonEmptyString(item.label) ?? nonEmptyString(id);
    if (!label) return [];
    const description = nonEmptyString(item.description);
    return [{ id, label, ...(description ? { description } : {}) }];
  });
}

function parseEnumOptions(raw: unknown): NormalizedOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === undefined || entry === null) return [];
    const id = String(entry);
    return [{ id, label: id }];
  });
}

function parseValueType(raw: unknown): NormalizedElicitationQuestion["valueType"] {
  if (raw === "number" || raw === "integer" || raw === "boolean" || raw === "array") {
    return raw;
  }
  return "string";
}

function collectPrimaryIds(keys: readonly string[]): Set<string> {
  const primaryIds = new Set<string>();
  for (const key of keys) {
    if (key.endsWith("_other")) {
      const base = key.slice(0, -"_other".length);
      if (base.length > 0) primaryIds.add(base);
    } else {
      primaryIds.add(key);
    }
  }
  return primaryIds;
}

function parseQuestionProperty(
  id: string,
  index: number,
  properties: Record<string, unknown>,
  fallbackMessage: string | undefined,
): NormalizedElicitationQuestion {
  const prop = asRecord(properties[id]);
  const other = asRecord(properties[`${id}_other`]);
  const valueType = parseValueType(prop.type);
  const multiSelect = valueType === "array";
  const target = multiSelect ? asRecord(prop.items) : prop;

  let options = parseChoices(target.oneOf ?? target.anyOf);
  if (options.length === 0) options = parseEnumOptions(target.enum);
  if (options.length === 0 && valueType === "boolean") {
    options = [
      { id: "true", label: "Yes" },
      { id: "false", label: "No" },
    ];
  }

  const header = `Question ${index}`;
  const otherTitle = nonEmptyString(other.title);
  const otherDesc = nonEmptyString(other.description)?.replace(
    /^Optional free-form answer to:\s*/i,
    "",
  );
  const question =
    nonEmptyString(prop.title) ??
    nonEmptyString(prop.description) ??
    (otherTitle && otherTitle !== "Other" ? otherTitle : undefined) ??
    otherDesc ??
    fallbackMessage ??
    header;

  return {
    id,
    header,
    question,
    options,
    multiSelect,
    allowOther: `${id}_other` in properties || options.length === 0,
    valueType,
  };
}

/** Parse an ACP `elicitation/create` request into Paseo `QuestionFormCard` questions. */
export function parseElicitationQuestions(
  request: CreateElicitationRequest,
): NormalizedElicitationQuestion[] | null {
  if (request.mode === "url") return null;
  const schema = asRecord("requestedSchema" in request ? request.requestedSchema : undefined);
  const properties = asRecord(schema.properties);
  const keys = Object.keys(properties);
  const fallbackMessage = nonEmptyString(request.message);
  if (keys.length === 0) {
    if (!fallbackMessage) return null;
    return [
      {
        id: "answer",
        header: "Question 1",
        question: fallbackMessage,
        options: [],
        multiSelect: false,
        allowOther: true,
        valueType: "string",
      },
    ];
  }

  // Pair `<id>` with `<id>_other` when agents represent "Other" as a sibling property.
  const questions: NormalizedElicitationQuestion[] = [];
  let index = 0;
  for (const id of collectPrimaryIds(keys)) {
    index += 1;
    questions.push(parseQuestionProperty(id, index, properties, fallbackMessage));
  }
  return questions.length > 0 ? questions : null;
}

/** Build the `input` payload expected by Paseo's `kind: "question"` permission card. */
export function toQuestionPermissionInput(
  questions: readonly NormalizedElicitationQuestion[],
): Record<string, JsonValue> {
  return {
    questions: questions.map((question) => ({
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      multiSelect: question.multiSelect,
      allowOther: question.allowOther,
    })),
  };
}

function splitMultiSelectAnswer(
  rawAnswer: string,
  options: readonly NormalizedOption[],
): { selectedIds: string[]; custom?: string } {
  let remaining = rawAnswer.trim();
  if (!remaining) return { selectedIds: [] };
  const sorted = [...options].sort((left, right) => right.label.length - left.label.length);
  const selectedIds: string[] = [];
  const unmatched: string[] = [];

  while (remaining.length > 0) {
    const matched = sorted.find(
      (option) => remaining === option.label || remaining.startsWith(`${option.label}, `),
    );
    if (matched) {
      selectedIds.push(matched.id);
      if (remaining === matched.label) break;
      remaining = remaining.slice(matched.label.length + 2).trimStart();
      continue;
    }
    const separator = remaining.indexOf(", ");
    if (separator === -1) {
      unmatched.push(remaining);
      break;
    }
    const token = remaining.slice(0, separator).trim();
    if (token) unmatched.push(token);
    remaining = remaining.slice(separator + 2).trimStart();
  }

  return {
    selectedIds,
    ...(unmatched.length > 0 ? { custom: unmatched.join(", ") } : {}),
  };
}

function coerceScalarAnswer(
  rawAnswer: string,
  valueType: NormalizedElicitationQuestion["valueType"],
): ElicitationContentValue {
  if (valueType === "boolean") {
    return rawAnswer === "true" || rawAnswer.toLowerCase() === "yes";
  }
  if (valueType === "number" || valueType === "integer") {
    const parsed = Number(rawAnswer);
    if (Number.isFinite(parsed)) {
      return valueType === "integer" ? Math.trunc(parsed) : parsed;
    }
  }
  return rawAnswer;
}

/** Convert Paseo's question permission response into an ACP `CreateElicitationResponse`. */
export function buildElicitationResponse(
  questions: readonly NormalizedElicitationQuestion[],
  response: ProviderPermissionResponse,
): CreateElicitationResponse {
  if (response.behavior === "deny") {
    return { action: "decline" };
  }
  const answers = asRecord(asRecord(response.updatedInput).answers);
  const content: Record<string, ElicitationContentValue> = {};

  for (const question of questions) {
    const raw = nonEmptyString(answers[question.header]);
    if (raw === undefined) continue;

    if (question.multiSelect) {
      const { selectedIds, custom } = splitMultiSelectAnswer(raw, question.options);
      if (selectedIds.length > 0) content[question.id] = selectedIds;
      if (custom !== undefined) {
        if (question.allowOther) {
          content[`${question.id}_other`] = custom;
        } else if (selectedIds.length === 0) {
          content[question.id] = [custom];
        }
      }
      continue;
    }

    if (question.options.length > 0) {
      const matched = question.options.find((option) => option.label === raw || option.id === raw);
      if (matched) {
        content[question.id] = coerceScalarAnswer(matched.id, question.valueType);
      } else if (question.allowOther) {
        content[`${question.id}_other`] = raw;
      } else {
        content[question.id] = coerceScalarAnswer(raw, question.valueType);
      }
      continue;
    }

    content[question.id] = coerceScalarAnswer(raw, question.valueType);
  }

  return { action: "accept", content };
}
