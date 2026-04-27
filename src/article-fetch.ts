// Fetches an external article URL referenced from a LinkedIn share, strips
// boilerplate, and returns clean main text. Used to recover full content for
// LinkedIn article-share posts where the post body itself is just a teaser.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function fetchArticleBody(url: string, timeoutMs = 12000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    const html = await res.text();
    return extractMainText(html);
  } catch {
    return null;
  }
}

export function extractMainText(html: string): string {
  let s = html;

  // Drop heavy non-content blocks
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<header[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  s = s.replace(/<form[\s\S]*?<\/form>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Prefer <article> or <main> if present (much cleaner)
  const article = s.match(/<article[\s\S]*?<\/article>/i)?.[0];
  const main = s.match(/<main[\s\S]*?<\/main>/i)?.[0];
  if (article && article.length > 500) s = article;
  else if (main && main.length > 500) s = main;

  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, " ");

  // Decode common entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&[a-z]+;/gi, " ");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  // Cap at 5000 chars to match existing post content limit
  return s.slice(0, 5000);
}

// Pull article URL from a harvestapi listing item or supreme_coder result.
// Returns null when the post isn't an article-share or has no link.
export function extractArticleLink(raw: Record<string, unknown>): string | null {
  // harvestapi listing: raw.article = { title, link, ... }
  const a = raw.article as Record<string, unknown> | undefined;
  if (a && typeof a.link === "string" && a.link.startsWith("http")) {
    return a.link;
  }
  // supreme_coder/linkedin-post: raw.article = { url, ... }
  if (a && typeof a.url === "string" && a.url.startsWith("http")) {
    return a.url;
  }
  return null;
}

// Heuristic: true when the post body is too short OR clearly truncated.
export function looksTruncated(content: string): boolean {
  if (!content) return true;
  if (content.length < 500) return true;
  // LinkedIn's "see more" cut typically ends with 4 dots
  if (/\.{4,}\s*$/.test(content)) return true;
  return false;
}

// Compose a final content string when we have both a teaser and an article body.
// Keeps the teaser at the top so author voice is preserved, then appends article.
export function mergeTeaserAndArticle(teaser: string, articleBody: string): string {
  const t = (teaser || "").replace(/\s*\.{4,}\s*$/, "").trim();
  if (!articleBody) return t;
  if (!t) return articleBody;
  return `${t}\n\n--- Linked article ---\n${articleBody}`.slice(0, 5000);
}
