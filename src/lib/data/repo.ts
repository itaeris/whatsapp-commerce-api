import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { shouldUseSupabaseData } from "@/lib/data/mode";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import {
  DEMO_ADDRESSES,
  DEMO_CASES,
  DEMO_CONVERSATIONS,
  DEMO_CUSTOMERS,
  DEMO_NOTICES,
  DEMO_ORDERS,
  DEMO_PACK_SESSIONS,
  DEMO_PRODUCTS,
  DEMO_SHIPMENTS,
  DEMO_USERS,
  assignDemoConversation,
  demoMessages,
} from "@/lib/demo/data";
import { mergeImportedCustomerTags } from "@/lib/customers/source";
import { listCustomersFromApi } from "@/lib/backend";
import type {
  Address,
  AppUser,
  Conversation,
  Customer,
  Message,
  Order,
  PackScanLog,
  PackSession,
  Product,
  Role,
  Shipment,
  ShipmentEvent,
  SupportCase,
  WarehouseNotice,
} from "@/lib/types";

/**
 * Single data-access facade. Each reader runs against Supabase when the project
 * is configured, otherwise against the in-memory demo dataset. Pages only ever
 * import from here, so swapping storage never touches the UI layer.
 */

/**
 * Unwraps a live multi-row read. A failed query must never fall through to the
 * demo dataset, or an outage/RLS misconfiguration would show staff fabricated
 * customers and orders that look entirely real.
 */
function liveRows<T>(
  scope: string,
  { data, error }: { data: T[] | null; error: PostgrestError | null },
): T[] {
  if (error) {
    console.error(`[repo] ${scope} failed`, error);
    return [];
  }
  return data ?? [];
}

/** Single-row variant of {@link liveRows}. */
function liveRow<T>(
  scope: string,
  { data, error }: { data: T | null; error: PostgrestError | null },
): T | null {
  if (error) {
    console.error(`[repo] ${scope} failed`, error);
    return null;
  }
  return data;
}

/**
 * Unwraps an exact-count read.
 *
 * Prefer this over `rows.length` whenever a list reader is paged or capped
 * (orders, etc.) so the UI shows the real Postgres total.
 */
function liveTotal(
  scope: string,
  { count, error }: { count: number | null; error: PostgrestError | null },
): number {
  if (error) {
    console.error(`[repo] ${scope} failed`, error);
    return 0;
  }
  return count ?? 0;
}

const HEAD_COUNT = { count: "exact", head: true } as const;
/** PostgREST default max-rows is 1000; page past it so the CRM is not silently capped. */
const PAGE_SIZE = 1000;

/* ---------- Customers ---------- */

export async function listCustomers(): Promise<Customer[]> {
  const fromApi = await listCustomersFromApi();
  if (fromApi) return fromApi;

  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const collected: Customer[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const res = await supabase
        .from("customers")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      const batch = liveRows("listCustomers", res);
      collected.push(...batch.map(mapCustomer));
      if (batch.length < PAGE_SIZE) break;
    }
    return collected;
  }
  return DEMO_CUSTOMERS;
}

export async function countCustomers(): Promise<number> {
  if (!shouldUseSupabaseData()) return DEMO_CUSTOMERS.length;
  const supabase = await createSupabaseServerClient();
  const res = await supabase.from("customers").select("*", HEAD_COUNT);
  return liveTotal("countCustomers", res);
}

export async function getCustomer(id: string): Promise<Customer | null> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase.from("customers").select("*").eq("id", id).maybeSingle();
    const row = liveRow("getCustomer", res);
    return row ? mapCustomer(row) : null;
  }
  return DEMO_CUSTOMERS.find((c) => c.id === id) ?? null;
}

export type CustomerProfilePatch = {
  name: string;
  phone: string;
  waId: string;
  email: string | null;
  city: string | null;
  birthDate: string | null;
};

export type CustomerWriteResult = { ok: true } | { ok: false; error: string };

export async function updateCustomer(
  id: string,
  patch: CustomerProfilePatch,
): Promise<CustomerWriteResult> {
  if (!shouldUseSupabaseData()) {
    const existing = DEMO_CUSTOMERS.find((c) => c.id === id);
    if (!existing) return { ok: false, error: "Contact not found." };
    const clash = DEMO_CUSTOMERS.find((c) => c.id !== id && c.waId === patch.waId);
    if (clash) return { ok: false, error: "Another contact already uses that WhatsApp number." };
    existing.name = patch.name;
    existing.phone = patch.phone;
    existing.waId = patch.waId;
    existing.email = patch.email;
    existing.city = patch.city;
    existing.birthDate = patch.birthDate;
    return { ok: true };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("customers")
    .update({
      name: patch.name,
      phone: patch.phone,
      wa_id: patch.waId,
      email: patch.email,
      city: patch.city,
      birth_date: patch.birthDate,
    })
    .eq("id", id);
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Another contact already uses that WhatsApp number." };
    }
    console.error("[repo] updateCustomer failed", error);
    return { ok: false, error: "Could not update this contact." };
  }
  return { ok: true };
}

