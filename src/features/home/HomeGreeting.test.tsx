// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HomeGreeting } from "./HomeGreeting";

describe("HomeGreeting", () => {
  it("greets by time of day in our own words, never a name", () => {
    const { rerender } = render(<HomeGreeting hour={8} />);
    expect(screen.getByText(/good morning/i)).toBeDefined();
    rerender(<HomeGreeting hour={14} />);
    expect(screen.getByText(/good afternoon/i)).toBeDefined();
    rerender(<HomeGreeting hour={21} />);
    expect(screen.getByText(/good evening/i)).toBeDefined();
  });
});
