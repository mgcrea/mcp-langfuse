export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

/**
 * Langfuse's public API takes HTTP Basic auth with the public key as the user
 * and the secret key as the password. There is nothing to refresh: a 401 is
 * final, so the client never retries one.
 */
export const basicAuthHeader = (publicKey: string, secretKey: string): string =>
  `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;

/** Show enough of the public key to tell two projects apart, and nothing of the secret. */
export const maskKey = (key: string | undefined): string | undefined =>
  key === undefined ? undefined : `${key.slice(0, 10)}…`;
