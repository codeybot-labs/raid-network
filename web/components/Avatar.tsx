const PALETTES = [
  ['#c8ff4d', '#44e1ff'], ['#ff4fa3', '#8b5cf6'], ['#44e1ff', '#8b5cf6'], ['#ffb84d', '#ff4fa3'],
  ['#7dffb0', '#c8ff4d'], ['#b79cff', '#44e1ff'], ['#ff7a59', '#ffcf4d'],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export default function Avatar(props: { name: string; src?: string; size?: number }) {
  const size = () => props.size ?? 44;
  const pal = () => PALETTES[hash(props.name) % PALETTES.length];
  const initials = () => props.name.replace(/[^A-Za-z0-9]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div class="avatar" style={{ width: `${size()}px`, height: `${size()}px`, 'font-size': `${size() * 0.36}px`,
      background: `linear-gradient(135deg, ${pal()[0]}, ${pal()[1]})`, 'border-radius': `${size() * 0.32}px` }}>
      {props.src ? <img src={props.src} alt="" /> : initials()}
    </div>
  );
}
