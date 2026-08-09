export type InteractionStepLike = {
  type?: string;
  name?: string;
  id?: string;
  call_id?: string;
  arguments?: unknown;
  content?: Array<{ type?: string; text?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
};

export type InteractionLike = {
  id?: string;
  status?: string;
  output_text?: string;
  errors?: unknown[];
  outputs?: InteractionStepLike[];
  steps?: InteractionStepLike[];
};

export type AgentFunctionCall = {
  name: string;
  id?: string;
  arguments?: unknown;
};

/** Prefer steps (May 2026 schema); fall back to legacy outputs. */
export function getInteractionSteps(
  interaction: InteractionLike,
): InteractionStepLike[] {
  if (Array.isArray(interaction.steps) && interaction.steps.length > 0) {
    return interaction.steps;
  }
  if (Array.isArray(interaction.outputs) && interaction.outputs.length > 0) {
    return interaction.outputs;
  }
  return [];
}

export function getFunctionCalls(
  interaction: InteractionLike,
): AgentFunctionCall[] {
  const calls: AgentFunctionCall[] = [];

  for (const step of getInteractionSteps(interaction)) {
    if (step.type === "function_call" && step.name) {
      calls.push({
        name: step.name,
        id: step.id,
        arguments: step.arguments,
      });
    }
  }

  return calls;
}

export function extractInteractionText(interaction: InteractionLike): string {
  const direct = interaction.output_text?.trim();
  if (direct) return direct;

  const parts: string[] = [];
  for (const step of getInteractionSteps(interaction)) {
    if (step.type === "model_output" && Array.isArray(step.content)) {
      for (const item of step.content) {
        if (item.type === "text" && item.text?.trim()) {
          parts.push(item.text.trim());
        }
      }
    }
  }

  return parts.join("\n").trim();
}

export function summarizeInteraction(interaction: InteractionLike) {
  const steps = getInteractionSteps(interaction);
  return {
    id: interaction.id,
    status: interaction.status ?? null,
    outputTextLength: interaction.output_text?.length ?? 0,
    outputTextPreview: (interaction.output_text ?? "").slice(0, 160),
    extractedTextPreview: extractInteractionText(interaction).slice(0, 160),
    stepTypes: steps.map((step) => step.type),
    functionCalls: getFunctionCalls(interaction).map((call) => call.name),
    errorCount: Array.isArray(interaction.errors) ? interaction.errors.length : 0,
    errorsPreview: Array.isArray(interaction.errors)
      ? JSON.stringify(interaction.errors).slice(0, 400)
      : null,
  };
}

export function buildFunctionResultInput(args: {
  name: string;
  callId: string;
  result: Record<string, unknown>;
  isError?: boolean;
}) {
  return {
    type: "function_result" as const,
    name: args.name,
    call_id: args.callId,
    is_error: args.isError ?? false,
    result: [
      {
        type: "text" as const,
        text: JSON.stringify(args.result),
      },
    ],
  };
}