export async function deleteCustomer(id: string): Promise<CustomerWriteResult> {
  if (!shouldUseSupabaseData()) {
    const idx = DEMO_CUSTOMERS.findIndex((c) => c.id === id);
    if (idx === -1) return { ok: false, error: "Contact not found." };
    if (DEMO_CUSTOMERS[idx].orderCount > 0) {
      return { ok: false, error: "Cannot delete a contact that has orders." };
    }
    DEMO_CUSTOMERS.splice(idx, 1);
    return { ok: true };
  }

  const supabase = await createSupabaseServerClient();
  const { data: existing, error: readErr } = await supabase
    .from("customers")
    .select("id, order_count")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    console.error("[repo] deleteCustomer lookup failed", readErr);
    return { ok: false, error: "Could not delete this contact." };
  }
  if (!existing) return { ok: false, error: "Contact not found." };
  if ((existing.order_count ?? 0) > 0) {
    return { ok: false, error: "Cannot delete a contact that has orders." };
  }

  const { error } = await supabase.from("customers").delete().eq("id", id);
  if (error) {
    if (error.code === "23503") {
      return { ok: false, error: "Cannot delete a contact that still has related records." };
    }
    console.error("[repo] deleteCustomer failed", error);
    return { ok: false, error: "Could not delete this contact." };
  }
  return { ok: true };
}

export type CustomerImportInput = {
  row: number;
  name: string;
  waId: string;
  phone: string;
  email: string | null;
  city: string | null;
  birthDate: string | null;
  tags: string[];
};

export type CustomerImportResult = {
  created: number;
  updated: number;
  failed: { row: number; reason: string }[];
};

type ExistingImportRow = {
  id: string;
  tags: unknown;
  email: string | null;
  city: string | null;
  birth_date: string | null;
};

async function findExistingImportCustomer(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  row: CustomerImportInput,
): Promise<{
  row: ExistingImportRow | null;
  matchedBy: "phone" | "email" | null;
  error?: string;
}> {
  const byPhone = await supabase
    .from("customers")
    .select("id, tags, email, city, birth_date")
    .eq("wa_id", row.waId)
    .maybeSingle();
  if (byPhone.error) {
    return { row: null, matchedBy: null, error: byPhone.error.message };
  }
  if (byPhone.data) return { row: byPhone.data, matchedBy: "phone" };

  if (!row.email) return { row: null, matchedBy: null };

  const byEmail = await supabase
    .from("customers")
    .select("id, tags, email, city, birth_date")
    .ilike("email", row.email)
    .limit(1);
  if (byEmail.error) {
    return { row: null, matchedBy: null, error: byEmail.error.message };
  }
  const hit = byEmail.data?.[0] ?? null;
  return { row: hit, matchedBy: hit ? "email" : null };
}

