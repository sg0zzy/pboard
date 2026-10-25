// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareControls } from "../src/sidebar/components/ShareControls";
import type { Collaborator, DrivePermissionService, PboardRole } from "../src/sync/drivePermissions";

type Handles = {
  service: DrivePermissionService;
  invite: ReturnType<typeof vi.fn>;
  updateRole: ReturnType<typeof vi.fn>;
  removeCollaborator: ReturnType<typeof vi.fn>;
};

function makeService(overrides: Partial<DrivePermissionService> = {}): Handles {
  const collaborators: Collaborator[] = [
    { email: "owner@example.com", role: "owner", name: "Owner" },
    { email: "edit@example.com", role: "editor", name: "Editor" },
    { email: "view@example.com", role: "viewer" }
  ];
  const invite = vi.fn(async () => undefined);
  const updateRole = vi.fn(async () => undefined);
  const removeCollaborator = vi.fn(async () => undefined);
  const service: DrivePermissionService = {
    myRole: vi.fn(async (): Promise<PboardRole | null> => "owner"),
    listCollaborators: vi.fn(async () => collaborators),
    invite,
    updateRole,
    removeCollaborator,
    removeSelfFromProject: vi.fn(async () => undefined),
    wasReinvitedSince: vi.fn(async () => false),
    invalidateSharedDiscovery: vi.fn(),
    ensureSharedProject: vi.fn(async () => "f1"),
    readSharedSnapshot: vi.fn(async () => "{}"),
    writeSharedSnapshot: vi.fn(async () => undefined),
    readSharedImage: vi.fn(async () => null),
    writeSharedImage: vi.fn(async () => undefined),
    projectFileId: vi.fn(async () => "p1"),
    realtimeFolderId: vi.fn(async () => "r1"),
    discoverSharedProjects: vi.fn(async () => []),
    ...overrides
  };
  return { service, invite, updateRole, removeCollaborator };
}

// Set a controlled React input/select value the way React's tests require:
// bypass the value tracker via the native prototype setter, then dispatch the
// event React listens for. A plain `element.value = x` is swallowed by the
// tracker and never reaches onChange.
function setFieldValue(element: HTMLInputElement | HTMLSelectElement, value: string, event: string) {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event(event, { bubbles: true }));
}

