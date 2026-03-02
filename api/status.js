import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;

// ✅ 너 Notion DB 속성명과 1:1로 맞춰줘야 함 (현재 대화 기준 최종명)
const PROP_RECEIPT = "접수번호";   // Title
const PROP_STATUS  = "처리상태";   // Select
const PROP_TRACK   = "송장번호";   // Text or Rich text

function titleText(p) {
  const t = p?.title || [];
  return t.map(x => x.plain_text || "").join("").trim();
}
function richText(p) {
  const t = p?.rich_text || [];
  return t.map(x => x.plain_text || "").join("").trim();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // ✅ GET/POST 둘 다 허용 (status.html은 GET을 씀)
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const receipt =
    (req.method === "GET" ? req.query?.receipt : req.body?.receipt) || "";

  if (!String(receipt).trim()) {
    return res.status(400).json({ error: "Missing receipt" });
  }

  try {
    const q = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        property: PROP_RECEIPT,
        title: { equals: String(receipt).trim() },
      },
      page_size: 1,
    });

    if (!q.results?.length) {
      return res.status(404).json({ error: "Not found" });
    }

    const page = q.results[0];
    const props = page.properties || {};

    const receiptTitle = titleText(props[PROP_RECEIPT]);
    const statusName = props[PROP_STATUS]?.select?.name || "접수";

    // 송장번호가 Text면 rich_text로 읽히는 경우가 많아서 rich_text 우선
    const trackingNumber =
      richText(props[PROP_TRACK]) ||
      props[PROP_TRACK]?.number?.toString?.() ||
      "";

    return res.status(200).json({
      receipt: receiptTitle,
      status: statusName,
      trackingNumber,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Status lookup failed" });
  }
}
