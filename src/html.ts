// Shared bits for the HTML the service renders (ops dashboard, escalation email), following the Kira
// design system: near-black plum surfaces, magenta glows and CTAs, white → pink gradient headlines.

// Values shown in ops HTML can come straight from a provider webhook body, so everything is escaped.
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const kira = {
  bg: '#0E0010', bgRaised: '#130113', surface: '#35002F', surfaceGlow: '#780069', nav: '#52012E', navActive: '#5D1A3F',
  magenta: '#D80084', pink: '#FF0085', pinkBright: '#F90F8A', pinkSoft: '#FD6EBD', blush: '#FFF2F9', glow: '#750C57',
  text: '#FFFFFF', textMuted: '#B1ACB1', textSoft: '#C8B0BD',
  border: 'rgba(255,0,133,0.18)', borderSubtle: 'rgba(255,255,255,0.08)',
  display: `Raleway, Quicksand, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`,
  font: `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`,
  mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
} as const;

export const when = (d: Date | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
