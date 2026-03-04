import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DB = process.env.NOTION_DATABASE_ID;
const ADMIN_PASS = process.env.TRACKING_ADMIN_PASS || "";

// ====== 설정 ======
const TARGET_STATUS = "출고준비";
const DEFAULT_LOOKBACK_DAYS = 14;
const UPDATE_DELAY_MS = 350;

// ✅ 미일치 상태 확인(성능 보호)
const MISS_CHECK_DELAY_MS = 120;
const MAX_MISS_STATUS_CHECK = 30;
// ==================

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

// ✅ 접수번호(title)로 노션 직접 조회(미일치 상태 확인용)
async function queryPagesByReceipt(receipt) {
  return await notion.databases.query({
    database_id: NOTION_DB,
    page_size: 5,
    filter: {
      property: "접수번호",
      title: { equals: receipt },
    },
  });
}

// ✅ 노션 페이지 업데이트
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
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    const {
      pass,
      items,
      overwrite = false,
      setDone = true,
      dryRun = true,
      lookbackDays,
      checkMissStatus = false,
    } = body;

    if (!ADMIN_PASS) {
      return res.status(500).json({
        error: "서버 설정 오류: TRACKING_ADMIN_PASS가 설정되지 않았습니다.",
        hint: "Vercel > Settings > Environment Variables 에 TRACKING_ADMIN_PASS를 Production으로 추가한 뒤 Redeploy 하세요."
      });
    }

    if (pass !== ADMIN_PASS) {
      return res.status(401).json({
        error: "운영자 비밀번호가 올바르지 않습니다.",
        hint: "비밀번호를 다시 확인해 주세요."
      });
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
    let ok = 0, miss = 0, duplicated = 0, skipped = 0, updated = 0;

    let missCheckCount = 0;

    for (const it of items) {
      const receipt = String(it.receipt || "").trim();
      const tracking = String(it.tracking || "").trim();
      if (!receipt || !tracking) continue;

      if (dup.has(receipt)) {
        duplicated++;
        results.push({ receipt, tracking, status: "중복(출고준비에서 같은 접수번호 2개 이상)" });
        continue;
      }

      const hit = map.get(receipt);

      // === 미일치 처리 ===
      if (!hit) {
        if (dryRun && checkMissStatus) {
          if (missCheckCount >= MAX_MISS_STATUS_CHECK) {
            miss++;
            results.push({
              receipt,
              tracking,
              status: `미일치(상태 확인 생략: 최대 ${MAX_MISS_STATUS_CHECK}건만 조회)`,
            });
            continue;
          }

          missCheckCount++;

          try {
            const q = await queryPagesByReceipt(receipt);
            await sleep(MISS_CHECK_DELAY_MS);

            const found = q.results || [];

            if (found.length === 0) {
              miss++;
              results.push({ receipt, tracking, status: "미일치(노션에 없음)" });
              continue;
            }

            if (found.length > 1) {
              duplicated++;
              results.push({
                receipt,
                tracking,
                status: `중복(노션에 동일 접수번호 ${found.length}개 존재)`,
              });
              continue;
            }

            const page = found[0];
            const props = page.properties || {};
            const st = getStatusName(props["처리상태"]) || "(상태없음)";
            const existing = getRichText(props["송장번호"]);
            const created = formatKST(page.created_time);

            miss++;
            results.push({
              receipt,
              tracking,
              status: `미일치(노션에는 있음: 처리상태='${st}'${existing ? `, 기존 송장='${existing}'` : ""}${created ? `, 접수=${created}` : ""})`,
            });
            continue;
          } catch {
            miss++;
            results.push({ receipt, tracking, status: "미일치(상태 확인 실패: 잠시 후 다시 시도)" });
            continue;
          }
        }

        miss++;
        results.push({
          receipt,
          tracking,
          status: `미일치(노션에 없음 또는 처리상태가 '${TARGET_STATUS}' 아님)`,
        });
        continue;
      }

      // === 출고준비 일치 ===
      ok++;

      if (dryRun) {
        if (hit.existingTracking && !overwrite) {
          skipped++;
          results.push({ receipt, tracking, status: `건너뜀: 이미 송장번호 있음(${hit.existingTracking})` });
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
          results.push({ receipt, tracking, status: `건너뜀: ${r.reason}` });
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
      missStatusChecked: dryRun && checkMissStatus ? Math.min(missCheckCount, MAX_MISS_STATUS_CHECK) : 0,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
