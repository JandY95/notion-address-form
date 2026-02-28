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

export default async function handler(req, res) {
  try {
    const method = req.method || 'GET';
    if (method !== 'POST' && method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (method === 'POST')
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)
      : {};

    const receiptTitle = (method === 'GET' ? req.query.receiptTitle : body.receiptTitle) || '';
    const last4 = (method === 'GET' ? req.query.last4 : body.last4) || '';

    if (!receiptTitle) return res.status(400).json({ error: 'Missing receiptTitle' });
    if (!/^\d{4}$/.test(String(last4))) return res.status(400).json({ error: 'Missing/Invalid last4' });

    // DB에서 접수번호(Title)로 찾기
    const result = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
        property: '접수번호',
        title: { equals: receiptTitle }
      }
    });

    if (!result.results?.length) {
      return res.status(404).json({ error: '해당 접수번호를 찾을 수 없습니다.' });
    }

    const page = result.results[0];
    const props = page.properties || {};

    const phone = readText(props['연락처']);
    const phoneDigits = digitsOnly(phone);
    const storedLast4 = phoneDigits.slice(-4);

    if (storedLast4 !== String(last4)) {
      return res.status(403).json({ error: '연락처 뒤 4자리가 일치하지 않습니다.' });
    }

    const status = readStatus(props['처리상태']) || '접수';

    // 송장번호(있으면)
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
