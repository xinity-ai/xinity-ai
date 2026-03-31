/**
 * Error handling utilities for oRPC calls.
 * Provides user-friendly error messages for permission and other errors.
 */
import { toastState } from "$lib/state/toast.svelte";

interface ORPCError {
  code?: string;
  message?: string;
  data?: {
    code?: string;
    message?: string;
  };
}

/**
 * Standard error messages for common error codes
 */
const errorMessages: Record<string, string> = {
  FORBIDDEN: "You don't have permission to perform this action.",
  UNAUTHORIZED: "You need to be logged in to perform this action.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "This action conflicts with existing data.",
  BAD_REQUEST: "Invalid request. Please check your input.",
};

/**
 * Extract error code from oRPC error response
 */
function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  const err = error as ORPCError;

  // Check direct code
  if (err.code) return err.code;

  // Check nested data code
  if (err.data?.code) return err.data.code;

  // Check message for code pattern
  if (err.message?.includes("FORBIDDEN")) return "FORBIDDEN";
  if (err.message?.includes("UNAUTHORIZED")) return "UNAUTHORIZED";

  return undefined;
}

/**
 * Get user-friendly error message
 */
function getErrorMessage(error: unknown): string {
  const code = getErrorCode(error);

  if (code && errorMessages[code]) {
    return errorMessages[code];
  }

  // Try to extract custom message
  if (error && typeof error === "object") {
    const err = error as ORPCError;
    if (err.data?.message) return err.data.message;
    if (err.message && !err.message.includes("Error:")) return err.message;
  }

  return "An unexpected error occurred. Please try again.";
}

/**
 * Handle oRPC error by showing a toast notification
 */
export function handleError(error: unknown, customMessage?: string): void {
  const message = customMessage || getErrorMessage(error);
  const code = getErrorCode(error);

  // Use different toast types based on error code
  if (code === "FORBIDDEN" || code === "UNAUTHORIZED") {
    toastState.add(message, "warning");
  } else {
    toastState.add(message, "error");
  }
}

/**
 * Wrap an async operation with error handling
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  options?: {
    onError?: (error: unknown) => void;
    errorMessage?: string;
    showToast?: boolean;
  }
): Promise<T | undefined> {
  const { onError, errorMessage, showToast = true } = options || {};

  try {
    return await operation();
  } catch (error) {
    if (showToast) {
      handleError(error, errorMessage);
    }
    onError?.(error);
    return undefined;
  }
}

/**
 * Check if an error is a permission error
 */
export function isPermissionError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "FORBIDDEN" || code === "UNAUTHORIZED";
}
