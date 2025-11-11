export const runtime = 'nodejs';

/**
 * Create a FreeAgent Bill with the receipt attached.
 * Expects form fields from the review screen.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const payload = {
      bill: {
        contact: val(form.get('contact_url')), // optional
        dated_on: val(form.get('date')) || new Date().toISOString().slice(0, 10),
        currency: 'GBP',
        total_value: val(form.get('total')),
        sales_tax_value: val(form.get('vat_amount')),
        reference: val(form.get('merchant')) || 'Receipt',
        comments: 'Created via receipt uploader',
        attachment: {
          file_name: val(form.get('file_name')) || 'receipt.jpg',
          content_type: val(form.get('file_type')) || 'image/jpeg',
          data: String(form.get('file_data') || ''),
        },
      },
    };

    if (!process.env.FREEAGENT_ACCESS_TOKEN) {
      return json({ error: 'Missing FREEAGENT_ACCESS_TOKEN (.env.local)' }, 500);
    }

    const faRes = await fetch('https://api.freeagent.com/v2/bills', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FREEAGENT_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'receipt-uploader/1.0',
      },
      body: JSON.stringify(payload),
    });

    const faJson = await faRes.json();
    if (!faRes.ok) {
      return json({ error: 'FreeAgent API error', detail: faJson }, faRes.status);
    }

    return json({ ok: true, bill_url: faJson?.bill?.url || 'Created' });
  } catch (e: any) {
    return json({ error: e?.message || 'Create failed' }, 500);
  }
}

/* -------------------- helpers -------------------- */

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function val(v: FormDataEntryValue | null | undefined) {
  const s = v == null ? '' : String(v);
  return s.trim() ? s.trim() : undefined;
}
