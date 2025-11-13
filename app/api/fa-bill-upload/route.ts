import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function tokenHost() {
  const base = process.env.FREEAGENT_BASE_URL || "https://api.freeagent.com/v2";
  return base.includes("sandbox")
    ? "https://api.sandbox.freeagent.com"
    : "https://api.freeagent.com";
}

async function refreshAccessToken() {
  const host = tokenHost();
  const res = await fetch(`${host}/v2/token_endpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.FREEAGENT_REFRESH_TOKEN || "",
      client_id: process.env.FREEAGENT_CLIENT_ID || "",
      client_secret: process.env.FREEAGENT_CLIENT_SECRET || "",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("FreeAgent token refresh failed:", res.status, text);
    throw new Error("Failed to refresh FreeAgent access token");
  }

  const json = await res.json();
  const newAccess = json.access_token as string | undefined;
  const newRefresh = json.refresh_token as string | undefined;

  if (newAccess) {
    process.env.FREEAGENT_ACCESS_TOKEN = newAccess;
  }
  if (newRefresh) {
    process.env.FREEAGENT_REFRESH_TOKEN = newRefresh;
  }

  return newAccess;
}

async function withToken<T>(
  fn: (token: string) => Promise<Response>
): Promise<[Response, string, string]> {
  let token = process.env.FREEAGENT_ACCESS_TOKEN || "";
  let res = await fn(token);
  let text = await res.text();

  if (res.status === 401) {
    token = (await refreshAccessToken()) || "";
    res = await fn(token);
    text = await res.text();
  }

  return [res, text, token];
}

export async function POST(req: NextRequest) {
  try {
    const { merchant, date, total, vat, file_b64, file_name, file_type } =
      await req.json();

    if (!total)
      return NextResponse.json(
        { error: "Missing total" },
        { status: 400 }
      );
    if (!file_b64)
      return NextResponse.json(
        { error: "Missing file data" },
        { status: 400 }
      );

    const base = process.env.FREEAGENT_BASE_URL || "https://api.freeagent.com/v2";
    const UA =
      process.env.FREEAGENT_USER_AGENT ||
      "ReceiptUploader (receipt-to-freeagent)";

    // --- 1) Look up or create contact ---
    // For now, we naïvely search by company_name == merchant.
    const searchName = merchant || "Unknown Supplier";
    const [cRes, cText] = await withToken((t) =>
      fetch(
        `${base}/contacts?company_name=${encodeURIComponent(searchName)}`,
        {
          headers: {
            Authorization: `Bearer ${t}`,
            Accept: "application/json",
            "User-Agent": UA,
          },
        }
      )
    );

    if (!cRes.ok) {
      return NextResponse.json(
        { error: "Contact lookup failed", details: cText },
        { status: 500 }
      );
    }

    const cJson = JSON.parse(cText || "{}");
    let contactUrl =
      Array.isArray(cJson.contacts) && cJson.contacts.length > 0
        ? cJson.contacts[0].url
        : null;

    if (!contactUrl) {
      // Create a new contact
      const contactBody = {
        contact: {
          company_name: merchant || "Supplier",
          first_name: "",
          last_name: "",
        },
      };

      const [nRes, nText] = await withToken((t) =>
        fetch(`${base}/contacts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${t}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": UA,
          },
          body: JSON.stringify(contactBody),
        })
      );

      if (!nRes.ok) {
        return NextResponse.json(
          { error: "Create contact failed", details: nText },
          { status: 500 }
        );
      }

      const nJson = JSON.parse(nText || "{}");
      contactUrl = nJson.contact?.url;
      if (!contactUrl) {
        return NextResponse.json(
          { error: "No contact URL in response" },
          { status: 500 }
        );
      }
    }

    // --- 2) Normalise amounts & dates ---
    const today = new Date().toISOString().slice(0, 10);
    const dated_on =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
    const due_on = dated_on;

    // Parse strings to numbers, then force them positive.
    const grossRaw = Number(
      String(total).replace(/[^\d.-]/g, "")
    );
    const vatRaw = vat
      ? Number(String(vat).replace(/[^\d.-]/g, ""))
      : undefined;

    const gross = Math.abs(grossRaw);
    const vatNum =
      typeof vatRaw === "number" && !Number.isNaN(vatRaw)
        ? Math.abs(vatRaw)
        : undefined;

    // --- 3) Build Bill payload ---
    const billBody: any = {
      bill: {
        contact: contactUrl,
        dated_on,
        due_on,
        reference: merchant || "Receipt",
        bill_items: [
          {
            category: "/categories/280", // General Purchases
            total_value: gross, // ✅ Always positive
          },
        ],
      },
    };

    if (typeof vatNum === "number" && !Number.isNaN(vatNum)) {
      billBody.bill.bill_items[0].sales_tax_value = vatNum; // ✅ Always positive
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

    if (!bRes.ok) {
      return NextResponse.json(
        { error: "Create bill failed", details: bText },
        { status: 500 }
      );
    }

    const bJson = JSON.parse(bText || "{}");
    const billUrl = bJson.bill?.url;

    if (!billUrl) {
      return NextResponse.json(
        { error: "Bill created but no URL returned" },
        { status: 500 }
      );
    }

    // --- 4) Upload attachment & link it to the bill ---
    const binary = Buffer.from(file_b64, "base64");
    const attachBody = {
      attachment: {
        file_name: file_name || "receipt.jpg",
        content_type: file_type || "image/jpeg",
        file: file_b64,
        // Some FreeAgent APIs allow linking via "attached_to"
        attached_to: billUrl,
      },
    };

    const [aRes, aText] = await withToken((t) =>
      fetch(`${base}/attachments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify(attachBody),
      })
    );

    if (!aRes.ok) {
      return NextResponse.json(
        { error: "Attach file failed", details: aText },
        { status: 500 }
      );
    }

    const aJson = JSON.parse(aText || "{}");

    return NextResponse.json({
      success: true,
      bill: aJson.bill || bJson.bill,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "fa-bill-upload failed" },
      { status: 500 }
    );
  }
}
