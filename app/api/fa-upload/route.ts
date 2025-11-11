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
  if (!res.ok || !data.access_token) {
    console.error("FA refresh failed:", res.status, data);
    throw new Error(`Failed to refresh FreeAgent token: ${res.status}`);
  }
  process.env.FREEAGENT_ACCESS_TOKEN = data.access_token;
  return data.access_token as string;
}

export async function POST(req: NextRequest) {
  try {
    const { merchant, date, total, file_b64, file_name, file_type } = await req.json();

    if (!file_b64) return NextResponse.json({ error: "Missing file_b64" }, { status: 400 });

    const base = process.env.FREEAGENT_BASE_URL || "https://api.freeagent.com/v2";
    let token = process.env.FREEAGENT_ACCESS_TOKEN!;
    if (!token) return NextResponse.json({ error: "Missing FREEAGENT_ACCESS_TOKEN" }, { status: 500 });

    const UA = process.env.FREEAGENT_USER_AGENT || "Receipt OCR Uploader (example@example.com)";

    const safeMerchant = (merchant || "receipt").replace(/[^\w\- ]+/g, "").slice(0, 50);
    const safeDate = (date || "").replace(/[^0-9\-]/g, "");
    const safeTotal = (total || "").replace(/[^\d.]/g, "");
    const filename =
      file_name ||
      `${safeDate ? safeDate + "_" : ""}${safeMerchant}${safeTotal ? "_" + safeTotal : ""}.jpg`;

    const bin = Buffer.from(file_b64, "base64");
    const blob = new Blob([bin], { type: file_type || "image/jpeg" });

    // Build two candidate form bodies (different field names)
    const fdFile = new FormData();
    fdFile.append("file", blob, filename);

    const fdAttachment = new FormData();
    // some tenants expect nested param name
    (fdAttachment as any).append("attachment[file]", blob, filename);

    async function post(url: string, body: FormData) {
      return fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": UA,
        },
        body,
      });
    }

    const urls = [`${base}/attachments`, `${base}/attachments.json`];

    // Try combinations: url x [file, attachment[file]]
    let lastText = "";
    for (const url of urls) {
      for (const body of [fdFile, fdAttachment]) {
        let resUp = await post(url, body);
        let txt = await resUp.text();
        if (resUp.status === 401) {
          token = await refreshAccessToken();
          resUp = await post(url, body);
          txt = await resUp.text();
        }
        if (resUp.ok) {
          try {
            const json = JSON.parse(txt);
            return NextResponse.json({ success: true, attachment: json.attachment || json });
          } catch {
            return NextResponse.json({ success: true, raw: txt });
          }
        } else {
          lastText = `Tried ${url} → ${resUp.status}: ${txt}`;
          // keep trying the other variant
        }
      }
    }

    return NextResponse.json(
      { error: "Upload failed", details: lastText.slice(0, 2000) },
      { status: 500 }
    );
  } catch (e: any) {
    console.error("fa-upload route error:", e);
    return NextResponse.json({ error: e?.message || "fa-upload failed" }, { status: 500 });
  }
}
