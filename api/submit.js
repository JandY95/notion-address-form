import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function getKoreanDateTimeParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const yy = parts.find(p => p.type === 'year')?.value || '00';
  const mm = parts.find(p => p.type === 'month')?.value || '00';
  const dd = parts.find(p => p.type === 'day')?.value || '00';
  const hh = parts.find(p => p.type === 'hour')?.value || '00';
  const mi = parts.find(p => p.type === 'minute')?.value || '00';
  const ss = parts.find(p => p.type === 'second')?.value || '00';

  return { yy, mm, dd, hh, mi, ss };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const {
      customerName,
      phone,
      postcode,
      baseAddress,
      detailAddress,
      fullAddress,
      request,
      website
    } = body;

    // 허니팟(봇 방지)
    if (website) return res.status(400).json({ error: 'Invalid request' });

    if (!customerName || !phone || !postcode || !baseAddress || !fullAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { yy, mm, dd, hh, mi, ss } = getKoreanDateTimeParts();

    const cleanName = String(customerName).trim().replace(/\s+/g, '');
    const phoneDigits = String(phone).replace(/\D/g, '');
    const phoneLast4 = phoneDigits.slice(-4).padStart(4, '0');

    // 예: 260226-153045-홍길동-5678
    const receiptTitle = `${yy}${mm}${dd}-${hh}${mi}${ss}-${cleanName}-${phoneLast4}`;

    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        접수번호: { title: [{ text: { content: receiptTitle } }] },
        고객명: { rich_text: [{ text: { content: customerName } }] },
        연락처: { rich_text: [{ text: { content: phone } }] },
        우편번호: { rich_text: [{ text: { content: postcode } }] },
        기본주소: { rich_text: [{ text: { content: baseAddress } }] },
        상세주소: { rich_text: [{ text: { content: detailAddress || '' } }] },
        전체주소: { rich_text: [{ text: { content: fullAddress } }] },
        요청사항: { rich_text: [{ text: { content: request || '' } }] },
        처리상태: { status: { name: '접수' } }
      }
    });

    return res.status(200).json({ success: true, receiptTitle });
  } catch (e) {
    console.error('Notion save error:', e);
    return res.status(500).json({ error: '저장 실패' });
  }
}
