import "server-only";
import {
  extraCustomerTags,
  matchesCustomerSource,
  SOURCE_LABEL,
  customerSources,
} from "@/lib/customers/source";
import type { CustomerExportSource } from "@/lib/customers/export-xlsx";
import type { Customer } from "@/lib/types";

/**
 * Official Mailchimp audience import columns (their sample CSV, minus
 * custom merge fields like "What do you like to grow?").
 * @see https://mailchimp.com/help/format-guidelines-for-your-import-file/
 */
export const MAILCHIMP_IMPORT_HEADERS = [
  "Email Address",
  "First Name",
  "Last Name",
  "Address",
  "Phone",
  "Tags",
  "Birthday",
] as const;

function jakartaStamp(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function mailchimpExportFilename(
  source: CustomerExportSource = "all",
): string {
  const day = jakartaStamp();
  const suffix = source === "all" ? "all" : source.replace("_", "-");
  return `aeris-mailchimp-audience-${suffix}-${day}.csv`;
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function clipBytes(value: string, max: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= max) return value;
  return buf.subarray(0, max).toString("utf8").replace(/\uFFFD$/, "");
}

function splitDisplayName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: clipBytes(parts[0], 255), last: "" };
  return {
    first: clipBytes(parts[0], 255),
    last: clipBytes(parts.slice(1).join(" "), 255),
  };
}

/** Birthday field accepts MM/DD or DD-MM — not a full year. */
function mailchimpBirthday(iso: string | null | undefined): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[2]}/${m[3]}`;
}

/**
 * Mailchimp address parts are separated by two spaces, country as ISO-2.
 * We only store city, so: `Jakarta  ID`
 */
function mailchimpAddress(city: string | null | undefined): string {
  const place = city?.trim();
  if (!place) return "";
  return `${clipBytes(place, 45)}  ID`;
}

function mailchimpPhone(phone: string | null | undefined): string {
  const raw = phone?.trim() ?? "";
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function mailchimpTags(customer: Customer): string {
  const tags = [
    ...customerSources(customer).map((s) => SOURCE_LABEL[s]),
    ...extraCustomerTags(customer.tags),
  ]
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => clipBytes(t.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").trim(), 100))
    .filter(Boolean);
  return [...new Set(tags)].join(", ");
}

function mailchimpEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase() ?? "";
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (/[^\x00-\x7F]/.test(email.split("@")[0] ?? "")) return null;
  return email;
}

function phoneKey(customer: Customer): string {
  return (customer.waId || customer.phone || "").replace(/\D/g, "");
}

function exportScore(customer: Customer): number {
  let score = 0;
  if (customer.consentStatus === "opted_in") score += 100;
  if (customer.name?.trim()) score += 10;
  if (customer.city) score += 5;
  if (customer.birthDate) score += 5;
  if (customer.phone) score += 5;
  const stamp = Date.parse(
    customer.lastOrderAt || customer.termsAcceptedAt || customer.createdAt || "",
  );
  if (Number.isFinite(stamp)) score += stamp / 1e15;
  return score;
}

export function buildMailchimpAudienceCsv(
  customers: Customer[],
  source: CustomerExportSource = "all",
): string {
  const eligible = customers
    .filter((c) => matchesCustomerSource(c, source) && c.consentStatus !== "opted_out")
    .map((c) => ({ customer: c, email: mailchimpEmail(c.email), phone: phoneKey(c) }))
    .filter((row) => row.email)
    .sort((a, b) => exportScore(b.customer) - exportScore(a.customer));

  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();
  const lines = [MAILCHIMP_IMPORT_HEADERS.join(",")];

  for (const { customer: c, email, phone } of eligible) {
    if (!email) continue;
    if (seenEmail.has(email)) continue;
    if (phone && seenPhone.has(phone)) continue;
    seenEmail.add(email);
    if (phone) seenPhone.add(phone);

    const { first, last } = splitDisplayName(c.name);
    lines.push(
      [
        csvCell(email),
        csvCell(first),
        csvCell(last),
        csvCell(mailchimpAddress(c.city)),
        csvCell(mailchimpPhone(c.phone)),
        csvCell(mailchimpTags(c)),
        csvCell(mailchimpBirthday(c.birthDate)),
      ].join(","),
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}
