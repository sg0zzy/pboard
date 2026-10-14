import type { CSSProperties } from 'react';
import { getCardTypeDefinition, note } from '../../../../src/templates/boardTemplates';
import type { BoardItemType, BoardTemplate } from '../../../../src/types';

export function cardColors(template?: BoardTemplate, type?: BoardItemType): CSSProperties {
  const definition = template && type ? getCardTypeDefinition(template, type) : note;
  return { '--card-accent': definition.color, '--card-tint': definition.tint } as CSSProperties;
}
