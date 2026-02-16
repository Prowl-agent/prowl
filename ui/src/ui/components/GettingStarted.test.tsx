/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GettingStarted from "./GettingStarted.tsx";

const fetchMock = vi.fn<typeof fetch>();

function makeJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GettingStarted", () => {
  it("renders when totalInferences is 0", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ totalInferences: 0 }));

    render(<GettingStarted />);
    await flushEffects();

    expect(screen.getByTestId("getting-started")).toBeTruthy();
    expect(screen.getByText("Getting Started")).toBeTruthy();
  });

  it("renders example cards", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ totalInferences: 2 }));

    render(<GettingStarted />);
    await flushEffects();

    expect(screen.getByTestId("getting-started-example-0")).toBeTruthy();
    expect(screen.getByTestId("getting-started-example-1")).toBeTruthy();
    expect(screen.getByTestId("getting-started-example-2")).toBeTruthy();
    expect(screen.getByTestId("getting-started-example-3")).toBeTruthy();
  });

  it("hides when totalInferences >= 5", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ totalInferences: 5 }));

    render(<GettingStarted />);
    await flushEffects();

    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("hides when dismissed", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ totalInferences: 1 }));

    render(<GettingStarted />);
    await flushEffects();

    expect(screen.getByTestId("getting-started")).toBeTruthy();

    fireEvent.click(screen.getByTestId("getting-started-dismiss"));

    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("does not render before fetch completes", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));

    render(<GettingStarted />);

    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("shows 'Copied to clipboard!' when example is clicked", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ totalInferences: 0 }));

    const clipboardMock = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, "clipboard", {
      value: clipboardMock,
      writable: true,
      configurable: true,
    });

    render(<GettingStarted />);
    await flushEffects();

    fireEvent.click(screen.getByTestId("getting-started-example-0"));

    expect(screen.getByText("Copied to clipboard!")).toBeTruthy();
    expect(clipboardMock.writeText).toHaveBeenCalledOnce();
  });

  it("renders null gracefully on fetch error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    render(<GettingStarted />);
    await flushEffects();

    // Falls back to 0, so card should show
    expect(screen.getByTestId("getting-started")).toBeTruthy();
  });
});
