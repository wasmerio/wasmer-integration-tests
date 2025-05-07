export async function validateWordpressIsLive(app_url: string) {
  if (app_url === "") {
    throw new Error("Expected app_url to be set");
  }

  // validate properly setup
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 2000;

  let body = "";
  let got: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      got = await fetch(app_url, { method: "GET" });
      body = await got.text();

      if (body.trim() !== "") {
        break;
      }
    } catch (err) {
      console.error(err);
    }
    if (attempt > 0) {
      console.warn("Trying to get response. Retry attempt: ", attempt);
    }
    const backoff = RETRY_DELAY_MS * Math.pow(1.5, attempt);
    const jitter = Math.random() * 300;
    await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
  }

  if (!got || !got.ok) {
    throw new Error(
      `Failed to fetch deployed WordPress app. Response not OK or missing. Body:
    ${body}`,
    );
  }

  expect(got.ok).toBe(true);
  expect(body).toContain("<html");
  expect(body).toContain("WordPress");
}
