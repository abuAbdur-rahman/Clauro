// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FileTextIcon } from "lucide-react";
import { Message, MessageContent, MessageFooter, MessageHeader } from "./message";
import { Bubble, BubbleContent } from "./bubble";
import { Avatar, AvatarFallback } from "./avatar";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "./attachment";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Badge } from "./badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";
import { Textarea } from "./textarea";
import { Spinner } from "./spinner";
import { Marker, MarkerContent, MarkerIcon } from "./marker";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./empty";
import { Progress } from "./progress";

/**
 * Chat batch smoke coverage (Task 026, D112). Presentational primitives only:
 * each renders its documented slots. Behaviour (scroller follow-output,
 * streaming) belongs to 006 with the transcript loop.
 */

beforeEach(() => {
  cleanup();
});

describe("chat primitives", () => {
  it("message composes header, bubble, and footer actions", () => {
    render(
      <Message align="end">
        <MessageHeader>You</MessageHeader>
        <MessageContent>
          <Bubble align="end">
            <BubbleContent>Refactor the tokenizer</BubbleContent>
          </Bubble>
        </MessageContent>
        <MessageFooter>
          <button type="button" aria-label="Copy">
            copy
          </button>
        </MessageFooter>
      </Message>,
    );
    expect(screen.getByText("Refactor the tokenizer")).not.toBeNull();
    expect(screen.getByText("You")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).not.toBeNull();
  });

  it("ghost bubble carries unframed assistant text", () => {
    render(
      <Message>
        <MessageContent>
          <Bubble variant="ghost">
            <BubbleContent>I will start by reading the lexer.</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>,
    );
    expect(screen.getByText(/reading the lexer/)).not.toBeNull();
  });

  it("avatar falls back to initials with no image", () => {
    render(
      <Avatar>
        <AvatarFallback>CL</AvatarFallback>
      </Avatar>,
    );
    expect(screen.getByText("CL")).not.toBeNull();
  });

  it("attachment shows title, description, and error state", () => {
    render(
      <Attachment state="error">
        <AttachmentMedia>
          <FileTextIcon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>notes.pdf</AttachmentTitle>
          <AttachmentDescription>Upload failed. Try again.</AttachmentDescription>
        </AttachmentContent>
      </Attachment>,
    );
    expect(screen.getByText("notes.pdf")).not.toBeNull();
    expect(screen.getByText(/upload failed/i)).not.toBeNull();
  });

  it("alert, badge, and card render their slots", () => {
    render(
      <div>
        <Alert variant="destructive">
          <AlertTitle>Rate limited</AlertTitle>
          <AlertDescription>Retry after 60 seconds.</AlertDescription>
        </Alert>
        <Badge>thinking</Badge>
        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
            <CardDescription>Topics</CardDescription>
          </CardHeader>
          <CardContent>12 topics</CardContent>
        </Card>
      </div>,
    );
    expect(screen.getByRole("alert")).not.toBeNull();
    expect(screen.getByText("thinking")).not.toBeNull();
    expect(screen.getByText("Memory")).not.toBeNull();
  });

  it("textarea, spinner, marker, empty, and progress render", () => {
    render(
      <div>
        <Textarea aria-label="Message" placeholder="Write a message…" />
        <Spinner />
        <Marker>
          <MarkerIcon>
            <Spinner />
          </MarkerIcon>
          <MarkerContent>Compiling…</MarkerContent>
        </Marker>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">+</EmptyMedia>
            <EmptyTitle>No threads</EmptyTitle>
            <EmptyDescription>Start a conversation.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <Progress value={40} />
      </div>,
    );
    expect(screen.getByLabelText("Message")).not.toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getByText("Compiling…")).not.toBeNull();
    expect(screen.getByText("No threads")).not.toBeNull();
    expect(screen.getByRole("progressbar")).not.toBeNull();
  });
});
