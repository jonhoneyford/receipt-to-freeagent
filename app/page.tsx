"use client";

import "cropperjs/dist/cropper.css";
import { useState, useRef } from "react";
import * as exifr from "exifr";
import Cropper from "cropperjs";

// ---------------- Types ----------------
type Parsed = {
  merchant: string;
  date: string;         // YYYY-MM-DD preferred
  total: string;
  vat_amount: string;
  file_b64: string;
  file_name: string;
  file_type: string;
  raw_text?: string;
  error?: string;
};

// --------------- Image helpers ---------------

// Convert HEIC -> JPEG (dynamic import to avoid SSR "window" errors)
async function convertHEIC(file: File): Promise<File> {
  if (!file.name.toLowerCase().endsWith(".heic")) return file;
  const { default: heic2any } = await import("heic2any");
  const blob = (await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.92,
  })) as Blob;
  return new File([blob], file.name.replace(/\.heic$/i, ".jpg"), {
    type: "image/jpeg",
  });
}

// Auto-rotate based on EXIF Orientation
async function fixOrientation(file: File): Promise<File> {
  try {
    const meta = await exifr.parse(file, { translateValues: false, tiff: true });
    const o = (meta as any)?.Orientation;
    if (!o || o === 1) return file;

    const img = await createImageBitmap(file);
    let angle = 0;
    if (o === 6) angle = 90;
    if (o === 8) angle = -90;
    if (o === 3) angle = 180;

    const rad = (angle * Math.PI) / 180;
    const sin = Math.abs(Math.sin(rad));
    const cos = Math.abs(Math.cos(rad));
    const w = img.width;
    const h = img.height;
    const rw = Math.round(w * cos + h * sin);
    const rh = Math.round(w * sin + h * cos);

    const canvas = document.createElement("canvas");
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext("2d")!;
    ctx.translate(rw / 2, rh / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -w / 2, -h / 2);

    const blob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", 0.92)
    );

    return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
      type: "image/jpeg",
    });
  } catch {
    return file;
  }
}

// Downscale large photos to speed up preview + OCR
async function downscaleImage(
  file: File,
  maxDim = 2000,
  quality = 0.92
): Promise<File> {
  const bmp = await createImageBitmap(file);
  let { width, height } = bmp;

  if (Math.max(width, height) <= maxDim) return file;

  const scale = maxDim / Math.max(width, height);
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, width, height);

  const blob: Blob = await new Promise((res) =>
    canvas.toBlob((b) => res(b!), "image/jpeg", quality)
  );
  return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
    type: "image/jpeg",
  });
}

