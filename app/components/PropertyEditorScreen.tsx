"use client";

import { useTrack } from "./TrackContext";
import { trackUrl } from "../../lib/track";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EDITOR_FIELDS,
  JUDGMENT_FIELDS,
  MAX_FIELD_LENGTH,
  type EditorField,
  type EditorNotes,
  type JudgmentField,
} from "../../lib/editor";
import { formatDate } from "../../lib/format";
import type { TriStateJudgment } from "../../lib/types";

const FIELD_LABELS: Record<EditorField, string> = {
  remarks: "Remarks",
  pros: "Pros",
  cons: "Cons",
};

const FIELD_HINTS: Record<EditorField, string> = {
  remarks: "Free-form notes: impressions, questions, things to verify on a tour.",
  pros: "One pro per line \u2014 they render as a list on save.",
  cons: "One con per line \u2014 they render as a list on save.",
};

const JUDGMENT_LABELS: Record<JudgmentField, string> = {
  bedroomSizeOk: "Bedroom size acceptable",
  rentalIncome: "Can support rental income",
  drumSpace: "Has a place to play drums",
};

const JUDGMENT_HINTS: Record<JudgmentField, string> = {
  bedroomSizeOk:
    "Your call, shown alongside the measured bedroom flag \u2014 it never changes or overrides published measurements.",
  rentalIncome: "Separate studio, basement unit, ADU-like space, or similar.",
  drumSpace: "Somewhere drums can actually be played.",
};

const VERDICT_OPTIONS: Array<{ value: TriStateJudgment; label: string }> = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Unknown" },
];

type LoadPhase = "loading" | "ready" | "error";
type SavePhase = "idle" | "saving" | "saved" | "error";

interface Draft {
  remarks: string;
  pros: string;
  cons: string;
  bedroomSizeOk: TriStateJudgment;
  rentalIncome: TriStateJudgment;
  drumSpace: TriStateJudgment;
}

const EMPTY_DRAFT: Draft = {
  remarks: "",
  pros: "",
  cons: "",
  bedroomSizeOk: "unknown",
  rentalIncome: "unknown",
  drumSpace: "unknown",
};

function draftFromNotes(notes: EditorNotes): Draft {
  return {
    remarks: notes.remarks?.value ?? "",
    pros: notes.pros?.value ?? "",
    cons: notes.cons?.value ?? "",
    bedroomSizeOk: notes.judgments?.bedroomSizeOk ?? "unknown",
    rentalIncome: notes.judgments?.rentalIncome ?? "unknown",
    drumSpace: notes.judgments?.drumSpace ?? "unknown",
  };
}

/**
 * The dedicated property editor screen: the user’s own Remarks / Pros / Cons
 * for one house, persisted to Postgres through the narrow /api/editor
 * endpoint as append-only revisions. These are her notes — deliberately
 * separate from source listing remarks. Rendered as a full-screen dialog
 * with focus handling, Escape-to-close, and unsaved-change protection.
 */
