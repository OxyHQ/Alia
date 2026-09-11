import { describe, expect, it } from "vitest";
import { summarize } from "./production-chat-canary.js";

describe("production chat canary safe projection", () => {
  it("keeps only product-safe correlation fields", () => {
    const payload = `data: {"id":"chatcmpl-safe","provider":"must-not-leak","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`;
    expect(summarize("auto", 200, payload)).toEqual({
      label: "auto",
      reference: "chatcmpl-safe",
      code: null,
      retryable: null,
      synthetic: false,
      done: true,
      answerDelta: true,
      toolEvent: false,
      statusCode: 200,
    });
    expect(JSON.stringify(summarize("auto", 200, payload))).not.toContain(
      "must-not-leak",
    );
  });

  it("retains the classified safe failure", () => {
    const payload = `data: {"alia_meta":{"synthetic":true,"retryable":true,"error":{"code":"RATE_LIMITED","reference":"chatcmpl-ref"}},"choices":[{"delta":{"content":"busy"}}]}\n\ndata: [DONE]\n\n`;
    expect(summarize("recovery", 200, payload)).toMatchObject({
      reference: "chatcmpl-ref",
      code: "RATE_LIMITED",
      retryable: true,
      synthetic: true,
      done: true,
    });
  });
});
