// lib/html-escape.ts
// Telegram pings are sent with parse_mode "HTML": a stray `<` or `&` in free
// text (an email, a hand-typed cell, an error message) makes Telegram reject
// the whole message. Escape anything interpolated into one.
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