export async function importCustomers(
  rows: CustomerImportInput[],
): Promise<CustomerImportResult> {
  const failed: { row: number; reason: string }[] = [];
  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();

  if (!shouldUseSupabaseData()) {
    for (const [i, row] of rows.entries()) {
      const email = row.email?.trim().toLowerCase() ?? "";
      const existing = DEMO_CUSTOMERS.find(
        (c) =>
          c.waId === row.waId ||
          c.phone.replace(/\D/g, "") === row.waId ||
          (email !== "" && c.email?.trim().toLowerCase() === email),
      );
      if (existing) {
        const matchedByPhone =
          existing.waId === row.waId ||
          existing.phone.replace(/\D/g, "") === row.waId;
        existing.name = row.name;
        if (matchedByPhone) {
          existing.phone = row.phone;
          existing.waId = row.waId;
        }
        if (row.email) existing.email = row.email;
        if (row.city) existing.city = row.city;
        if (row.birthDate) existing.birthDate = row.birthDate;
        existing.tags = mergeImportedCustomerTags(existing.tags, row.tags);
        updated += 1;
        continue;
      }
      DEMO_CUSTOMERS.unshift({
        id: `c-import-${Date.now()}-${i}`,
        waId: row.waId,
        name: row.name,
        phone: row.phone,
        email: row.email,
        city: row.city,
        birthDate: row.birthDate,
        consentStatus: "pending",
        consentChannel: "import",
        segments: ["New"],
        tags: mergeImportedCustomerTags([], row.tags),
        lifetimeValue: 0,
        orderCount: 0,
        firstSeenAt: now,
        lastOrderAt: null,
        termsAcceptedAt: null,
        termsVersion: null,
        createdAt: now,
      });
      created += 1;
    }
    return { created, updated, failed };
  }

  const supabase = await createSupabaseServerClient();
  for (const row of rows) {
    const line = row.row;
    const existing = await findExistingImportCustomer(supabase, row);
    if (existing.error) {
      failed.push({ row: line, reason: existing.error });
      continue;
    }

    const tags = mergeImportedCustomerTags(
      Array.isArray(existing.row?.tags) ? (existing.row.tags as string[]) : [],
      row.tags,
    );

    if (existing.row) {
      const matchedByPhone = existing.matchedBy === "phone";
      const { error } = await supabase
        .from("customers")
        .update({
          name: row.name,
          ...(matchedByPhone
            ? { phone: row.phone, wa_id: row.waId }
            : {}),
          email: row.email ?? existing.row.email,
          city: row.city ?? existing.row.city,
          birth_date: row.birthDate ?? existing.row.birth_date,
          tags,
        })
        .eq("id", existing.row.id);
      if (error) {
        failed.push({ row: line, reason: error.message });
        continue;
      }
      updated += 1;
      continue;
    }

    const { error } = await supabase.from("customers").insert({
      wa_id: row.waId,
      name: row.name,
      phone: row.phone,
      email: row.email,
      city: row.city,
      birth_date: row.birthDate,
      consent_status: "pending",
      consent_channel: "import",
      segments: ["New"],
      tags,
      first_seen_at: now,
    });
    if (error) {
      failed.push({ row: line, reason: error.message });
      continue;
    }
    created += 1;
  }

  return { created, updated, failed };
}

export async function getCustomerAddresses(customerId: string): Promise<Address[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase.from("addresses").select("*").eq("customer_id", customerId);
    return liveRows("getCustomerAddresses", res).map(mapAddress);
  }
  return DEMO_ADDRESSES.filter((a) => a.customerId === customerId);
}

/* ---------- Conversations & messages ---------- */

export async function listConversations(): Promise<Conversation[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("conversations")
      .select(
        "*, customers!conversations_customer_id_fkey(name, wa_id), users!conversations_assignee_id_fkey(name)",
      )
      .order("last_message_at", { ascending: false })
      .limit(200);
    return liveRows("listConversations", res).map(mapConversation);
  }
  return DEMO_CONVERSATIONS.slice().sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
  );
}

export async function countConversations(): Promise<number> {
  if (!shouldUseSupabaseData()) return DEMO_CONVERSATIONS.length;
  const supabase = await createSupabaseServerClient();
  const res = await supabase.from("conversations").select("*", HEAD_COUNT);
  return liveTotal("countConversations", res);
}

/**
 * customer id -> last inbound timestamp, for conversations with inbound
 * activity since `since`.
 *
 * Campaign dispatch needs this to honour WhatsApp's 24h service window. It
 * reads with the service-role client because dispatch also runs from cron,
 * where there is no session for the `is_staff()` policy to match, and it
 * selects two columns rather than reusing listConversations() so the window
 * check does not pull 200 rows and their joins.
 */
export async function listRecentInboundByCustomer(
  since: Date,
): Promise<Map<string, string>> {
  const iso = since.toISOString();
  if (!shouldUseSupabaseData()) {
    return new Map(
      DEMO_CONVERSATIONS.filter(
        (c) => c.lastInboundAt && c.lastInboundAt >= iso,
      ).map((c) => [c.customerId, c.lastInboundAt as string]),
    );
  }
  const supabase = createSupabaseAdminClient();
  const res = await supabase
    .from("conversations")
    .select("customer_id, last_inbound_at")
    .gte("last_inbound_at", iso);
  const rows = liveRows("listRecentInboundByCustomer", res);
  return new Map(
    rows
      .filter((r) => r.customer_id && r.last_inbound_at)
      .map((r) => [r.customer_id as string, r.last_inbound_at as string]),
  );
}

export type DataClientMode = "session" | "admin";

async function supabaseClientFor(mode: DataClientMode) {
  return mode === "admin"
    ? createSupabaseAdminClient()
    : await createSupabaseServerClient();
}

