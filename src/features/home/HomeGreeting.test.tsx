// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HomeGreeting } from "./HomeGreeting";

describe("HomeGreeting", () => {
  beforeEach(() => {
    cleanup();
  });
  it("greets by time of day in our own words, never a name", () => {
    const { rerender } = render(<HomeGreeting hour={8} />);
    expect(screen.getByText(/good morning/i)).toBeDefined();
    rerender(<HomeGreeting hour={14} />);
    expect(screen.getByText(/good afternoon/i)).toBeDefined();
    rerender(<HomeGreeting hour={21} />);
    expect(screen.getByText(/good evening/i)).toBeDefined();
  });

  it("appends the settings display name like the reference greeting", () => {
    render(<HomeGreeting hour={21} name="Abu" />);
    expect(screen.getByText("Good evening, Abu")).toBeDefined();
  });

  it("falls back to Abu when no name is set", () => {
    render(<HomeGreeting hour={8} />);
    expect(screen.getByText("Good morning, Abu")).toBeDefined();
  });
});
