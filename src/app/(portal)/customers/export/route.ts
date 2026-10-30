import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { listCustomers } from "@/lib/data/repo";
import { exportCustomersFromApi } from "@/lib/backend";
import {
  buildCustomersExportXlsx,
  customerExportFilename,
  type CustomerExportSource,
} from "@/lib/customers/export-xlsx";
import {
  buildMailchimpAudienceCsv,
  mailchimpExportFilename,
} from "@/lib/customers/export-mailchimp";

function parseSource(raw: string | null): CustomerExportSource {
  if (raw === "internal" || raw === "voucher" || raw === "form_digital") {
    return raw;
  }
  return "all";
}

export async function GET(req: NextRequest) {
  await requirePermission("customers.pii");
  const source = parseSource(req.nextUrl.searchParams.get("source"));
  const format = req.nextUrl.searchParams.get("format");

  if (format === "mailchimp") {
    const customers = await listCustomers();
    const csv = buildMailchimpAudienceCsv(customers, source);
    const filename = mailchimpExportFilename(source);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const fromApi = await exportCustomersFromApi(source);
  if (fromApi) {
    const filename =
      fromApi.headers.get("content-disposition") ??
      `attachment; filename="${customerExportFilename(source)}"`;
    return new NextResponse(fromApi.body, {
      headers: {
        "Content-Type":
          fromApi.headers.get("content-type") ??
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": filename,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const customers = await listCustomers();
  const buffer = await buildCustomersExportXlsx(customers, source);
  const filename = customerExportFilename(source);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
