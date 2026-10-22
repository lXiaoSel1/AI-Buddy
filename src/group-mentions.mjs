// Text ranges retain the chosen character ID even when two members share a name.
const nameOf = c => String(c?.effective?.displayName || c?.effective?.name || c?.name || c?.id || '');
const boundaryBefore = c => !c || !/[A-Za-z0-9_.@+-]/.test(c);
const boundaryAfter = c => !c || !/[A-Za-z0-9_]/.test(c);
export function mentionQuery(text, caret) {
  const end = Math.max(0, Math.min(text.length, caret ?? text.length));
  const start = text.lastIndexOf('@', end - 1);
  if (start < 0 || !boundaryBefore(text[start - 1])) return null;
  const query = text.slice(start + 1, end);
  return query.length <= 80 && !/[\r\n@]/.test(query) ? {start, end, query} : null;
}
export function mentionCandidates(characters, query = '') {
  const key = query.toLocaleLowerCase().trim();
  return characters.filter(c => (nameOf(c) + ' ' + c.id).toLocaleLowerCase().includes(key));
}
export function updateMentionBindings(before, after, bindings = []) {
  let start = 0, end = before.length, nextEnd = after.length;
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const shift = nextEnd - end;
  return bindings.flatMap(b => b.end <= start ? [b] : b.start >= end ? [{...b, start:b.start + shift, end:b.end + shift}] : []);
}
export function insertMention(text, query, character, bindings = []) {
  const token = '@' + nameOf(character), value = text.slice(0, query.start) + token + ' ' + text.slice(query.end);
  const kept=bindings.filter(b=>b.end<=query.start||b.start>=query.end);
  return {text:value, caret:query.start + token.length + 1, bindings:[...updateMentionBindings(text,value,kept), {id:character.id,start:query.start,end:query.start + token.length}]};
}
export function resolveMentionIds(text, characters, bindings = []) {
  const result = [], occupied = [], add = id => { if (!result.includes(id)) result.push(id); };
  for (const b of Array.isArray(bindings) ? bindings : []) {
    const c = characters.find(c => c.id === b.id);
    if (!c || !Number.isInteger(b.start) || !Number.isInteger(b.end) || b.start < 0 || b.end > text.length) continue;
    if (text.slice(b.start,b.end).toLocaleLowerCase() !== ('@' + nameOf(c)).toLocaleLowerCase() || !boundaryBefore(text[b.start-1]) || !boundaryAfter(text[b.end])) continue;
    occupied.push([b.start,b.end]); add(c.id);
  }
  const ordered = characters.map(c => ({id:c.id,name:nameOf(c)})).filter(c => c.name).sort((a,b)=>b.name.length-a.name.length);
  const lower = text.toLocaleLowerCase();
  for (let start=lower.indexOf('@');start>=0;start=lower.indexOf('@',start+1)) {
    if (!boundaryBefore(text[start-1]) || occupied.some(([a,b])=>start>=a&&start<b)) continue;
    const match=ordered.filter(c=>lower.startsWith(c.name.toLocaleLowerCase(),start+1)&&boundaryAfter(text[start+1+c.name.length]));
    if (!match.length) continue;
    const longest=match.filter(c=>c.name.length===match[0].name.length);
    if (longest.length===1) add(longest[0].id); // Ambiguous names require selection from the menu.
  }
  return result;
}
