"""
One-time script to generate:
  - frontend/src/data/cookbooks-index.json  (committed, metadata only)
  - frontend/src/data/recipes.json          (gitignored, all recipes merged)

Run from the daves-world project root:
  python scripts/generate_cookbook_index.py
"""

import json
import re
import sys
from pathlib import Path

COOKBOOKS_DIR = Path(__file__).parent.parent / "frontend/src/data/cookbooks"
OUT_INDEX = Path(__file__).parent.parent / "frontend/src/data/cookbooks-index.json"
OUT_RECIPES = Path(__file__).parent.parent / "frontend/public/recipes.json"


def slugify(text):
    text = text.lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def main():
    json_files = sorted(COOKBOOKS_DIR.glob("*.json"))
    if not json_files:
        print(f"No JSON files found in {COOKBOOKS_DIR}", file=sys.stderr)
        sys.exit(1)

    index = []
    all_recipes = []

    for path in json_files:
        with open(path, encoding="utf-8") as f:
            recipes = json.load(f)

        if not recipes:
            continue

        first = recipes[0]
        book_title = first.get("book", path.stem)
        author = first.get("author", "")
        book_id = slugify(book_title)

        # Collect all unique cuisines and categories from recipes
        cuisines = set()
        categories = set()
        for recipe in recipes:
            for cat in recipe.get("categories", []):
                cat_lower = cat.lower()
                # Rough heuristic: treat geographic/nationality terms as cuisines
                cuisine_keywords = {
                    "italian", "japanese", "american", "korean", "mexican",
                    "chinese", "georgian", "middle eastern", "jewish",
                    "french", "indian", "asian", "mediterranean",
                }
                if any(kw in cat_lower for kw in cuisine_keywords):
                    cuisines.add(cat)
                else:
                    categories.add(cat)

        index.append({
            "id": book_id,
            "title": book_title,
            "author": author,
            "recipeCount": len(recipes),
            "cuisines": sorted(cuisines),
            "categories": sorted(categories),
        })

        for i, recipe in enumerate(recipes):
            recipe_id = f"{book_id}-{slugify(recipe.get('title', str(i)))}"
            all_recipes.append({
                "id": recipe_id,
                "title": recipe.get("title", ""),
                "book": book_title,
                "bookId": book_id,
                "author": author,
                "page": str(recipe.get("page", "")),
                "categories": recipe.get("categories", []),
                "ingredients": recipe.get("ingredients", []),
                "ingredientsStandardised": recipe.get("ingredients_standardised", []),
            })

    # Sort index by title
    index.sort(key=lambda x: x["title"])

    with open(OUT_INDEX, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(index)} books → {OUT_INDEX}")

    with open(OUT_RECIPES, "w", encoding="utf-8") as f:
        json.dump(all_recipes, f, ensure_ascii=False)
    print(f"Wrote {len(all_recipes)} recipes → {OUT_RECIPES}")


if __name__ == "__main__":
    main()
