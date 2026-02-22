import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature(payload: string, secret: string, signatureHeader?: string): boolean {
  if (!signatureHeader) {
    return false;
  }

  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  const expected = `sha256=${digest}`;

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}