export async function getConversation(
  id: string,
  mode: DataClientMode = "session",
): Promise<Conversation | null> {
  if (shouldUseSupabaseData()) {
    const supabase = await supabaseClientFor(mode);
    const res = await supabase
      .from("conversations")
      .select(
        "*, customers!conversations_customer_id_fkey(name, wa_id), users!conversations_assignee_id_fkey(name)",
      )
      .eq("id", id)
      .maybeSingle();
    const row = liveRow("getConversation", res);
    return row ? mapConversation(row) : null;
  }
  return DEMO_CONVERSATIONS.find((c) => c.id === id) ?? null;
}

export async function listStaffUsers(
  mode: DataClientMode = "session",
): Promise<AppUser[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await supabaseClientFor(mode);
    const res = await supabase
      .from("users")
      .select("id, name, email, role, avatar_color")
      .order("name");
    return liveRows("listStaffUsers", res).map(mapUser);
  }
  return DEMO_USERS;
}

/** Open (non-resolved) conversation counts keyed by assignee id. */
export async function countOpenConversationsByAssignee(
  mode: DataClientMode = "session",
): Promise<Map<string, number>> {
  if (shouldUseSupabaseData()) {
    const supabase = await supabaseClientFor(mode);
    const res = await supabase
      .from("conversations")
      .select("assignee_id")
      .neq("status", "resolved")
      .not("assignee_id", "is", null);
    const counts = new Map<string, number>();
    for (const row of liveRows("countOpenConversationsByAssignee", res)) {
      const id = row.assignee_id as string | null;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }
  const counts = new Map<string, number>();
  for (const conv of DEMO_CONVERSATIONS) {
    if (conv.status === "resolved" || !conv.assigneeId) continue;
    counts.set(conv.assigneeId, (counts.get(conv.assigneeId) ?? 0) + 1);
  }
  return counts;
}

export async function updateConversationAssignee(
  conversationId: string,
  assigneeId: string | null,
  options?: { onlyIfUnassigned?: boolean; mode?: DataClientMode },
): Promise<boolean> {
  const mode = options?.mode ?? "session";
  if (shouldUseSupabaseData()) {
    const supabase = await supabaseClientFor(mode);
    let query = supabase
      .from("conversations")
      .update({ assignee_id: assigneeId })
      .eq("id", conversationId);
    if (options?.onlyIfUnassigned) {
      query = query.is("assignee_id", null);
    }
    const res = await query.select("id");
    const rows = liveRows("updateConversationAssignee", res);
    return rows.length > 0;
  }
  return assignDemoConversation(conversationId, assigneeId, {
    onlyIfUnassigned: options?.onlyIfUnassigned,
  });
}

export async function listMessages(conversationId: string): Promise<Message[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return liveRows("listMessages", res).map(mapMessage);
  }
  return demoMessages(conversationId);
}

/* ---------- Catalog ---------- */

export async function listProducts(): Promise<Product[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase.from("products").select("*").order("name");
    return liveRows("listProducts", res).map(mapProduct);
  }
  return DEMO_PRODUCTS;
}

/* ---------- Orders ---------- */

export async function listOrders(): Promise<Order[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("orders")
      .select(
        "*, customers!orders_customer_id_fkey(name), order_items(product_id, sku, name, qty, unit_price)",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    return liveRows("listOrders", res).map(mapOrder);
  }
  return DEMO_ORDERS.slice().sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export async function countOrders(): Promise<number> {
  if (!shouldUseSupabaseData()) return DEMO_ORDERS.length;
  const supabase = await createSupabaseServerClient();
  const res = await supabase.from("orders").select("*", HEAD_COUNT);
  return liveTotal("countOrders", res);
}

/** Orders sitting in the warehouse queue — paid but not yet shipped. */
const FULFILLMENT_STATUSES = ["paid", "allocated", "packed"];

export async function countFulfillmentQueue(): Promise<number> {
  if (!shouldUseSupabaseData()) {
    return DEMO_ORDERS.filter((o) => FULFILLMENT_STATUSES.includes(o.status)).length;
  }
  const supabase = await createSupabaseServerClient();
  const res = await supabase
    .from("orders")
    .select("*", HEAD_COUNT)
    .in("status", FULFILLMENT_STATUSES);
  return liveTotal("countFulfillmentQueue", res);
}

/**
 * The head of the fulfillment queue. The warehouse landing page used to pull
 * 500 orders with their line items and filter down to the dozen it renders.
 */
export async function listFulfillmentQueue(limit = 12): Promise<Order[]> {
  if (!shouldUseSupabaseData()) {
    return DEMO_ORDERS.filter((o) => FULFILLMENT_STATUSES.includes(o.status)).slice(
      0,
      limit,
    );
  }
  const supabase = await createSupabaseServerClient();
  const res = await supabase
    .from("orders")
    .select(
      "*, customers!orders_customer_id_fkey(name), order_items(product_id, sku, name, qty, unit_price)",
    )
    .in("status", FULFILLMENT_STATUSES)
    .order("created_at", { ascending: false })
    .limit(limit);
  return liveRows("listFulfillmentQueue", res).map(mapOrder);
}

export async function getOrder(id: string): Promise<Order | null> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("orders")
      .select(
        "*, customers!orders_customer_id_fkey(name), order_items(product_id, sku, name, qty, unit_price)",
      )
      .eq("id", id)
      .maybeSingle();
    const row = liveRow("getOrder", res);
    return row ? mapOrder(row) : null;
  }
  return DEMO_ORDERS.find((o) => o.id === id) ?? null;
}

