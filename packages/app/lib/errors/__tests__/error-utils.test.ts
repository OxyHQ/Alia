import { describe, expect, it } from "vitest";

import { errorBodyText, errorMessage } from "../error-utils";

describe("errorBodyText", () => {
  it("reads the legacy string error body", () => {
    expect(errorBodyText({ error: "Invite expired" })).toBe("Invite expired");
  });

  it("reads the OpenAI-compatible object error body", () => {
    expect(
      errorBodyText({
        error: { message: "Show not found", type: "invalid_request_error" },
      }),
    ).toBe("Show not found");
  });

  it("falls through to the body message and then the caller fallback", () => {
    expect(errorBodyText({ error: { type: "server_error" }, message: "Try again" })).toBe(
      "Try again",
    );
    expect(errorBodyText({ error: { type: "server_error" } }, "Could not delete show")).toBe(
      "Could not delete show",
    );
  });
});

describe("errorMessage", () => {
  it("never returns an object from an HTTP error response", () => {
    const error = {
      response: {
        data: {
          error: { message: "Show not found", type: "invalid_request_error" },
        },
      },
    };

    expect(errorMessage(error)).toBe("Show not found");
    expect(typeof errorMessage(error)).toBe("string");
  });

  it("keeps the existing Error, string, and fallback behaviour", () => {
    expect(errorMessage(new Error("Network unavailable"))).toBe("Network unavailable");
    expect(errorMessage("Request cancelled")).toBe("Request cancelled");
    expect(errorMessage(null, "Please try again")).toBe("Please try again");
  });
});
