#!/usr/bin/env python3
"""
BDS Product Knowledge Rebuilder
================================
Reads a Shopify products CSV export and rebuilds the 8 product knowledge
markdown files in knowledge/products/.

Each product entry shows ALL size variants with their individual prices,
not just the first variant.

Usage:
    python3 scripts/rebuild_products.py <path-to-products-export.csv>

Example:
    python3 scripts/rebuild_products.py ~/Downloads/products_export_1.csv
"""

import sys
import csv
import os
from collections import defaultdict

# ── Category mapping ──────────────────────────────────────────────────────────

CATEGORY_FILES = {
    'booth_kits':            'knowledge/products/products_booth_kits.md',
    'media_walls_backdrops': 'knowledge/products/products_media_walls_backdrops.md',
    'banners_printing':      'knowledge/products/products_banners_printing.md',
    'counters_displays':     'knowledge/products/products_counters_displays.md',
    'outdoor_events':        'knowledge/products/products_outdoor_events.md',
    'photo_studio':          'knowledge/products/products_photo_studio.md',
    'fifa_2026':             'knowledge/products/products_fifa_2026.md',
    'other':                 'knowledge/products/products_other.md',
}

CATEGORY_LABELS = {
    'booth_kits':            'Booth Kits',
    'media_walls_backdrops': 'Media Walls & Backdrops',
    'banners_printing':      'Banners & Printing',
    'counters_displays':     'Counters & Displays',
    'outdoor_events':        'Outdoor & Events',
    'photo_studio':          'Photo Studio',
    'fifa_2026':             'FIFA 2026',
    'other':                 'Other',
}

TYPE_TO_CATEGORY = {
    'booth kits':                  'booth_kits',
    'booth kit':                   'booth_kits',
    'media walls':                 'media_walls_backdrops',
    'media wall':                  'media_walls_backdrops',
    'backdrops':                   'media_walls_backdrops',
    'backdrop':                    'media_walls_backdrops',
    'tension fabric':              'media_walls_backdrops',
    'banners':                     'banners_printing',
    'banner':                      'banners_printing',
    'printing':                    'banners_printing',
    'print':                       'banners_printing',
    'counters':                    'counters_displays',
    'counter':                     'counters_displays',
    'displays':                    'counters_displays',
    'display':                     'counters_displays',
    'outdoor':                     'outdoor_events',
    'events':                      'outdoor_events',
    'canopy':                      'outdoor_events',
    'canopies':                    'outdoor_events',
    'photo studio':                'photo_studio',
    'photography':                 'photo_studio',
    'fifa':                        'fifa_2026',
    'fifa 2026':                   'fifa_2026',
}

TITLE_KEYWORDS_TO_CATEGORY = {
    'booth kit':    'booth_kits',
    'media wall':   'media_walls_backdrops',
    'backdrop':     'media_walls_backdrops',
    'tension wall': 'media_walls_backdrops',
    'seg ':         'counters_displays',
    'sego':         'counters_displays',
    'lightbox':     'counters_displays',
    'led':          'counters_displays',
    'counter':      'counters_displays',
    'podium':       'counters_displays',
    'popup':        'counters_displays',
    'retractable':  'banners_printing',
    'roll-up':      'banners_printing',
    'banner':       'banners_printing',
    'canopy':       'outdoor_events',
    'outdoor':      'outdoor_events',
    'tent':         'outdoor_events',
    'flag':         'outdoor_events',
    'photo':        'photo_studio',
    'studio':       'photo_studio',
    'green screen': 'photo_studio',
    'fifa':         'fifa_2026',
    'world cup':    'fifa_2026',
}


def categorize(product_type: str, title: str) -> str:
    pt = product_type.lower().strip()
    for key, cat in TYPE_TO_CATEGORY.items():
        if key in pt:
            return cat
    tl = title.lower()
    for key, cat in TITLE_KEYWORDS_TO_CATEGORY.items():
        if key in tl:
            return cat
    return 'other'


