export function generateNeedlesslySecureRandomPassword(
  length: number | undefined = undefined,
): string {
  const charset =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+~";
  const bytes = new Uint8Array(length ? length : 16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => charset[b % charset.length])
    .join("");
}
