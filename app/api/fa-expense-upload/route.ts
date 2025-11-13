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

  // Retry once on 401 with refreshed token
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

    if (!total) {
      return NextResponse.json(
        { error: "Missing total" },
        { status: 400 }
      );
    }
    if (!file_b64) {
      return NextResponse.json(
        { error: "Missing file data" },
        { status: 400 }
      );
    }

    const base = process.env.FREEAGENT_BASE_URL || "https://api.freeagent.com/v2";
    const UA =
      process.env.FREEAGENT_USER_AGENT ||
      "ReceiptUploader (receipt-to-freeagent)";

    // --- 1) Fetch current user (for expense.user) ---
    const [uRes, uText] = await withToken((t) =>
      fetch(`${base}/users/me`, {
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: "application/json",
          "User-Agent": UA,
        },
      })
    );

    if (!uRes.ok) {
      return NextResponse.json(
        { error: "User lookup failed", details: uText },
        { status: 500 }
      );
    }

    const uJson = JSON.parse(uText || "{}");
    const userUrl = uJson.user?.url;
    if (!userUrl) {
      return NextResponse.json(
        { error: "No user URL in response" },
        { status: 500 }
      );
    }

    // --- 2) Normalise dates & amounts ---
    const today = new Date().toISOString().slice(0, 10);
    const dated_on =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;

    // Parse strings, then force positive values (normal receipts)
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

    // --- 3) Build Expense payload ---
    const expenseBody: any = {
      expense: {
        user: userUrl,
        dated_on,
        description: merchant || "Receipt",
        // Category: adjust this if you prefer a different default
        category: "/categories/280", // General Purchases (example)
        gross_value: gross,          // ✅ always positive
      },
    };

    if (typeof vatNum === "number" && !Number.isNaN(vatNum)) {
      expenseBody.expense.sales_tax_value = vatNum; // ✅ always positive
    }

    const [eRes, eText, token] = await withToken((t) =>
      fetch(`${base}/expenses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify(expenseBody),
      })
    );

    if (!eRes.ok) {
      return NextResponse.json(
        { error: "Create expense failed", details: eText },
        { status: 500 }
      );
    }

    const eJson = JSON.parse(eText || "{}");
    const expenseUrl = eJson.expense?.url;

    if (!expenseUrl) {
      return NextResponse.json(
        { error: "Expense created but no URL returned" },
        { status: 500 }
      );
    }

    // --- 4) Upload attachment & link to the expense ---
    const attachBody = {
      attachment: {
        file_name: file_name || "receipt.jpg",
        content_type: file_type || "image/jpeg",
        file: file_b64,
        attached_to: expenseUrl,
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
      expense: eJson.expense,
      attachment: aJson.attachment ?? aJson,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "fa-expense-upload failed" },
      { status: 500 }
    );
  }
}