export async function listOrdersForCustomer(customerId: string): Promise<Order[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("orders")
      .select(
        "*, customers!orders_customer_id_fkey(name), order_items(product_id, sku, name, qty, unit_price)",
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });
    return liveRows("listOrdersForCustomer", res).map(mapOrder);
  }
  return DEMO_ORDERS.filter((o) => o.customerId === customerId);
}

/* ---------- Cases ---------- */

export async function listCases(): Promise<SupportCase[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("cases")
      .select(
        "*, customers!cases_customer_id_fkey(name), users!cases_owner_id_fkey(name)",
      )
      // Urgent first. Ordering by recency and then re-sorting in the page meant
      // a month-old urgent case fell outside the window and vanished from the
      // queue entirely. The enum is declared low..urgent, so descending is
      // urgent..low.
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200);
    return liveRows("listCases", res).map(mapCase);
  }
  return [...DEMO_CASES].sort(
    (a, b) => CASE_PRIORITY_ORDER[a.priority] - CASE_PRIORITY_ORDER[b.priority],
  );
}

const CASE_PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 } as const;

export async function countCases(): Promise<number> {
  if (!shouldUseSupabaseData()) return DEMO_CASES.length;
  const supabase = await createSupabaseServerClient();
  const res = await supabase.from("cases").select("*", HEAD_COUNT);
  return liveTotal("countCases", res);
}

/* ---------- Shipments ---------- */

export async function listShipments(): Promise<Shipment[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("shipments")
      .select(
        "*, orders!shipments_order_id_fkey(code, customers!orders_customer_id_fkey(name)), shipment_events(status, note, at)",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    return liveRows("listShipments", res).map(mapShipment);
  }
  return DEMO_SHIPMENTS;
}

export type ShipmentTotals = {
  total: number;
  inTransit: number;
  delivered: number;
};

const IN_TRANSIT = ["in_transit", "picked_up"];

export async function countShipments(): Promise<ShipmentTotals> {
  if (!shouldUseSupabaseData()) {
    return {
      total: DEMO_SHIPMENTS.length,
      inTransit: DEMO_SHIPMENTS.filter((s) => IN_TRANSIT.includes(s.status)).length,
      delivered: DEMO_SHIPMENTS.filter((s) => s.status === "delivered").length,
    };
  }
  const supabase = await createSupabaseServerClient();
  const [total, inTransit, delivered] = await Promise.all([
    supabase.from("shipments").select("*", HEAD_COUNT),
    supabase.from("shipments").select("*", HEAD_COUNT).in("status", IN_TRANSIT),
    supabase.from("shipments").select("*", HEAD_COUNT).eq("status", "delivered"),
  ]);
  return {
    total: liveTotal("countShipments.total", total),
    inTransit: liveTotal("countShipments.inTransit", inTransit),
    delivered: liveTotal("countShipments.delivered", delivered),
  };
}

/* ---------- Warehouse ---------- */

export async function listNotices(): Promise<WarehouseNotice[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("warehouse_notices")
      .select(
        "*, orders!warehouse_notices_order_id_fkey(code), users!warehouse_notices_raised_by_fkey(name)",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    return liveRows("listNotices", res).map(mapNotice);
  }
  return DEMO_NOTICES;
}

export async function countOpenNotices(): Promise<number> {
  if (!shouldUseSupabaseData()) {
    return DEMO_NOTICES.filter((n) => n.status !== "resolved").length;
  }
  const supabase = await createSupabaseServerClient();
  const res = await supabase
    .from("warehouse_notices")
    .select("*", HEAD_COUNT)
    .neq("status", "resolved");
  return liveTotal("countOpenNotices", res);
}

/* ---------- Pick & Pack ---------- */

/** Orders that are paid/allocated and have a label affixed — ready to pack. */
export async function listPackableOrders(): Promise<Order[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("orders")
      .select(
        "*, customers!orders_customer_id_fkey(name), order_items(product_id, sku, name, qty, unit_price)",
      )
      .in("status", ["paid", "allocated"])
      .not("label_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);
    return liveRows("listPackableOrders", res).map(mapOrder);
  }
  return DEMO_ORDERS.filter(
    (o) => ["paid", "allocated"].includes(o.status) && o.labelNumber,
  );
}

