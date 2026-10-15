// links.ts — opening web pages in your default browser.
//   openLink:    pages the assistant opens by itself ("play lofi", "google X").
//                Built by the backend from your words, never typed by the LLM,
//                and checked again here: only YouTube watch/search pages and
//                Google search results, over https.
//   openWebLink: a link *you* clicked in the chat (a search answer's sources):
//                any plain https web page.

import { shell } from "electron";
import { log } from "./log";

const ALLOWED: Record<string, string[]> = {
  "www.youtube.com": ["/watch", "/results"],
  "www.google.com": ["/search"], // "google best biryani in Hyderabad"
};

export function isAllowedLink(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const paths = ALLOWED[url.hostname];
  if (!paths || !paths.includes(url.pathname)) return false;
  if (url.pathname === "/watch") return /^[\w-]{6,20}$/.test(url.searchParams.get("v") ?? "");
  if (url.hostname === "www.google.com") return !!url.searchParams.get("q");
  return !!url.searchParams.get("search_query");
}

// Swappable for the self-test, so it doesn't open real browser tabs.
let opener: (url: string) => Promise<void> = (url) => shell.openExternal(url);
export function setLinkOpener(fn: (url: string) => Promise<void>): void {
  opener = fn;
}

/**
 * A web page you chose to open yourself (a search answer's source link in
 * the chat panel): any ordinary https page, nothing else (no file:, no app
 * protocols, no logins in the URL, no bare IPs or local addresses).
 */
export function isSafeWebLink(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return false;
  return true;
}

export async function openWebLink(raw: unknown): Promise<boolean> {
  if (!isSafeWebLink(raw)) {
    log("refused to open link:", String(raw).slice(0, 120));
    return false;
  }
  try {
    await opener(raw as string);
    return true;
  } catch (err) {
    log("couldn't open link:", String(err));
    return false;
  }
}

export async function openLink(raw: unknown): Promise<boolean> {
  if (!isAllowedLink(raw)) {
    log("refused to open link:", String(raw).slice(0, 120));
    return false;
  }
  try {
    await opener(raw as string);
    return true;
  } catch (err) {
    log("couldn't open link:", String(err));
    return false;
  }
}
