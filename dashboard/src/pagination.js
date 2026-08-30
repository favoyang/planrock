export async function fetchAllPages(fetchPage, collection, limit = 200) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 10000; pageNumber += 1) {
    const page = await fetchPage(collection, cursor, Math.min(Math.max(1, limit), 200));
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seen.has(page.nextCursor)) throw new Error(`Planrock API repeated a ${collection} cursor`);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`Planrock API returned too many ${collection} pages`);
}
