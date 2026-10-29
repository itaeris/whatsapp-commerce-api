import "server-only";
import ExcelJS from "exceljs";
import { normalizePhone } from "@/lib/phone";

export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export type ParsedImportRow = {
  row: number;
  name: string;
  waId: string;
  phone: string;
  email: string | null;
  city: string | null;
  birthDate: string | null;
  tags: string[];
};

export type ParsedImport = {
  rows: ParsedImportRow[];
  skipped: { row: number; reason: string }[];
};

const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  nama: "name",
  full_name: "name",
  fullname: "name",
  first_name: "first_name",
  fname: "first_name",
  last_name: "last_name",
  lname: "last_name",
  phone: "phone",
  phone_number: "phone",
  mobile: "phone",
  mobile_phone: "phone",
  mobile_number: "phone",
  nomor: "phone",
  no_hp: "phone",
  nohp: "phone",
  handphone: "phone",
  whatsapp: "phone",
  wa: "phone",
  wa_id: "phone",
  email: "email",
  email_address: "email",
  e_mail: "email",
  city: "city",
  kota: "city",
  address_city: "city",
  address: "address",
  birth_date: "birth_date",
  birthdate: "birth_date",
  birthday: "birth_date",
  tanggal_lahir: "birth_date",
  dob: "birth_date",
  tags: "tags",
  tag: "tags",
  label: "tags",
};

function normHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\ufeff/, "")
    .replace(/[\s-]+/g, "_");
}

function cellText(value: unknown): string {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "object" && value && "text" in value) {
    return String((value as { text: unknown }).text ?? "").trim();
  }
  if (typeof value === "object" && value && "richText" in value) {
    const parts = (value as { richText?: { text?: string }[] }).richText ?? [];
    return parts.map((p) => p.text ?? "").join("").trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 20000 && value < 80000 && Number.isInteger(value)) {
      const utc = Date.UTC(1899, 11, 30) + value * 86400000;
      return new Date(utc).toISOString().slice(0, 10);
    }
    return String(value);
  }
  return String(value).trim();
}

function looksLikeMailchimp(headers: Iterable<string>): boolean {
  const set = new Set(headers);
  return (
    set.has("email_address") ||
    set.has("first_name") ||
    set.has("last_name") ||
    set.has("phone_number") ||
    set.has("birthday")
  );
}

