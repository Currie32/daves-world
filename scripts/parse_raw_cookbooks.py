"""
Parse raw cookbook .txt files (eatyourbooks.com copy-paste format) into
processed JSON files for use in frontend/src/data/cookbooks/.

Each recipe block in the .txt looks like:

    [Optional bare title line]
    Recipe Title (page XX)
    from Book Full Title by Author
    Categories: Cat1; Cat2, SubCat; Cat3
    Ingredients: ing1; ing2; ing3
    [Optional Accompaniments: ...]
    N  (save count — ignored)
    [Optional: Recipe Online / Report Broken Link lines]

Usage (from project root):
    python scripts/parse_raw_cookbooks.py <source_dir> [--out <output_dir>] [--dry-run]

    source_dir  Directory containing .txt files to parse
    --out       Output directory (default: frontend/src/data/cookbooks)
    --dry-run   Print book titles and recipe counts; don't write files
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import inflect
    _p = inflect.engine()
    def _singular(word):
        try:
            result = _p.singular_noun(word)
            return result if result else word
        except Exception:
            return word
except ImportError:
    def _singular(word):
        return word

DEFAULT_SRC = Path(__file__).parent.parent / "frontend/src/data/cookbooks/raw"
DEFAULT_OUT = Path(__file__).parent.parent / "frontend/src/data/cookbooks"

INGREDIENT_MAPPING = {
    "active dry yeast": "yeast",
    "baby basil": "basil",
    "cashew nut": "cashew",
    "capsicum": "bell pepper",
    "cherry tomatoes": "tomato",
    "coriander leaves": "coriander leaf",
    "coriander stalks": "coriander",
    "feta cheese": "feta",
    "ginger root": "ginger",
    "grated ginger": "ginger",
    "haloumi cheese": "haloumi",
    "hot chilli sauce": "chilli sauce",
    "lebanese cucumbers": "cucumber",
    "natural yoghurt": "yoghurt",
    "vine tomatoes": "tomato",
    "wholegrain mustard": "mustard",
}


def _standardize_ingredient(ingredient):
    s = ingredient.lower().strip()
    if s != "sweet potato":
        s = re.sub(r"(canned |ground |fresh |frozen |sweet )|( in oil)", "", s)
    s = re.sub(r"[a-z]+ noodle[s]*", "noodles", s)
    s = re.sub(r"(light|dark) soy sauce", "soy sauce", s)
    s = re.sub(r" of your choice", "", s)
    s = s.replace("è", "e").replace("raman", "ramen")
    s = _singular(s)
    s = INGREDIENT_MAPPING.get(s, s)
    s = re.sub(r"[a-z]+ bell pepper", "bell pepper", s)
    return s


def _standardize_category(cat):
    s = cat.lower().strip()
    s = re.sub(r" \(no-alcohol\)| &amp;?", "", s)
    if not s or s == "false general":
        return None
    s = _singular(s)
    return s


def _parse_categories(raw):
    """Split 'Cat1, Sub; Cat2 & Sub2' into a flat list of standardized strings."""
    result = []
    for group in raw.split(";"):
        for part in group.split(","):
            for subpart in part.split(" & "):
                cleaned = _standardize_category(subpart)
                if cleaned:
                    result.append(cleaned)
    return result


_MARKETING_SUBTITLE = re.compile(
    r"^(\d|over |a |an |the |classic |simple |quick |everyday |recipes |illustrated |better |good )",
    re.IGNORECASE,
)


def _shorten_title(full_title):
    """Keep the meaningful part of a title, dropping publisher subtitles."""
    parts = full_title.split(": ")
    if len(parts) == 1:
        return full_title
    after_first_colon = parts[1]
    # Drop if it looks like a marketing blurb (starts with common descriptor words)
    # or is longer than 5 words (clearly a descriptive tagline, not a real subtitle)
    word_count = len(after_first_colon.split())
    is_marketing = _MARKETING_SUBTITLE.match(after_first_colon) or word_count > 5
    if is_marketing:
        return parts[0]
    # Multiple colons and not a marketing blurb → join first two segments
    # (e.g. "One: Pot, Pan, Planet: A Greener Way to Cook...")
    if len(parts) >= 3:
        return ": ".join(parts[:2])
    return full_title


def _extract_book_info(from_line):
    """
    'from East: 120 Veg Recipes by Meera Sodha' →
    short_title='East', author='Meera Sodha'
    """
    body = from_line[len("from "):].strip()
    # Split off author at last occurrence of " by "
    by_idx = body.rfind(" by ")
    if by_idx == -1:
        return body, ""
    full_title = body[:by_idx].strip()
    author = body[by_idx + 4:].strip()
    short_title = _shorten_title(full_title)
    return short_title, author


def parse_txt(path: Path):
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()

    # Use "from ... by ..." lines as recipe anchors — they appear in every recipe block.
    from_re = re.compile(r"^from .+ by .+$", re.IGNORECASE)
    page_re = re.compile(r"^(.+?)\s*\(page\s+(\d+)\)\s*$")
    noise = {"recipe online", "report broken link", '"""'}

    # Find indices of all "from" lines
    from_indices = [i for i, l in enumerate(lines) if from_re.match(l.strip())]
    if not from_indices:
        return [], None

    book_title = None
    author = None
    recipes = []

    for fi in from_indices:
        from_line = lines[fi].strip()

        if book_title is None:
            book_title, author = _extract_book_info(from_line)

        # Title: walk back to find the last non-noise, non-empty line before this from_line.
        # If that line has "(page XX)", use it; otherwise use it as-is.
        title = ""
        page = ""
        for k in range(fi - 1, max(fi - 4, -1), -1):
            candidate = lines[k].strip()
            if not candidate or candidate.lower() in noise:
                continue
            m = page_re.match(candidate)
            if m:
                title = m.group(1).strip()
                page = m.group(2)
            else:
                title = candidate
            break

        # Walk forward from the from_line for categories and ingredients
        categories_raw = ingredients_raw = ""
        for k in range(fi + 1, min(fi + 6, len(lines))):
            l = lines[k].strip()
            if l.lower().startswith("categories:"):
                categories_raw = l[len("categories:"):].strip()
            elif l.lower().startswith("ingredients:"):
                raw = l[len("ingredients:"):].strip()
                raw = re.sub(r"\s*Accompaniments:.*$", "", raw, flags=re.IGNORECASE)
                ingredients_raw = raw

        categories = _parse_categories(categories_raw) if categories_raw else []
        ingredients_list = [x.strip() for x in ingredients_raw.split(";") if x.strip()] if ingredients_raw else []
        ingredients_sorted = sorted(x.lower() for x in ingredients_list)
        ingredients_std = [_standardize_ingredient(x) for x in ingredients_list]

        if title:
            recipes.append({
                "title": title,
                "page": page,
                "categories": categories,
                "ingredients": ingredients_sorted,
                "book": book_title or path.stem,
                "author": author or "",
                "ingredients_standardised": ingredients_std,
            })

    return recipes, book_title or path.stem


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source_dir", nargs="?", default=str(DEFAULT_SRC), help="Directory containing .txt files (default: frontend/src/data/cookbooks/raw)")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output directory")
    parser.add_argument("--dry-run", action="store_true", help="Print stats without writing files")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing JSON files (default: skip them)")
    args = parser.parse_args()

    source = Path(args.source_dir)
    out_dir = Path(args.out)

    if not source.is_dir():
        print(f"Error: {source} is not a directory", file=sys.stderr)
        sys.exit(1)

    txt_files = sorted(source.glob("*.txt"))
    if not txt_files:
        print(f"No .txt files found in {source}", file=sys.stderr)
        sys.exit(1)

    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    for txt_path in txt_files:
        recipes, book_title = parse_txt(txt_path)
        if not recipes:
            print(f"  SKIP  {txt_path.name} — no recipes parsed")
            continue

        out_path = out_dir / f"{book_title}.json"
        exists = out_path.exists()
        if args.dry_run:
            flag = "(exists — will skip)" if exists else "(new)"
            if exists and args.overwrite:
                flag = "(exists — will overwrite)"
            print(f"  {len(recipes):>4} recipes  {book_title}  {flag}")
        else:
            if exists and not args.overwrite:
                print(f"  SKIP    {out_path.name}  (already exists; use --overwrite to replace)")
                continue
            label = "UPDATE" if exists else "CREATE"
            print(f"  {label}  {out_path.name}  ({len(recipes)} recipes)")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(recipes, f, indent=2, ensure_ascii=False)

    if not args.dry_run:
        print(f"\nDone. Run 'python scripts/generate_cookbook_index.py' to rebuild the index.")


if __name__ == "__main__":
    main()
