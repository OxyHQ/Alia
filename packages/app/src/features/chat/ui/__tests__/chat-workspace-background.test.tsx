import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host("View"),
    Platform: {
      OS: "web",
      select: (o: Record<string, unknown>) => o.web ?? o.default,
    },
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 48, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/shared/platform/keyboard", async () => {
  const ReactModule = await import("react");
  return {
    KeyboardAvoidingView: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement("KeyboardAvoidingView", props, children),
  };
});

vi.mock("@/features/chat/ui/ambient-field", async () => {
  const ReactModule = await import("react");
  return {
    AmbientField: (props: Record<string, unknown>) =>
      ReactModule.createElement("AmbientField", props),
  };
});

/**
 * The stub renders `background` first and `children` after it, which is the
 * order Bloom documents and draws. Getting that order wrong here would make
 * the test agree with a broken implementation.
 */
vi.mock("@oxy.so/bloom/ai-chat", async () => {
  const ReactModule = await import("react");
  return {
    AiChatContainer: ({
      background,
      children,
      composer,
      header,
      ...props
    }: Record<string, any>) =>
      ReactModule.createElement(
        "AiChatContainer",
        props,
        background,
        header,
        children,
        composer,
      ),
  };
});

import { ChatWorkspace } from "@/features/chat/ui/chat-workspace";

function render(over: Record<string, unknown> = {}) {
  let renderer: any;
  act(() => {
    renderer = create(
      React.createElement(ChatWorkspace, {
        title: "A chat",
        children: React.createElement("TheTurns"),
        composer: React.createElement("TheComposer"),
        ...over,
      } as any),
    );
  });
  return renderer;
}

describe("the template chat workspace", () => {
  it("keeps Bloom surface authority without an ambient background", () => {
    const container = render().root.findByType("AiChatContainer");
    expect(container.findAllByType("AmbientField")).toHaveLength(0);
  });

  it("still renders the turns and the composer around it", () => {
    const renderer = render();

    expect(renderer.root.findAllByType("TheTurns")).toHaveLength(1);
    expect(renderer.root.findAllByType("TheComposer")).toHaveLength(1);
  });

  it("leaves the project crumb off a chat that belongs to none", () => {
    // Bloom 3.3.0 made `project` optional for exactly this. Passing '' would
    // draw an empty crumb and a folder glyph for a project nobody named.
    const container = render().root.findByType("AiChatContainer");

    expect(container.props.project).toBeUndefined();
  });

  it("keeps the composer above the keyboard on a device", () => {
    // Bloom's ai-chat family imports no keyboard controller at all — verified
    // against 3.3.0 — so the host composes it back. Without this the thread
    // scrolls under the keyboard and the composer sits behind it on native.
    expect(render().root.findAllByType("KeyboardAvoidingView")).toHaveLength(1);
  });

  it("lifts the composer by the status bar the shell sits below", () => {
    // It measures itself against its parent, as if it began at the top of the
    // screen; the shell starts a status bar lower. Without the offset the
    // composer stopped that far behind the keyboard on the Android emulator
    // (docs/native-validation.mdx).
    const avoider = render().root.findByType("KeyboardAvoidingView");
    expect(avoider.props.keyboardVerticalOffset).toBe(48);
  });
});
