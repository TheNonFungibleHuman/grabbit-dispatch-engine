export function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? { statusCode: (error as { statusCode: number }).statusCode }
        : {}),
      ...(error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? { code: (error as { code: string }).code }
        : {}),
    };
  }

  return { message: String(error) };
}

export function logInfo(scope: string, message: string, data?: unknown): void {
  if (data === undefined) {
    console.info(`[${scope}] ${message}`);
    return;
  }
  console.info(`[${scope}] ${message}`, data);
}

export function logWarn(scope: string, message: string, data?: unknown): void {
  if (data === undefined) {
    console.warn(`[${scope}] ${message}`);
    return;
  }
  console.warn(`[${scope}] ${message}`, data);
}

export function logError(scope: string, message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`[${scope}] ${message}`);
    return;
  }
  console.error(`[${scope}] ${message}`, formatError(error));
}