export type PackReportSummary = {
  sessions: number;
  completed: number;
  avgPackSeconds: number;
  unitsScanned: number;
};

export async function getPackReportSummary(): Promise<PackReportSummary> {
  if (!shouldUseSupabaseData()) {
    const completed = DEMO_PACK_SESSIONS.filter((s) => s.status === "completed");
    const totalSecs = completed.reduce(
      (sum, s) =>
        sum +
        (new Date(s.completedAt!).getTime() - new Date(s.startedAt).getTime()) / 1000,
      0,
    );
    return {
      sessions: DEMO_PACK_SESSIONS.length,
      completed: completed.length,
      avgPackSeconds: completed.length ? Math.round(totalSecs / completed.length) : 0,
      unitsScanned: DEMO_PACK_SESSIONS.reduce((n, s) => n + s.scans.length, 0),
    };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("pack_report_summary");
  if (error || !data) {
    console.error("[repo] pack_report_summary failed", error);
    return { sessions: 0, completed: 0, avgPackSeconds: 0, unitsScanned: 0 };
  }
  const m = data as Record<string, unknown>;
  return {
    sessions: Number(m.sessions ?? 0),
    completed: Number(m.completed ?? 0),
    avgPackSeconds: Number(m.avgPackSeconds ?? 0),
    unitsScanned: Number(m.unitsScanned ?? 0),
  };
}

export async function countPackableOrders(): Promise<number> {
  if (!shouldUseSupabaseData()) {
    return DEMO_ORDERS.filter(
      (o) => ["paid", "allocated"].includes(o.status) && o.labelNumber,
    ).length;
  }
  const supabase = await createSupabaseServerClient();
  const res = await supabase
    .from("orders")
    .select("*", HEAD_COUNT)
    .in("status", ["paid", "allocated"])
    .not("label_number", "is", null);
  return liveTotal("countPackableOrders", res);
}

export async function findOrderByLabel(label: string): Promise<Order | null> {
  const norm = label.trim();
  if (!norm) return null;

  if (shouldUseSupabaseData()) {
    // `.or()` takes a raw PostgREST filter string, so a scanned value containing
    // commas or dots could graft on extra conditions. AWBs and order codes are
    // alphanumeric with dashes, and anything else cannot match a real order.
    if (!/^[A-Za-z0-9_-]+$/.test(norm)) return null;

    const supabase = await createSupabaseServerClient();
    // Packers scan the AWB but may also key in the order code; `ilike` keeps the
    // lookup case-insensitive (see the trigram indexes in migration 0018).
    const res = await supabase
      .from("orders")
      .select(
        "*, customers!orders_customer_id_fkey(name), order_items(product_id, sku, name, qty, unit_price)",
      )
      .or(`label_number.ilike.${norm},code.ilike.${norm}`)
      .limit(1)
      .maybeSingle();
    const row = liveRow("findOrderByLabel", res);
    return row ? mapOrder(row) : null;
  }

  const lower = norm.toLowerCase();
  return (
    DEMO_ORDERS.find(
      (o) =>
        o.labelNumber?.toLowerCase() === lower || o.code.toLowerCase() === lower,
    ) ?? null
  );
}

export async function listPackSessions({
  limit = 200,
  offset = 0,
}: { limit?: number; offset?: number } = {}): Promise<PackSession[]> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("pack_sessions")
      .select(PACK_SESSION_SELECT)
      // id breaks ties so paging cannot repeat or skip a session.
      .order("started_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    return liveRows("listPackSessions", res).map(mapPackSession);
  }
  return [...DEMO_PACK_SESSIONS]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(offset, offset + limit);
}

/**
 * Every pack session, paged.
 *
 * Only for the CSV exports: they are the warehouse's accountability record, so
 * truncating them at the page size would quietly drop scans from an audit.
 */
export async function listAllPackSessions(): Promise<PackSession[]> {
  const pageSize = 200;
  const out: PackSession[] = [];
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const page = await listPackSessions({ limit: pageSize, offset });
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

const PACK_SESSION_SELECT =
  "*, orders!pack_sessions_order_id_fkey(code), users!pack_sessions_packer_id_fkey(name), pack_session_items(product_id, sku, barcode, name, required, scanned), pack_scans(sku, name, scanned_at)";

export async function getPackSession(sessionId: string): Promise<PackSession | null> {
  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase
      .from("pack_sessions")
      .select(PACK_SESSION_SELECT)
      .eq("id", sessionId)
      .maybeSingle();
    const row = liveRow("getPackSession", res);
    return row ? mapPackSession(row) : null;
  }
  return DEMO_PACK_SESSIONS.find((s) => s.id === sessionId) ?? null;
}

