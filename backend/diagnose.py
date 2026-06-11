from app.database import SessionLocal
from app.models import Chunk

db = SessionLocal()

print("\n" + "=" * 70)
print("STEP 1: Looking at page 4 (where Lumina said the TOC is)")
print("=" * 70)

page4_chunks = db.query(Chunk).filter(Chunk.page_number == 4).order_by(Chunk.chunk_index).all()
print(f"\nFound {len(page4_chunks)} chunks on page 4\n")
for c in page4_chunks:
    print(f"--- Chunk {c.chunk_index} (page 4) ---")
    print(c.content)
    print()

print("\n" + "=" * 70)
print("STEP 2: Looking at pages 3 and 5 too (in case TOC spans them)")
print("=" * 70)
for pg in [3, 5]:
    chunks = db.query(Chunk).filter(Chunk.page_number == pg).order_by(Chunk.chunk_index).all()
    print(f"\n--- Page {pg} ({len(chunks)} chunks) ---")
    for c in chunks:
        print(f"  [Chunk {c.chunk_index}]: {c.content[:300]}")
        print()

print("\n" + "=" * 70)
print("STEP 3: Search for 'IMPOSSIBLE' (uppercase, no 'task') anywhere")
print("=" * 70)
chunks = db.query(Chunk).filter(Chunk.content.like('%IMPOSSIBLE%')).all()
print(f"Found {len(chunks)} chunks containing 'IMPOSSIBLE' (case-sensitive)")
for c in chunks[:5]:
    print(f"  [Chunk {c.chunk_index}, page {c.page_number}]: {c.content[:200]}")

print("\n" + "=" * 70)
print("STEP 4: Search for various chapter formats")
print("=" * 70)
for pattern in ['Chapter', 'CHAPTER', 'chapter']:
    count = db.query(Chunk).filter(Chunk.content.like(f'%{pattern}%')).count()
    print(f"  '{pattern}' (case-sensitive): {count} chunks")

db.close()
print("\nDone.")