// Microtask-flush until a condition holds. The component's load/run await the
// mock service and then update state, which React renders on a following
// microtask, so a fixed number of flushes is racy. Polling (no timers, so the
// ts-no-test-timers rule is not implicated) settles deterministically.
async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await act(async () => undefined);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("ShareControls", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(service: DrivePermissionService) {
    act(() => root.render(<ShareControls projectId="p1" permissions={service} />));
  }

  async function openDialog(service: DrivePermissionService) {
    render(service);
    act(() => container.querySelector<HTMLButtonElement>(".share-button")!.click());
    await until(() => container.querySelector('[role="dialog"]') !== null, "dialog to open");
  }

  it("renders a share button and opens a dialog with the invite form and collaborators", async () => {
    await openDialog(makeService().service);
    await until(() => container.querySelector(".share-collaborator") !== null, "collaborators to load");

    expect(container.querySelector('[role="dialog"][aria-label="Share project"]')).toBeTruthy();
    expect(container.querySelector('.share-invite input[type="email"]')).toBeTruthy();
    expect(container.querySelector(".share-invite select")).toBeTruthy();
    expect(container.querySelector('.share-invite button[type="submit"]')).toBeTruthy();

    const rows = [...container.querySelectorAll<HTMLElement>(".share-collaborator")];
    expect(rows.map((row) => row.querySelector(".share-collaborator-name")!.textContent)).toEqual(["Owner", "Editor", "view@example.com"]);
    // Owner is shown as a label, not a role selector, and has no Remove button.
    expect(rows[0].querySelector(".share-collaborator-role")!.textContent).toBe("Owner");
    expect(rows[0].querySelector(".share-remove-button")).toBeNull();
    expect(rows[0].querySelector(".share-role-select")).toBeNull();
    // Non-owner collaborators have a role selector and a Remove button.
    expect(rows[1].querySelector(".share-role-select")).toBeTruthy();
    expect(rows[2].querySelector(".share-remove-button")).toBeTruthy();
  });

  it("preserves email text and focus while live status updates", async () => {
    const service = makeService().service;
    await openDialog(service);
    await until(() => container.querySelector(".share-invite input") !== null);
    const input = container.querySelector<HTMLInputElement>(".share-invite input")!;
    input.focus();
    act(() => setFieldValue(input, "partial.email@", "input"));
    act(() => root.render(<ShareControls projectId="p1" permissions={service} liveStatus="Waiting for another browser" />));
    expect(container.querySelector(".share-invite input")).toBe(input);
    expect(input.value).toBe("partial.email@");
    expect(document.activeElement).toBe(input);
  });

  it("invites a collaborator with the selected role and clears the email", async () => {
    const { service, invite } = makeService();
    await openDialog(service);
    await until(() => container.querySelector('.share-invite input[type="email"]') !== null, "invite form");

    const email = container.querySelector<HTMLInputElement>('.share-invite input[type="email"]')!;
    const role = container.querySelector<HTMLSelectElement>(".share-invite select")!;
    act(() => setFieldValue(email, "new@example.com", "input"));
    act(() => setFieldValue(role, "viewer", "change"));
    act(() => container.querySelector<HTMLButtonElement>('.share-invite button[type="submit"]')!.click());
    await until(() => invite.mock.calls.length > 0, "invite call");

    expect(invite).toHaveBeenCalledWith("p1", "new@example.com", "viewer");
    await until(() => email.value === "", "email to clear");
  });

  it("changes a collaborator's role via the row selector", async () => {
    const { service, updateRole } = makeService();
    await openDialog(service);
    await until(() => container.querySelectorAll(".share-collaborator").length > 0, "collaborators");

    const row = container.querySelectorAll<HTMLElement>(".share-collaborator")[1];
    const select = row.querySelector<HTMLSelectElement>(".share-role-select")!;
    act(() => setFieldValue(select, "viewer", "change"));
    await until(() => updateRole.mock.calls.length > 0, "updateRole call");

    expect(updateRole).toHaveBeenCalledWith("p1", "edit@example.com", "viewer");
  });

  it("removes a non-owner collaborator", async () => {
    const { service, removeCollaborator } = makeService();
    await openDialog(service);
    await until(() => container.querySelectorAll(".share-collaborator").length > 0, "collaborators");

    const row = container.querySelectorAll<HTMLElement>(".share-collaborator")[1];
    act(() => row.querySelector<HTMLButtonElement>(".share-remove-button")!.click());
    await until(() => removeCollaborator.mock.calls.length > 0, "removeCollaborator call");

    expect(removeCollaborator).toHaveBeenCalledWith("p1", "edit@example.com");
  });

  it("shows collaborators read-only for a viewer (no invite form, controls disabled)", async () => {
    const { service } = makeService({ myRole: vi.fn(async (): Promise<PboardRole | null> => "viewer") });
    await openDialog(service);
    await until(() => container.querySelectorAll(".share-collaborator").length > 0, "collaborators");

    expect(container.querySelector(".share-invite")).toBeNull();
    expect(container.querySelector(".share-note")).toBeTruthy();
    expect(container.querySelector(".share-remove-button")).toBeNull();
    const roleSelects = [...container.querySelectorAll<HTMLSelectElement>(".share-role-select")];
    expect(roleSelects.length).toBeGreaterThan(0);
    for (const select of roleSelects) expect(select.disabled).toBe(true);
  });

  it("shows an error when the invite fails", async () => {
    const failingInvite = vi.fn(async () => { throw new Error("Invitation rejected"); });
    const { service } = makeService({ invite: failingInvite as DrivePermissionService["invite"] });
    await openDialog(service);
    await until(() => container.querySelector('.share-invite input[type="email"]') !== null, "invite form");

    const email = container.querySelector<HTMLInputElement>('.share-invite input[type="email"]')!;
    act(() => setFieldValue(email, "bad@example.com", "input"));
    act(() => container.querySelector<HTMLButtonElement>('.share-invite button[type="submit"]')!.click());
    await until(() => failingInvite.mock.calls.length > 0, "failing invite call");
    await until(() => container.querySelector(".share-error") !== null, "error to appear");

    expect(failingInvite).toHaveBeenCalledWith("p1", "bad@example.com", "editor");
    expect(container.querySelector(".share-error")?.textContent).toBe("Invitation rejected");
  });

  it("allows the first invitation on a private project without calling its owner a viewer", async () => {
    const { service, invite } = makeService({
      myRole: vi.fn(async () => null),
      projectFileId: vi.fn(async () => null),
      listCollaborators: vi.fn(async () => [])
    });
    await openDialog(service);
    await until(() => container.querySelector('.share-invite input') !== null, "private project invitation");
    expect(container.textContent).not.toContain("You are a viewer");
    act(() => setFieldValue(container.querySelector<HTMLInputElement>('.share-invite input')!, "friend@example.com", "input"));
    act(() => container.querySelector<HTMLButtonElement>('.share-invite button')!.click());
    await until(() => invite.mock.calls.length > 0, "first invitation");
    expect(invite).toHaveBeenCalledWith("p1", "friend@example.com", "editor");
  });

  it("enables live collaboration on a private project without inviting another account", async () => {
    let shared = false;
    const onAccessChanged = vi.fn();
    const { service } = makeService({
      myRole: vi.fn(async () => shared ? "owner" : null),
      projectFileId: vi.fn(async () => shared ? "shared-file" : null),
      listCollaborators: vi.fn(async () => []),
      ensureSharedProject: vi.fn(async () => { shared = true; return "shared-folder"; })
    });
    act(() => root.render(<ShareControls projectId="p1" permissions={service} onAccessChanged={onAccessChanged} liveStatus="Live collaboration: waiting for another browser." />));
    act(() => container.querySelector<HTMLButtonElement>(".share-button")!.click());
    const enableButton = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Enable live collaboration");
    await until(() => enableButton() !== undefined, "enable live collaboration");
    act(() => enableButton()!.click());
    await until(() => onAccessChanged.mock.calls.length > 0, "restart collaboration");
    expect(service.ensureSharedProject).toHaveBeenCalledWith("p1");
    expect(enableButton()).toBeUndefined();
    expect(container.textContent).toContain("Live collaboration: waiting for another browser.");
  });

  it("does not classify unresolved shared access as viewer or permit invitations", async () => {
    await openDialog(makeService({ myRole: vi.fn(async () => null) }).service);
    await until(() => container.textContent?.includes("could not be verified") === true, "unresolved access");
    expect(container.textContent).not.toContain("You are a viewer");
    expect(container.querySelector(".share-invite")).toBeNull();
  });

  it("shows lookup failures instead of a viewer role", async () => {
    await openDialog(makeService({ myRole: vi.fn(async () => { throw new Error("Reconnect Google Drive"); }) }).service);
    await until(() => container.querySelector('[role="alert"]') !== null, "lookup error");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Reconnect Google Drive");
    expect(container.textContent).not.toContain("You are a viewer");
    expect(container.querySelector(".share-invite")).toBeNull();
  });

  it("does not show a viewer role while access is loading", async () => {
    await openDialog(makeService({ myRole: vi.fn(() => new Promise<PboardRole | null>(() => {})) }).service);
    expect(container.textContent).toContain("Checking project access");
    expect(container.textContent).not.toContain("You are a viewer");
  });

  it("closes the dialog on Escape", async () => {
    await openDialog(makeService().service);

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await until(() => container.querySelector('[role="dialog"]') === null, "dialog to close");
  });

  it("renders nothing when there is no project", async () => {
    render(makeService().service);
    act(() => root.render(<ShareControls projectId={null} permissions={makeService().service} />));
    expect(container.querySelector(".share-button")).toBeNull();
  });
});
