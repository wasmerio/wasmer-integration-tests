import { assertEquals } from "jsr:@std/assert/equals";
import { TestEnv } from "../../src/env.ts";
import { buildPhpApp, randomAppName } from "../../src/index.ts";
import { sleep } from "../../src/util.ts";

class DeveloperMailClient {
  private name: string;
  private token: string;

  static TOKEN_HEADER = "X-MailboxToken";

  constructor(name: string, token: string) {
    this.name = name;
    this.token = token;
  }

  static async createMailbox(): Promise<DeveloperMailClient> {
    interface CreateMailboxResponse {
      success: boolean;
      error?: string | null;
      result?: {
        name: string;
        token: string;
      };
    }

    const res = await fetch("https://www.developermail.com/api/v1/mailbox", {
      method: "PUT",
      headers: {
        "accept": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create mailbox: ${res.status}: ${body}`);
    }
    const data: CreateMailboxResponse = await res.json();
    if (!data.success) {
      throw new Error(`Failed to create mailbox: ${data.error}`);
    }
    if (!data.result) {
      throw new Error("Failed to create mailbox: no result");
    }
    return new DeveloperMailClient(data.result.name, data.result.token);
  }

  email(): string {
    return `${this.name}@developermail.com`;
  }

  async messageIds(): Promise<string[]> {
    const res = await fetch(
      `https://www.developermail.com/api/v1/mailbox/${this.name}`,
      {
        headers: {
          "accept": "application/json",
          [DeveloperMailClient.TOKEN_HEADER]: this.token,
        },
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get mailbox messages: ${res.status}: ${body}`);
    }
    const data = await res.json();
    if (!data.success) {
      throw new Error(`Failed to get mailbox messages: ${data.error}`);
    }
    if (!data.result || !Array.isArray(data.result)) {
      throw new Error("Failed to get mailbox messages: no result");
    }
    // deno-lint-ignore no-explicit-any
    if (!data.result.every((id: any) => typeof id === "string")) {
      throw new Error(
        "Failed to get mailbox messages: invalid result, expected an array of strings",
      );
    }
    return data.result;
  }

  async messages(ids: string[]): Promise<string[]> {
    const url =
      `https://www.developermail.com/api/v1/mailbox/${this.name}/messages`;
    console.debug({ url, ids });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        [DeveloperMailClient.TOKEN_HEADER]: this.token,
        "accept": "application/json",
        "content-type": "application/json",
        body: JSON.stringify(ids),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get mailbox messages: ${res.status}: ${body}`);
    }
    const data = await res.json();
    if (!data.success) {
      console.debug("Failed to retrieve mailbox messages", {
        ids,
        responseData: data,
      });
      throw new Error(`Failed to get mailbox messages: ${data.error}`);
    }
    if (!data.result || !Array.isArray(data.result)) {
      throw new Error("Failed to get mailbox messages: no result");
    }

    // deno-lint-ignore no-explicit-any
    return data.result.map((item: any) => item.value);
  }

  async waitForMessageIds(): Promise<string[]> {
    let messageIds: string[] | null = null;

    while (true) {
      console.debug("Checking for messages...");
      let ids: string[] = [];
      try {
        ids = await this.messageIds();
      } catch (error) {
        // deno-lint-ignore no-explicit-any
        const message = (error as any).toString?.() || "unknown error";
        console.warn("Failed to get mailbox message ids:", {
          message,
          error,
        });
        continue;
      }
      if (ids.length > 0) {
        messageIds = ids;
        break;
      }
      // No messages yet, wait a bit.
      await sleep(3_000);
    }
    return messageIds;
  }

  async waitForMessages(): Promise<string[]> {
    const messageIds = await this.waitForMessageIds();

    while (true) {
      console.debug("Loading messages", { messageIds });
      try {
        const messages = await this.messages(messageIds);
        return messages;
      } catch (error) {
        // deno-lint-ignore no-explicit-any
        const message = (error as any).toString?.() || "unknown error";
        console.warn("Failed to load mailbox messages:", { message, error });
      }
      await sleep(3_000);
    }
  }
}

// Test that the integrated email sending works.
Deno.test("php-email-sending", { ignore: true }, async () => {
  const env = TestEnv.fromEnv();
  console.log("Creating a new mailbox...");
  const mbox = await DeveloperMailClient.createMailbox();
  console.log("Created mailbox:", { email: mbox.email() });

  const subject = "SUBJECT-" + randomAppName();
  const body = "BODY-" + randomAppName();

  const code = `<?php

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$path = ltrim($_SERVER['SCRIPT_NAME'], '/');

error_log('handing path: "' . $path . '"');
if ($path !== 'send') {
  echo 'Use /send to send a mail';
  exit;
}

// Send the email.
$subject = "${subject}";
$body = "${body}";
echo "Sending email - subject: '$subject', body: '$body'\n";
mail("${mbox.email()}", "${subject}", "${body}");
echo "email_sent\n";
  `;

  const spec = buildPhpApp(code);
  spec.wasmerToml!["dependencies"] = {
    "php/php": "8.3.402",
  };
  spec.appYaml.enable_email = true;
  const info = await env.deployApp(spec);

  console.log("Sending request to app to trigger email sending...");
  const res = await env.fetchApp(info, "/send");
  const resBody = await res.text();
  assertEquals(resBody.trim(), "email_sent");

  console.log("App responded with ok - waiting for email to arrive...");

  const ids = await mbox.waitForMessageIds();
  if (ids.length === 0) {
    throw new Error("No messages found in mailbox");
  }
  // Note: commented out because apparently the mailbox api throws an error
  // when the source sender is undefined.
  const messages = await mbox.waitForMessages();

  console.debug("Received messages:", { messages });

  const first = messages[0];
  if (!first.includes(subject)) {
    throw new Error(
      `Email does not contain expected subject '${subject}': ${first}`,
    );
  }
  if (!first.includes(body)) {
    throw new Error(`Email does not contain expected body '${body}': ${first}`);
  }
});
