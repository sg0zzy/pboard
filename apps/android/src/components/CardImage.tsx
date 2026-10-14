import { useEffect, useState } from 'react';
import type { StoredBlob } from '../../../../src/storage/blobStore';
import type { BoardItem } from '../storage/repository';
import { thumbnailBlob } from '../images/thumbnail';

export type ImageLoader = (id: string) => Promise<StoredBlob | null>;
export type CardPhoto = Pick<BoardItem, 'imageId' | 'image' | 'imageWidth' | 'imageHeight'>;
export function CardImage({ card, getImage, thumbnail = false, alt = 'Card photo' }: { card: CardPhoto; getImage?: ImageLoader; thumbnail?: boolean; alt?: string }) {
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const key = `${card.imageId ?? card.image?.dataUrl ?? ''}:${thumbnail}`;
  useEffect(() => {
    let active = true; let url: string | undefined;
    setFailed(false);
    async function load() {
      const blob = card.image ? await (await fetch(card.image.dataUrl)).blob() : card.imageId && getImage ? (await getImage(card.imageId))?.blob : null;
      if (!blob) throw new Error('Photo unavailable.');
      const picture = thumbnail ? await thumbnailBlob(blob).catch(() => blob) : blob;
      if (!active) return;
      url = URL.createObjectURL(picture); setPreview({ key, url });
    }
    void load().catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [key, card.image, card.imageId, thumbnail, getImage]);
  return preview?.key === key && !failed ? <img className={`card-photo${thumbnail ? ' card-photo--thumbnail' : ''}`} src={preview.url} alt={alt} draggable={false} loading="lazy" onError={() => setFailed(true)} /> : <span className="photo-placeholder" role="status">{failed ? 'Photo unavailable' : 'Loading photo…'}</span>;
}
