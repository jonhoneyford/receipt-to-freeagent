"use client";

import { useRef, useState } from "react";

// ---------- Types & Supplier Memory ----------
type SubmitType = "expense" | "bill";
type MerchantRecord = { canonical: string; submitType: SubmitType };
type MerchantMap = Record<string, MerchantRecord>;

function loadMerchantMap(): MerchantMap {
  try {
    return JSON.parse(localStorage.getItem("merchantMap") || "{}") as MerchantMap;
  } catch {
    return {} as MerchantMap;
  }
}
function saveMerchantMap(map: MerchantMap) {
  localStorage.setItem("merchantMap", JSON.stringify(map));
}
function normKey(name: string) {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------- Image helpers (client-side) ----------
async function convertIfHeic(file: File): Promise<File> {
  const ext = file.name.toLowerCase();
  if (ext.endsWith(".heic") || ext.endsWith(".heif")) {
    const { default: heic2any } = await import("heic2any");
    const blob = (await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 })) as Blob;
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" });
  }
  return file;
}

async function autoRotate(file: File): Promise<File> {
  try {
    const { parse } = await import("exifr");
    const meta: any = await parse(file, { translateValues: false, tiff: true });
    const orientation = meta?.Orientation;
    if (!orientation || orientation === 1) return file;

    const img = await createImageBitmap(file);
    let angle = 0;
    if (orientation === 6) angle = 90;
    if (orientation === 8) angle = -90;
    if (orientation === 3) angle = 180;

    const rad = (angle * Math.PI) / 180;
    const sin = Math.abs(Math.sin(rad));
    const cos = Math.abs(Math.cos(rad));
    const w = img.width, h = img.height;
    const rw = Math.round(w * cos + h * sin);
    const rh = Math.round(w * sin + h * cos);

    const canvas = document.createElement("canvas");
    canvas.width = rw; canvas.height = rh;
    const ctx = canvas.getContext("2d")!;
    ctx.translate(rw / 2, rh / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -w / 2, -h / 2);

    const blob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", 0.92)
    );
    return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function downscale(file: File, maxDim = 2000, quality = 0.92): Promise<File> {
  const bmp = await createImageBitmap(file);
  let { width, height } = bmp;
  if (Math.max(width, height) <= maxDim) return file;

  const scale = maxDim / Math.max(width, height);
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, width, height);

  const blob: Blob = await new Promise((res) =>
    canvas.toBlob((b) => res(b!), "image/jpeg", quality)
  );
  return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
}

