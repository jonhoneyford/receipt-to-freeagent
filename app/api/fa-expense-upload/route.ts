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
    console.error("FreeAgent token refresh failed (expense):", res.status, text);
    throw new Error("Failed to refresh FreeAgent access token");
  }

  const json = await res.json();
  const newAccess = json.access_token as string | undefined;
  const newRefresh = json.refresh_token as string | undefined;

  if (newAccess) process.env.FREEAGENT_ACCESS_TOKEN = newAccess;
  if (newRefresh) process.env.FREEAGENT_REFRESH_TOKEN = newRefresh;

  return newAccess;
}

async function withToken(
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

    // --- 1) Get current user (for expense.user) ---
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

    // --- 2) Normalise date & amounts ---
    const today = new Date().toISOString().slice(0, 10);
    const dated_on =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;

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

    // --- 3) Build Expense payload *with inline attachment* ---
    const expenseBody: any = {
      expense: {
        user: userUrl,
        dated_on,
        description: merchant || "Receipt",
        category: "/categories/280", // General Purchases – adjust if you prefer
        gross_value: gross,
        attachment: {
          data: file_b64,
          file_name: file_name || "receipt.jpg",
          description: merchant || "Receipt",
          content_type: file_type || "image/jpeg",
        },
      },
    };

    if (typeof vatNum === "number" && !Number.isNaN(vatNum)) {
      expenseBody.expense.sales_tax_value = vatNum;
    }

    const [eRes, eText] = await withToken((t) =>
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

    return NextResponse.json({
      success: true,
      expense: eJson.expense,
    });
  } catch (e: any) {
    console.error("fa-expense-upload failed:", e);
    return NextResponse.json(
      { error: e?.message || "fa-expense-upload failed" },
      { status: 500 }
    );
  }
}
