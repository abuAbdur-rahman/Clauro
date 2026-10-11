// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectDetail } from "./ProjectDetail";

const base = {
  project: { id: "p1", name: "Alpha" },
  instructions: "Be terse",
  memoryCount: 3,
  contextUsed: "12%",
  onBack: () => {},
};

afterEach(() => {
  cleanup();
});

describe("ProjectDetail", () => {
  it("shows breadcrumb, instructions/memory/context panels", () => {
    render(<ProjectDetail {...base} onBack={() => {}} />);
    expect(screen.getByTestId<HTMLInputElement>("project-title").value).toBe("Alpha");
    expect(screen.getByText(/instructions/i)).toBeDefined();
    expect(screen.getByText(/memory/i)).toBeDefined();
    expect(screen.getByText(/context/i)).toBeDefined();
    expect(screen.getByText("12%")).toBeDefined();
  });

  it("back button fires onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<ProjectDetail {...base} onBack={onBack} />);
    await user.click(screen.getByTestId("project-back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("title edit commits on blur via onRename", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<ProjectDetail {...base} onRename={onRename} />);
    const title = screen.getByTestId<HTMLInputElement>("project-title");
    expect(title.value).toBe("Alpha");
    await user.clear(title);
    await user.type(title, "Beta");
    await user.tab();
    expect(onRename).toHaveBeenCalledWith("Beta");
  });

  it("instructions Save is disabled when pristine, fires when dirty", async () => {
    const user = userEvent.setup();
    const onSaveInstructions = vi.fn();
    render(<ProjectDetail {...base} onSaveInstructions={onSaveInstructions} />);
    const save = screen.getByTestId<HTMLButtonElement>("project-instructions-save");
    expect(save.disabled).toBe(true);
    await user.type(screen.getByTestId("project-instructions"), "!");
    expect(save.disabled).toBe(false);
    await user.click(save);
    expect(onSaveInstructions).toHaveBeenCalledWith("Be terse!");
  });

  it("composer starts a chat and lists project chats", async () => {
    const user = userEvent.setup();
    const onStartChat = vi.fn();
    const onOpenChat = vi.fn();
    render(
      <ProjectDetail
        {...base}
        chats={[{ id: "c1", title: "First chat" }]}
        onOpenChat={onOpenChat}
        onStartChat={onStartChat}
      />,
    );
    expect(screen.getByTestId("project-chat-c1")).toBeDefined();
    const send = screen.getByTestId<HTMLButtonElement>("project-composer-send");
    expect(send.disabled).toBe(true);
    await user.type(screen.getByTestId("project-composer"), "Hello project");
    await user.click(send);
    expect(onStartChat).toHaveBeenCalledWith("Hello project");
    await user.click(screen.getByTestId("project-chat-c1"));
    expect(onOpenChat).toHaveBeenCalledWith("c1");
  });

  it("shows empty chats state", () => {
    render(<ProjectDetail {...base} chats={[]} />);
    expect(screen.getByTestId("project-chats-empty").textContent).toBe("No chats yet.");
  });

  it("capacity derives from real file sizes, delete fires", async () => {
    const user = userEvent.setup();
    const onDeleteFile = vi.fn();
    render(
      <ProjectDetail
        {...base}
        files={[
          { name: "a.pdf", sizeBytes: 1024 },
          { name: "b.pdf", sizeBytes: 3072 },
        ]}
        capacityBytes={8192}
        onDeleteFile={onDeleteFile}
      />,
    );
    expect(screen.getByTestId("project-capacity-label").textContent).toBe(
      "50% of project knowledge used",
    );
    expect(screen.getByText("1.0 KB")).toBeDefined();
    expect(screen.getByText("3.0 KB")).toBeDefined();
    await user.click(screen.getByTestId("project-file-delete-0"));
    expect(onDeleteFile).toHaveBeenCalledWith(0);
  });

  it("back is an icon-only chevron button (no text glyph)", () => {
    render(<ProjectDetail {...base} onBack={() => {}} />);
    const back = screen.getByTestId("project-back");
    expect(back.getAttribute("aria-label")).toBe("Back to projects");
    expect(back.textContent.trim()).toBe("");
    expect(back.querySelector("svg")).not.toBeNull();
  });

  it("composer send is an icon button with an accessible label", async () => {
    const user = userEvent.setup();
    render(<ProjectDetail {...base} onStartChat={() => {}} />);
    const send = screen.getByTestId("project-composer-send");
    expect(send.querySelector("svg")).not.toBeNull();
    expect(send.getAttribute("aria-label")).toBe("Start chat");
    await user.type(screen.getByTestId("project-composer"), "Hello");
    expect(send.textContent.trim()).toBe("");
  });

  it("file delete is an icon button (no unicode glyph)", () => {
    render(
      <ProjectDetail
        {...base}
        files={[{ name: "a.pdf", sizeBytes: 1024 }]}
        capacityBytes={2048}
      />,
    );
    const del = screen.getByTestId("project-file-delete-0");
    expect(del.querySelector("svg")).not.toBeNull();
    expect(del.textContent.trim()).toBe("");
  });

  it("labels sample capacity honestly when none is supplied", () => {
    render(<ProjectDetail {...base} files={[]} />);
    expect(screen.getByTestId("project-capacity-label").textContent).toContain("(sample capacity)");
  });
});
