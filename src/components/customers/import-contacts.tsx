"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui";
import { importContactsAction, type ImportContactsResult } from "@/app/(portal)/customers/actions";

export function ImportContactsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="secondary" type="button" onClick={() => setOpen(true)}>
        <UploadCloud size={15} /> Import contacts
      </Button>
      {open ? <ImportContactsModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ImportContactsModal({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportContactsResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setResult({ ok: false, error: "Choose an Excel (.xlsx) or Mailchimp CSV file to import." });
      return;
    }
    setBusy(true);
    setResult(null);
    const fd = new FormData();
    fd.set("file", file);
    const next = await importContactsAction(fd);
    setResult(next);
    setBusy(false);
    if (next.ok) setFile(null);
  }

  const skipped = result?.skipped ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50 p-4"
      role="dialog"
      aria-labelledby="import-contacts-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-[14px] border border-border bg-surface p-5 shadow-[0_18px_50px_rgba(45,43,42,0.12)]">
        <h2 id="import-contacts-title" className="text-base font-semibold text-foreground">
          Import contacts
        </h2>
        <p className="mt-1 text-sm text-muted">
          Upload our Excel template or a Mailchimp audience CSV (the same file
          Mailchimp exports / uses to import contacts). Matching phone numbers
          update the existing profile; new numbers are added with pending
          consent and tagged{" "}
          <span className="font-medium text-foreground">Internal</span> so you
          can tell them apart from voucher signups.
        </p>

        <Link
          href="/customers/import-template"
          prefetch={false}
          className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-merlot hover:underline"
        >
          <FileSpreadsheet size={15} />
          Download Excel template
        </Link>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              Excel (.xlsx) or Mailchimp CSV
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
              }}
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-beige-200"
            />
          </label>

          {result?.error ? (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{result.error}</p>
          ) : null}
          {result?.ok ? (
            <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
              Imported {result.created ?? 0} new
              {result.updated ? `, updated ${result.updated}` : ""}
              {skipped.length ? `, skipped ${skipped.length}` : ""}.
            </p>
          ) : null}
          {skipped.length > 0 ? (
            <ul className="max-h-32 overflow-y-auto rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-muted">
              {skipped.slice(0, 20).map((s) => (
                <li key={`${s.row}-${s.reason}`}>
                  Row {s.row}: {s.reason}
                </li>
              ))}
              {skipped.length > 20 ? <li>…and {skipped.length - 20} more</li> : null}
            </ul>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
              {result?.ok ? "Close" : "Cancel"}
            </Button>
            <Button type="submit" disabled={busy || !file}>
              {busy ? "Importing…" : "Import"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
