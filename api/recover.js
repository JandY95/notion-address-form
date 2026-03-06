import { Client } from "@notionhq/client";
import {
  createLimiterStore,
  denyIfCrossOrigin,
  digitsOnly,
  getClientIp,
  isRateLimited,
  normalizeText,
  setCommonSecurityHeaders,
} from "./_security.js";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DB = process.env.NOTION_DATABASE_ID;
const recoverLimiter = createLimiterStore();

const DATE_PROP_NAME = "접수일시";
const NAME_PROP_NAME = "고객명";
const PHONE_PROP_NAME = "연락처";
const RECEIPT_PROP_NAME = "접수번호";
const MAX_RETURN = 5;
const PAGE_SIZE = 100;

function normName(v) {
  return normalizeText(v, 40).replace(/\s+/g, "");
}

function getTitleText(prop) {
  try {
    const t = prop?.title || [];
    return t.map((x) => x.plain_text).join("").trim();
  } catch {
    return "";
  }
}

function getRichText(prop) {
  try {
    const rt = prop?.rich_text || [];
    return rt.map((x) => x.plain_text).join("").trim();
  } catch {
    return "";
  }
}

function formatKST(iso) {
  try {
    const d = new Date(iso);
    const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const yy = k.getUTCFullYear();
    const mm = String(k.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(k.getUTCDate()).padStart(2, "0");
    const hh = String(k.getUTCHours()).padStart(2, "0");
    const mi = String(k.getUTCMinutes()).padStart(2, "0");
    return `${yy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "";
  }
}

function maskPhone(phoneDigits) {
  if (!phoneDigits) return "";
  const d = String(phoneDigits);
  const last4 = d.slice(-4).padStart(4, "*");
  const head = d.slice(0, 3);
  return `${head}****${last4}`;
}

function makeDayRangeISO(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+09:00`);
  const end = new Date(`${dateStr}T00:00:00+09:00`);
  end.setDate(end.getDate() + 1);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export default async function handler(req, res) {
  setCommonSecurityHeaders(res);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (denyIfCrossOrigin(req, res)) return;

  const ip = getClientIp(req);
  if (isRateLimited(recoverLimiter, `recover:${ip}`, 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "조회 요청이 많아요. 잠시 후 다시 시도해 주세요." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const name = normalizeText(body.name, 40);
    const phone = normalizeText(body.phone, 20);
    const date = normalizeText(body.date, 20);

    if (!NOTION_DB) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID" });
    if (!name || !phone || !date) {
      return res.status(400).json({ error: "Missing fields (name, phone, date)" });
    }

    const inputName = normName(name);
    const inputPhone = digitsOnly(phone);

    if (inputName.length < 2) {
      return res.status(400).json({ error: "Name too short" });
    }
    if (inputPhone.length < 9 || inputPhone.length > 11) {
      return res.status(400).json({ error: "Invalid phone number" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: "Invalid date format (YYYY-MM-DD)" });
    }

    const { startISO, endISO } = makeDayRangeISO(date);
    let cursor = undefined;
    const hits = [];

    while (true) {
      const resp = await notion.databases.query({
        database_id: NOTION_DB,
        page_size: PAGE_SIZE,
        start_cursor: cursor,
        filter: {
          and: [
            { property: DATE_PROP_NAME, created_time: { on_or_after: startISO } },
            { property: DATE_PROP_NAME, created_time: { before: endISO } },
          ],
        },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
      });

      for (const page of resp.results || []) {
        const props = page.properties || {};
        const receipt = getTitleText(props[RECEIPT_PROP_NAME]);
        if (!receipt) continue;

        const savedName = normName(getRichText(props[NAME_PROP_NAME]));
        const savedPhoneDigits = digitsOnly(getRichText(props[PHONE_PROP_NAME]));

        if (savedName !== inputName) continue;
        if (savedPhoneDigits !== inputPhone) continue;

        hits.push({
          receipt,
          createdKST: formatKST(page.created_time),
          phoneMasked: maskPhone(savedPhoneDigits),
        });

        if (hits.length >= MAX_RETURN) break;
      }

      if (hits.length >= MAX_RETURN) break;
      if (!resp.has_more) break;
      cursor = resp.next_cursor;
    }

    return res.status(200).json({
      success: true,
      count: hits.length,
      items: hits,
      truncated: hits.length >= MAX_RETURN,
    });
  } catch (e) {
    console.error("recover error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