// ---------------- Page ----------------
export default function Page() {
  // upload / analyze state
  const [file, setFile] = useState<File | null>(null);
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [loading, setLoading] = useState(false);

  // review fields
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState("");   // YYYY-MM-DD for <input type="date">
  const [total, setTotal] = useState("");
  const [vat, setVat] = useState("");

  // bill vs expense selection
  const [submitType, setSubmitType] = useState<"bill" | "expense">("bill");

  // manual crop
  const cropRef = useRef<HTMLImageElement>(null);
  const cropperRef = useRef<Cropper | null>(null);
  const [manualCrop, setManualCrop] = useState(false);

  // ------------- Handlers -------------

  // Upload flow -> HEIC convert -> auto-rotate -> downscale
  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    setLoading(true);
    try {
      let processed = await convertHEIC(f);
      processed = await fixOrientation(processed);
      processed = await downscaleImage(processed, 2000, 0.92);

      setFile(processed);
      setImageURL(URL.createObjectURL(processed));
      setParsed(null);
    } finally {
      setLoading(false);
    }
  }

  // Manual crop flow
  function startManualCrop() {
    setManualCrop(true);
    setTimeout(() => {
      cropperRef.current = new Cropper(cropRef.current!, {
        viewMode: 1,
        autoCropArea: 1,
        movable: true,
        zoomable: true,
        responsive: true,
      });
    }, 50);
  }

  async function applyCrop() {
    if (!cropperRef.current) return;
    const canvas = cropperRef.current.getCroppedCanvas({ imageSmoothingEnabled: true });
    if (!canvas) return;

    const blob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", 0.92)
    );
    const newFile = new File([blob], "receipt.jpg", { type: "image/jpeg" });
    setFile(newFile);
    setImageURL(URL.createObjectURL(newFile));
    setManualCrop(false);
  }

  // Analyze via AWS Textract route
  async function analyze() {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      const data = await res.json();

      if (data.error) {
        alert("Analyze error: " + data.error);
        return;
      }

      setParsed(data);
      setMerchant(data.merchant || "");
      setDate(data.date || "");
      setTotal(data.total || "");
      setVat(data.vat_amount || "");
    } finally {
      setLoading(false);
    }
  }

  // Submit to FreeAgent (Bill or Expense)
  async function sendToFreeAgent() {
    if (!parsed) return;
    const endpoint = submitType === "expense" ? "/api/fa-expense-upload" : "/api/fa-bill-upload";

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchant,
        date,
        total,
        vat,
        file_b64: parsed.file_b64,
        file_name: parsed.file_name,
        file_type: parsed.file_type,
      }),
    });
    const data = await res.json();
    if (data.success) {
      alert(
        submitType === "expense"
          ? "✅ Expense created and receipt attached."
          : "✅ Bill created and receipt attached."
      );
    } else {
      alert(
        `⚠️ FreeAgent error: ${(data.error || "unknown")}\n${(data.details || "").slice(0, 400)}`
      );
      console.log("FA upload error:", data);
    }
  }

  // ------------- UI -------------

  return (
    <div style={{ maxWidth: 700, margin: "2rem auto", padding: "1rem" }}>
      <h1>Receipt → Review</h1>

      {/* Upload / Preview */}
      {!parsed && !manualCrop && (
        <>
          <input type="file" accept="image/*" onChange={onFileChange} />
          {imageURL && (
            <>
              <img
                src={imageURL}
                style={{ maxWidth: "100%", marginTop: "1rem" }}
                alt="receipt preview"
              />
              <div style={{ marginTop: "0.5rem" }}>
                <button onClick={startManualCrop} disabled={!file || loading}>
                  Adjust Crop
                </button>
              </div>
            </>
          )}
          <div style={{ marginTop: "0.75rem" }}>
            <button onClick={analyze} disabled={!file || loading}>
              {loading ? "Analyzing..." : "Analyze"}
            </button>
          </div>
        </>
      )}

      {/* Manual Crop Overlay */}
      {manualCrop && (
        <div>
          <h3>Adjust Crop</h3>
          <img ref={cropRef} src={imageURL!} style={{ maxWidth: "100%" }} />
          <div style={{ marginTop: "0.5rem" }}>
            <button onClick={applyCrop}>Apply Crop</button>
            <button onClick={() => setManualCrop(false)} style={{ marginLeft: 8 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Review & Edit */}
      {parsed && (
        <>
          <img
            src={`data:${parsed.file_type};base64,${parsed.file_b64}`}
            style={{ maxWidth: "100%", margin: "1rem 0" }}
            alt="receipt"
          />

          <label>Merchant</label>
          <input value={merchant} onChange={(e) => setMerchant(e.target.value)} />

          <label style={{ marginTop: 8 }}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <label style={{ marginTop: 8 }}>Total</label>
          <input value={total} onChange={(e) => setTotal(e.target.value)} />

          <label style={{ marginTop: 8 }}>VAT</label>
          <input value={vat} onChange={(e) => setVat(e.target.value)} />

          {/* Bill vs Expense */}
          <div style={{ marginTop: 12 }}>
            <label style={{ marginRight: 12 }}>
              <input
                type="radio"
                name="submitType"
                checked={submitType === "bill"}
                onChange={() => setSubmitType("bill")}
              />{" "}
              Business card (Bill)
            </label>
            <label>
              <input
                type="radio"
                name="submitType"
                checked={submitType === "expense"}
                onChange={() => setSubmitType("expense")}
                style={{ marginLeft: 16 }}
              />{" "}
              Paid personally (Expense)
            </label>
          </div>

          <div style={{ marginTop: 12 }}>
            <button onClick={sendToFreeAgent}>Send to FreeAgent</button>
          </div>
        </>
      )}
    </div>
  );
}
