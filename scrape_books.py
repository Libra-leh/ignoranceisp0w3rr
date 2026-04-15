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
-  pip install requests beautifulsoup4
+  Python 3.10+ (no third-party dependencies)
 """
 
 import re
 import json
 import time
 import argparse
 import sys
+from html import unescape
 from urllib.parse import urljoin
-
-try:
-    import requests
-    from bs4 import BeautifulSoup
-except ImportError:
-    print("Missing dependencies. Run: pip install requests beautifulsoup4")
-    sys.exit(1)
+from urllib.request import Request, urlopen
+from urllib.error import URLError, HTTPError
 
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
-            resp = requests.get(url, headers=HEADERS, timeout=20)
-            resp.raise_for_status()
-            return resp.text
-        except requests.RequestException as e:
+            req = Request(url, headers=HEADERS)
+            with urlopen(req, timeout=20) as resp:
+                return resp.read().decode("utf-8", errors="ignore")
+        except (URLError, HTTPError, TimeoutError) as e:
             print(f"  Attempt {attempt + 1}/{retries} failed: {e}")
             if attempt < retries - 1:
                 time.sleep(2 ** attempt)  # exponential backoff
     raise RuntimeError(f"Failed to fetch {url} after {retries} attempts")
 
 
+def _to_int_count(raw: str) -> int:
+    """Convert a textual loved-count to an integer."""
+    raw = raw.strip().lower().replace(",", "")
+    if raw.endswith("k"):
+        return int(float(raw[:-1]) * 1000)
+    if raw.endswith("m"):
+        return int(float(raw[:-1]) * 1_000_000)
+    return int(raw)
+
+
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
-    def parse_books(html: str) -> list[dict]:
-    soup = BeautifulSoup(html, "html.parser")
     books = []
     seen = set()
-    loved_pattern = re.compile(r"Loved by\s*(\d+)\s*people", re.IGNORECASE)
-
-    # Every book block contains an <h2> with a title link.
-    # For loved books, a sibling/nearby element contains "Loved by N people".
-    # Walk all h2s, check if their ancestor block has a loved count.
-    for h2 in soup.find_all("h2"):
-        title_el = h2.find("a") or h2
-        title = title_el.get_text(strip=True)
-        if not title or title in seen:
-            continue
+    loved_pattern = re.compile(r"Loved by\s*([\d,.]+[km]?)\s*people?", re.IGNORECASE)
 
-        # Walk up to find a container that holds the loved count
-        container = h2.parent
-        loved_count = 0
-        for _ in range(8):
-            if container is None:
-                break
-            text = container.get_text(" ", strip=True)
-            m = loved_pattern.search(text)
-            if m:
-                loved_count = int(m.group(1))
-                break
-            container = container.parent
-
-        # Skip promoted books with no loved count
-        if loved_count == 0:
+    # Find each loved-count marker and parse book data from nearby HTML.
+    for m in loved_pattern.finditer(html):
+        loved_raw = m.group(1)
+        try:
+            loved_count = _to_int_count(loved_raw)
+        except ValueError:
             continue
 
-        seen.add(title)
+        window = html[m.start():m.start() + 6000]
 
-        # Book URL
-        href = title_el.get("href", "") if title_el.name == "a" else ""
-        book_url = urljoin(BASE_URL, href) if href else ""
+        title_m = re.search(
+            r"<h2[^>]*>\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>\s*</h2>",
+            window,
+            flags=re.IGNORECASE | re.DOTALL,
+        )
+        if not title_m:
+            continue
 
-        # Re-find container from h2 for img/author search
-        block = h2.parent
-        for _ in range(8):
-            if block is None:
-                break
-            if block.find("img", alt=re.compile(r"Book cover", re.I)):
-                break
-            block = block.parent
+        href = title_m.group(1).strip()
+        title = re.sub(r"<[^>]+>", "", title_m.group(2))
+        title = unescape(title).strip()
+        if not title or title.lower() in seen:
+            continue
 
-        # Author
         author = ""
-        if block:
-            al = block.find_all("a", href=re.compile(r"/search/author/"))
-            if al:
-                author = al[0].get_text(strip=True)
+        author_m = re.search(
+            r'By\s*<a[^>]*href="/search/author/[^"]*"[^>]*>(.*?)</a>',
+            window,
+            flags=re.IGNORECASE | re.DOTALL,
+        )
+        if author_m:
+            author = unescape(re.sub(r"<[^>]+>", "", author_m.group(1))).strip()
 
-        # Cover — upgrade to width=600 for better quality
         cover = ""
-        if block:
-            img = block.find("img", alt=re.compile(r"Book cover", re.I))
-            if img:
-                src = img.get("src", "")
-                src = re.sub(r"width=\d+", "width=600", src)
-                src = re.sub(r"quality=\d+", "quality=90", src)
-                cover = src
+        cover_m = re.search(
+            r'<img[^>]*alt="[^"]*Book cover[^"]*"[^>]*src="([^"]+)"',
+            window,
+            flags=re.IGNORECASE | re.DOTALL,
+        )
+        if cover_m:
+            cover = cover_m.group(1)
+            cover = re.sub(r"width=\d+", "width=600", cover)
+            cover = re.sub(r"quality=\d+", "quality=90", cover)
+
+        seen.add(title.lower())
+        book_url = urljoin(BASE_URL, href) if href else ""
 
         books.append({
             "title":       title,
             "author":      author,
             "cover":       cover,
             "loved_count": loved_count,
             "url":         book_url,
         })
 
     books.sort(key=lambda b: b["loved_count"], reverse=True)
     return books
 
-    # Sort by loved_count descending (page order is already roughly sorted,
-    # but let's be explicit)
-    books.sort(key=lambda b: b["loved_count"], reverse=True)
-    return books
-
 
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
 
EOF
)
