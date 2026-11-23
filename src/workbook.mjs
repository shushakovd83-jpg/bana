import {excel} from './excel.mjs';

export const workbookKey = 'private/vesna.xlsx';
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Read the previous workbook before the journal. A late writer cannot replace a
// newer workbook if another request has already published a different revision.
export async function syncWorkbook(env, readJournal) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await env.BUCKET.head(workbookKey);
    const {rows, etag} = await readJournal(env);
    const revision = etag || 'empty';
    if (current?.customMetadata?.journal === revision) return;

    const sorted = [...rows].sort((a, b) => b.created.localeCompare(a.created));
    const updated = await env.BUCKET.put(workbookKey, excel(sorted), {
      onlyIf: current ? {etagMatches: current.etag} : {etagDoesNotMatch: '*'},
      httpMetadata: {contentType: workbookType, cacheControl: 'private, no-store'},
      customMetadata: {journal: revision}
    });
    if (updated) return;
  }
  throw Object.assign(new Error('Таблица обновляется. Повторите запрос.'), {status: 503});
}

export async function downloadWorkbook(env, readJournal) {
  await syncWorkbook(env, readJournal);
  const file = await env.BUCKET.get(workbookKey);
  if (!file) throw new Error('Workbook unavailable');
  return new Response(file.body, {headers: {
    'Content-Type': workbookType,
    'Content-Disposition': 'attachment; filename="vesna.xlsx"',
    'Cache-Control': 'private, no-store'
  }});
}
