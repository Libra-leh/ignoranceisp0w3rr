#!/usr/bin/env python3
"""
BookDNA Fiction Scraper
=======================
Scrapes https://bookdna.com/bookshelf/fiction and extracts the
"All Time Best" fiction books ranked by community "Loved by N people" count.

Output: books.json  — array of objects sorted by loved_count desc:
  { "title", "author", "cover", "loved_count", "url" }

Usage:
  python3 scrape_bookdna.py              # fetches live, saves books.json
  python3 scrape_bookdna.py --pages 3    # scrapes first 3 pages (pagination)
  python3 scrape_bookdna.py --min-loved 10  # only books loved by >= 10 people

Requirements:
  pip install requests beautifulsoup4
"""

import re
import json
import time
import argparse
import sys
from urllib.parse import urljoin

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Missing dependencies. Run: pip install requests beautifulsoup4")
    sys.exit(1)

BASE_URL   = "https://bookdna.com"
SHELF_URL  = "https://bookdna.com/bookshelf/fiction"
OUTPUT     = "books.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://bookdna.com/",
}


def fetch_page(url: str, retries: int = 3) -> str:
    """Fetch a page with retry logic."""
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            resp.raise_for_status()
            return resp.text
        except requests.RequestException as e:
            print(f"  Attempt {attempt + 1}/{retries} failed: {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)  # exponential backoff
    raise RuntimeError(f"Failed to fetch {url} after {retries} attempts")


def parse_books(html: str) -> list[dict]:
    """
    Parse book entries from the page HTML.

    BookDNA page structure for popular books:
      <strong>Loved by 118\npeople</strong>
      <h2><a href="/book/demon-copperhead">Demon Copperhead</a></h2>
      By <a href="/search/author/...">Barbara Kingsolver</a>
      <img alt="Book cover of Demon Copperhead" src="https://media.bookdna-cdn.com/...">

    Books without a "Loved by" count are indie/promoted listings — we skip those.
    """
    def parse_books(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    books = []
    seen = set()
    loved_pattern = re.compile(r"Loved by\s*(\d+)\s*people", re.IGNORECASE)

    # Every book block contains an <h2> with a title link.
    # For loved books, a sibling/nearby element contains "Loved by N people".
    # Walk all h2s, check if their ancestor block has a loved count.
    for h2 in soup.find_all("h2"):
        title_el = h2.find("a") or h2
        title = title_el.get_text(strip=True)
        if not title or title in seen:
            continue

        # Walk up to find a container that holds the loved count
        container = h2.parent
        loved_count = 0
        for _ in range(8):
            if container is None:
                break
            text = container.get_text(" ", strip=True)
            m = loved_pattern.search(text)
            if m:
                loved_count = int(m.group(1))
                break
            container = container.parent

        # Skip promoted books with no loved count
        if loved_count == 0:
            continue

        seen.add(title)

        # Book URL
        href = title_el.get("href", "") if title_el.name == "a" else ""
        book_url = urljoin(BASE_URL, href) if href else ""

        # Re-find container from h2 for img/author search
        block = h2.parent
        for _ in range(8):
            if block is None:
                break
            if block.find("img", alt=re.compile(r"Book cover", re.I)):
                break
            block = block.parent

        # Author
        author = ""
        if block:
            al = block.find_all("a", href=re.compile(r"/search/author/"))
            if al:
                author = al[0].get_text(strip=True)

        # Cover — upgrade to width=600 for better quality
        cover = ""
        if block:
            img = block.find("img", alt=re.compile(r"Book cover", re.I))
            if img:
                src = img.get("src", "")
                src = re.sub(r"width=\d+", "width=600", src)
                src = re.sub(r"quality=\d+", "quality=90", src)
                cover = src

        books.append({
            "title":       title,
            "author":      author,
            "cover":       cover,
            "loved_count": loved_count,
            "url":         book_url,
        })

    books.sort(key=lambda b: b["loved_count"], reverse=True)
    return books

    # Sort by loved_count descending (page order is already roughly sorted,
    # but let's be explicit)
    books.sort(key=lambda b: b["loved_count"], reverse=True)
    return books


def scrape(pages: int = 1, min_loved: int = 1) -> list[dict]:
    """Scrape N pages and return merged, deduplicated book list."""
    all_books = []
    seen = set()

    for page in range(1, pages + 1):
        url = SHELF_URL if page == 1 else f"{SHELF_URL}?page={page}"
        print(f"Fetching page {page}: {url}")
        html = fetch_page(url)
        books = parse_books(html)
        print(f"  Found {len(books)} books with loved counts on page {page}")

        for b in books:
            key = b["title"].lower().strip()
            if key not in seen:
                seen.add(key)
                all_books.append(b)

        if page < pages:
            time.sleep(1)  # polite delay between pages

    # Filter by minimum loved count
    all_books = [b for b in all_books if b["loved_count"] >= min_loved]
    # Final sort
    all_books.sort(key=lambda b: b["loved_count"], reverse=True)
    return all_books


def main():
    parser = argparse.ArgumentParser(description="Scrape BookDNA best fiction list")
    parser.add_argument("--pages",     type=int, default=1,  help="Number of pages to scrape (default: 1)")
    parser.add_argument("--min-loved", type=int, default=1,  help="Minimum loved count to include (default: 1)")
    parser.add_argument("--output",    type=str, default=OUTPUT, help=f"Output JSON file (default: {OUTPUT})")
    parser.add_argument("--pretty",    action="store_true",   help="Pretty-print JSON output")
    args = parser.parse_args()

    print(f"BookDNA Fiction Scraper")
    print(f"  Pages:     {args.pages}")
    print(f"  Min loved: {args.min_loved}")
    print(f"  Output:    {args.output}")
    print()

    try:
        books = scrape(pages=args.pages, min_loved=args.min_loved)
    except RuntimeError as e:
        print(f"\nError: {e}")
        sys.exit(1)

    indent = 2 if args.pretty else None
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(books, f, ensure_ascii=False, indent=indent)

    print(f"\nDone. {len(books)} books saved to {args.output}")
    if books:
        print(f"\nTop 10:")
        for i, b in enumerate(books[:10], 1):
            print(f"  {i:2}. [{b['loved_count']:3} ❤] {b['title']} — {b['author']}")


if __name__ == "__main__":
    main()
