import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function tokenHost() {
  const base = process.env.FREEAGENT_BASE_URL || "https://api.freeagent.com/v2";
  return base.includes("sandbox") ? "https://api.sandbox.freeagent.com" : "https://api.freeagent.com";
}

async function refreshAccessToken() {
  const host = tokenHost();
  const res = await fetch(`${host}/v2/token_endpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.FREEAGENT_CLIENT_ID!,
      client_secret: process.env.FREEAGENT_CLIENT_SECRET!,
      refresh_token: process.env.FREEAGENT_REFRESH_TOKEN!,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Failed to refresh FreeAgent token: ${res.status}`);
  process.env.FREEAGENT_ACCESS_TOKEN = data.access_token;
  return data.access_token as string;
}

async function withToken(fn: (t: string) => Promise<Response>): Promise<[Response, string, string]> {
  let t = process.env.FREEAGENT_ACCESS_TOKEN!;
  let r = await fn(t);
  let txt = await r.text();
  if (r.status === 401) {
    t = await refreshAccessToken();
    r = await fn(t);
    txt = await r.text();
  }
  return [r, txt, t];
}

export async function POST(req: NextRequest) {
  try {
    const { merchant, date, total, vat, file_b64, file_name, file_type } = await req.json();

    if (!total)   return NextResponse.json({ error: "Missing total" }, { status: 400 });
    if (!file_b64) return NextResponse.json({ error: "Missing file_b64" }, { status: 400 });

    const base = process.env.FREEAGENT_BASE_URL || "https://api.freeagent.com/v2";
    const UA = process.env.FREEAGENT_USER_AGENT || "Receipt OCR Uploader (you@example.com)";

    // --- contact (find/create) ---
    const contactName = (merchant?.trim() || "Misc Receipts").slice(0, 80);
    const [cRes, cText] = await withToken((t) =>
      fetch(`${base}/contacts?view=all&search=${encodeURIComponent(contactName)}`, {
        headers: { Authorization: `Bearer ${t}`, Accept: "application/json", "User-Agent": UA },
      })
    );
    if (!cRes.ok) return NextResponse.json({ error: "Contact search failed", details: cText }, { status: 500 });
    const cJson = JSON.parse(cText || "{}");
    let contactUrl: string | null =
      (cJson.contacts || []).find((c: any) =>
        (c.organisation_name || c.first_name || "").toLowerCase() === contactName.toLowerCase()
      )?.url || null;

    if (!contactUrl) {
      const [ccRes, ccText] = await withToken((t) =>
        fetch(`${base}/contacts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${t}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": UA,
          },
          body: JSON.stringify({ contact: { organisation_name: contactName, first_name: contactName } }),
        })
      );
      if (!ccRes.ok) return NextResponse.json({ error: "Create contact failed", details: ccText }, { status: 500 });
      contactUrl = JSON.parse(ccText || "{}")?.contact?.url;
      if (!contactUrl) return NextResponse.json({ error: "No contact URL returned" }, { status: 500 });
    }

    // --- bill create (force dates) ---
    const today = new Date().toISOString().slice(0, 10);
    const dated_on = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : today;
    const due_on = dated_on;
    const gross = Number(String(total).replace(/[^\d.-]/g, ""));
    const vatNum = vat ? Number(String(vat).replace(/[^\d.-]/g, "")) : undefined;

    // FreeAgent’s current schema prefers nested bill_items; keep it minimal (single item)
    const billBody: any = {
      bill: {
        contact: contactUrl,
        dated_on, due_on,
        reference: merchant || "Receipt",
        bill_items: [
          {
            category: "/categories/280", // General Purchases
            total_value: gross,
          },
        ],
      },
    };
    if (typeof vatNum === "number" && !Number.isNaN(vatNum)) {
      billBody.bill.bill_items[0].sales_tax_value = vatNum;
    }

    const [bRes, bText, token] = await withToken((t) =>
      fetch(`${base}/bills`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify(billBody),
      })
    );
    if (!bRes.ok) return NextResponse.json({ error: "Create bill failed", details: bText }, { status: 500 });

    const bJson = JSON.parse(bText || "{}");
    const billUrl: string | undefined = bJson.bill?.url;
    if (!billUrl) return NextResponse.json({ error: "No bill URL returned" }, { status: 500 });

    // --- attach via PUT .../bills/:id with attachment object ---
    const filename =
      file_name ||
      `${dated_on}_${(merchant || "receipt").replace(/[^\w\- ]+/g, "").slice(0, 50)}_${gross.toFixed(2)}.jpg`;

    const attachBody = {
      bill: {
        attachment: {
          data: file_b64,                          // base64 (no data URI prefix)
          content_type: file_type || "image/jpeg",
          file_name: filename,
        },
      },
    };

    const [aRes, aText] = await withToken((t) =>
      fetch(billUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify(attachBody),
      })
    );
    if (!aRes.ok) return NextResponse.json({ error: "Attach file failed", details: aText }, { status: 500 });

    const aJson = JSON.parse(aText || "{}");
    return NextResponse.json({ success: true, bill: aJson.bill || bJson.bill });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "fa-bill-upload failed" }, { status: 500 });
  }
}