def parse_price(val: str) -> float | None:
    try:
        return float(val.strip())
    except (ValueError, AttributeError):
        return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/rebuild_products.py <path-to-csv>")
        sys.exit(1)

    csv_path = sys.argv[1]
    if not os.path.exists(csv_path):
        print(f"File not found: {csv_path}")
        sys.exit(1)

    # ── Parse CSV ─────────────────────────────────────────────────────────────
    # Key data structures:
    #   products[handle] = { title, type, url, variants: [(size, color, price)], options: {name: set(values)} }

    products = {}  # handle -> product dict, preserving insertion order

    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.reader(f)
        headers = next(reader)

        # Find column indices
        def col(name):
            name_lower = name.lower()
            for i, h in enumerate(headers):
                if h.strip().lower() == name_lower:
                    return i
            return None

        idx_handle        = col('handle')            or 0
        idx_title         = col('title')             or 1
        idx_type          = col('type')              or 13
        idx_variant_price = col('variant price')
        idx_opt1_name     = col('option1 name')
        idx_opt1_value    = col('option1 value')
        idx_opt2_name     = col('option2 name')
        idx_opt2_value    = col('option2 value')
        idx_opt3_name     = col('option3 name')
        idx_opt3_value    = col('option3 value')

        # Fall back to positional if named cols not found
        # Shopify CSV standard: variant price ~col 19, opt1 name ~20, opt1 val ~21, etc.
        def safe_get(row, idx, fallback=None):
            if idx is not None and idx < len(row):
                return row[idx].strip()
            return fallback or ''

        for row in reader:
            if len(row) < 5:
                continue

            handle = safe_get(row, idx_handle)
            if not handle:
                continue

            title         = safe_get(row, idx_title)
            product_type  = safe_get(row, idx_type)
            price_raw     = safe_get(row, idx_variant_price)
            opt1_name     = safe_get(row, idx_opt1_name)
            opt1_val      = safe_get(row, idx_opt1_value)
            opt2_name     = safe_get(row, idx_opt2_name)
            opt2_val      = safe_get(row, idx_opt2_value)
            opt3_name     = safe_get(row, idx_opt3_name)
            opt3_val      = safe_get(row, idx_opt3_value)

            price = parse_price(price_raw)

            if handle not in products:
                products[handle] = {
                    'title':    title or handle,
                    'type':     product_type,
                    'url':      f'https://www.backdropsource.com/products/{handle}',
                    'prices':   set(),
                    'variants': [],   # list of (opt1_val, opt2_val, opt3_val, price)
                    'opt_names': {},  # opt1_name, opt2_name, opt3_name
                    'opt_values': defaultdict(set),  # opt_name -> set of values
                }

            p = products[handle]

            # Update title/type from first non-empty row
            if not p['title'] and title:
                p['title'] = title
            if not p['type'] and product_type:
                p['type'] = product_type

            # Store option names
            if opt1_name and 'opt1' not in p['opt_names']:
                p['opt_names']['opt1'] = opt1_name
            if opt2_name and 'opt2' not in p['opt_names']:
                p['opt_names']['opt2'] = opt2_name
            if opt3_name and 'opt3' not in p['opt_names']:
                p['opt_names']['opt3'] = opt3_name

            # Collect option values
            if opt1_val:
                p['opt_values'][opt1_name or 'Option 1'].add(opt1_val)
            if opt2_val:
                p['opt_values'][opt2_name or 'Option 2'].add(opt2_val)
            if opt3_val:
                p['opt_values'][opt3_name or 'Option 3'].add(opt3_val)

            # Track price range
            if price is not None:
                p['prices'].add(price)

            # Store variant row for size+price tables
            if price is not None and (opt1_val or opt2_val or opt3_val):
                # Only store if this combo not already seen
                combo = (opt1_val, opt2_val, opt3_val, price)
                if combo not in p['variants']:
                    p['variants'].append(combo)

    # ── Group by category ─────────────────────────────────────────────────────

    by_category = defaultdict(list)
    for handle, p in products.items():
        cat = categorize(p['type'], p['title'])
        by_category[cat].append(p)

    # ── Write markdown files ───────────────────────────────────────────────────

    # Determine if a product has meaningful size variants (opt1 is a size-like option)
    SIZE_KEYWORDS = ['size', 'width', 'height', 'dimension', 'w x h', 'ft', 'inch']

    def is_size_option(opt_name: str) -> bool:
        nl = opt_name.lower()
        return any(kw in nl for kw in SIZE_KEYWORDS)

    for cat, cat_products in by_category.items():
        filepath = CATEGORY_FILES[cat]
        label    = CATEGORY_LABELS[cat]
        os.makedirs(os.path.dirname(filepath), exist_ok=True)

        lines = [f'# {label}\n', f'\n**Total products: {len(cat_products)}**\n']

        for p in sorted(cat_products, key=lambda x: x['title']):
            title = p['title']
            url   = p['url']
            prices = sorted(p['prices'])

            if len(prices) == 0:
                price_str = 'Contact for pricing'
            elif len(prices) == 1:
                price_str = f'${prices[0]:.0f}'
            else:
                price_str = f'${prices[0]:.0f}–${prices[-1]:.0f}'

            lines.append(f'\n\n### {title}')
            lines.append(f'- **Price:** {price_str}')
            lines.append(f'- **URL:** {url}')

            opt1_name = p['opt_names'].get('opt1', '')
            opt2_name = p['opt_names'].get('opt2', '')
            opt3_name = p['opt_names'].get('opt3', '')

            # If opt1 looks like a size and there are multiple variants with different prices,
            # show a size→price table instead of just listing values
            show_price_table = (
                opt1_name and
                is_size_option(opt1_name) and
                len(prices) > 1 and
                len(p['variants']) > 1
            )

            if show_price_table:
                # Group variants by opt1_val (size), show price per size
                size_prices = {}
                for (v1, v2, v3, price) in p['variants']:
                    if v1 not in size_prices:
                        size_prices[v1] = set()
                    size_prices[v1].add(price)

                lines.append(f'- **Size variants with pricing:**')
                for size_val, size_price_set in size_prices.items():
                    sp_sorted = sorted(size_price_set)
                    if len(sp_sorted) == 1:
                        price_label = f'${sp_sorted[0]:.0f}'
                    else:
                        price_label = f'${sp_sorted[0]:.0f}–${sp_sorted[-1]:.0f}'
                    lines.append(f'  - {size_val} — {price_label}')

                # Show non-size options (color, material, etc.)
                for oname, ovals in p['opt_values'].items():
                    if is_size_option(oname):
                        continue
                    sorted_vals = sorted(ovals)
                    lines.append(f'- **{oname}:** {", ".join(sorted_vals)}')

            else:
                # Standard: list all unique values per option
                lines.append('- **Options:**')
                for oname, ovals in p['opt_values'].items():
                    sorted_vals = sorted(ovals)
                    if len(sorted_vals) <= 8:
                        lines.append(f'  - **{oname}:** {", ".join(sorted_vals)}')
                    else:
                        # Too many to list inline — show count
                        sample = ', '.join(sorted_vals[:6])
                        lines.append(f'  - **{oname}:** {sample}, ... ({len(sorted_vals)} options)')

        content = '\n'.join(lines) + '\n'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)

        print(f'✅ {label}: {len(cat_products)} products → {filepath}')

    total = sum(len(v) for v in by_category.values())
    print(f'\n✅ Done. {total} products across {len(by_category)} categories.')
    print('Next: re-run the Milvus indexer to pick up the updated files.')


if __name__ == '__main__':
    main()
