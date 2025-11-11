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

    // --- me ---
    const [uRes, uText] = await withToken((t) =>
      fetch(`${base}/users/me`, { headers: { Authorization: `Bearer ${t}`, Accept: "application/json" , "User-Agent": UA } })
    );
    if (!uRes.ok) return NextResponse.json({ error: "Fetch current user failed", details: uText }, { status: 500 });
    const me = JSON.parse(uText || "{}")?.user;
    const userUrl: string | undefined = me?.url;
    if (!userUrl) return NextResponse.json({ error: "No user URL returned" }, { status: 500 });

    // --- expense create ---
    const today = new Date().toISOString().slice(0, 10);
    const dated_on = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : today;
    const gross = Number(String(total).replace(/[^\d.-]/g, ""));
    const vatNum = vat ? Number(String(vat).replace(/[^\d.-]/g, "")) : undefined;

    const expenseBody: any = {
      expense: {
        user: userUrl,
        dated_on,
        description: merchant || "Receipt",
        category: "/categories/280",
        gross_value: gross,
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
    if (!eRes.ok) return NextResponse.json({ error: "Create expense failed", details: eText }, { status: 500 });
    const eJson = JSON.parse(eText || "{}");
    const expenseUrl: string | undefined = eJson.expense?.url;
    if (!expenseUrl) return NextResponse.json({ error: "No expense URL returned" }, { status: 500 });

    // --- attach via PUT .../expenses/:id with attachment object ---
const filename =
  file_name ||
  `${dated_on}_${(merchant || "receipt").replace(/[^\w\- ]+/g, "").slice(0, 50)}_${gross.toFixed(2)}.jpg`;

    const attachBody = {
      expense: {
        attachment: {
          data: file_b64,
          content_type: file_type || "image/jpeg",
          file_name: filename,
        },
      },
    };

    const [aRes, aText] = await withToken((t) =>
      fetch(expenseUrl, {
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
    return NextResponse.json({ success: true, expense: aJson.expense || eJson.expense });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "fa-expense-upload failed" }, { status: 500 });
  }
}
