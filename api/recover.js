import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DB = process.env.NOTION_DATABASE_ID;

// ===== 설정 =====
const DATE_PROP_NAME = "접수일시";     // Notion의 created_time 속성명
const NAME_PROP_NAME = "고객명";       // rich_text
const PHONE_PROP_NAME = "연락처";      // rich_text
const RECEIPT_PROP_NAME = "접수번호"; // title
const BASE_ADDR_PROP = "기본주소";     // rich_text (있으면)
const DETAIL_ADDR_PROP = "상세주소";   // rich_text (있으면)
const REQUEST_PROP = "요청사항";       // rich_text (있으면)

const MAX_RETURN = 5;                 // 같은 날짜에 여러 건 있어도 최대 5건만 노출
const PAGE_SIZE = 100;                // Notion query page size
// ==================

function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}

function normName(v) {
  return String(v || "").trim().replace(/\s+/g, "");
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

// phone 마스킹: 010****1234 형태
function maskPhone(phoneDigits) {
  if (!phoneDigits) return "";
  const d = String(phoneDigits);
  const last4 = d.slice(-4).padStart(4, "*");
  const head = d.slice(0, 3);
  return `${head}****${last4}`;
}

// 날짜(YYYY-MM-DD) → KST 기준 하루 범위 ISO(UTC)
function makeDayRangeISO(dateStr) {
  // ex: "2026-03-06"
  const start = new Date(`${dateStr}T00:00:00+09:00`);
  const end = new Date(`${dateStr}T00:00:00+09:00`);
  end.setDate(end.getDate() + 1);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export default async function handler(req, res) {
  // CORS (원하면 제한 가능)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { name, phone, date } = body;

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

    // 1) 접수일(하루 범위)로 먼저 좁혀서 가져오고
    // 2) 서버에서 이름/연락처(숫자)로 최종 매칭
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

        const baseAddress = getRichText(props[BASE_ADDR_PROP]);
        const detailAddress = getRichText(props[DETAIL_ADDR_PROP]);
        const request = getRichText(props[REQUEST_PROP]);

        hits.push({
          receipt,
          createdKST: formatKST(page.created_time),
          // 개인정보는 화면에서 과하게 노출되지 않게 일부 마스킹
          phoneMasked: maskPhone(savedPhoneDigits),
          baseAddress,
          detailAddress,
          request,
        });

        if (hits.length >= MAX_RETURN) break;
      }

      if (hits.length >= MAX_RETURN) break;
      if (!resp.has_more) break;
      cursor = resp.next_cursor;
    }

    // 결과가 0이어도 “없음” 이상의 힌트는 최소화 (개인정보 보호)
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
