import { Client } from "@notionhq/client";
import {
  createLimiterStore,
  denyIfCrossOrigin,
  getClientIp,
  isRateLimited,
  isValidKoreanPhone,
  normalizeText,
  setCommonSecurityHeaders,
} from "./_security.js";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const submitLimiter = createLimiterStore();

function getKoreanDateTimeParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const yy = parts.find((p) => p.type === "year")?.value || "00";
  const mm = parts.find((p) => p.type === "month")?.value || "00";
  const dd = parts.find((p) => p.type === "day")?.value || "00";
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mi = parts.find((p) => p.type === "minute")?.value || "00";
  const ss = parts.find((p) => p.type === "second")?.value || "00";

  return { yy, mm, dd, hh, mi, ss };
}

export default async function handler(req, res) {
  setCommonSecurityHeaders(res);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (denyIfCrossOrigin(req, res)) return;

  const ip = getClientIp(req);
  if (isRateLimited(submitLimiter, `submit:${ip}`, 12, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const customerName = normalizeText(body.customerName, 40);
    const phone = normalizeText(body.phone, 20);
    const postcode = normalizeText(body.postcode, 10);
    const baseAddress = normalizeText(body.baseAddress, 140);
    const detailAddress = normalizeText(body.detailAddress, 140);
    const request = normalizeText(body.request, 300);
    const website = normalizeText(body.website, 120);

    if (website) {
      return res.status(400).json({ error: "Invalid request" });
    }

    if (!customerName || !phone || !postcode || !baseAddress || !detailAddress) {
      return res.status(400).json({ error: "입력되지 않은 필수 항목이 있어요." });
    }

    if (customerName.length < 2) {
      return res.status(400).json({ error: "성함을 다시 확인해 주세요." });
    }

    if (!isValidKoreanPhone(phone)) {
      return res.status(400).json({ error: "연락처 형식을 다시 확인해 주세요." });
    }

    if (!/^\d{5}$/.test(postcode)) {
      return res.status(400).json({ error: "우편번호를 다시 확인해 주세요." });
    }

    const { yy, mm, dd, hh, mi, ss } = getKoreanDateTimeParts();
    const cleanName = customerName.replace(/\s+/g, "");
    const phoneDigits = phone.replace(/\D/g, "");
    const phoneLast4 = phoneDigits.slice(-4).padStart(4, "0");
    const receiptTitle = `${yy}${mm}${dd}-${hh}${mi}${ss}-${cleanName}-${phoneLast4}`;

    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        접수번호: { title: [{ text: { content: receiptTitle } }] },
        고객명: { rich_text: [{ text: { content: customerName } }] },
        연락처: { rich_text: [{ text: { content: phone } }] },
        우편번호: { rich_text: [{ text: { content: postcode } }] },
        기본주소: { rich_text: [{ text: { content: baseAddress } }] },
        상세주소: { rich_text: [{ text: { content: detailAddress } }] },
        요청사항: { rich_text: [{ text: { content: request || "" } }] },
        처리상태: { status: { name: "접수" } },
      },
    });

    return res.status(200).json({ success: true, receiptTitle });
  } catch (e) {
    console.error("Notion save error:", e);
    return res.status(500).json({ error: "접수 저장 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요." });
  }
}
