// The browser tools Meital may call, and the page protocol the API expects.
// A page whose code lacks any of these (an old tab) must not start a conversation:
// the agent would call a tool the page cannot answer ("not defined on client").
export const CLIENT_TOOLS = ['open_payment', 'show_whatsapp', 'save_brief_note', 'switch_ad'];
// Bumped when a page change must not run against the new API (old tabs are refused, then reloaded).
export const PAGE_PROTOCOL = 2;
