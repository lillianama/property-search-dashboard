import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source-contract assertions for the map quick-view Reject flow. The pure
// pieces (note sanitizing, optimistic rejection state, request validation)
// are covered in rejection.test.ts and funnel.test.ts; these guard the
// wiring rules that must not regress:
//  - the map Reject goes through the SAME funnel-move rejection workflow
//    as the list view (no parallel persistence path), and
//  - the confirmation dialog is a real accessible modal.

const appFile = (...parts: string[]) => readFileSync(join(__dirname, "..", "app", ...parts), "utf8");

describe("map quick-view reject flow", () => {
  it("quick views expose a Reject action with an accessible per-house name", () => {
    const map = appFile("components", "PropertyMap.tsx");
    expect(map).toContain("onReject");
    expect(map).toContain("`Reject ${house.address}`");
  });

  it("the dashboard routes map rejections through the existing requestMove('reject') workflow", () => {
    const dashboard = appFile("components", "Dashboard.tsx");
    expect(dashboard).toContain("<RejectPropertyDialog");
    expect(dashboard).toContain('requestMove(mapRejectTarget, "reject", { note })');
    // No parallel persistence path: exactly one fetch call to the shared
    // funnel-move endpoint in the whole component.
    expect(dashboard.match(/fetch\(trackUrl\("\/api\/funnel\/move"/g)).toHaveLength(1);
  });

  it("the confirmation dialog is a modal alertdialog with a reason input, Escape cancel, and focus handling", () => {
    const dialog = appFile("components", "RejectPropertyDialog.tsx");
    expect(dialog).toContain('role="alertdialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("MAX_REJECTION_NOTE_LENGTH");
    expect(dialog).toContain("sanitizeRejectionNote");
    expect(dialog).toContain('event.key === "Escape"');
    expect(dialog).toContain("inputRef.current?.focus({ preventScroll: true })");
    // It renders no fetch of its own — persistence stays with the parent's
    // shared workflow.
    expect(dialog).not.toContain("fetch(");
  });

  it("removes the rejected house reactively (optimistic rejectedIds), not via a page reload", () => {
    const dashboard = appFile("components", "Dashboard.tsx");
    expect(dashboard).toContain("rejectedIds: [...prev.rejectedIds, house.id]");
    expect(dashboard).not.toContain("location.reload");
  });
});
