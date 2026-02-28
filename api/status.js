import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function readText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('');
  if (prop.type === 'number') return String(prop.number ?? '');
  return '';
}

function readStatus(prop) {
  if (!prop) return '';
  if (prop.type === 'status') return prop.status?.name || '';
  if (prop.type === 'select') return prop.select?.name || '';
  return '';
}

function digitsOnly(v){ return String(v || '').replace(/\D/g,''); }

function extractLast4FromReceipt(receiptTitle){
  const parts = String(receiptTitle || '').split('-');
  const last = parts[parts.length - 1] || '';
  return /^\d{4}$/.test(last) ? last : '';
}

export default async function handler(req, res) {
  try {
    if ((req.method || 'GET') !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'string') ? JSON.parse(req.body) : req.body;
    const receiptTitle = (body?.receiptTitle || '').trim();

    if (!receiptTitle) return res.status(400).json({ error: 'Missing receiptTitle' });

    const last4FromReceipt = extractLast4FromReceipt(receiptTitle);
    if (!last4FromReceipt) {
      return res.status(400).json({ error: '접수번호 형식이 올바르지 않습니다. (마지막 4자리가 숫자여야 해요)' });
    }

    const result = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
        property: '접수번호', // 노션 속성명
        title: { equals: receiptTitle }
      }
    });

    if (!result.results?.length) {
      return res.status(404).json({ error: '해당 접수번호를 찾을 수 없습니다.' });
    }

    const page = result.results[0];
    const props = page.properties || {};

    const phone = readText(props['연락처']); // 노션 속성명
    const storedLast4 = digitsOnly(phone).slice(-4);

    if (storedLast4 !== last4FromReceipt) {
      return res.status(403).json({ error: '접수번호 확인에 실패했습니다. (접수번호를 다시 확인해주세요)' });
    }

    const status = readStatus(props['처리상태']) || '접수'; // 노션 속성명

    let tracking = '';
    if (props['송장번호']) tracking = readText(props['송장번호']);
    if (!tracking && props['운송장번호']) tracking = readText(props['운송장번호']);

    return res.status(200).json({
      success: true,
      receiptTitle,
      status,
      tracking: tracking || '',
      lastEdited: page.last_edited_time || ''
    });
  } catch (e) {
    console.error('status error:', e);
    return res.status(500).json({ error: '조회 중 오류가 발생했습니다.' });
  }
}
