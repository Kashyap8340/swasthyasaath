import json
import re

m = json.load(open('eligibility/ccmt_mapping.json', encoding='utf-8'))
o = json.load(open('eligibility/orcr_mapping.json', encoding='utf-8'))

def clean(s):
    if not s: return ""
    s = re.sub(r'-\([^)]+\)$', '', s).strip() # Remove -(XX)
    return s.replace(' ', '').replace('&','and').replace(',', '').replace('.','').lower()

matches = 0
unmatched = set()

for item in m[:5000]:
    prog = clean(item['pg_program'])
    inst = clean(item['institute'])
    
    match = [x for x in o if clean(x['institute']) == inst and clean(x['pg_program']) == prog]
    if match:
        matches += 1
    else:
        unmatched.add(f"{inst} || {prog}")

print(f"Matches: {matches}")
print(f"Unmatched unique: {len(unmatched)}")
for u in list(unmatched)[:10]:
    print(u)