export function PropertyEditorScreen({
  propertyId,
  address,
  onClose,
  onSaved,
}: {
  propertyId: string;
  address: string;
  onClose: () => void;
  /** Called with the server-confirmed notes after every SUCCESSFUL save so
   * the parent view can update its rows (judgment pills, etc.) immediately
   * without a reload. Never called for failed saves — the draft and error
   * stay in the editor and parent rows are untouched. */
  onSaved?: (propertyId: string, notes: EditorNotes) => void;
}) {
  const track = useTrack();
  const [loadPhase, setLoadPhase] = useState<LoadPhase>("loading");
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saved, setSaved] = useState<Draft>(EMPTY_DRAFT);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty =
    draft.remarks !== saved.remarks ||
    draft.pros !== saved.pros ||
    draft.cons !== saved.cons ||
    draft.bedroomSizeOk !== saved.bedroomSizeOk ||
    draft.rentalIncome !== saved.rentalIncome ||
    draft.drumSpace !== saved.drumSpace;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const requestClose = useCallback(() => {
    if (
      dirtyRef.current &&
      !window.confirm("You have unsaved changes. Discard them and close the editor?")
    ) {
      return;
    }
    onClose();
  }, [onClose]);

  // Load the current notes once per property.
  useEffect(() => {
    const controller = new AbortController();
    setLoadPhase("loading");
    (async () => {
      try {
        const res = await fetch(trackUrl(`/api/editor/${propertyId}`, track), {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`request failed with status ${res.status}`);
        const json = (await res.json()) as { notes: EditorNotes };
        const loaded = draftFromNotes(json.notes);
        setDraft(loaded);
        setSaved(loaded);
        setSavedAt(
          [json.notes.remarks?.savedAt, json.notes.pros?.savedAt, json.notes.cons?.savedAt]
            .filter((v): v is string => Boolean(v))
            .sort()
            .pop() ?? null,
        );
        setLoadPhase("ready");
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setLoadPhase("error");
      }
    })();
    return () => controller.abort();
  }, [propertyId, track]);

  // Warn on tab close/navigation while dirty.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Basic dialog behavior: focus the first field, Escape closes (with the
  // unsaved-change confirmation).
  useEffect(() => {
    if (loadPhase === "ready") firstFieldRef.current?.focus();
  }, [loadPhase]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      requestClose();
    }
  };

  const save = async () => {
    setSavePhase("saving");
    setSaveError(null);
    try {
      const res = await fetch(trackUrl(`/api/editor/${propertyId}`, track), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          remarks: draft.remarks,
          pros: draft.pros,
          cons: draft.cons,
          bedroomSizeOk: draft.bedroomSizeOk,
          rentalIncome: draft.rentalIncome,
          drumSpace: draft.drumSpace,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `request failed with status ${res.status}`);
      }
      const json = (await res.json()) as { notes: EditorNotes };
      const persisted = draftFromNotes(json.notes);
      setDraft(persisted);
      setSaved(persisted);
      setSavedAt(new Date().toISOString());
      setSavePhase("saved");
      onSaved?.(propertyId, json.notes);
    } catch (err) {
      setSavePhase("error");
      setSaveError(err instanceof Error ? err.message : "unknown error");
    }
  };

  return (
    <div className="editor-overlay" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        className="editor-screen"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit notes for ${address}`}
      >
        <header className="editor-header">
          <div>
            <p className="eyebrow">PROPERTY EDITOR</p>
            <h2 className="editor-title">{address}</h2>
            <p className="editor-subtitle">
              Your own remarks, pros, and cons {"\u2014"} saved to the property store as revisions (history is
              kept, nothing is overwritten). Separate from any listing description.
            </p>
          </div>
          <button type="button" className="btn-secondary" onClick={requestClose}>
            Close
          </button>
        </header>

        {loadPhase === "loading" && <p className="loading-note">Loading notes{"\u2026"}</p>}
        {loadPhase === "error" && (
          <p className="editor-error" role="alert">
            Could not load notes for this property (database unavailable or the property is unknown). Close and try
            again.
          </p>
        )}

        {loadPhase === "ready" && (
          <>
            <div className="editor-judgments">
              <p className="editor-judgments-title">Quick judgments</p>
              <p className="editor-field-hint">
                Your own Yes / No / Unknown calls. Unknown means {"\u201c"}not evaluated yet{"\u201d"} {"\u2014"} a
                property is never assumed No. The bedroom-size call is shown next to the measured flag; published
                measurements are never changed.
              </p>
              {JUDGMENT_FIELDS.map((field) => (
                <fieldset key={field} className="editor-judgment">
                  <legend className="editor-judgment-legend">
                    {JUDGMENT_LABELS[field]}
                    <span className="editor-field-hint editor-judgment-hint">{JUDGMENT_HINTS[field]}</span>
                  </legend>
                  <div className="editor-judgment-options" role="radiogroup" aria-label={JUDGMENT_LABELS[field]}>
                    {VERDICT_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={`editor-judgment-option${draft[field] === option.value ? " editor-judgment-option-active" : ""}`}
                      >
                        <input
                          type="radio"
                          name={`judgment-${field}`}
                          value={option.value}
                          checked={draft[field] === option.value}
                          disabled={savePhase === "saving"}
                          onChange={() => {
                            setDraft((prev) => ({ ...prev, [field]: option.value }));
                            if (savePhase === "saved") setSavePhase("idle");
                          }}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>

            <div className="editor-fields">
              {EDITOR_FIELDS.map((field, index) => (
                <label key={field} className="editor-field">
                  <span className="editor-field-label">{FIELD_LABELS[field]}</span>
                  <span className="editor-field-hint">{FIELD_HINTS[field]}</span>
                  <textarea
                    ref={index === 0 ? firstFieldRef : undefined}
                    className="editor-textarea"
                    rows={field === "remarks" ? 6 : 4}
                    maxLength={MAX_FIELD_LENGTH}
                    value={draft[field]}
                    onChange={(event) => {
                      setDraft((prev) => ({ ...prev, [field]: event.target.value }));
                      if (savePhase === "saved") setSavePhase("idle");
                    }}
                    disabled={savePhase === "saving"}
                  />
                </label>
              ))}
            </div>

            <footer className="editor-footer">
              <div className="editor-status" role="status" aria-live="polite">
                {savePhase === "saving" && <span>Saving{"\u2026"}</span>}
                {savePhase === "saved" && <span className="editor-status-saved">Saved.</span>}
                {savePhase === "error" && (
                  <span className="editor-error">Save failed: {saveError}. Your text is still here {"\u2014"} try again.</span>
                )}
                {savePhase === "idle" && dirty && <span>Unsaved changes.</span>}
                {savePhase === "idle" && !dirty && savedAt && (
                  <span>Last saved {formatDate(savedAt)}.</span>
                )}
              </div>
              <div className="editor-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={save}
                  disabled={savePhase === "saving" || !dirty}
                >
                  {savePhase === "saving" ? "Saving\u2026" : "Save notes"}
                </button>
                <button type="button" className="btn-secondary" onClick={requestClose}>
                  {dirty ? "Discard & close" : "Close"}
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
