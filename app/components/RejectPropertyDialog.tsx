"use client";

import { useEffect, useRef } from "react";
import { ACTION_REJECT_CLASS } from "../../lib/action-styles";
import { MAX_REJECTION_NOTE_LENGTH, sanitizeRejectionNote } from "../../lib/rejection";
import type { HouseRecord } from "../../lib/types";

const QUICK_REJECTION_REASONS = [
  "Bedrooms too small",
  "Outside of boundary",
  "Poor walkability",
  "Not enough rental income",
] as const;

/**
 * Accessible confirmation dialog for rejecting a house from the map quick
 * view: a modal (focus-trapped, Escape-cancelable) that collects an
 * optional rejection reason and hands it to the SAME funnel-move rejection
 * workflow the list view uses — no parallel persistence path. Focus lands
 * in the reason field on open and returns to wherever it was on close.
 */
export function RejectPropertyDialog({
  house,
  onConfirm,
  onCancel,
}: {
  house: HouseRecord;
  /** Called with the sanitized reason (null = none recorded). */
  onConfirm: (note: string | null) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      // The originating quick view may already be gone; focusing a
      // detached element is a harmless no-op.
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    // Minimal focus trap: Tab cycles within the dialog's focusables.
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="editor-overlay" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        className="reject-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reject-dialog-title"
        aria-describedby="reject-dialog-description"
      >
        <h2 id="reject-dialog-title" className="reject-dialog-title">
          Reject this property?
        </h2>
        <p id="reject-dialog-description" className="reject-dialog-description">
          <strong>{house.address}</strong> leaves My Search immediately and lives on in the Rejected tab{" "}
          {"\u2014"} nothing is deleted, its ranking is remembered, and a later reconsideration brings it back.
        </p>
        <div className="reject-quick-reasons" role="group" aria-label="Reject immediately with a common reason">
          <p className="reject-quick-hint">One click saves the reason and rejects.</p>
          {QUICK_REJECTION_REASONS.map((reason) => (
            <button key={reason} type="button" className="btn-secondary reject-reason-button"
              onClick={() => {
                if (inputRef.current) inputRef.current.value = reason;
                onConfirm(sanitizeRejectionNote(reason));
              }}>
              {reason}
            </button>
          ))}
        </div>
        <form
          className="reject-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(sanitizeRejectionNote(inputRef.current?.value ?? ""));
          }}
        >
          <label className="funnel-reject-note-label">
            Or write your own reason (optional)
            <input
              ref={inputRef}
              type="text"
              maxLength={MAX_REJECTION_NOTE_LENGTH}
              placeholder="e.g. Too close to the highway"
            />
          </label>
          <div className="funnel-reject-actions">
            <button type="submit" className={`btn-secondary ${ACTION_REJECT_CLASS}`}>
              Reject property
            </button>
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
