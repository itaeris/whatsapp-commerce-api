"use server";

import { revalidatePath } from "next/cache";
import { importCustomers, updateCustomer, deleteCustomer } from "@/lib/data/repo";
import { normalizePhone } from "@/lib/phone";
import {
  IMPORT_MAX_BYTES,
  isContactsImportFilename,
  parseContactsFile,
} from "@/lib/customers/import-xlsx";
import { requirePermission } from "@/lib/guard";

export type ImportContactsResult = {
  ok: boolean;
  error?: string;
  created?: number;
  updated?: number;
  skipped?: { row: number; reason: string }[];
};

export async function importContactsAction(
  formData: FormData,
): Promise<ImportContactsResult> {
  await requirePermission("customers.edit");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose an Excel (.xlsx) or Mailchimp CSV file to import." };
  }
  if (file.size > IMPORT_MAX_BYTES) {
    return { ok: false, error: "File is too large. Maximum size is 2 MB." };
  }
  const name = file.name;
  if (!isContactsImportFilename(name)) {
    return { ok: false, error: "Use the Excel template (.xlsx) or a Mailchimp audience CSV." };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = await parseContactsFile(buffer, name);
  } catch (e) {
    console.error("[customers:import] parse failed", e);
    return {
      ok: false,
      error: "Could not read that file. Use the Excel template or a Mailchimp CSV export.",
    };
  }

  if (parsed.rows.length === 0 && parsed.skipped.length === 0) {
    return { ok: false, error: "No contact rows found. Keep the header row and add at least one contact." };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, error: parsed.skipped[0]?.reason ?? "No valid contacts in the file.", skipped: parsed.skipped };
  }

  const result = await importCustomers(parsed.rows);
  revalidatePath("/customers");

  return {
    ok: true,
    created: result.created,
    updated: result.updated,
    skipped: [...parsed.skipped, ...result.failed],
  };
}

export type CustomerMutationResult = { ok: boolean; error?: string };

function parseBirthDate(raw: string): string | null | { error: string } {
  const value = raw.trim();
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  const ymd = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : dmy
      ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`
      : null;
  if (!ymd) return { error: "Birth date must be DD/MM/YYYY." };
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) {
    return { error: "Birth date is not a real date." };
  }
  return ymd;
}

export async function updateCustomerAction(
  formData: FormData,
): Promise<CustomerMutationResult> {
  await requirePermission("customers.edit");

  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  const cityRaw = String(formData.get("city") ?? "").trim();
  const birth = parseBirthDate(String(formData.get("birthDate") ?? ""));

  if (!id) return { ok: false, error: "Missing contact." };
  if (!name) return { ok: false, error: "Name is required." };
  const phone = normalizePhone(phoneRaw);
  if (!phone) return { ok: false, error: "Enter a valid WhatsApp number." };
  if (birth && typeof birth === "object") return { ok: false, error: birth.error };

  const email = emailRaw || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email, or leave it blank." };
  }

  const result = await updateCustomer(id, {
    name,
    phone: phone.phone,
    waId: phone.waId,
    email,
    city: cityRaw || null,
    birthDate: birth,
  });
  if (!result.ok) return result;

  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  return { ok: true };
}

export async function deleteCustomerAction(id: string): Promise<CustomerMutationResult> {
  await requirePermission("customers.edit");
  const customerId = id.trim();
  if (!customerId) return { ok: false, error: "Missing contact." };

  const result = await deleteCustomer(customerId);
  if (!result.ok) return result;

  revalidatePath("/customers");
  revalidatePath(`/customers/${customerId}`);
  return { ok: true };
}
