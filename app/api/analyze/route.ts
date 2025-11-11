import { NextRequest, NextResponse } from "next/server";
import { TextractClient, AnalyzeExpenseCommand } from "@aws-sdk/client-textract";

export const runtime = "nodejs";

// ---------- helpers ----------
function normMoney(s?: string) {
  if (!s) return "";
  const cleaned = s.replace(/[^\d.,-]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Try lots of formats: 2025-11-09, 09/11/25, 9/11/2025, 09 Nov 2025, 9-Nov-25, etc.
function normalizeDateLoose(input?: string): string {
  if (!input) return "";
  // quick ISO first
  const direct = new Date(input);
  if (!isNaN(direct.getTime())) return ymd(direct);

  const monthMap: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  // dd/mm/yyyy or dd-mm-yyyy or dd.mm.yyyy (UK-first)
  const m1 = input.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/);
  if (m1) {
    const d = parseInt(m1[1], 10);
    const m = parseInt(m1[2], 10);
    let y = m1[3].length === 2 ? parseInt("20" + m1[3], 10) : parseInt(m1[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (!isNaN(dt.getTime())) return ymd(dt);
    }
  }

  // dd Mon yyyy (or dd-Mon-yy)
  const m2 = input.match(/\b(\d{1,2})[ \-/.]([A-Za-z]{3,9})[ \-/.](\d{2,4})\b/);
  if (m2) {
    const d = parseInt(m2[1], 10);
    const mon = monthMap[m2[2].toLowerCase()];
    let y = m2[3].length === 2 ? parseInt("20" + m2[3], 10) : parseInt(m2[3], 10);
    if (mon && d >= 1 && d <= 31) {
      const dt = new Date(Date.UTC(y, mon - 1, d));
      if (!isNaN(dt.getTime())) return ymd(dt);
    }
  }

  // yyyy-mm-dd
  const m3 = input.match(/\b(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\b/);
  if (m3) {
    const y = parseInt(m3[1], 10);
    const m = parseInt(m3[2], 10);
    const d = parseInt(m3[3], 10);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (!isNaN(dt.getTime())) return ymd(dt);
  }

  return "";
}

function extractFirstDateFromText(text: string): string {
  if (!text) return "";
  // check multiple patterns; return the first normalisable one
  const patterns: RegExp[] = [
    /\b(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\b/g,               // 09/11/2025
    /\b(\d{1,2}[ \-/.][A-Za-z]{3,9}[ \-/.]\d{2,4})\b/g,         // 09 Nov 2025
    /\b(20\d{2}[\/.\-]\d{1,2}[\/.\-]\d{1,2})\b/g,               // 2025-11-09
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) {
      const n = normalizeDateLoose(m[1]);
      if (n) return n;
    }
  }
  return "";
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());

    const client = new TextractClient({
      region: process.env.AWS_REGION || "eu-west-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    const command = new AnalyzeExpenseCommand({ Document: { Bytes: buf } });
    const result = await client.send(command);

    if (!result.ExpenseDocuments?.length) {
      return NextResponse.json({ error: "No expense data found" }, { status: 422 });
    }

    const doc = result.ExpenseDocuments[0];
    const summary = doc.SummaryFields || [];

    // pull a value by Type.Text matching any of these keys
    function getFirst(keys: string[]): string {
      for (const k of keys) {
        const f = summary.find((s) => s?.Type?.Text === k);
        const v = f?.ValueDetection?.Text?.trim();
        if (v) return v;
      }
      return "";
    }

    // merchant candidates
    const merchant =
      getFirst(["VENDOR_NAME", "MERCHANT_NAME", "RECEIVER_NAME", "BUYER_NAME"]) || "";

    // totals & VAT
    const totalRaw = getFirst(["TOTAL", "AMOUNT_DUE", "SUBTOTAL"]);
    let vatRaw = getFirst(["TAX", "VAT_AMOUNT"]);
    if (!vatRaw) {
      // sum any TAX lines in summary as a fallback
      let sum = 0;
      for (const f of summary) {
        if (f?.Type?.Text?.includes("TAX")) {
          const t = f?.ValueDetection?.Text || "";
          const n = Number(t.replace(/[^\d.,-]/g, "").replace(",", "."));
          if (Number.isFinite(n)) sum += n;
        }
      }
      if (sum > 0) vatRaw = sum.toFixed(2);
    }

    // --- DATE (improved) ---
    // try several semantic fields first
    let dateRaw =
      getFirst([
        "INVOICE_RECEIPT_DATE",
        "INVOICE_DATE",
        "RECEIPT_DATE",
        "TRANSACTION_DATE",
        "PURCHASE_DATE",
        "ORDER_DATE",
        "DATE",
      ]);

    let date = normalizeDateLoose(dateRaw);

    // If still empty, build a plain-text blob from summary + line items and regex it
    let rawText = "";
    try {
      const lines: string[] = [];
      for (const f of summary) {
        const k = f?.Type?.Text;
        const v = f?.ValueDetection?.Text;
        if (v) lines.push(`${k || ""}: ${v}`);
      }
      for (const g of doc.LineItemGroups || []) {
        for (const li of g.LineItems || []) {
          for (const f of li.LineItemExpenseFields || []) {
            const t = f?.ValueDetection?.Text;
            if (t) lines.push(t);
          }
        }
      }
      rawText = lines.join("\n");
    } catch {
      rawText = "";
    }

    if (!date) {
      const fromText = extractFirstDateFromText(rawText);
      if (fromText) date = fromText;
    }

    // build response
    return NextResponse.json({
      merchant,
      date, // YYYY-MM-DD or ""
      total: normMoney(totalRaw),
      vat_amount: normMoney(vatRaw),
      file_b64: buf.toString("base64"),
      file_name: (file as any).name || "receipt.jpg",
      file_type: file.type || "image/jpeg",
      raw_text: rawText,
      debug: {
        date_source: date ? "summary|regex" : "missing",
      },
    });
  } catch (err: any) {
    console.error("Analyze Error:", err);
    return NextResponse.json(
      { error: err?.message || "Analyze failed" },
      { status: 500 }
    );
  }
}