/**
 * Scannable barcodes for a set of products, keyed by product id. Batched
 * because callers resolve every line item of an order at once.
 */
export async function getProductBarcodes(
  productIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  if (shouldUseSupabaseData()) {
    const supabase = await createSupabaseServerClient();
    const res = await supabase.from("products").select("id, sku, barcode").in("id", ids);
    return new Map(
      liveRows<{ id: string; sku: string; barcode: string | null }>(
        "getProductBarcodes",
        res,
      ).map((p) => [p.id, p.barcode ?? p.sku]),
    );
  }

  return new Map(
    ids.map((id) => {
      const product = DEMO_PRODUCTS.find((p) => p.id === id);
      return [id, product?.barcode ?? id];
    }),
  );
}

/* ---------- Row mappers (snake_case DB -> domain) ---------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapCustomer(r: any): Customer {
  return {
    id: r.id,
    waId: r.wa_id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    city: r.city,
    birthDate: r.birth_date ?? null,
    consentStatus: r.consent_status ?? "pending",
    consentChannel: r.consent_channel ?? null,
    segments: r.segments ?? [],
    tags: r.tags ?? [],
    lifetimeValue: r.lifetime_value ?? 0,
    orderCount: r.order_count ?? 0,
    firstSeenAt: r.first_seen_at,
    lastOrderAt: r.last_order_at,
    termsAcceptedAt: r.terms_accepted_at ?? null,
    termsVersion: r.terms_version ?? null,
    formAnswers:
      r.form_answers &&
      typeof r.form_answers === "object" &&
      !Array.isArray(r.form_answers)
        ? r.form_answers
        : undefined,
    leadDiscountCode:
      typeof r.lead_discount_code === "string" && r.lead_discount_code.trim()
        ? r.lead_discount_code.trim()
        : null,
    digitalDiscountCode:
      typeof r.digital_discount_code === "string" &&
      r.digital_discount_code.trim()
        ? r.digital_discount_code.trim()
        : null,
    createdAt: r.created_at,
  };
}

function mapAddress(r: any): Address {
  return {
    id: r.id,
    customerId: r.customer_id,
    label: r.label,
    recipientName: r.recipient_name,
    recipientPhone: r.recipient_phone,
    line1: r.line1,
    district: r.district,
    city: r.city,
    province: r.province,
    postalCode: r.postal_code,
    lat: r.lat,
    lng: r.lng,
    isDefault: r.is_default,
  };
}

function mapProduct(r: any): Product {
  return {
    id: r.id,
    sku: r.sku,
    barcode: r.barcode ?? r.sku,
    name: r.name,
    category: r.category,
    imageColor: r.image_color ?? "#6f2c3f",
    retailPrice: r.retail_price,
    discountPercent: r.discount_percent ?? 0,
    stock: r.stock ?? 0,
    reserved: r.reserved ?? 0,
    reorderPoint: r.reorder_point ?? 0,
    active: r.active ?? true,
    catalogSync: r.catalog_sync ?? "pending",
    units30d: r.units_30d ?? 0,
    unitsPrev30d: r.units_prev_30d ?? 0,
  };
}

function mapUser(r: {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar_color?: string | null;
}): AppUser {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role as Role,
    avatarColor: r.avatar_color ?? "#6f2c3f",
  };
}

function mapConversation(r: any): Conversation {
  const customer = r.customers ?? r.customer ?? null;
  const assignee = r.users ?? r.assignee ?? null;
  return {
    id: r.id,
    customerId: r.customer_id,
    customerName: customer?.name ?? "Unknown",
    customerWaId: customer?.wa_id ?? "",
    assigneeId: r.assignee_id,
    assigneeName: assignee?.name ?? null,
    status: r.status,
    unread: r.unread ?? 0,
    lastMessagePreview: r.last_message_preview ?? "",
    lastMessageAt: r.last_message_at ?? r.created_at,
    lastInboundAt: r.last_inbound_at,
    firstResponseSeconds: r.first_response_seconds,
    topic: r.topic,
  };
}

function mapMessage(r: any): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    kind: r.kind ?? "text",
    body: r.body ?? "",
    createdAt: r.created_at,
    authorName: r.author_name,
    status: r.status ?? null,
  };
}

function mapCase(r: any): SupportCase {
  const customer = Array.isArray(r.customers) ? r.customers[0] : r.customers;
  const owner = Array.isArray(r.users) ? r.users[0] : r.users;
  return {
    id: r.id,
    code: r.code,
    customerId: r.customer_id ?? "",
    customerName: customer?.name ?? "Unknown",
    subject: r.subject,
    priority: r.priority,
    status: r.status,
    ownerId: r.owner_id ?? null,
    ownerName: owner?.name ?? null,
    orderId: r.order_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
  };
}

function mapShipment(r: any): Shipment {
  const order = Array.isArray(r.orders) ? r.orders[0] : r.orders;
  const customer = Array.isArray(order?.customers) ? order.customers[0] : order?.customers;
  const events: ShipmentEvent[] = (r.shipment_events ?? [])
    .map((e: any) => ({
      status: e.status ?? "",
      note: e.note ?? "",
      at: e.at,
    }))
    .sort(
      (a: ShipmentEvent, b: ShipmentEvent) =>
        new Date(a.at).getTime() - new Date(b.at).getTime(),
    );
  return {
    id: r.id,
    orderId: r.order_id,
    orderCode: order?.code ?? "",
    customerName: customer?.name ?? "Unknown",
    courier: r.courier ?? "",
    service: r.service ?? "",
    trackingNumber: r.tracking_number ?? "",
    status: r.status,
    cost: Number(r.cost ?? 0),
    destinationCity: r.destination_city ?? "",
    events,
    createdAt: r.created_at,
    biteshipOrderId: r.biteship_order_id ?? null,
  };
}

function mapNotice(r: any): WarehouseNotice {
  const order = Array.isArray(r.orders) ? r.orders[0] : r.orders;
  const raisedBy = Array.isArray(r.users) ? r.users[0] : r.users;
  return {
    id: r.id,
    orderId: r.order_id ?? "",
    orderCode: order?.code ?? "",
    raisedByName: raisedBy?.name ?? "System",
    type: r.type,
    message: r.message,
    status: r.status,
    createdAt: r.created_at,
  };
}

function mapPackSession(r: any): PackSession {
  const order = Array.isArray(r.orders) ? r.orders[0] : r.orders;
  const packer = Array.isArray(r.users) ? r.users[0] : r.users;
  return {
    id: r.id,
    orderId: r.order_id,
    orderCode: order?.code ?? "",
    labelNumber: r.label_number ?? order?.code ?? "",
    packerId: r.packer_id ?? "",
    packerName: packer?.name ?? "Unknown",
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
    items: (r.pack_session_items ?? []).map((it: any) => ({
      productId: it.product_id ?? "",
      sku: it.sku ?? "",
      barcode: it.barcode ?? it.sku ?? "",
      name: it.name ?? it.sku ?? "Item",
      required: Number(it.required ?? 0),
      scanned: Number(it.scanned ?? 0),
    })),
    scans: (r.pack_scans ?? [])
      .map((s: any) => ({
        sku: s.sku ?? "",
        name: s.name ?? s.sku ?? "Item",
        at: s.scanned_at,
      }))
      .sort(
        (a: PackScanLog, b: PackScanLog) =>
          new Date(a.at).getTime() - new Date(b.at).getTime(),
      ),
  };
}

function mapOrder(r: any): Order {
  const customer = Array.isArray(r.customers) ? r.customers[0] : r.customers;
  const items = (r.order_items ?? r.items ?? []).map((it: any) => ({
    productId: it.product_id ?? "",
    sku: it.sku ?? "",
    name: it.name ?? it.sku ?? "Item",
    qty: Number(it.qty ?? 0),
    unitPrice: Number(it.unit_price ?? it.unitPrice ?? 0),
  }));
  const snap = r.shipping_address_snapshot ?? null;
  return {
    id: r.id,
    code: r.code,
    customerId: r.customer_id,
    customerName: customer?.name ?? r.customer_name ?? "Unknown",
    status: r.status,
    paymentStatus: r.payment_status,
    paymentProvider: r.payment_provider ?? null,
    paymentLink: r.payment_link ?? null,
    channel: r.channel === "agent" ? "agent" : "whatsapp_cart",
    items,
    subtotal: Number(r.subtotal ?? 0),
    shippingCost: Number(r.shipping_cost ?? 0),
    total: Number(r.total ?? 0),
    shippingAddress: snap
      ? {
          recipientName: snap.recipientName ?? snap.recipient_name ?? "",
          line1: snap.line1 ?? "",
          city: snap.city ?? "",
          postalCode: snap.postalCode ?? snap.postal_code ?? "",
        }
      : null,
    courier: r.courier ?? null,
    trackingNumber: r.tracking_number ?? null,
    labelNumber: r.label_number ?? null,
    flaggedIssue: r.flagged_issue ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