function composeName(raw: Record<string, string>): string {
  const combined = raw.name?.trim() ?? "";
  if (combined) return combined;
  return [raw.first_name, raw.last_name]
    .map((p) => p?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Mailchimp mashed address: `154 Example Dr.  Hendersonville  NC  28792  US` */
function cityFromMailchimpAddress(address: string): string | null {
  const parts = address
    .split(/\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  for (let i = 1; i < parts.length - 1; i++) {
    const next = parts[i + 1] ?? "";
    if (/^[A-Z]{2}$/.test(next) && !/^apt\.?$/i.test(parts[i])) {
      return parts[i];
    }
  }
  return null;
}

function composeCity(raw: Record<string, string>): string | null {
  const city = raw.city?.trim() ?? "";
  if (city) return city;
  const fromAddress = raw.address?.trim()
    ? cityFromMailchimpAddress(raw.address)
    : null;
  return fromAddress;
}

function validYmd(y: string, m: string, d: string): string | null {
  const ymd = `${y}-${m}-${d}`;
  const dt = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== ymd) {
    return null;
  }
  return ymd;
}

/**
 * Aeris template uses YYYY-MM-DD or DD/MM/YYYY.
 * Mailchimp audience CSV uses Birthday as MM/DD or MM/DD/YYYY (no year → ignored).
 * A bad birthday never drops the contact.
 */
function parseBirthDate(raw: string, mailchimp: boolean): string | null {
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return validYmd(iso[1], iso[2], iso[3]);

  const slash = raw.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?$/);
  if (!slash) return null;
  const a = slash[1].padStart(2, "0");
  const b = slash[2].padStart(2, "0");
  const year = slash[3];
  if (!year) return null;
  if (mailchimp || (Number(a) <= 12 && Number(b) > 12)) {
    return validYmd(year, a, b);
  }
  if (Number(a) > 12 && Number(b) <= 12) {
    return validYmd(year, b, a);
  }
  return mailchimp ? validYmd(year, a, b) : validYmd(year, b, a);
}

function parseTags(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;|]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function parseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function sniffCsvDelimiter(headerLine: string): "," | ";" {
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (let i = 0; i < headerLine.length; i++) {
    const c = headerLine[i];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (c === ",") commas += 1;
    if (c === ";") semis += 1;
  }
  return semis > commas ? ";" : ",";
}

function parseCsv(text: string): string[][] {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  src = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = src.split("\n")[0] ?? "";
  const delimiter = sniffCsvDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

function parseMappedRows(
  records: { row: number; raw: Record<string, string> }[],
  mappedKeys: string[],
  originalHeaders: string[],
): ParsedImport {
  const mailchimp = looksLikeMailchimp(originalHeaders);
  const hasName =
    mappedKeys.includes("name") ||
    mappedKeys.includes("first_name") ||
    mappedKeys.includes("last_name");
  const hasPhone = mappedKeys.includes("phone");

  if (!hasName || !hasPhone) {
    return {
      rows: [],
      skipped: [
        {
          row: 1,
          reason: mailchimp
            ? "Mailchimp CSV needs First Name/Last Name (or Name) and a Phone / Phone Number column."
            : "Missing required columns. Need at least name and phone (see the template).",
        },
      ],
    };
  }

  const rows: ParsedImportRow[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const seen = new Set<string>();

  for (const { row: rowNumber, raw } of records) {
    const name = composeName(raw);
    const phoneRaw = raw.phone?.trim() ?? "";
    const emailRaw = raw.email?.trim() ?? "";
    if (!name && !phoneRaw && !emailRaw && !raw.city && !raw.address) continue;

    if (!name) {
      skipped.push({ row: rowNumber, reason: "Name is required." });
      continue;
    }
    const normalized = normalizePhone(phoneRaw);
    if (!normalized) {
      skipped.push({
        row: rowNumber,
        reason: mailchimp
          ? "Phone Number is missing or invalid. WhatsApp needs a number on the row."
          : "Phone number is missing or invalid.",
      });
      continue;
    }
    if (seen.has(normalized.waId)) {
      skipped.push({ row: rowNumber, reason: "Duplicate phone in this file." });
      continue;
    }
    seen.add(normalized.waId);

    if (rows.length >= IMPORT_MAX_ROWS) {
      skipped.push({ row: rowNumber, reason: `Over the ${IMPORT_MAX_ROWS}-row limit.` });
      continue;
    }

    const email = emailRaw ? parseEmail(emailRaw) : null;
    if (emailRaw && !email) {
      skipped.push({ row: rowNumber, reason: "Email looks invalid." });
      continue;
    }

    const birthRaw = raw.birth_date?.trim() ?? "";
    const birthDate = birthRaw ? parseBirthDate(birthRaw, mailchimp) : null;

    rows.push({
      row: rowNumber,
      name,
      waId: normalized.waId,
      phone: normalized.phone,
      email,
      city: composeCity(raw),
      birthDate,
      tags: parseTags(raw.tags ?? ""),
    });
  }

  return { rows, skipped };
}

export function isContactsImportFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".csv");
}

export async function parseContactsFile(
  buffer: Buffer,
  filename: string,
): Promise<ParsedImport> {
  if (filename.toLowerCase().endsWith(".csv")) {
    return parseContactsCsv(buffer);
  }
  return parseContactsXlsx(buffer);
}

export function parseContactsCsv(buffer: Buffer): ParsedImport {
  const table = parseCsv(buffer.toString("utf8"));
  if (table.length === 0) {
    return { rows: [], skipped: [{ row: 0, reason: "The CSV is empty." }] };
  }

  const header = table[0];
  const colMap = new Map<number, string>();
  header.forEach((cell, idx) => {
    const key = HEADER_ALIASES[normHeader(cell)];
    if (key) colMap.set(idx, key);
  });

  const records: { row: number; raw: Record<string, string> }[] = [];
  for (let i = 1; i < table.length; i++) {
    const line = table[i];
    const raw: Record<string, string> = {};
    colMap.forEach((key, col) => {
      raw[key] = (line[col] ?? "").trim();
    });
    records.push({ row: i + 1, raw });
  }

  return parseMappedRows(
    records,
    [...colMap.values()],
    header.map((cell) => normHeader(cell)),
  );
}

export async function buildContactsTemplateXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Aeris WhatsApp Commerce";

  const sheet = wb.addWorksheet("Contacts", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "name", key: "name", width: 28 },
    { header: "phone", key: "phone", width: 20 },
    { header: "email", key: "email", width: 32 },
    { header: "city", key: "city", width: 18 },
    { header: "birth_date", key: "birth_date", width: 14 },
    { header: "tags", key: "tags", width: 22 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn("phone").numFmt = "@";
  sheet.getColumn("birth_date").numFmt = "@";

  sheet.addRows([
    {
      name: "Dewi Lestari",
      phone: "+6281234567890",
      email: "dewi@example.com",
      city: "Jakarta",
      birth_date: "1995-03-12",
      tags: "vip, repeat",
    },
    {
      name: "Bagus Pratama",
      phone: "081298765432",
      email: "bagus@example.com",
      city: "Bandung",
      birth_date: "",
      tags: "",
    },
  ]);

  const help = wb.addWorksheet("Instructions");
  help.columns = [{ width: 92 }];
  help.addRows([
    ["Aeris · contact import template"],
    [""],
    ["Use the Contacts sheet. Keep the header row. Delete the sample rows before importing real data."],
    ["You can also upload a Mailchimp audience CSV (the export / sample-mailchimp-contact-import.csv)."],
    [""],
    ["name (required) - or Mailchimp First Name + Last Name"],
    ["phone (required) - WhatsApp number. Local 08… or +62… is fine. Mailchimp: Phone / Phone Number."],
    ["email (optional) - Mailchimp: Email Address"],
    ["city (optional) - Mailchimp: Address - City, or inferred from Address"],
    ["birth_date (optional) - YYYY-MM-DD. Mailchimp Birthday MM/DD is ignored (no year)."],
    ["tags (optional) - comma-separated. Mailchimp Tags map here."],
    [""],
    ["Every imported row is tagged Internal automatically so it is distinct from voucher (/daftar) signups."],
    ["Existing contacts are matched by phone (wa_id). Matching rows are updated; new numbers are created."],
    ["Consent stays pending - import does not opt anyone in to WhatsApp campaigns."],
    [`Maximum ${IMPORT_MAX_ROWS} rows per file.`],
  ]);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export async function parseContactsXlsx(buffer: Buffer): Promise<ParsedImport> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet =
    wb.getWorksheet("Contacts") ??
    wb.worksheets.find((s) => s.name.toLowerCase() !== "instructions") ??
    wb.worksheets[0];
  if (!sheet) {
    return { rows: [], skipped: [{ row: 0, reason: "The spreadsheet has no sheets." }] };
  }

  const headerRow = sheet.getRow(1);
  const colMap = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const key = HEADER_ALIASES[normHeader(cell.value)];
    if (key) colMap.set(col, key);
  });

  const records: { row: number; raw: Record<string, string> }[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string> = {};
    colMap.forEach((key, col) => {
      raw[key] = cellText(row.getCell(col).value);
    });
    records.push({ row: rowNumber, raw });
  });

  const originalHeaders: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    originalHeaders.push(normHeader(cell.value));
  });

  return parseMappedRows(records, [...colMap.values()], originalHeaders);
}
