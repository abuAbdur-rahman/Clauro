// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";
import { Textarea } from "./textarea";
import { Progress } from "./progress";

/**
 * Kit smoke coverage for the components production actually renders.
 *
 * The Task 026 / D112 chat batch (Message, Bubble, Avatar, Attachment,
 * Alert, Badge, Spinner, Marker, Empty, ScrollArea) was vendored but never
 * wired — ZERO production callers, smoke tests only (review 32). Per D130
 * those files are deleted rather than wired: untested-by-use code that
 * duplicates the hand-rolled transcript/composer is the AGENTS §7a trap.
 * What remains here covers exactly what ships.
 */

beforeEach(() => {
  cleanup();
});

describe("kit primitives in production", () => {
  it("card renders its slots", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Memory</CardTitle>
          <CardDescription>Topics</CardDescription>
        </CardHeader>
        <CardContent>12 topics</CardContent>
      </Card>,
    );
    expect(screen.getByText("Memory")).not.toBeNull();
    expect(screen.getByText("12 topics")).not.toBeNull();
  });

  it("textarea and progress render", () => {
    render(
      <div>
        <Textarea aria-label="Message" placeholder="Write a message…" />
        <Progress value={40} />
      </div>,
    );
    expect(screen.getByLabelText("Message")).not.toBeNull();
    expect(screen.getByRole("progressbar")).not.toBeNull();
  });
});
