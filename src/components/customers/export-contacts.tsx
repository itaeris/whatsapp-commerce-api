"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

const EXCEL_OPTIONS = [
  {
    source: "all",
    label: "All customers",
    hint: "Excel · imports, fisik cards, and Form Digital",
  },
  {
    source: "internal",
    label: "Internal (uploaded)",
    hint: "Excel · imported lists only",
  },
  {
    source: "voucher",
    label: "Voucher (fisik)",
    hint: "Excel · QR card /daftar signups",
  },
  {
    source: "form_digital",
    label: "Form Digital",
    hint: "Excel · social share-link signups",
  },
] as const;

const MAILCHIMP_OPTIONS = [
  {
    source: "all",
    label: "Mailchimp audience",
    hint: "CSV Mailchimp import (Email, Name, Phone, Tags, Birthday)",
  },
] as const;

export function ExportContactsButton() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="secondary"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Download size={15} /> Export contacts
        <ChevronDown size={14} className={cn(open && "rotate-180")} />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-[0_12px_40px_rgba(45,43,42,0.12)]"
        >
          {MAILCHIMP_OPTIONS.map((opt) => (
            <a
              key={`mailchimp-${opt.source}`}
              role="menuitem"
              href="/customers/export?format=mailchimp"
              className="block px-3 py-2.5 text-left transition hover:bg-surface-muted"
              onClick={() => setOpen(false)}
            >
              <span className="block text-sm font-medium text-foreground">
                {opt.label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                {opt.hint}
              </span>
            </a>
          ))}
          <div className="my-1 border-t border-border" />
          {EXCEL_OPTIONS.map((opt) => (
            <a
              key={opt.source}
              role="menuitem"
              href={
                opt.source === "all"
                  ? "/customers/export"
                  : `/customers/export?source=${opt.source}`
              }
              className="block px-3 py-2.5 text-left transition hover:bg-surface-muted"
              onClick={() => setOpen(false)}
            >
              <span className="block text-sm font-medium text-foreground">
                {opt.label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                {opt.hint}
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