// ---------- Page ----------
export default function Page() {
  // File & preview
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewURL, setPreviewURL] = useState<string | null>(null);

  // Analyze result
  const [parsed, setParsed] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Review fields
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState("");
  const [total, setTotal] = useState("");
  const [vat, setVat] = useState("");

  // Save type
  const [submitType, setSubmitType] = useState<SubmitType>("expense");

  // Supplier memory suggestion
  const [showSuggest, setShowSuggest] = useState(false);
  const [suggestedName, setSuggestedName] = useState("");
  const [suggestedType, setSuggestedType] = useState<SubmitType | undefined>(undefined);
  const [lastDetectedKey, setLastDetectedKey] = useState("");

  // ----- Handlers -----
  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    setLoading(true);
    setParsed(null);
    setShowSuggest(false);
    setMerchant(""); setDate(""); setTotal(""); setVat("");

    try {
      // Prepare image for Textract (JPEG, rotated, (optionally) smaller)
      let processed = await convertIfHeic(f);
      processed = await autoRotate(processed);
      processed = await downscale(processed, 2000, 0.9);

      setFile(processed);
      setPreviewURL(URL.createObjectURL(processed));
    } catch (err: any) {
      alert("Failed to prepare image: " + (err?.message || String(err)));
      setFile(null);
      setPreviewURL(null);
    } finally {
      setLoading(false);
    }
  }

  async function analyze() {
    if (!file) {
      alert("Please select a receipt image first.");
      return;
    }
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file); // send processed JPEG/PNG
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      const data = await res.json();
      if (data.error) {
        alert("Analyze error: " + data.error);
        return;
      }

      setParsed(data);
      const ocrMerchant = (data.merchant || "").trim();
      setDate(data.date || "");
      setTotal(data.total || "");
      setVat(data.vat_amount || ""); // we'll send as `vat` later

      if (ocrMerchant) {
        const mem = loadMerchantMap();
        const key = normKey(ocrMerchant);
        setLastDetectedKey(key);
        const rec = mem[key];

        if (rec) {
          const sameName = normKey(rec.canonical) === normKey(ocrMerchant);
          const sameType = (rec.submitType ?? submitType) === submitType;

          setSuggestedName(rec.canonical);
          setSuggestedType(rec.submitType);
          setShowSuggest(!(sameName && sameType)); // show only if different

          // keep detected text until user decides
          setMerchant(ocrMerchant);
        } else {
          setMerchant(ocrMerchant);
          setShowSuggest(false);
        }
      } else {
        setMerchant("");
        setShowSuggest(false);
      }
    } finally {
      setLoading(false);
    }
  }

  function useSuggested() {
    setMerchant(suggestedName);
    if (suggestedType) setSubmitType(suggestedType);
    setShowSuggest(false);
  }
  function keepDetected() {
    setShowSuggest(false);
  }

  function rememberSupplier() {
    if (!merchant) return;
    const mem = loadMerchantMap();
    const key = lastDetectedKey || normKey(merchant);
    mem[key] = { canonical: merchant, submitType };
    saveMerchantMap(mem);
    alert(`Saved supplier: ${merchant} (${submitType})`);
  }

  async function sendToFreeAgent() {
    if (!parsed) return;

    const endpoint = submitType === "expense" ? "/api/fa-expense-upload" : "/api/fa-bill-upload";
    const payload = {
      merchant,
      date: date || new Date().toISOString().slice(0, 10),
      total,
      vat, // your routes expect `vat`
      file_b64: parsed.file_b64,
      file_name: parsed.file_name,
      file_type: parsed.file_type,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success) {
      alert(
        submitType === "expense"
          ? "✅ Expense created and receipt attached."
          : "✅ Bill created and receipt attached."
      );
    } else {
      alert(`⚠️ FreeAgent error: ${(data.error || "unknown")}\n${(data.details || "").slice(0, 400)}`);
      console.log("FA upload error:", data);
    }
  }

  // ---------- UI ----------
  return (
    <>
      <div className="container">
        <h1 style={{ margin: "12px 0 8px" }}>Receipt → Review</h1>

        {!parsed && (
          <>
            {/* Hidden input + camera/library triggers */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.heic,.heif,.jpg,.jpeg,.png,.pdf"
              capture="environment"       // rear camera hint on iPhone
              onChange={onFileChange}
              style={{ display: "none" }}
            />

            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => fileInputRef.current?.click()}>📷 Take photo</button>
              <button className="btn secondary" onClick={() => fileInputRef.current?.click()}>
                Upload from library
              </button>
            </div>

            {previewURL && (
              <img
                src={previewURL}
                alt="preview"
                style={{ width: "100%", marginTop: 12, borderRadius: 12 }}
              />
            )}

            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={analyze} disabled={!file || loading}>
                {loading ? "Analyzing..." : "Analyze receipt"}
              </button>
            </div>
          </>
        )}

        {parsed && (
          <>
            {/* Suggestion banner (only if different) */}
            {showSuggest && (
              <div
                style={{
                  background: "#f1f5ff",
                  border: "1px solid #cfe0ff",
                  padding: 12,
                  borderRadius: 10,
                  marginBottom: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Use saved supplier name?</div>
                <div>Detected: <b>{merchant || "(unknown)"}</b></div>
                <div>
                  Saved as: <b>{suggestedName}</b>
                  {suggestedType ? ` · preferred: ${suggestedType}` : ""}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn" onClick={useSuggested}>Use “{suggestedName}”</button>
                  <button className="btn secondary" onClick={keepDetected}>Keep detected</button>
                </div>
              </div>
            )}

            {/* Fields */}
            <label className="field">Merchant</label>
            <input type="text" value={merchant} onChange={(e) => setMerchant(e.target.value)} />

            <label className="field">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

            <label className="field">Total</label>
            <input type="text" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />

            <label className="field">VAT</label>
            <input type="text" inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />

            {/* Save type */}
            <div className="field">
              <label style={{ marginRight: 16 }}>
                <input
                  type="radio"
                  name="submitType"
                  checked={submitType === "expense"}
                  onChange={() => setSubmitType("expense")}
                />{" "}
                Paid personally (Expense)
              </label>
              <label style={{ marginLeft: 16 }}>
                <input
                  type="radio"
                  name="submitType"
                  checked={submitType === "bill"}
                  onChange={() => setSubmitType("bill")}
                />{" "}
                Business card (Bill)
              </label>
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn secondary" onClick={rememberSupplier}>Remember this supplier</button>
            </div>

            {/* Show analyzed image from API */}
            <img
              src={`data:${parsed.file_type};base64,${parsed.file_b64}`}
              alt="analyzed"
              style={{ width: "100%", marginTop: 16, borderRadius: 12 }}
            />
          </>
        )}
      </div>

      {/* Sticky bottom bar (only when review is visible) */}
      {parsed && (
        <div className="sticky-bar">
          <button className="btn" onClick={sendToFreeAgent}>Save to FreeAgent</button>
        </div>
      )}
    </>
  );
}
