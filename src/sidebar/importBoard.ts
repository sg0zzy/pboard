import { strFromU8, unzipSync } from 'fflate';
import { BOARD_ITEM_STATUSES, BOARD_ITEM_TYPES, BOARD_TEMPLATES, type BoardImage, type BoardItem, type BoardTemplate } from '../types';
import { normalizeCardDisplayMode } from '../cardDisplayModes';
import { isTypeSupported } from '../templates/boardTemplates';
import type { repository } from '../storage/browser';

export const MAX_BOARD_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml' };
type Card = Pick<BoardItem, 'type' | 'status' | 'content' | 'title' | 'displayMode' | 'source' | 'image'>;
export type ImportedBoard = { name: string; template: BoardTemplate; cards: Card[]; legacy: boolean };
const invalid = () => new Error('This is not a supported Pboard board ZIP. Choose a file saved with Download board.');
const text = (value: unknown, max = 1024 * 1024): string => {
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
};

/** Parse and validate everything before creating any local board. IDs, grants,
 * signatures and remote bindings are deliberately never imported. */
export async function readBoardArchive(data: Uint8Array): Promise<ImportedBoard> {
  if (data.length > MAX_BOARD_IMPORT_BYTES) throw new Error('Board ZIP exceeds the 25 MB import limit.');
  let total = 0, count = 0;
  const names = new Set<string>();
  const files = unzipSync(data, { filter(file) {
    if (++count > 2000 || names.has(file.name) || file.name.includes('..') || file.name.startsWith('/')) throw invalid();
    names.add(file.name);
    if (file.name !== 'board.json' && file.name !== 'board.txt' && !/^images\/[^/]+$/.test(file.name)) return false;
    total += file.originalSize;
    if (total > MAX_EXPANDED_BYTES) throw new Error('Expanded board ZIP exceeds the 64 MB import limit.');
    return true;
  } });
  async function image(path: string, width?: unknown, height?: unknown): Promise<BoardImage> {
    const bytes = files[path], mimeType = mimeTypes[path.split('.').at(-1)!.toLowerCase()];
    if (!/^images\/[^/]+$/.test(path) || !bytes || !mimeType) throw invalid();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    let dimensions = { width: 1, height: 1 };
    if (typeof width === 'number' && Number.isFinite(width) && width > 0 && typeof height === 'number' && Number.isFinite(height) && height > 0) dimensions = { width, height };
    else if (typeof createImageBitmap === 'function') {
      const decoded = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType })).catch(() => null);
      if (decoded) { dimensions = { width: decoded.width, height: decoded.height }; decoded.close(); }
    }
    return { dataUrl: `data:${mimeType};base64,${btoa(binary)}`, mimeType, ...dimensions };
  }
  if (files['board.json']) {
    const value = JSON.parse(strFromU8(files['board.json']));
    if (!value || value.format !== 'pboard-download' || value.version !== 1 || !BOARD_TEMPLATES.includes(value.template)
      || !Array.isArray(value.cards) || value.cards.length > 1000) throw invalid();
    const name = text(value.name, 1000).trim(); if (!name) throw invalid();
    const cards: Card[] = [];
    for (const card of value.cards) {
      if (!card || !BOARD_ITEM_TYPES.includes(card.type) || !BOARD_ITEM_STATUSES.includes(card.status) || card.status === 'trash') throw invalid();
      const source = card.source;
      if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source))) throw invalid();
      cards.push({ type: card.type, status: card.status, content: text(card.content),
        ...(card.title !== undefined ? { title: text(card.title) } : {}), displayMode: normalizeCardDisplayMode(card.displayMode),
        ...(source ? { source: Object.fromEntries(['provider', 'conversationUrl', 'sourceText'].filter(k => source[k] !== undefined).map(k => [k, text(source[k])])) } : {}),
        ...(card.imagePath !== undefined ? { image: await image(text(card.imagePath, 1000), card.imageWidth, card.imageHeight) } : {}) });
    }
    return { name, template: value.template, cards, legacy: false };
  }
  if (!files['board.txt']) throw invalid();
  const prompt = strFromU8(files['board.txt']).replace(/\r\n/g, '\n');
  if (!prompt.startsWith('PROJECT: ')) throw invalid();
  const boundary = prompt.indexOf('\n\n');
  const name = text((boundary < 0 ? prompt.slice(9) : prompt.slice(9, boundary)).trim(), 1000);
  if (!name) throw invalid();
  const body = boundary < 0 ? '' : prompt.slice(boundary + 2);
  const cards: Card[] = [];
  const tags = [...body.matchAll(/(?:^|\n\n)\[([a-z_]+)\] \[([^\]\n]+)\] /g)];
  if (body.trim() && (!tags.length || tags[0].index !== 0)) throw invalid();
  for (const [i, tag] of tags.entries()) {
    const type = tag[1] === 'idea' ? 'core_idea' : tag[1];
    const status = tag[2];
    if (!BOARD_ITEM_TYPES.includes(type as Card['type']) || !BOARD_ITEM_STATUSES.includes(status as Card['status']) || status === 'trash') throw invalid();
    cards.push({ type: type as Card['type'], status: status as Card['status'], content: text(body.slice(tag.index! + tag[0].length, tags[i + 1]?.index ?? body.length)) });
  }
  const template = [...BOARD_TEMPLATES].sort((a, b) => cards.filter(c => isTypeSupported(b, c.type)).length - cards.filter(c => isTypeSupported(a, c.type)).length)[0];
  // Older ZIPs have no card/image mapping: preserve every image as a separate card.
  for (const path of Object.keys(files).filter(p => p.startsWith('images/'))) cards.push({ type: isTypeSupported(template, 'reference') ? 'reference' : 'note', status: 'candidate', content: '', image: await image(path) });
  if (cards.length > 1000) throw invalid();
  return { name, template, cards, legacy: true };
}

export async function importBoardCopy(board: ImportedBoard, target: Pick<typeof repository, 'importLocalBoard'>) {
  return target.importLocalBoard(board.name, board.template, board.cards);
}
