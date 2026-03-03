import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DB = process.env.NOTION_DATABASE_ID;
const ADMIN_PASS = process.env.TRACKING_ADMIN_PASS || "";

// ====== 여기만 보면 됨(설정값) ======
const TARGET_STATUS = "출고준비";     // 이 상태인 건만 반영
const DEFAULT_LOOKBACK_DAYS = 14;     // 최근 N일치에서 출고준비를 모아 매칭(기본 14)
const UPDATE_DELAY_MS = 350;          // Notion API 속도 제한 대비
// ====================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function ymdKST() {
  const d = kstNow();
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
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

function getStatusName(prop) {
  try {
    return prop?.status?.name || "";
  } catch {
    return "";
  }
}

// ✅ "출고준비" + 최근 N일만 모아서 접수번호 맵 생성
async function buildReceiptMap(lookbackDays) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const map = new Map(); // receipt -> { pageId, existingTracking }
  const dup = new Set();

  let cursor = undefined;
  while (true) {
    const resp = await notion.databases.query({
      database_id: NOTION_DB,
      page_size: 100,
      start_cursor: cursor,
      filter: {
        and: [
          { property: "접수일시", created_time: { on_or_after: since } },
          { property: "처리상태", status: { equals: TARGET_STATUS } },
        ],
      },
    });

    for (const page of resp.results || []) {
      const props = page.properties || {};
      const receipt = getTitleText(props["접수번호"]);
      if (!receipt) continue;

      if (map.has(receipt)) {
        dup.add(receipt);
      } else {
        const existingTracking = getRichText(props["송장번호"]);
        map.set(receipt, { pageId: page.id, existingTracking });
      }
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  return { map, dup };
}

// ✅ 노션 페이지 업데이트(추가 retrieve 없이 기존값 판단 가능)
async function updateTracking({ pageId, trackingNo, setDone, overwrite, existingTracking }) {
  if (existingTracking && !overwrite) {
    return { updated: false, reason: "이미 송장번호가 있음", existing: existingTracking };
  }

  const newProps = {
    송장번호: { rich_text: [{ text: { content: trackingNo } }] },
  };

  if (setDone) {
    newProps["처리상태"] = { status: { name: "출고완료" } };
    newProps["출고일시"] = { date: { start: ymdKST() } };
  }

  await notion.pages.update({
    page_id: pageId,
    properties: newProps,
  });

  return { updated: true };
}

export default async function handler(req, res) {
  // CORS(필요 시)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      pass,
      items,
      overwrite = false,
      setDone = true,
      dryRun = true,
      lookbackDays,
    } = req.body || {};

    if (!ADMIN_PASS || pass !== ADMIN_PASS) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!NOTION_DB) {
      return res.status(500).json({ error: "Missing NOTION_DATABASE_ID" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items is empty" });
    }

    const lb = Number.isFinite(Number(lookbackDays))
      ? Number(lookbackDays)
      : DEFAULT_LOOKBACK_DAYS;

    const { map, dup } = await buildReceiptMap(lb);

    const results = [];
    let ok = 0,
      miss = 0,
      duplicated = 0,
      skipped = 0,
      updated = 0;

    for (const it of items) {
      const receipt = String(it.receipt || "").trim();
      const tracking = String(it.tracking || "").trim();
      if (!receipt || !tracking) continue;

      // 중복
      if (dup.has(receipt)) {
        duplicated++;
        results.push({
          receipt,
          tracking,
          status: "중복(출고준비에서 같은 접수번호 2개 이상)",
        });
        continue;
      }

      // ✅ 출고준비 맵에서만 찾는다 (즉, 출고준비가 아니면 매칭 안 됨)
      const hit = map.get(receipt);
      if (!hit) {
        miss++;
        results.push({
          receipt,
          tracking,
          status: `미일치(노션에 없음 또는 처리상태가 '${TARGET_STATUS}' 아님)`,
        });
        continue;
      }

      ok++;

      if (dryRun) {
        // 미리보기에서도 "이미 송장 있음" 안내
        if (hit.existingTracking && !overwrite) {
          skipped++;
          results.push({
            receipt,
            tracking,
            status: `건너뜀: 이미 송장번호 있음(${hit.existingTracking})`,
          });
        } else {
          results.push({ receipt, tracking, status: "일치(적용 가능)" });
        }
      } else {
        const r = await updateTracking({
          pageId: hit.pageId,
          trackingNo: tracking,
          setDone,
          overwrite,
          existingTracking: hit.existingTracking,
        });

        if (r.updated) {
          updated++;
          results.push({ receipt, tracking, status: "업데이트 완료" });
        } else {
          skipped++;
          results.push({
            receipt,
            tracking,
            status: `건너뜀: ${r.reason}`,
          });
        }

        await sleep(UPDATE_DELAY_MS);
      }
    }

    return res.status(200).json({
      success: true,
      dryRun,
      lookbackDays: lb,
      summary: { ok, miss, duplicated, updated, skipped },
      results,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
