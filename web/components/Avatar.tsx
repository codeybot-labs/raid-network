import { Avatar as UiAvatar } from './ui/avatar';

// Showdown-palette fallbacks: solid red / blue / ink / deep blue / gold tiles with white initials.
const PALETTE = ['#d4101f', '#1c4fd8', '#14122b', '#1536b8', '#b80d1a', '#c48700'];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export default function Avatar(props: { name: string; src?: string; size?: number; ring?: string }) {
  const size = () => props.size ?? 44;
  const initials = () => props.name.replace(/[^A-Za-z0-9]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <UiAvatar src={props.src} fallback={initials()} style={{
      width: `${size()}px`, height: `${size()}px`, 'font-size': `${size() * 0.36}px`, 'border-radius': `${size() * 0.32}px`,
      background: PALETTE[hash(props.name) % PALETTE.length], ...(props.ring ? { 'box-shadow': `0 0 0 3px ${props.ring}` } : {}),
    }} />
  );
}
