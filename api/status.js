import { Client } from "@notionhq/client";
import {
  createLimiterStore,
  denyIfCrossOrigin,
  getClientIp,
  isRateLimited,
  setCommonSecurityHeaders,
} from "./_security.js";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;
const statusLimiter = createLimiterStore();

const PROP_RECEIPT = "접수번호";
const PROP_STATUS = "처리상태";
const PROP_TRACK = "송장번호";
const RECEIPT_PATTERN = /^\d{6}-\d{6}-.{1,40}-\d{4}$/;

function titleText(p) {
  const t = p?.title || [];
  return t.map((x) => x.plain_text || "").join("").trim();
}

function richText(p) {
  const t = p?.rich_text || [];
  return t.map((x) => x.plain_text || "").join("").trim();
}

export default async function handler(req, res) {
  setCommonSecurityHeaders(res);

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (denyIfCrossOrigin(req, res)) return;

  const ip = getClientIp(req);
  if (isRateLimited(statusLimiter, `status:${ip}`, 60, 10 * 60 * 1000)) {
    return res.status(429).json({
      error: "TOO_MANY_REQUESTS",
      message: "조회 요청이 많아요. 잠시 후 다시 시도해 주세요.",
    });
  }

  const receipt = String(req.method === "GET" ? req.query?.receipt : req.body?.receipt || "").trim();

  if (!receipt) {
    return res.status(400).json({ error: "Missing receipt" });
  }

  if (receipt.length > 80 || !RECEIPT_PATTERN.test(receipt)) {
    return res.status(400).json({
      error: "INVALID_RECEIPT",
      message: "접수번호 형식을 다시 확인해 주세요.",
    });
  }

  try {
    const q = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        property: PROP_RECEIPT,
        title: { equals: receipt },
      },
      page_size: 1,
    });

    if (!q.results?.length) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "입력하신 접수번호를 찾을 수 없어요.",
      });
    }

    const page = q.results[0];
    const props = page.properties || {};

    const receiptTitle = titleText(props[PROP_RECEIPT]);
    const statusName = props[PROP_STATUS]?.status?.name || props[PROP_STATUS]?.select?.name || "접수";
    const trackingNumber = richText(props[PROP_TRACK]) || props[PROP_TRACK]?.number?.toString?.() || "";

    return res.status(200).json({
      receipt: receiptTitle,
      status: statusName,
      trackingNumber,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "LOOKUP_FAILED",
      message: "조회 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.",
    });
  }
}
