type IconName = 'cloud' | 'settings' | 'back' | 'add' | 'trash' | 'photo' | 'more' | 'copy' | 'download';
const paths: Record<IconName, string> = {
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  photo: 'M3 4h18v16H3zM3 17l5-5 4 4 4-6 5 7M10 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
  cloud: 'M7 18h10a4.5 4.5 0 0 0 .7-8.9A6 6 0 0 0 6 8a5 5 0 0 0 1 10Z',
  settings: 'm9 3-.6 2.3-2 .9-2.2-.6-2 3.5 1.6 1.7v2.4l-1.6 1.7 2 3.5 2.2-.6 2 .9L9 21h6l.6-2.3 2-.9 2.2.6 2-3.5-1.6-1.7v-2.4l1.6-1.7-2-3.5-2.2.6-2-.9L15 3H9Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  back: 'm12 5-7 7 7 7M5 12h14',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  add: 'M12 5v14M5 12h14',
};
export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
