#!/usr/bin/env python3
"""
BookDNA Fiction Scraper
=======================
Scrapes https://bookdna.com/bookshelf/fiction
Output: books.json — sorted by loved_count desc

Usage:
  python3 scrape_bookdna.py
  python3 scrape_bookdna.py --pages 3 --min-loved 20 --pretty

Requirements:
  pip install curl_cffi beautifulsoup4
  (curl_cffi impersonates a real Chrome TLS fingerprint — bypasses Cloudflare)
"""

import re, json, time, argparse, sys
from urllib.parse import urljoin

# ── HTTP client: curl_cffi impersonates Chrome at TLS level (bypasses Cloudflare) ──
try:
    from curl_cffi import requests
    IMPERSONATE = "chrome120"
    print("Using curl_cffi (Cloudflare bypass enabled)")
except ImportError:
    print("ERROR: curl_cffi not found.")
    print("Install it with:  pip install curl_cffi")
    print()
    print("Why curl_cffi? Bookdna.com uses Cloudflare, which blocks plain requests.")
    print("curl_cffi impersonates a real Chrome browser at the TLS fingerprint level,")
    print("which is the only reliable way to bypass Cloudflare without a headless browser.")
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("ERROR: beautifulsoup4 not found.  pip install beautifulsoup4")
    sys.exit(1)

BASE_URL  = "https://bookdna.com"
SHELF_URL = "https://bookdna.com/bookshelf/fiction"
OUTPUT    = "books.json"
LOVED_RE  = re.compile(r'Loved by (\d+)\s*people', re.IGNORECASE)

HEADERS = {
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://bookdna.com/",
}


def fetch_page(url, retries=3):
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, impersonate=IMPERSONATE, timeout=20)
            r.raise_for_status()
            html = r.text
            # Detect Cloudflare challenge page
            if "Just a moment" in html or "cf-browser-verification" in html:
                raise RuntimeError("Cloudflare challenge page received — not the real content")
            return html
        except Exception as e:
            print(f"  Attempt {attempt+1}/{retries} failed: {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed to fetch {url} after {retries} attempts")


def parse_books(html):
    """
    Parse books with loved counts from the page.

    BookDNA structure (flat siblings):
      <strong>Loved by 118 people</strong>   <- find this text node
      <h2><a href="/book/...">Title</a></h2> <- find_next('h2')
      <a href="/search/author/...">Author</a> <- find_next author link
      <img alt="Book cover of ..." src="..."> <- find_next img

    Books without a loved count are promoted/indie listings — skipped.
    """
    soup  = BeautifulSoup(html, "html.parser")

    # Diagnostic: confirm we got real content
    title_tag = soup.find("title")
    page_title = title_tag.get_text(strip=True) if title_tag else "?"
    print(f"  Page title: {page_title}")
    if "Just a moment" in page_title:
        print("  ⚠️  Got Cloudflare challenge page, not real content!")
        return []

    books = []
    seen  = set()

    for text_node in soup.find_all(string=LOVED_RE):
        match = LOVED_RE.search(text_node)
        if not match:
            continue
        loved_count = int(match.group(1))

        # Walk up to a block-level container
        # text → <strong/b/span> → parent block (div/section/li/p/a)
        base = text_node.parent.parent

        # Title: find_next h2 from this point forward in the document
        h2 = base.find_next("h2")
        if not h2:
            continue
        title_el = h2.find("a") or h2
        title = title_el.get_text(strip=True)
        if not title or title in seen:
            continue
        seen.add(title)

        # Book URL
        href     = title_el.get("href", "") if title_el.name == "a" else ""
        book_url = urljoin(BASE_URL, href) if href else ""

        # Author
        author_a = base.find_next("a", href=re.compile(r"/search/author/"))
        author   = author_a.get_text(strip=True) if author_a else ""

        # Cover — upgrade resolution width=220 → width=400
        img   = base.find_next("img", alt=re.compile(r"Book cover", re.I))
        cover = re.sub(r"width=\d+", "width=400", img.get("src", "")) if img else ""

        books.append({
            "title":       title,
            "author":      author,
            "cover":       cover,
            "loved_count": loved_count,
            "url":         book_url,
        })

    books.sort(key=lambda b: b["loved_count"], reverse=True)
    return books


def scrape(pages=1, min_loved=1):
    all_books, seen = [], set()

    for page in range(1, pages + 1):
        url = SHELF_URL if page == 1 else f"{SHELF_URL}?page={page}"
        print(f"\nFetching page {page}: {url}")
        html  = fetch_page(url)
        found = parse_books(html)
        print(f"  Parsed {len(found)} books with loved counts")

        for b in found:
            key = b["title"].lower().strip()
            if key not in seen:
                seen.add(key)
                all_books.append(b)

        if page < pages:
            time.sleep(1)

    all_books = [b for b in all_books if b["loved_count"] >= min_loved]
    all_books.sort(key=lambda b: b["loved_count"], reverse=True)
    return all_books


def main():
    p = argparse.ArgumentParser(description="Scrape BookDNA best fiction")
    p.add_argument("--pages",     type=int, default=1,      help="Pages to scrape (default 1)")
    p.add_argument("--min-loved", type=int, default=1,      help="Min loved count (default 1)")
    p.add_argument("--output",    type=str, default=OUTPUT, help=f"Output JSON (default {OUTPUT})")
    p.add_argument("--pretty",    action="store_true",      help="Pretty-print JSON")
    args = p.parse_args()

    print("BookDNA Fiction Scraper")
    print(f"  Pages:     {args.pages}")
    print(f"  Min loved: {args.min_loved}")
    print(f"  Output:    {args.output}")

    try:
        books = scrape(pages=args.pages, min_loved=args.min_loved)
    except RuntimeError as e:
        print(f"\nError: {e}")
        sys.exit(1)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(books, f, ensure_ascii=False, indent=2 if args.pretty else None)

    print(f"\nDone — {len(books)} books saved to {args.output}")
    if books:
        print("\nTop 10:")
        for i, b in enumerate(books[:10], 1):
            print(f"  {i:2}. [{b['loved_count']:3}❤] {b['title']} — {b['author']}")


if __name__ == "__main__":
    main()
